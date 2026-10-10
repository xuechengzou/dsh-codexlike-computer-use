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
 * 最后一个未知数：**往不在前台的 Chromium/Electron 窗口点击与打字，能不能生效。**
 *
 * 前几轮attempts全被 Windows 的前台锁毁掉了——`SetForegroundWindow` 从后台进程
 * 调用会被拒绝，于是窗口既没到前台也没露出来，对照组失效，结论自相矛盾。
 *
 * 这一轮换了观察通道：既然已验证 `PrintWindow + PW_RENDERFULLCONTENT` 能抓到
 * 非前台 Electron 窗口的真实内容，就不再需要把窗口推到前台——
 * 用 PrintWindow 当眼睛，页面把收到的事件写进 `document.title` 当计数器。
 * 于是"窗口全程不在前台、光标全程不动"这个前提从一开始就成立。
 *
 * 页面标题格式：`L<宽>x<高>|<最近事件>`，例如 `L804x612|MD-402x306#1`。
 * 初始为 `L<宽>x<高>|none`，因此标题不变就等于"页面一个事件都没收到"。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireRealKoffi } from './real-koffi.mjs';

requireRealKoffi();

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const koffi = await import('koffi');
const api = koffi.default ?? koffi;
const user32 = api.load('user32.dll');
const gdi32 = api.load('gdi32.dll');
const bind = (lib, signature) => lib.func(signature);

const GetDC = bind(user32, 'void *GetDC(void *hWnd)');
const ReleaseDC = bind(user32, 'int ReleaseDC(void *hWnd, void *hDC)');
const GetWindowRect = bind(user32, 'int GetWindowRect(void *hWnd, _Out_ void *rect)');
const GetClientRect = bind(user32, 'int GetClientRect(void *hWnd, _Out_ void *rect)');
const PrintWindow = bind(user32, 'int PrintWindow(void *hWnd, void *hdcBlt, uint32 nFlags)');
const FindWindowW = bind(user32, 'void *FindWindowW(const char16_t *cls, const char16_t *name)');
const FindWindowExW = bind(user32, 'void *FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *name)');
const GetClassNameW = bind(user32, 'int GetClassNameW(void *hWnd, _Out_ char16_t *buf, int max)');
const GetWindowTextW = bind(user32, 'int GetWindowTextW(void *hWnd, _Out_ char16_t *buf, int max)');
const GetForegroundWindow = bind(user32, 'void *GetForegroundWindow()');
const GetCursorPos = bind(user32, 'int GetCursorPos(_Out_ void *point)');
const PostMessageW = bind(user32, 'int PostMessageW(void *hWnd, uint32 msg, intptr_t wParam, intptr_t lParam)');
const SendMessageW = bind(user32, 'int SendMessageW(void *hWnd, uint32 msg, intptr_t wParam, intptr_t lParam)');

const CreateCompatibleDC = bind(gdi32, 'void *CreateCompatibleDC(void *hdc)');
const CreateCompatibleBitmap = bind(gdi32, 'void *CreateCompatibleBitmap(void *hdc, int cx, int cy)');
const SelectObject = bind(gdi32, 'void *SelectObject(void *hdc, void *h)');
const GetDIBits = bind(gdi32, 'int GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, _Out_ void *bits, _Inout_ void *info, uint32 usage)');
const BitBlt = bind(gdi32, 'int BitBlt(void *hdc, int x, int y, int cx, int cy, void *src, int x1, int y1, uint32 rop)');
const SRCCOPY = 0x00cc0020;
const DeleteObject = bind(gdi32, 'int DeleteObject(void *h)');
const DeleteDC = bind(gdi32, 'int DeleteDC(void *hdc)');
const CreateSolidBrush = bind(gdi32, 'void *CreateSolidBrush(uint32 color)');
const FillRect = bind(user32, 'int FillRect(void *hdc, _In_ void *rect, void *brush)');

