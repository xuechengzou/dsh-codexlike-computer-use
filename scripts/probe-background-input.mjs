// ---------------------------------------------------------------------------
// 打扰性守卫：本脚本会创建窗口、抢占前台或移动光标，可能打断正在使用电脑的人。
// 必须显式放行才运行——"默认安全"而不是"默认危险"。
// ---------------------------------------------------------------------------
if (process.env.DSH_COMPUTER_USE_ALLOW_DISRUPTIVE !== '1') {
	console.error('本脚本会创建窗口 / 抢占前台 / 移动光标，可能打扰到正在使用电脑的人。');
	console.error('确认此刻可以打扰时，用以下方式显式放行：');
	console.error('  PowerShell:  $env:DSH_COMPUTER_USE_ALLOW_DISRUPTIVE="1"; node <本脚本>');
	console.error('  或临时:      set DSH_COMPUTER_USE_ALLOW_DISRUPTIVE=1 && node <本脚本>');
	process.exit(2);
}

/**
 * 核心问题的测量：**窗口不在前台、也不获得焦点时，能不能点它、能不能往它里面打字。**
 *
 * 前提约束（用户明确要求）：不碰鼠标、不碰键盘——
 * 也就是完全不用 SetCursorPos 与 SendInput，只用"给目标窗口发消息"这条路。
 *
 * 靶窗口由本脚本自己启动，另起一个置顶窗口盖住它并抢走前台，然后：
 *   1. PostMessage WM_LBUTTONDOWN/UP → 按钮点击计数有没有涨
 *   2. PostMessage WM_CHAR          → 文本框内容有没有变
 *   3. UI Automation InvokePattern  → 按钮点击计数有没有涨（语义寻址，不需要坐标）
 * 每一步都记录光标位置，确认全程未被移动。
 *
 * 清理：按自己启动的 PID 精确终止（`taskkill /PID <自己> /T /F`），
 * 绝不安照可执行文件路径杀进程——那会连带关掉用户自己的程序。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireRealKoffi } from './real-koffi.mjs';

requireRealKoffi();

const koffi = await import('koffi');
const api = koffi.default ?? koffi;
const user32 = api.load('user32.dll');
const bind = (signature) => user32.func(signature);

const FindWindowW = bind('void *FindWindowW(const char16_t *cls, const char16_t *name)');
const FindWindowExW = bind('void *FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *name)');
const GetClassNameW = bind('int GetClassNameW(void *hWnd, _Out_ char16_t *buf, int max)');
const GetForegroundWindow = bind('void *GetForegroundWindow()');
const SetForegroundWindow = bind('int SetForegroundWindow(void *hWnd)');
const GetCursorPos = bind('int GetCursorPos(_Out_ void *point)');
const GetClientRect = bind('int GetClientRect(void *hWnd, _Out_ void *rect)');
const PostMessageW = bind('int PostMessageW(void *hWnd, uint32 msg, intptr_t wParam, intptr_t lParam)');
const SendMessageW = bind('int SendMessageW(void *hWnd, uint32 msg, intptr_t wParam, intptr_t lParam)');

const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_MOUSEMOVE = 0x0200;
const WM_CHAR = 0x0102;
const WM_SETTEXT = 0x000c;
const BM_CLICK = 0x00f5;
const MK_LBUTTON = 0x0001;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROJECT = fileURLToPath(new URL('..', import.meta.url));

const cursorNow = () => {
	const buffer = Buffer.alloc(8);
	GetCursorPos(buffer);
	return { x: buffer.readInt32LE(0), y: buffer.readInt32LE(4) };
};
const className = (handle) => {
	const buffer = Buffer.alloc(512);
	const written = GetClassNameW(handle, buffer, 256);
	return written <= 0 ? '' : buffer.subarray(0, written * 2).toString('utf16le');
};
const makeLParam = (x, y) => ((y << 16) | (x & 0xffff)) | 0;

const workDir = mkdtempSync(join(tmpdir(), 'dsh-bg-input-'));
const targetOut = join(workDir, 'target.json');
const coverOut = join(workDir, 'cover.json');

const target = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(PROJECT, 'test', 'helpers', 'background-target.ps1'),
	'-OutPath', targetOut, '-Title', 'BG-TARGET', '-Left', '200', '-Top', '140'], { stdio: 'ignore' });
// 遮挡 + 抢前台的窗口：置顶纯色窗口，放在靶窗口上方
const cover = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(PROJECT, 'test', 'helpers', 'paint-target.ps1'),
	'-OutPath', coverOut, '-Title', 'BG-COVER', '-Color', 'Cyan', '-Left', '160', '-Top', '110', '-Width', '660', '-Height', '420'], { stdio: 'ignore' });

const stop = (child) => {
	if (child.pid !== undefined) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
};

try {
	// 等靶窗口就绪（它每 150ms 刷一次 JSON）
	let state = null;
	for (let attempt = 0; attempt < 80; attempt += 1) {
		await sleep(200);
		if (existsSync(targetOut)) {
			try { state = JSON.parse(readFileSync(targetOut, 'utf8')); } catch { /* 半写状态 */ }
			if (state?.button) break;
		}
	}
	if (!state?.button) throw new Error('靶窗口未就绪');

	let coverHandle = null;
	for (let attempt = 0; attempt < 60 && coverHandle == null; attempt += 1) {
		await sleep(200);
		coverHandle = FindWindowW(null, 'BG-COVER');
	}
	if (coverHandle == null) throw new Error('遮挡窗口未出现');
	await sleep(1000);

	// 把前台交给遮挡窗口，靶窗口于是既不在前台又被盖住
	SetForegroundWindow(coverHandle);
	await sleep(800);

	const formHandle = BigInt(state.form);
	const buttonHandle = BigInt(state.button);
	const boxHandle = BigInt(state.box);
	console.log(`靶窗口 form=${formHandle} button=${buttonHandle} box=${boxHandle}`);
	console.log(`按钮类名 ${className(buttonHandle)}   文本框类名 ${className(boxHandle)}`);
	console.log(`前台是靶窗口: ${GetForegroundWindow() === formHandle ? '是（不符合预期）' : '否（符合预期）'}`);

	const readState = () => JSON.parse(readFileSync(targetOut, 'utf8'));
	const buttonRect = Buffer.alloc(16);
	GetClientRect(buttonHandle, buttonRect);
	const clickX = Math.round(buttonRect.readInt32LE(8) / 2);
	const clickY = Math.round(buttonRect.readInt32LE(12) / 2);
	const lParam = makeLParam(clickX, clickY);

	const cursorStart = cursorNow();
	console.log(`起始光标 (${cursorStart.x}, ${cursorStart.y})`);

	/** 每一步之后都记录前台归属，定位"是谁把前台抢走了"。 */
	const reportForeground = (label) => {
		const foreground = GetForegroundWindow();
		const who = foreground === formHandle ? '靶窗口（被抢走了）' : foreground === coverHandle ? '遮挡窗口（保持）' : `其它 ${foreground}`;
		console.log(`   前台: ${who}   [${label}]`);
	};
	reportForeground('起始');

	// ---- 1. PostMessage 模拟鼠标按下/抬起 -----------------------------------
	{
		const before = readState().clicks;
		PostMessageW(buttonHandle, WM_MOUSEMOVE, 0, lParam);
		PostMessageW(buttonHandle, WM_LBUTTONDOWN, MK_LBUTTON, lParam);
		PostMessageW(buttonHandle, WM_LBUTTONUP, 0, lParam);
		await sleep(600);
		const after = readState().clicks;
		console.log(`\n1. PostMessage WM_LBUTTONDOWN/UP（模拟鼠标）`);
		console.log(`   点击计数 ${before} → ${after}  ${after > before ? '成功' : '无效'}`);
		reportForeground('PostMessage 模拟鼠标');
	}

	// ---- 2. SendMessage 模拟鼠标按下/抬起 -----------------------------------
	{
		const before = readState().clicks;
		SendMessageW(buttonHandle, WM_MOUSEMOVE, 0, lParam);
		SendMessageW(buttonHandle, WM_LBUTTONDOWN, MK_LBUTTON, lParam);
		SendMessageW(buttonHandle, WM_LBUTTONUP, 0, lParam);
		await sleep(600);
		const after = readState().clicks;
		console.log(`\n2. SendMessage WM_LBUTTONDOWN/UP（同步投递模拟鼠标）`);
		console.log(`   点击计数 ${before} → ${after}  ${after > before ? '成功' : '无效'}`);
		reportForeground('SendMessage 模拟鼠标');
	}

	// ---- 3. BM_CLICK：标准按钮的"语义点击"消息 -------------------------------
	{
		const before = readState().clicks;
		const result = SendMessageW(buttonHandle, BM_CLICK, 0, 0);
		await sleep(600);
		const after = readState().clicks;
		console.log(`\n3. SendMessage BM_CLICK（按钮的语义点击消息，不涉及坐标）`);
		console.log(`   返回值=${result}  点击计数 ${before} → ${after}  ${after > before ? '成功' : '无效'}`);
		reportForeground('BM_CLICK');
	}

	// ---- 4. PostMessage WM_CHAR 往文本框打字 --------------------------------
	{
		const before = readState().text;
		for (const character of 'BG') {
			PostMessageW(boxHandle, WM_CHAR, character.charCodeAt(0), 0);
			await sleep(60);
		}
		await sleep(600);
		const after = readState().text;
		console.log(`\n4. PostMessage WM_CHAR 输入文本（文本框未获焦点）`);
		console.log(`   文本框 ${JSON.stringify(before)} → ${JSON.stringify(after)}  ${after.length > before.length ? '成功' : '无效'}`);
		reportForeground('WM_CHAR');
	}

	// ---- 5. WM_SETTEXT 直接设文本 -------------------------------------------
	{
		const before = readState().text;
		// WM_SETTEXT 的 lParam 是字符串指针，用 SendMessage 的宽字符重载
		const SendMessageStr = bind('intptr_t SendMessageW(void *hWnd, uint32 msg, intptr_t wParam, const char16_t *lParam)');
		const result = SendMessageStr(boxHandle, WM_SETTEXT, 0, 'VIA-WM-SETTEXT');
		await sleep(600);
		const after = readState().text;
		console.log(`\n5. SendMessage WM_SETTEXT 直接设文本`);
		console.log(`   返回值=${result}  文本框 ${JSON.stringify(before)} → ${JSON.stringify(after)}  ${after !== before ? '成功' : '无效'}`);
		reportForeground('WM_SETTEXT');
	}

	// ---- 6. UI Automation InvokePattern ------------------------------------
	{
		const before = readState().clicks;
		const uiaScript = join(PROJECT, 'test', 'helpers', 'click-uia.ps1');
		const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', uiaScript, '-Title', 'BG-TARGET', '-ButtonName', 'CLICK'], { encoding: 'utf8' });
		await sleep(600);
		const after = readState().clicks;
		console.log(`\n6. UI Automation InvokePattern（按名字寻址，不用坐标）`);
		console.log(`   探针: ${(result.stdout ?? '').trim().split('\n').at(-1) ?? '(无输出)'}`);
		console.log(`   点击计数 ${before} → ${after}  ${after > before ? '成功' : '无效'}`);
		reportForeground('UIA InvokePattern');
	}

	// ---- 7. UI Automation ValuePattern 直接写文本框 -------------------------
	{
		const before = readState().text;
		const uiaValue = join(PROJECT, 'test', 'helpers', 'setvalue-uia.ps1');
		const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', uiaValue, '-Title', 'BG-TARGET', '-Value', 'VIA-UIA-VALUE'], { encoding: 'utf8' });
		await sleep(600);
		const after = readState().text;
		console.log(`\n7. UI Automation ValuePattern 直接设值`);
		console.log(`   探针: ${(result.stdout ?? '').trim().split('\n').at(-1) ?? '(无输出)'}`);
		console.log(`   文本框 ${JSON.stringify(before)} → ${JSON.stringify(after)}  ${after !== before ? '成功' : '无效'}`);
		reportForeground('UIA ValuePattern');
	}

	const cursorEnd = cursorNow();
	console.log(`\n光标 (${cursorStart.x}, ${cursorStart.y}) → (${cursorEnd.x}, ${cursorEnd.y})  ${cursorStart.x === cursorEnd.x && cursorStart.y === cursorEnd.y ? '全程未被移动' : '被移动了'}`);
	console.log(`最终状态: ${JSON.stringify(readState())}`);
} finally {
	stop(target);
	stop(cover);
	await sleep(500);
	rmSync(workDir, { recursive: true, force: true });
	console.log('\n已清理（按 PID 精确终止）');
}
