/**
 * 在真实的 Chromium 窗口上重复点击投递对比。
 *
 * 为什么必须单独测：Chromium/Electron 不是普通 Win32 窗口，web 内容渲染在一个
 * 独立的子窗口里（Chrome_RenderWidgetHostHWND），而且浏览器常常按**真实光标位置**
 * 而不是消息里带的坐标做命中测试。所以"PostMessage 点击在 WinForms 上有效"这一条
 * 完全不能外推——而 DSH 自己就是 Electron，用户日常要点的也多是这类窗口。
 *
 * 做法：起一个自己的 Chrome 窗口（独立临时 profile，不碰用户的浏览数据），
 * 页面做成整屏一个大按钮并在被点时改 document.title，靠读窗口标题判断有没有点中。
 *
 * 安全性：只操作本脚本自己启动的 Chrome；结束后杀掉进程并清理临时目录。
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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireRealKoffi } from './real-koffi.mjs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
requireRealKoffi();

const koffi = await import('koffi');
const api = koffi.default ?? koffi;
const user32 = api.load('user32.dll');
const bind = (signature) => user32.func(signature);

const FindWindowW = bind('void *FindWindowW(const char16_t *cls, const char16_t *name)');
const FindWindowExW = bind('void *FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *name)');
const GetClassNameW = bind('int GetClassNameW(void *hWnd, _Out_ char16_t *buf, int max)');
const GetWindowTextW = bind('int GetWindowTextW(void *hWnd, _Out_ char16_t *buf, int max)');
const GetClientRect = bind('int GetClientRect(void *hWnd, _Out_ void *rect)');
const PostMessageW = bind('int PostMessageW(void *hWnd, uint32 msg, intptr_t wParam, intptr_t lParam)');
const SendMessageW = bind('int SendMessageW(void *hWnd, uint32 msg, intptr_t wParam, intptr_t lParam)');
const GetCursorPos = bind('int GetCursorPos(_Out_ void *point)');
const SetCursorPos = bind('int SetCursorPos(int x, int y)');
const SetForegroundWindow = bind('int SetForegroundWindow(void *hWnd)');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cursorNow = () => {
	const buffer = Buffer.alloc(8);
	GetCursorPos(buffer);
	return { x: buffer.readInt32LE(0), y: buffer.readInt32LE(4) };
};
const textOf = (handle, reader) => {
	const buffer = Buffer.alloc(1024);
	const written = reader(handle, buffer, 512);
	return written <= 0 ? '' : buffer.subarray(0, written * 2).toString('utf16le');
};
const classOf = (handle) => textOf(handle, GetClassNameW);
const titleOf = (handle) => textOf(handle, GetWindowTextW);

const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_MOUSEMOVE = 0x0200;
const MK_LBUTTON = 0x0001;
const makeLParam = (x, y) => ((y << 16) | (x & 0xffff)) | 0;

// 页面把**收到的每一个鼠标事件连同坐标**写进标题，而不是只报"命中了/没命中"。
// 二元信号在多轮对比里无法区分"事件没送到"与"送到了但落点不对"，实测就卡在这里：
// 连真实的 SendInput 点击都没触发，说明缺的是可观测性，不是结论。
//
// 标题格式：`<事件>-<x>x<y>#<序号>`，例如 `MD-663x331#1`。
// 页面加载后会先写 `READY`，作为"脚本已就绪"的基准。
const html = `<!doctype html><meta charset="utf-8"><title>CHROME-CLICK-PROBE</title>
<style>html,body{margin:0;height:100%;display:flex}button{flex:1;font-size:32px}</style>
<button id="l">LEFT</button><button id="r">RIGHT</button>
<script>
let n = 0;
const mark = (tag) => (e) => {
  n += 1;
  document.title = tag + '-' + Math.round(e.clientX) + 'x' + Math.round(e.clientY) + '#' + n;
};
document.addEventListener('mousemove', mark('MM'), true);
document.addEventListener('mousedown', mark('MD'), true);
document.addEventListener('mouseup', mark('MU'), true);
document.addEventListener('click', mark('CK'), true);
document.title = 'READY';
</script>`;

const workDir = mkdtempSync(join(tmpdir(), 'dsh-chrome-probe-'));
const pagePath = join(workDir, 'probe.html');
const profileDir = join(workDir, 'profile');
writeFileSync(pagePath, html, 'utf8');

const chrome = spawn(CHROME, [
	`--user-data-dir=${profileDir}`,
	'--no-first-run',
	'--no-default-browser-check',
	'--window-size=900,700',
	'--window-position=250,180',
	'--disable-features=Translate',
	// 用 --app 模式：窗口标题就是页面标题，不带 " - Google Chrome" 后缀，
	// 便于精确定位；也避免在用户已有的 Chrome 里开标签页
	`--app=file:///${pagePath.replaceAll('\\', '/')}`,
], { stdio: 'ignore', detached: false });

/**
 * 只终止本脚本自己启动的那个进程树。
 *
 * 之前踩过的坑：按可执行文件路径杀 chrome.exe 会把用户正在用的浏览器一起关掉。
 * 这里用 taskkill 的 /PID <自己的 pid> /T，作用域严格限制在本进程及其子进程。
 */