const PW_RENDERFULLCONTENT = 0x00000002;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_MOUSEMOVE = 0x0200;
const WM_CHAR = 0x0102;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const MK_LBUTTON = 0x0001;
const VK_A = 0x41;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const GetTopWindow = bind(user32, 'void *GetTopWindow(void *hWnd)');
const GetWindow = bind(user32, 'void *GetWindow(void *hWnd, uint32 cmd)');
const GetWindowThreadProcessId = bind(user32, 'uint32 GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *pid)');
const IsWindowVisible = bind(user32, 'int IsWindowVisible(void *hWnd)');
const GW_HWNDNEXT = 2;

/**
 * 按进程 id 找该进程的顶层可见窗口。
 *
 * 比"按标题找"可靠得多：本页面的脚本一加载就会改写 `document.title`，
 * 按固定标题根本找不到窗口。按 PID 找同时也更安全——只会命中本脚本自己
 * 启动的那个进程，不会碰到用户已经开着的浏览器。
 */
function findWindowByPid(pid) {
	const found = [];
	let handle = GetTopWindow(null);
	for (let guard = 0; guard < 3000 && handle != null && handle !== 0n; guard += 1) {
		const pidSlot = Buffer.alloc(4);
		GetWindowThreadProcessId(handle, pidSlot);
		if (pidSlot.readUInt32LE(0) === pid && IsWindowVisible(handle) !== 0) {
			const rect = Buffer.alloc(16);
			GetWindowRect(handle, rect);
			if (rect.readInt32LE(8) - rect.readInt32LE(0) >= 400) found.push(handle);
		}
		handle = GetWindow(handle, GW_HWNDNEXT);
	}
	return found;
}
const className = (handle) => {
	const buffer = Buffer.alloc(512);
	const written = GetClassNameW(handle, buffer, 256);
	return written <= 0 ? '' : buffer.subarray(0, written * 2).toString('utf16le');
};
const titleOf = (handle) => {
	const buffer = Buffer.alloc(1024);
	const written = GetWindowTextW(handle, buffer, 512);
	return written <= 0 ? '' : buffer.subarray(0, written * 2).toString('utf16le');
};
const cursorNow = () => {
	const buffer = Buffer.alloc(8);
	GetCursorPos(buffer);
	return { x: buffer.readInt32LE(0), y: buffer.readInt32LE(4) };
};
const makeLParam = (x, y) => ((y << 16) | (x & 0xffff)) | 0;

function readBitmap(memDc, bitmap, w, h) {
	const header = Buffer.alloc(40);
	header.writeUInt32LE(40, 0);
	header.writeInt32LE(w, 4);
	header.writeInt32LE(-h, 8);
	header.writeUInt16LE(1, 12);
	header.writeUInt16LE(32, 14);
	header.writeUInt32LE(0, 16);
	header.writeUInt32LE(w * h * 4, 20);
	const pixels = Buffer.alloc(w * h * 4);
	GetDIBits(memDc, bitmap, 0, h, pixels, header, 0);
	return pixels;
}

/** 屏幕位图：窗口可见时用它做对照。 */
function captureScreen(x, y, w, h) {
	const screenDc = GetDC(null);
	const memDc = CreateCompatibleDC(screenDc);
	const bitmap = CreateCompatibleBitmap(screenDc, w, h);
	const previous = SelectObject(memDc, bitmap);
	try {
		BitBlt(memDc, 0, 0, w, h, screenDc, x, y, SRCCOPY);
		return readBitmap(memDc, bitmap, w, h);
	} finally {
		SelectObject(memDc, previous);
		DeleteObject(bitmap);
		DeleteDC(memDc);
		ReleaseDC(null, screenDc);
	}
}

/** 从标题里取出事件序号（形如 L684x481|CK#4 → 4）；没有则 0。 */
function eventCount(title) {
	const match = /#(\d+)/u.exec(title);
	return match === null ? 0 : Number(match[1]);
}

