/**
 * 验证 `PrintWindow` 对 **Chromium / Electron** 窗口是否有效。
 *
 * 为什么必须单独测：这类窗口的内容由 DirectComposition / GPU 合成，不在 GDI 的
 * 常规绘制路径上。普通 GDI 窗口（WinForms）能成功，完全不能推及它们——
 * 已知的失败表现是 PrintWindow 返回 1（成功）却给你一张纯黑或纯白的图，
 * 也就是"看起来能用，实际拿不到内容"。
 *
 * 做法：起一个自己的 Chrome 应用窗口，页面整屏纯品红并带文字标记；用青色窗口
 * 盖住它并抢走前台，然后分别对顶层窗口与其 render widget 子窗口做 PrintWindow，
 * 按像素统计判断到底拿到了什么。
 *
 * 安全性：只操作本脚本自己启动的 Chrome 与遮挡窗口，按 PID 精确终止。
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
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
const PrintWindow = bind(user32, 'int PrintWindow(void *hWnd, void *hdcBlt, uint32 nFlags)');
const SetForegroundWindow = bind(user32, 'int SetForegroundWindow(void *hWnd)');
const GetForegroundWindow = bind(user32, 'void *GetForegroundWindow()');
const FindWindowW = bind(user32, 'void *FindWindowW(const char16_t *cls, const char16_t *name)');
const FindWindowExW = bind(user32, 'void *FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *name)');
const GetClassNameW = bind(user32, 'int GetClassNameW(void *hWnd, _Out_ char16_t *buf, int max)');
const GetClientRect = bind(user32, 'int GetClientRect(void *hWnd, _Out_ void *rect)');

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
		// 白底：让"窗口什么都没画"表现为白色，与真正的白色内容也能区分（会配合黑图判断）
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
	let magenta = 0; let cyan = 0; let black = 0; let white = 0; let other = 0;
	for (let i = 0; i < bgra.length; i += 4) {
		const b = bgra[i]; const g = bgra[i + 1]; const r = bgra[i + 2];
		if (r > 200 && g < 60 && b > 200) magenta += 1;
		else if (r < 60 && g > 200 && b > 200) cyan += 1;
		else if (r < 20 && g < 20 && b < 20) black += 1;
		else if (r > 235 && g > 235 && b > 235) white += 1;
		else other += 1;
	}
	const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
	return { magenta: pct(magenta), cyan: pct(cyan), black: pct(black), white: pct(white), other: pct(other) };
}

const className = (handle) => {
	const buffer = Buffer.alloc(512);
	const written = GetClassNameW(handle, buffer, 256);
	return written <= 0 ? '' : buffer.subarray(0, written * 2).toString('utf16le');
};

const workDir = mkdtempSync(join(tmpdir(), 'dsh-pw-chrome-'));
const pagePath = join(workDir, 'page.html');
// 整屏纯品红 + 文字标记；不需要任何交互
writeFileSync(pagePath, `<!doctype html><meta charset="utf-8"><title>PW-CHROME-TARGET</title>
<style>html,body{margin:0;height:100%;background:#ff00ff}div{font:28px Consolas;color:#000;padding:24px}</style>
<div>PW-CHROME-TARGET</div>`, 'utf8');

const chrome = spawn(CHROME, [
	`--user-data-dir=${join(workDir, 'profile')}`,
	'--no-first-run', '--no-default-browser-check',
	'--window-size=820,620', '--window-position=300,220',
	`--app=file:///${pagePath.replaceAll('\\', '/')}`,
], { stdio: 'ignore' });

const coverOut = join(workDir, 'cover.json');
const cover = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(PROJECT, 'test', 'helpers', 'paint-target.ps1'),
	'-OutPath', coverOut, '-Title', 'PW-COVER', '-Color', 'Cyan',
	'-Left', '380', '-Top', '300', '-Width', '560', '-Height', '420'], { stdio: 'ignore' });

const stop = (child) => {
	if (child.pid !== undefined) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
};

try {
	let top = null;
	for (let attempt = 0; attempt < 80 && top == null; attempt += 1) {
		await sleep(250);
		top = FindWindowW(null, 'PW-CHROME-TARGET');
	}
	if (top == null) throw new Error('Chrome 窗口未出现');

	let coverHandle = null;
	for (let attempt = 0; attempt < 60 && coverHandle == null; attempt += 1) {
		await sleep(200);
		coverHandle = FindWindowW(null, 'PW-COVER');
	}
	if (coverHandle == null) throw new Error('遮挡窗口未出现');
	await sleep(1200);

	// 让遮挡窗口到前台，Chrome 于是既不在前台、也被盖住
	SetForegroundWindow(coverHandle);
	await sleep(900);
	console.log(`Chrome 顶层 hwnd=${top}  遮挡窗口 hwnd=${coverHandle}`);
	console.log(`前台是 Chrome：${GetForegroundWindow() === top ? '是（不符合预期）' : '否（符合预期）'}`);

	const rect = Buffer.alloc(16);
	GetWindowRect(top, rect);
	const left = rect.readInt32LE(0); const topY = rect.readInt32LE(4);
	const w = rect.readInt32LE(8) - left; const h = rect.readInt32LE(12) - topY;
	console.log(`Chrome 窗口矩形 ${w}x${h} @ (${left},${topY})`);

	// 找出面积最大的 render widget 子窗口
	const renderWidgets = [];
	{
		const queue = [top];
		while (queue.length > 0) {
			const parent = queue.shift();
			let previous = null;
			for (let guard = 0; guard < 400; guard += 1) {
				const child = FindWindowExW(parent, previous, null, null);
				if (child == null || child === 0n) break;
				if (className(child).toLowerCase().includes('renderwidgethost')) {
					const cr = Buffer.alloc(16);
					GetClientRect(child, cr);
					renderWidgets.push({ child, w: cr.readInt32LE(8), h: cr.readInt32LE(12) });
				}
				queue.push(child);
				previous = child;
			}
		}
		renderWidgets.sort((a, b) => b.w * b.h - a.w * a.h);
	}
	console.log(`render widget 候选: ${renderWidgets.map((r) => `${r.w}x${r.h}`).join(', ') || '(无)'}`);

	console.log(`\n1. 屏幕位图（对照：确认这个位置在屏幕上被遮挡）`);
	console.log(`   ${JSON.stringify(analyze(captureScreen(left, topY, w, h)))}`);

	console.log(`\n2. PrintWindow(顶层窗口) + PW_RENDERFULLCONTENT`);
	{
		const { ok, pixels } = captureWindow(top, w, h, PW_RENDERFULLCONTENT);
		console.log(`   返回=${ok}  ${JSON.stringify(analyze(pixels))}`);
	}

	console.log(`\n3. PrintWindow(顶层窗口) 不带标志（对照）`);
	{
		const { ok, pixels } = captureWindow(top, w, h, 0);
		console.log(`   返回=${ok}  ${JSON.stringify(analyze(pixels))}`);
	}

	const biggest = renderWidgets[0];
	if (biggest !== undefined) {
		console.log(`\n4. PrintWindow(最大 render widget ${biggest.w}x${biggest.h}) + PW_RENDERFULLCONTENT`);
		const { ok, pixels } = captureWindow(biggest.child, biggest.w, biggest.h, PW_RENDERFULLCONTENT);
		console.log(`   返回=${ok}  ${JSON.stringify(analyze(pixels))}`);
	}
} finally {
	stop(chrome);
	stop(cover);
	await sleep(600);
	rmSync(workDir, { recursive: true, force: true });
	if (existsSync(coverOut)) unlinkSync(coverOut);
	console.log('\n已清理');
	void readFileSync;
}
