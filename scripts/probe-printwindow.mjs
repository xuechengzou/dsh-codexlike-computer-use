/**
 * 验证：**窗口不在前台、甚至被完全遮挡时，能不能截到它自己的真实内容。**
 *
 * 对比两条路：
 *   - 屏幕位图（BitBlt from screen DC）：只能拿到屏幕上**可见**的像素，
 *     被遮挡的部分拿到的是盖在上面的东西。这也是当前插件 screenshot 的做法。
 *   - PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT)：让**窗口自己**渲染到位图，
 *     不需要它在前台，也不需要它可见。对 Chrome/Electron 这类用
 *     DirectComposition 合成的窗口，必须带 PW_RENDERFULLCONTENT，否则拿到黑图。
 *
 * 实验设计：品红底色的目标窗口 + 青色底色的遮挡窗口，重叠放置。按像素统计判断
 * 抓回来的到底是哪一种颜色，从而区分三条可能：目标自身内容 / 遮挡物 / 黑图。
 *
 * 安全性：只操作本脚本自己启动的两个窗口；结束后按 PID 精确终止。
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
const ShowWindow = bind(user32, 'int ShowWindow(void *hWnd, int cmd)');
const IsWindowVisible = bind(user32, 'int IsWindowVisible(void *hWnd)');
const IsIconic = bind(user32, 'int IsIconic(void *hWnd)');
const FindWindowW = bind(user32, 'void *FindWindowW(const char16_t *cls, const char16_t *name)');

const CreateCompatibleDC = bind(gdi32, 'void *CreateCompatibleDC(void *hdc)');
const CreateCompatibleBitmap = bind(gdi32, 'void *CreateCompatibleBitmap(void *hdc, int cx, int cy)');
const SelectObject = bind(gdi32, 'void *SelectObject(void *hdc, void *h)');
const BitBlt = bind(gdi32, 'int BitBlt(void *hdc, int x, int y, int cx, int cy, void *src, int x1, int y1, uint32 rop)');
const GetDIBits = bind(gdi32, 'int GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, _Out_ void *bits, _Inout_ void *info, uint32 usage)');
const DeleteObject = bind(gdi32, 'int DeleteObject(void *h)');
const DeleteDC = bind(gdi32, 'int DeleteDC(void *hdc)');

const SRCCOPY = 0x00cc0020;
const PW_RENDERFULLCONTENT = 0x00000002;
const SW_MINIMIZE = 6;
const SW_RESTORE = 9;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const PAINT_SCRIPT = join(PROJECT, 'test', 'helpers', 'paint-target.ps1');

/** 从屏幕 DC 抓一块区域，返回 BGRA。 */
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

/** 用 PrintWindow 让窗口自己渲染到位图，返回 BGRA。 */
function captureWindow(handle, w, h, flags) {
	const screenDc = GetDC(null);
	const memDc = CreateCompatibleDC(screenDc);
	const bitmap = CreateCompatibleBitmap(screenDc, w, h);
	const previous = SelectObject(memDc, bitmap);
	try {
		// 先用白色铺底：这样"窗口没画东西"会表现为白色，而不是残留内存的随机噪声
		const brush = bind(gdi32, 'void *CreateSolidBrush(uint32 color)');
		const white = brush(0x00ffffff);
		const FillRect = bind(user32, 'int FillRect(void *hdc, _In_ void *rect, void *brush)');
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

/** 从内存 DC 取回 BGRA 像素。 */
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

/** 统计各颜色的像素占比。 */
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
	return { total, magenta: pct(magenta), cyan: pct(cyan), black: pct(black), white: pct(white), other: pct(other) };
}

/** 启动一个纯色窗口并等它就绪。 */
async function launchPaint(title, color, left, top, width, height, outPath) {
	if (existsSync(outPath)) unlinkSync(outPath);
	const child = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PAINT_SCRIPT,
		'-OutPath', outPath, '-Title', title, '-Color', color,
		'-Left', String(left), '-Top', String(top), '-Width', String(width), '-Height', String(height)], { stdio: 'ignore' });
	for (let attempt = 0; attempt < 60; attempt += 1) {
		await sleep(200);
		if (existsSync(outPath)) {
			try {
				const info = JSON.parse(readFileSync(outPath, 'utf8'));
				if (info.hwnd) return { child, info, outPath };
			} catch { /* 文件可能只写了一半 */ }
		}
	}
	child.kill();
	throw new Error(`窗口 ${title} 未就绪`);
}

