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
 * 严格版 Chromium 窗口结构 + PrintWindow 测量。
 *
 * 上一版结论自相矛盾（只找到 12x10 的渲染子窗口，却在前台时找到过 884x661），
 * 说明**我连目标表面都没认准**，任何"能/不能"的结论都站不住。所以这一版先立对照：
 *
 *   对照 A：Chrome 可见且在前台时，屏幕位图必须能抓到品红。
 *           —— 抓不到就说明页面根本没渲染，后面所有测量都无意义。
 *   对照 B：把完整子窗口树（类名/客户区尺寸/可见性）打出来，
 *           确认内容表面到底叫什么、有多大。
 *
 * 然后分别对"可见且前台"与"被遮挡且非前台"两种状态做 PrintWindow，
 * 才能把"PrintWindow 行不行"与"我找错窗口了"区分开。
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
const SetForegroundWindow = bind(user32, 'int SetForegroundWindow(void *hWnd)');
const GetForegroundWindow = bind(user32, 'void *GetForegroundWindow()');
const FindWindowW = bind(user32, 'void *FindWindowW(const char16_t *cls, const char16_t *name)');
const FindWindowExW = bind(user32, 'void *FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *name)');
const GetClassNameW = bind(user32, 'int GetClassNameW(void *hWnd, _Out_ char16_t *buf, int max)');
const IsWindowVisible = bind(user32, 'int IsWindowVisible(void *hWnd)');

const CreateCompatibleDC = bind(gdi32, 'void *CreateCompatibleDC(void *hdc)');
const CreateCompatibleBitmap = bind(gdi32, 'void *CreateCompatibleBitmap(void *hdc, int cx, int cy)');
const SelectObject = bind(gdi32, 'void *SelectObject(void *hdc, void *h)');
const BitBlt = bind(gdi32, 'int BitBlt(void *hdc, int x, int y, int cx, int cy, void *src, int x1, int y1, uint32 rop)');
const GetDIBits = bind(gdi32, 'int GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, _Out_ void *bits, _Inout_ void *info, uint32 usage)');
const DeleteObject = bind(gdi32, 'int DeleteObject(void *h)');
const DeleteDC = bind(gdi32, 'int DeleteDC(void *hdc)');
const CreateSolidBrush = bind(gdi32, 'void *CreateSolidBrush(uint32 color)');
const FillRect = bind(user32, 'int FillRect(void *hdc, _In_ void *rect, void *brush)');

const SRCCOPY = 0x00cc0020;
const PW_RENDERFULLCONTENT = 0x00000002;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROJECT = fileURLToPath(new URL('..', import.meta.url));

const className = (handle) => {
	const buffer = Buffer.alloc(512);
	const written = GetClassNameW(handle, buffer, 256);
	return written <= 0 ? '' : buffer.subarray(0, written * 2).toString('utf16le');
};

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

function captureWindow(handle, w, h, flags) {
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
		const ok = PrintWindow(handle, memDc, flags);
		return { ok, pixels: readBitmap(memDc, bitmap, w, h) };
	} finally {
		SelectObject(memDc, previous);
		DeleteObject(bitmap);
		DeleteDC(memDc);
		ReleaseDC(null, screenDc);
	}
}

function analyze(bgra) {
	const total = bgra.length / 4;
	let magenta = 0; let black = 0; let white = 0; let other = 0;
	for (let i = 0; i < bgra.length; i += 4) {
		const b = bgra[i]; const g = bgra[i + 1]; const r = bgra[i + 2];
		if (r > 200 && g < 60 && b > 200) magenta += 1;
		else if (r < 20 && g < 20 && b < 20) black += 1;
		else if (r > 235 && g > 235 && b > 235) white += 1;
		else other += 1;
	}
	const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
	return { magenta: pct(magenta), black: pct(black), white: pct(white), other: pct(other) };
}

/** 递归打印子窗口树，标注类名、客户区尺寸与可见性。 */
function dumpTree(root, label) {
	console.log(`\n--- 子窗口树（${label}）---`);
	let count = 0;
	const walk = (parent, depth) => {
		let previous = null;
		for (let guard = 0; guard < 500; guard += 1) {
			const child = FindWindowExW(parent, previous, null, null);
			if (child == null || child === 0n) break;
			const cr = Buffer.alloc(16);
			GetClientRect(child, cr);
			const w = cr.readInt32LE(8);
			const h = cr.readInt32LE(12);
			const cls = className(child);
			const visible = IsWindowVisible(child) !== 0;
			console.log(`${'  '.repeat(depth + 1)}${child}  ${String(w).padStart(5)}x${String(h).padEnd(5)} ${visible ? '可见' : '隐藏'}  ${cls}`);
			count += 1;
			if (depth < 4) walk(child, depth + 1);
			previous = child;
		}
	};
	walk(root, 0);
	if (count === 0) console.log('  (无子窗口)');
	return count;
}

