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
 * 验证两件事，它们必须**同时**成立：
 *
 *   1. 测试用的靶窗口**不会抢走前台焦点**。这是用户明确要求的：脚本开出来的窗口
 *      不应该把用户正在做的事情挤到一边。
 *   2. "不抢前台"没有把"能盖住别的窗口"这个能力一起弄丢。二者是正交的：
 *      置顶（z 序）与激活（焦点）本来就没有关系，但很容易在实现里被绑在一起。
 *
 * 第 2 条尤其重要：如果为了不抢前台而放弃置顶，"被完全遮挡"这类测试就无法构造，
 * 后台截图的可信度会一起塌掉。
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
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const GetWindowRect = user32.func('int GetWindowRect(void *hWnd, _Out_ void *rect)');
const GetDC = user32.func('void *GetDC(void *hWnd)');
const ReleaseDC = user32.func('int ReleaseDC(void *hWnd, void *hDC)');
const GetClassNameW = user32.func('int GetClassNameW(void *hWnd, _Out_ char16_t *buf, int max)');
const GetWindowTextW = user32.func('int GetWindowTextW(void *hWnd, _Out_ char16_t *buf, int max)');
const gdi32 = api.load('gdi32.dll');
const CreateCompatibleDC = gdi32.func('void *CreateCompatibleDC(void *hdc)');
const CreateCompatibleBitmap = gdi32.func('void *CreateCompatibleBitmap(void *hdc, int cx, int cy)');
const SelectObject = gdi32.func('void *SelectObject(void *hdc, void *h)');
const BitBlt = gdi32.func('int BitBlt(void *hdc, int x, int y, int cx, int cy, void *src, int x1, int y1, uint32 rop)');
const GetDIBits = gdi32.func('int GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, _Out_ void *bits, _Inout_ void *info, uint32 usage)');
const DeleteObject = gdi32.func('int DeleteObject(void *h)');
const DeleteDC = gdi32.func('int DeleteDC(void *hdc)');

const SRCCOPY = 0x00cc0020;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROJECT = fileURLToPath(new URL('..', import.meta.url));

const textOf = (handle, reader) => {
	const buffer = Buffer.alloc(1024);
	const written = reader(handle, buffer, 512);
	return written <= 0 ? '' : buffer.subarray(0, written * 2).toString('utf16le');
};

/** 抓屏幕上一块区域，统计品红占比。 */
function screenMagenta(x, y, w, h) {
	const screenDc = GetDC(null);
	const memDc = CreateCompatibleDC(screenDc);
	const bitmap = CreateCompatibleBitmap(screenDc, w, h);
	const previous = SelectObject(memDc, bitmap);
	try {
		BitBlt(memDc, 0, 0, w, h, screenDc, x, y, SRCCOPY);
		const header = Buffer.alloc(40);
		header.writeUInt32LE(40, 0);
		header.writeInt32LE(w, 4);
		header.writeInt32LE(-h, 8);
		header.writeUInt16LE(1, 12);
		header.writeUInt16LE(32, 14);
		header.writeUInt32LE(w * h * 4, 20);
		const pixels = Buffer.alloc(w * h * 4);
		GetDIBits(memDc, bitmap, 0, h, pixels, header, 0);
		let magenta = 0;
		for (let i = 0; i < pixels.length; i += 4) {
			if (pixels[i + 2] > 200 && pixels[i + 1] < 60 && pixels[i] > 200) magenta += 1;
		}
		return (magenta / (w * h)) * 100;
	} finally {
		SelectObject(memDc, previous);
		DeleteObject(bitmap);
		DeleteDC(memDc);
		ReleaseDC(null, screenDc);
	}
}

const workDir = mkdtempSync(join(tmpdir(), 'dsh-noactivate-'));
const bottomOut = join(workDir, 'bottom.json');
const coverOut = join(workDir, 'cover.json');

const spawnTarget = (script, outPath, extra) => spawn('pwsh', [
	'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(PROJECT, 'test', 'helpers', script),
	'-OutPath', outPath, ...extra,
], { stdio: 'ignore' });

