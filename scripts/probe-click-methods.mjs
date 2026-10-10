/**
 * 对比三种点击投递方式，重点回答：**哪种不接管用户鼠标**。
 *
 * A. SendInput —— 当前实现用的方式。必须把光标移过去，物理接管。
 * B. PostMessage/SendMessage 投递 WM_LBUTTONDOWN/UP —— 直接给目标窗口发消息，
 *    光标完全不动。
 * C. 只对 WinForms 类控件成立，所以这里只作为"光标未动"的对照，不构成完整结论。
 *
 * UI Automation 的 InvokePattern 需要 .NET 侧的程序集，由 click-uia.ps1 单独探。
 *
 * 安全性：全部打在探针自己启动的置顶靶窗口上，不触碰桌面上的其它窗口。
 */
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

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireRealKoffi } from './real-koffi.mjs';

// 用宿主安装里的真实 koffi；替身会按这个环境变量委派过去
const REAL_KOFFI = requireRealKoffi();
process.env.DSH_COMPUTER_USE_REAL_KOFFI = REAL_KOFFI;

const koffi = (await import('koffi')).default ?? (await import('koffi'));
const user32 = koffi.load('user32.dll');
const bind = (signature) => user32.func(signature);

const FindWindowW = bind('void *FindWindowW(const char16_t *cls, const char16_t *name)');
const FindWindowExW = bind('void *FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *name)');
const GetClassNameW = bind('int GetClassNameW(void *hWnd, _Out_ char16_t *buf, int max)');
const PostMessageW = bind('int PostMessageW(void *hWnd, uint32 msg, intptr_t wParam, intptr_t lParam)');
const SendMessageW = bind('int SendMessageW(void *hWnd, uint32 msg, intptr_t wParam, intptr_t lParam)');
const GetCursorPos = bind('int GetCursorPos(_Out_ void *point)');
const SetCursorPos = bind('int SetCursorPos(int x, int y)');
const SendInput = bind('uint32 SendInput(uint32 count, _In_ void *inputs, int size)');
const koffiStruct = koffi.struct;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 本文件在 scripts/ 下，项目根是它的上一级
const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const TITLE = 'DSH-CLICK-PROBE';
const SCRIPT = join(PROJECT, 'test', 'helpers', 'click-target.ps1');
const RESULT = join(PROJECT, 'test', 'helpers', 'click-result.json');

const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const MK_LBUTTON = 0x0001;

const readState = () => (existsSync(RESULT) ? JSON.parse(readFileSync(RESULT, 'utf8')) : null);
const cursorNow = () => {
	// koffi 只在参数声明为结构体时才编组 JS 对象；声明成 void* 就必须传 Buffer
	const buffer = Buffer.alloc(8);
	GetCursorPos(buffer);
	return { x: buffer.readInt32LE(0), y: buffer.readInt32LE(4) };
};
const className = (handle) => {
	const buffer = Buffer.alloc(512);
	const written = GetClassNameW(handle, buffer, 256);
	return written <= 0 ? '' : buffer.subarray(0, written * 2).toString('utf16le');
};

/** 合成的 lParam：低 16 位 x，高 16 位 y（目标窗口的客户区坐标）。 */
const makeLParam = (x, y) => ((y << 16) | (x & 0xffff)) | 0;

if (existsSync(RESULT)) unlinkSync(RESULT);
const target = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-OutPath', RESULT, '-Title', TITLE], { stdio: 'ignore' });