const stop = (child) => {
	if (child.pid !== undefined) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
};

const workDir = mkdtempSync(join(tmpdir(), 'dsh-printwindow-'));
const target = await launchPaint('PAINT-BOTTOM', 'Magenta', 260, 200, 520, 380, join(workDir, 'bottom.json'));
const cover = await launchPaint('PAINT-TOP', 'Cyan', 340, 280, 520, 380, join(workDir, 'top.json'));

try {
	// 让遮挡窗口成为前台，目标窗口于是既不在前台、也被盖住
	SetForegroundWindow(FindWindowW(null, 'PAINT-TOP'));
	await sleep(900);
	const bounds = target.info;
	const handle = BigInt(bounds.hwnd);
	console.log(`目标窗口 hwnd=${handle} 客户区 ${bounds.width}x${bounds.height} @ (${bounds.left},${bounds.top})`);
	console.log(`前台窗口: ${GetForegroundWindow() === handle ? '就是目标（不符合预期）' : '不是目标（符合预期）'}`);
	console.log(`目标可见: ${IsWindowVisible(handle) !== 0}  最小化: ${IsIconic(handle) !== 0}`);

	const rect = Buffer.alloc(16);
	GetWindowRect(handle, rect);
	const w = rect.readInt32LE(8) - rect.readInt32LE(0);
	const h = rect.readInt32LE(12) - rect.readInt32LE(4);

	// ---- 1. 屏幕位图（当前实现的做法） ----
	{
		const pixels = captureScreen(rect.readInt32LE(0), rect.readInt32LE(4), w, h);
		console.log(`\n1. 屏幕位图 BitBlt（现状）`);
		console.log(`   颜色占比: ${JSON.stringify(analyze(pixels))}`);
		console.log('   期望：以青色为主 —— 说明这个位置在屏幕上被遮挡窗口占着');
	}

	// ---- 2. PrintWindow + PW_RENDERFULLCONTENT ----
	{
		const { ok, pixels } = captureWindow(handle, w, h, PW_RENDERFULLCONTENT);
		console.log(`\n2. PrintWindow + PW_RENDERFULLCONTENT`);
		console.log(`   返回=${ok}（1 表示成功）`);
		console.log(`   颜色占比: ${JSON.stringify(analyze(pixels))}`);
		console.log('   期望：以品红为主 —— 说明抓到了目标窗口自己的内容，与遮挡无关');
	}

	// ---- 3. PrintWindow 不带 FULLCONTENT（对照组） ----
	{
		const { ok, pixels } = captureWindow(handle, w, h, 0);
		console.log(`\n3. PrintWindow（不带 PW_RENDERFULLCONTENT，对照）`);
		console.log(`   返回=${ok}`);
		console.log(`   颜色占比: ${JSON.stringify(analyze(pixels))}`);
	}

	// ---- 4. 最小化之后再试 ----
	{
		ShowWindow(handle, SW_MINIMIZE);
		await sleep(900);
		const { ok, pixels } = captureWindow(handle, w, h, PW_RENDERFULLCONTENT);
		console.log(`\n4. 目标窗口最小化后 PrintWindow`);
		console.log(`   最小化=${IsIconic(handle) !== 0}  返回=${ok}`);
		console.log(`   颜色占比: ${JSON.stringify(analyze(pixels))}`);
		console.log('   期望：如果大面积黑/白，说明最小化时渲染被挂起，这条路不可用');
		ShowWindow(handle, SW_RESTORE);
		await sleep(600);
	}
} finally {
	stop(target.child);
	stop(cover.child);
	await sleep(500);
	rmSync(workDir, { recursive: true, force: true });
	for (const name of ['bottom.json', 'top.json']) {
		const path = join(workDir, name);
		if (existsSync(path)) unlinkSync(path);
	}
	console.log('\n已清理临时窗口与文件');
	void writeFileSync;
}