const stop = (child) => {
	if (child.pid !== undefined) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
};

// 品红底层窗口：不置顶、不激活
const bottom = spawnTarget('paint-target.ps1', bottomOut, [
	'-Title', 'NOACT-BOTTOM', '-Color', 'Magenta', '-Left', '300', '-Top', '240', '-Width', '520', '-Height', '380',
]);
// 青色遮挡窗口：置顶，但依然不激活。
// 刻意比底窗更大且包住它：上一版只部分重叠，于是"该看到多少品红"变成一个
// 需要精确计算阈值的模糊问题——测量里凡是能用构造消除的歧义都不该留给阈值。
const cover = spawnTarget('paint-target.ps1', coverOut, [
	'-Title', 'NOACT-COVER', '-Color', 'Cyan', '-Left', '280', '-Top', '220', '-Width', '600', '-Height', '460', '-TopMost',
]);

const readJson = (path) => {
	if (!existsSync(path)) return null;
	try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

try {
	const foregroundBefore = GetForegroundWindow();
	const beforeTitle = textOf(foregroundBefore, GetWindowTextW);
	console.log(`起始前台: hwnd=${foregroundBefore} "${beforeTitle}"`);

	let bottomInfo = null;
	let coverInfo = null;
	for (let attempt = 0; attempt < 80; attempt += 1) {
		await sleep(200);
		bottomInfo = readJson(bottomOut);
		coverInfo = readJson(coverOut);
		if (bottomInfo?.hwnd && coverInfo?.hwnd) break;
	}
	if (!bottomInfo?.hwnd || !coverInfo?.hwnd) throw new Error('靶窗口未就绪');
	await sleep(1500);

	const bottomHandle = BigInt(bottomInfo.hwnd);
	const coverHandle = BigInt(coverInfo.hwnd);
	const foregroundNow = GetForegroundWindow();

	console.log(`\n=== 检查 1：窗口是否抢了前台 ===`);
	const foregroundUnchanged = foregroundNow === foregroundBefore;
	const bottomIsForeground = foregroundNow === bottomHandle;
	const coverIsForeground = foregroundNow === coverHandle;
	console.log(`  前台是否变化: ${foregroundUnchanged ? '未变化 ✓' : `变化了（现为 ${foregroundNow} "${textOf(foregroundNow, GetWindowTextW)}"）✗`}`);
	console.log(`  底窗是否成了前台: ${bottomIsForeground ? '是 ✗' : '否 ✓'}`);
	console.log(`  遮挡窗是否成了前台: ${coverIsForeground ? '是 ✗' : '否 ✓'}`);

	console.log(`\n=== 检查 2：不抢前台是否把"能遮挡"一起弄丢了 ===`);
	const bottomRect = { x: bottomInfo.left, y: bottomInfo.top, w: bottomInfo.width, h: bottomInfo.height };
	const magentaOnScreen = screenMagenta(bottomRect.x, bottomRect.y, bottomRect.w, bottomRect.h);
	console.log(`  底窗所在屏幕区域的品红占比: ${magentaOnScreen.toFixed(1)}%`);
	console.log(`  ${magentaOnScreen < 20 ? '底窗被遮挡住了 ✓（置顶生效，且与是否抢前台无关）' : '底窗仍然可见 ✗（置顶没生效）'}`);

	const allPass = foregroundUnchanged && !bottomIsForeground && !coverIsForeground && magentaOnScreen < 20;
	console.log(`\n${allPass ? '全部通过 ✓' : '有检查未通过 ✗'}`);
	console.log(`底窗类名 ${textOf(bottomHandle, GetClassNameW).slice(0, 40)}`);
	console.log(`遮挡窗类名 ${textOf(coverHandle, GetClassNameW).slice(0, 40)}`);
} finally {
	stop(bottom);
	stop(cover);
	await sleep(500);
	rmSync(workDir, { recursive: true, force: true });
	for (const path of [bottomOut, coverOut]) if (existsSync(path)) unlinkSync(path);
	console.log('\n已清理（按 PID 精确终止）');
}