function captureWindow(handle, w, h) {
	const screenDc = GetDC(null);
	const memDc = CreateCompatibleDC(screenDc);
	const bitmap = CreateCompatibleBitmap(screenDc, w, h);
	const previous = SelectObject(memDc, bitmap);
	try {
		const white = CreateSolidBrush(0x00ffffff);
		const rect = Buffer.alloc(16);
		rect.writeInt32LE(0, 0); rect.writeInt32LE(0, 4); rect.writeInt32LE(w, 8); rect.writeInt32LE(h, 12);
		FillRect(memDc, rect, white);
		DeleteObject(white);
		PrintWindow(handle, memDc, PW_RENDERFULLCONTENT);
		return readBitmap(memDc, bitmap, w, h);
	} finally {
		SelectObject(memDc, previous);
		DeleteObject(bitmap);
		DeleteDC(memDc);
		ReleaseDC(null, screenDc);
	}
}

/** 统计品红占比，用来确认页面确实渲染了内容。 */
function magentaRatio(bgra) {
	let magenta = 0;
	const total = bgra.length / 4;
	for (let i = 0; i < bgra.length; i += 4) {
		if (bgra[i + 2] > 200 && bgra[i + 1] < 60 && bgra[i] > 200) magenta += 1;
	}
	return (magenta / total) * 100;
}

const pagePath = join(mkdtempSync(join(tmpdir(), 'dsh-cr-bg-')), 'page.html');
const workDir = join(pagePath, '..');
writeFileSync(pagePath, `<!doctype html><meta charset="utf-8"><title>CR-BG-TARGET</title>
<style>html,body{margin:0;height:100%;background:#ff00ff}
textarea{position:absolute;left:20px;top:20px;width:60%;height:40%;font:20px Consolas}</style>
<textarea id="t" placeholder="type here"></textarea>
<script>
let n = 0;
let last = 'none';
const size = () => innerWidth + 'x' + innerHeight;
// 把"最有信息量的那一条"保留在标题里：mousedown 的坐标、按键的键名。
// 否则 click 会在 mouseup 之后把坐标覆盖掉，测试就丢了"点在哪里"这个关键事实。
const mark = (tag) => (e) => {
  n += 1;
  if (tag === 'MD') last = 'MD-' + Math.round(e.clientX) + 'x' + Math.round(e.clientY);
  if (tag === 'KD') last = 'KD-' + e.key;
  document.title = 'L' + size() + '|' + last + '#' + n;
};
document.addEventListener('mousemove', mark('MM'), true);
document.addEventListener('mousedown', mark('MD'), true);
document.addEventListener('mouseup', mark('MU'), true);
document.addEventListener('click', mark('CK'), true);
document.addEventListener('keydown', mark('KD'), true);
document.title = 'L' + size() + '|none#0';
document.getElementById('t').focus();
</script>`, 'utf8');

const chrome = spawn(CHROME, [
	`--user-data-dir=${join(workDir, 'profile')}`,
	'--no-first-run', '--no-default-browser-check',
	'--window-size=840,640', '--window-position=260,180',
	`--app=file:///${pagePath.replaceAll('\\', '/')}`,
], { stdio: 'ignore' });

const stop = (child) => {
	if (child.pid !== undefined) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
};