try {
	let form = null;
	for (let attempt = 0; attempt < 80 && form == null; attempt += 1) {
		await sleep(250);
		form = FindWindowW(null, TITLE);
	}
	if (form == null) throw new Error('靶窗口未出现');
	await sleep(1200);

	// 找到窗体里的按钮子窗口
	let button = null;
	let previous = null;
	const seen = [];
	for (let guard = 0; guard < 200; guard += 1) {
		const child = FindWindowExW(form, previous, null, null);
		if (child == null || child === 0n) break;
		const cls = className(child);
		seen.push(`${child}:${cls}`);
		// WinForms 的类名是混写的（WindowsForms10.Button.app.0.…），不能按全大写比
		if (cls.toLowerCase().includes('button')) { button = child; break; }
		previous = child;
	}
	if (button == null) throw new Error(`没找到按钮子窗口；实际枚举到 ${seen.length} 个子窗口: ${seen.join(' | ')}`);
	console.log(`靶窗口 form=${form}  button=${button}  class=${className(button)}`);

	const state = readState();
	const { width, height } = state.button;
	const clientX = Math.round(width / 2);
	const clientY = Math.round(height / 2);
	const lParam = makeLParam(clientX, clientY);

	// ---- A. SendInput：必须移动光标 ----------------------------------------
	{
		const before = readState().clicks;
		const saved = cursorNow();

		// 用真实 API 走一遍：移动光标 + 合成点击
		SetCursorPos(state.button.screenX + clientX, state.button.screenY + clientY);
		await sleep(120);

		// 复用插件的输入实现，确保测的是同一套代码
		const { click, MOUSE_BUTTONS } = await import('../lib/input.js');
		const { loadWin32 } = await import('../lib/win32.js');
		const win32 = await loadWin32();
		await click(win32, MOUSE_BUTTONS.left, 1, undefined, 60);
		await sleep(300);

		const after = readState().clicks;
		const cursorAfter = cursorNow();
		const moved = cursorAfter.x !== saved.x || cursorAfter.y !== saved.y;
		console.log(`\nA. SendInput 点击`);
		console.log(`   按钮点击 ${before} → ${after}  ${after > before ? '已触发' : '未触发'}`);
		console.log(`   光标 (${saved.x},${saved.y}) → (${cursorAfter.x},${cursorAfter.y})  ${moved ? '被移动' : '未移动'}`);
		SetCursorPos(saved.x, saved.y);
	}

	// ---- B. PostMessage：不碰光标 ------------------------------------------
	{
		const before = readState().clicks;
		const saved = cursorNow();

		PostMessageW(button, WM_LBUTTONDOWN, MK_LBUTTON, lParam);
		PostMessageW(button, WM_LBUTTONUP, 0, lParam);
		await sleep(400);

		const after = readState().clicks;
		const cursorAfter = cursorNow();
		const moved = cursorAfter.x !== saved.x || cursorAfter.y !== saved.y;
		console.log(`\nB. PostMessage WM_LBUTTONDOWN/UP`);
		console.log(`   按钮点击 ${before} → ${after}  ${after > before ? '已触发' : '未触发'}`);
		console.log(`   光标 (${saved.x},${saved.y}) → (${cursorAfter.x},${cursorAfter.y})  ${moved ? '被移动' : '未移动'}`);
	}

	// ---- C. SendMessage（同步投递） ----------------------------------------
	{
		const before = readState().clicks;
		const saved = cursorNow();

		SendMessageW(button, WM_LBUTTONDOWN, MK_LBUTTON, lParam);
		SendMessageW(button, WM_LBUTTONUP, 0, lParam);
		await sleep(400);

		const after = readState().clicks;
		const cursorAfter = cursorNow();
		const moved = cursorAfter.x !== saved.x || cursorAfter.y !== saved.y;
		console.log(`\nC. SendMessage WM_LBUTTONDOWN/UP`);
		console.log(`   按钮点击 ${before} → ${after}  ${after > before ? '已触发' : '未触发'}`);
		console.log(`   光标 (${saved.x},${saved.y}) → (${cursorAfter.x},${cursorAfter.y})  ${moved ? '被移动' : '未移动'}`);
	}

	// ---- D. UI Automation（.NET 侧，单独进程） -----------------------------
	{
		const before = readState().clicks;
		const saved = cursorNow();
		const uiaScript = join(PROJECT, 'test', 'helpers', 'click-uia.ps1');
		const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', uiaScript, '-Title', TITLE, '-ButtonName', 'TARGET'], { encoding: 'utf8' });
		await sleep(400);

		const after = readState().clicks;
		const cursorAfter = cursorNow();
		const moved = cursorAfter.x !== saved.x || cursorAfter.y !== saved.y;
		console.log(`\nD. UI Automation InvokePattern`);
		console.log(`   探针输出: ${(result.stdout ?? '').trim().split('\n').at(-1) ?? '(无)'}`);
		console.log(`   按钮点击 ${before} → ${after}  ${after > before ? '已触发' : '未触发'}`);
		console.log(`   光标 (${saved.x},${saved.y}) → (${cursorAfter.x},${cursorAfter.y})  ${moved ? '被移动' : '未移动'}`);
	}
} finally {
	target.kill();
	await sleep(300);
}