const stopChrome = () => {
	if (chrome.pid === undefined) return;
	spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
};

try {
	let top = null;
	for (let attempt = 0; attempt < 80 && top == null; attempt += 1) {
		await sleep(250);
		top = FindWindowW(null, 'CHROME-CLICK-PROBE');
	}
	if (top == null) throw new Error('Chrome 窗口未出现');
	console.log(`Chrome 顶层窗口 hwnd=${top}  title="${titleOf(top)}"`);
	await sleep(1500);

	// 必须先把窗口真正推到前台并**激活**，否则：
	//   - 合成的鼠标消息不会送到未激活的窗口
	//   - 真实点击的第一下只会激活窗口，不会传给页面内容（Windows 的防误触行为）
	// 之前三项全部"未触发"正是这个原因——是测试设置问题，不是点击方式的问题。
	const GetForegroundWindow = bind('void *GetForegroundWindow()');
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (GetForegroundWindow() === top) break;
		SetForegroundWindow(top);
		await sleep(250);
	}
	console.log(`前台窗口确认: ${GetForegroundWindow() === top ? '已获得焦点' : '未获得焦点（结果不可信）'}`);
	await sleep(500);

	// 找到渲染 web 内容的子窗口。
	// 必须取**面积最大**的那个：Chromium 会建若干辅助窗口，类名同样含
	// RenderWidgetHost 但客户区只有十几像素（之前就抓到过一个 12x10 的）。
	let render = null;
	{
		const candidates = [];
		const queue = [top];
		while (queue.length > 0) {
			const parent = queue.shift();
			let previous = null;
			for (let guard = 0; guard < 400; guard += 1) {
				const child = FindWindowExW(parent, previous, null, null);
				if (child == null || child === 0n) break;
				const cls = classOf(child);
				if (cls.toLowerCase().includes('renderwidgethost')) {
					const rect = Buffer.alloc(16);
					GetClientRect(child, rect);
					candidates.push({ child, w: rect.readInt32LE(8), h: rect.readInt32LE(12) });
				}
				queue.push(child);
				previous = child;
			}
		}
		candidates.sort((a, b) => b.w * b.h - a.w * a.h);
		render = candidates[0]?.child ?? null;
		console.log(`候选 render widget: ${candidates.map((c) => `${c.w}x${c.h}`).join(', ') || '(无)'}`);
	}
	const surface = render ?? top;
	console.log(`投递目标: ${surface === top ? '顶层窗口（未找到 render widget）' : `render widget=${surface}`}`);

	const clientRect = Buffer.alloc(16);
	GetClientRect(surface, clientRect);
	const width = clientRect.readInt32LE(8);
	const height = clientRect.readInt32LE(12);
	// 点在客户区 75% 宽度处 —— 落在右半边的 RIGHT 按钮上
	const clientX = Math.round(width * 0.75);
	const clientY = Math.round(height / 2);
	const lParam = makeLParam(clientX, clientY);
	console.log(`客户区 ${width}x${height}，点击点 (${clientX}, ${clientY}) 应命中右半边`);

	/** 读标题里页面记录的最后一个鼠标事件。 */
	const outcome = () => titleOf(top);
	const expected = `MD-${clientX}x${clientY}`;

	// ---- B. PostMessage（按惯例先补一个 WM_MOUSEMOVE，让命中测试先更新） ----
	{
		const saved = cursorNow();
		PostMessageW(surface, WM_MOUSEMOVE, 0, lParam);
		PostMessageW(surface, WM_LBUTTONDOWN, MK_LBUTTON, lParam);
		PostMessageW(surface, WM_LBUTTONUP, 0, lParam);
		await sleep(700);
		const title = outcome();
		const cursorAfter = cursorNow();
		console.log(`\nB. PostMessage`);
		console.log(`   页面记录: ${title}${title.includes(expected) ? '  ← 收到了预期坐标的 mousedown' : ''}`);
		console.log(`   光标 ${saved.x},${saved.y} → ${cursorAfter.x},${cursorAfter.y}  ${cursorAfter.x === saved.x && cursorAfter.y === saved.y ? '未移动' : '被移动'}`);
	}

	// ---- C. SendMessage ----
	{
		const saved = cursorNow();
		SendMessageW(surface, WM_MOUSEMOVE, 0, lParam);
		SendMessageW(surface, WM_LBUTTONDOWN, MK_LBUTTON, lParam);
		SendMessageW(surface, WM_LBUTTONUP, 0, lParam);
		await sleep(700);
		const title = outcome();
		const cursorAfter = cursorNow();
		console.log(`\nC. SendMessage`);
		console.log(`   页面记录: ${title}${title.includes(expected) ? '  ← 收到了预期坐标的 mousedown' : ''}`);
		console.log(`   光标 ${saved.x},${saved.y} → ${cursorAfter.x},${cursorAfter.y}  ${cursorAfter.x === saved.x && cursorAfter.y === saved.y ? '未移动' : '被移动'}`);
	}

	// ---- A. SendInput 真实点击（对照组：证明页面本身可点、且坐标换算正确） ----
	{
		const saved = cursorNow();
		const before = outcome();
		const origin = Buffer.alloc(16);
		const GetWindowRect = bind('int GetWindowRect(void *hWnd, _Out_ void *rect)');
		GetWindowRect(surface, origin);
		const screenX = origin.readInt32LE(0) + clientX;
		const screenY = origin.readInt32LE(4) + clientY;
		console.log(`\nA. SendInput（对照）目标屏幕坐标 (${screenX}, ${screenY})`);

		SetCursorPos(screenX, screenY);
		await sleep(200);
		// 复用插件实现的点击，确保测的是同一套代码
		const { click, MOUSE_BUTTONS } = await import('../lib/input.js');
		const { loadWin32 } = await import('../lib/win32.js');
		const win32 = await loadWin32();
		await click(win32, MOUSE_BUTTONS.left, 1, undefined, 60);
		await sleep(800);
		const after = outcome();
		const cursorAfter = cursorNow();
		console.log(`   页面记录: ${after}   （点击前为 ${before}）`);
		console.log(`   光标 ${saved.x},${saved.y} → (${cursorAfter.x},${cursorAfter.y})  ${cursorAfter.x === saved.x && cursorAfter.y === saved.y ? '未移动' : '被移动'}`);
		SetCursorPos(saved.x, saved.y);
	}
	console.log(`\n页面最终状态: title="${titleOf(top)}"`);
} finally {
	stopChrome();
	await sleep(800);
	rmSync(workDir, { recursive: true, force: true });
	console.log('已清理临时 profile 与页面');
}