const workDir = mkdtempSync(join(tmpdir(), 'dsh-chromium-struct-'));
const pagePath = join(workDir, 'page.html');
writeFileSync(pagePath, `<!doctype html><meta charset="utf-8"><title>STRUCT-TARGET</title>
<style>html,body{margin:0;height:100%;background:#ff00ff}div{font:28px Consolas;color:#000;padding:20px}</style>
<div>STRUCT-TARGET</div>`, 'utf8');

const chrome = spawn(CHROME, [
	`--user-data-dir=${join(workDir, 'profile')}`,
	'--no-first-run', '--no-default-browser-check',
	'--window-size=820,620', '--window-position=280,200',
	`--app=file:///${pagePath.replaceAll('\\', '/')}`,
], { stdio: 'ignore' });

const coverOut = join(workDir, 'cover.json');
const cover = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(PROJECT, 'test', 'helpers', 'paint-target.ps1'),
	'-OutPath', coverOut, '-Title', 'STRUCT-COVER', '-Color', 'Cyan',
	'-Left', '330', '-Top', '260', '-Width', '600', '-Height', '460'], { stdio: 'ignore' });

const stop = (child) => {
	if (child.pid !== undefined) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
};

try {
	let top = null;
	for (let attempt = 0; attempt < 80 && top == null; attempt += 1) {
		await sleep(250);
		top = FindWindowW(null, 'STRUCT-TARGET');
	}
	if (top == null) throw new Error('Chrome 窗口未出现');
	await sleep(2500); // 给页面渲染留足时间

	const rect = Buffer.alloc(16);
	GetWindowRect(top, rect);
	const left = rect.readInt32LE(0); const topY = rect.readInt32LE(4);
	const w = rect.readInt32LE(8) - left; const h = rect.readInt32LE(12) - topY;
	console.log(`Chrome 顶层 hwnd=${top} 矩形 ${w}x${h} @ (${left},${topY})`);

	// 先让 Chrome 到前台并确认可见 —— 这是"对照 A"
	SetForegroundWindow(top);
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (GetForegroundWindow() === top) break;
		await sleep(200);
		SetForegroundWindow(top);
	}
	await sleep(900);
	console.log(`前台是 Chrome: ${GetForegroundWindow() === top ? '是' : '否'}`);

	console.log(`\n对照 A：Chrome 可见且在前台时，屏幕位图应当抓到品红`);
	const visibleCapture = captureScreen(left, topY, w, h);
	console.log(`   ${JSON.stringify(analyze(visibleCapture))}`);
	const pageRendered = analyze(visibleCapture).magenta !== '0.0%';
	console.log(`   页面确实渲染了: ${pageRendered ? '是' : '否 —— 后面的 PrintWindow 测量都无意义'}`);

	const childCount = dumpTree(top, 'Chrome 可见且前台');

	console.log(`\n状态 1：可见且前台`);
	{
		const { ok, pixels } = captureWindow(top, w, h, PW_RENDERFULLCONTENT);
		console.log(`   PrintWindow(顶层)+FULL 返回=${ok}  ${JSON.stringify(analyze(pixels))}`);
	}
	if (childCount > 0) {
		console.log(`   对每个"足够大"的子窗口分别 PrintWindow：`);
		let previous = null;
		for (let guard = 0; guard < 500; guard += 1) {
			const child = FindWindowExW(top, previous, null, null);
			if (child == null || child === 0n) break;
			previous = child;
			const cr = Buffer.alloc(16);
			GetClientRect(child, cr);
			const cw = cr.readInt32LE(8); const ch = cr.readInt32LE(12);
			if (cw < 200 || ch < 200) continue;
			const { ok, pixels } = captureWindow(child, cw, ch, PW_RENDERFULLCONTENT);
			console.log(`     ${child} ${cw}x${ch} ${className(child).slice(0, 40)} 返回=${ok} ${JSON.stringify(analyze(pixels))}`);
		}
	}

	// 切到遮挡状态
	let coverHandle = null;
	for (let attempt = 0; attempt < 60 && coverHandle == null; attempt += 1) {
		await sleep(200);
		coverHandle = FindWindowW(null, 'STRUCT-COVER');
	}
	if (coverHandle == null) throw new Error('遮挡窗口未出现');
	SetForegroundWindow(coverHandle);
	await sleep(900);
	console.log(`\n状态 2：被遮挡且不在前台（前台是遮挡窗口: ${GetForegroundWindow() === coverHandle ? '是' : '否'}）`);
	console.log(`   屏幕位图 ${JSON.stringify(analyze(captureScreen(left, topY, w, h)))}`);
	{
		const { ok, pixels } = captureWindow(top, w, h, PW_RENDERFULLCONTENT);
		console.log(`   PrintWindow(顶层)+FULL 返回=${ok}  ${JSON.stringify(analyze(pixels))}`);
	}
	dumpTree(top, 'Chrome 被遮挡后');
} finally {
	stop(chrome);
	stop(cover);
	await sleep(600);
	rmSync(workDir, { recursive: true, force: true });
	console.log('\n已清理（按 PID 精确终止）');
}