try {
	let top = null;
	for (let attempt = 0; attempt < 80 && top == null; attempt += 1) {
		await sleep(250);
		if (chrome.pid === undefined) break;
		top = findWindowByPid(chrome.pid)[0] ?? null;
	}
	if (top == null) throw new Error(`Chrome 窗口未出现（pid=${chrome.pid}）`);
	await sleep(1500);

	// 关键一步：把窗口置顶但**不激活**。
	//
	// 上一轮揭示真正影响 PrintWindow 的不是"前台/后台"，而是"**是否被遮挡**"：
	// 被完全盖住的 Chromium 窗口会停止产出帧，连它自己都交不出内容。
	// 而 DSH 窗口那次成功，恰恰因为它可见、只是不在前台。
	//
	// 所以这里用 SetWindowPos(HWND_TOPMOST) + SWP_NOACTIVATE 精确制造
	// "可见但不获得焦点"这一条件。**不能用 SetForegroundWindow**——那会抢走
	// 前台，测的就不是"后台"了；而且它本来也会被系统的前台锁拒绝。
	const SetWindowPos = bind(user32, 'int SetWindowPos(void *hWnd, void *after, int x, int y, int cx, int cy, uint32 flags)');
	const SWP_NOACTIVATE = 0x0010;
	// 放左上角、尺寸略小，尽量少挡住用户正在看的东西
	SetWindowPos(top, -1n, 60, 60, 700, 520, SWP_NOACTIVATE);
	await sleep(2200);

	const foregroundBefore = GetForegroundWindow();
	const cursorStart = cursorNow();
	console.log(`Chrome 顶层 hwnd=${top}  标题="${titleOf(top)}"`);
	console.log(`前台是否 Chrome: ${foregroundBefore === top ? '是（不符合前提）' : '否（符合"不在前台"前提）'}`);
	console.log(`起始光标 (${cursorStart.x}, ${cursorStart.y})`);

	const rect = Buffer.alloc(16);
	GetWindowRect(top, rect);
	const left = rect.readInt32LE(0); const topY = rect.readInt32LE(4);
	const w = rect.readInt32LE(8) - left; const h = rect.readInt32LE(12) - topY;
	console.log(`窗口矩形 ${w}x${h} @ (${left},${topY})`);

	// ---- 对照 1：屏幕位图。窗口现在是置顶可见的，这一路必须抓到品红 -------------
	// 上一版少了这个对照：当时窗口被完全遮挡，PrintWindow 拿不到任何东西，
	// 我因此误判"页面没渲染"。而真正的原因是 Chromium 对完全被遮挡的窗口
	// 会停止产出帧。先确认屏幕上真的看得见品红，后面的判断才有基准。
	const screenPixels = captureScreen(left, topY, w, h);
	const screenMagenta = magentaRatio(screenPixels);
	console.log(`\n对照 1：屏幕位图品红占比 ${screenMagenta.toFixed(1)}%  ${screenMagenta > 20 ? '（页面已渲染且可见）' : '（屏幕上没看到品红，后面测量无意义）'}`);

	// 找出面积最大的 Chromium 内容子窗口
	const surfaces = [{ handle: top, w, h, cls: className(top) }];
	{
		const queue = [top];
		while (queue.length > 0 && surfaces.length < 12) {
			const parent = queue.shift();
			let previous = null;
			for (let guard = 0; guard < 400; guard += 1) {
				const child = FindWindowExW(parent, previous, null, null);
				if (child == null || child === 0n) break;
				const cr = Buffer.alloc(16);
				GetClientRect(child, cr);
				const cw = cr.readInt32LE(8); const chh = cr.readInt32LE(12);
				if (cw >= 200 && chh >= 200) surfaces.push({ handle: child, w: cw, h: chh, cls: className(child) });
				queue.push(child);
				previous = child;
			}
		}
	}
	console.log(`\n可投递的表面：`);
	for (const s of surfaces) console.log(`  ${s.handle} ${String(s.w).padStart(4)}x${String(s.h).padEnd(4)} ${s.cls}`);

	// ---- 对照 2：PrintWindow 对每个表面各抓一次 -------------------------------
	console.log(`\n对照 2：PrintWindow + PW_RENDERFULLCONTENT 对各表面`);
	for (const surface of surfaces) {
		const pixels = captureWindow(surface.handle, surface.w, surface.h);
		console.log(`  ${String(surface.w).padStart(4)}x${String(surface.h).padEnd(4)} ${surface.cls.slice(0, 32).padEnd(32)} 品红 ${magentaRatio(pixels).toFixed(1)}%`);
	}

	/** 读页面事件计数（标题形如 L684x481|CK#4）。 */
	const readEvent = () => titleOf(top);

	// ---- 1. PostMessage 鼠标点击：逐表面独立测 ------------------------------
	// 每个表面点在与它不同的相对位置上，于是可以从页面回报的坐标反推出
	// 究竟是哪个表面把消息转成了 DOM 事件——混在一起测是分不清的。
	console.log(`\n1. PostMessage 点击（逐表面独立，坐标各不相同）`);
	for (let index = 0; index < surfaces.length; index += 1) {
		const surface = surfaces[index];
		const before = readEvent();
		// 依次取 25% / 45% / 65% 宽度，纵向都取 50%
		const cx = Math.round(surface.w * (0.25 + index * 0.2));
		const cy = Math.round(surface.h * 0.5);
		const lp = makeLParam(cx, cy);
		PostMessageW(surface.handle, WM_MOUSEMOVE, 0, lp);
		PostMessageW(surface.handle, WM_LBUTTONDOWN, MK_LBUTTON, lp);
		PostMessageW(surface.handle, WM_LBUTTONUP, 0, lp);
		await sleep(600);
		const after = readEvent();
		const gained = eventCount(after) > eventCount(before);
		console.log(`   [${index}] ${String(surface.w).padStart(4)}x${String(surface.h).padEnd(4)} ${surface.cls.slice(0, 30).padEnd(30)} 投递(${cx},${cy})`);
		console.log(`       ${before} → ${after}   ${gained ? `✓ 收到（页面记录的坐标 ${(/MD-(\d+x\d+)/u.exec(after) ?? [])[1] ?? '?'}）` : '✗ 未收到'}`);
	}

	// ---- 2. SendMessage 鼠标点击 -------------------------------------------
	{
		const before = readEvent();
		const surface = surfaces.find((s) => s.cls.includes('RenderWidgetHost')) ?? surfaces[1] ?? surfaces[0];
		const cx = Math.round(surface.w * 0.75);
		const cy = Math.round(surface.h * 0.5);
		const lp = makeLParam(cx, cy);
		SendMessageW(surface.handle, WM_MOUSEMOVE, 0, lp);
		SendMessageW(surface.handle, WM_LBUTTONDOWN, MK_LBUTTON, lp);
		SendMessageW(surface.handle, WM_LBUTTONUP, 0, lp);
		await sleep(800);
		const after = readEvent();
		console.log(`\n2. SendMessage 点击 ${surface.cls}`);
		console.log(`   ${before}  →  ${after}   ${after !== before && after.includes('MD') ? '页面收到了鼠标按下' : '页面未收到鼠标事件'}`);
	}

	// ---- 3. PostMessage 键盘 ----------------------------------------------
	{
		const before = readEvent();
		const surface = surfaces[1] ?? surfaces[0];
		PostMessageW(surface.handle, WM_KEYDOWN, VK_A, 0);
		PostMessageW(surface.handle, WM_CHAR, 'x'.charCodeAt(0), 0);
		PostMessageW(surface.handle, WM_KEYUP, VK_A, 0);
		await sleep(800);
		const after = readEvent();
		console.log(`\n3. PostMessage 键盘（WM_KEYDOWN/CHAR/KEYUP）`);
		console.log(`   ${before}  →  ${after}   ${after.includes('KD') || after.includes('IN-len') ? '页面收到了按键' : '页面未收到按键'}`);
	}

	const cursorEnd = cursorNow();
	const foregroundAfter = GetForegroundWindow();
	console.log(`\n光标 (${cursorStart.x}, ${cursorStart.y}) → (${cursorEnd.x}, ${cursorEnd.y})  ${cursorStart.x === cursorEnd.x && cursorStart.y === cursorEnd.y ? '全程未被移动' : '被移动了'}`);
	console.log(`前台 ${foregroundBefore === top ? '仍' : '始'}不是 Chrome；结束时前台 ${foregroundAfter === top ? '变成了 Chrome（被抢走）' : '仍不是 Chrome（未被抢走）'}`);
} finally {
	stop(chrome);
	await sleep(600);
	rmSync(workDir, { recursive: true, force: true });
	console.log('\n已清理（按 PID 精确终止）');
}
