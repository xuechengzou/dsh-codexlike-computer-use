/**
 * 用**已经在屏幕上的 Electron 窗口**（DSH 自己）测 PrintWindow。
 *
 * 为什么换这个思路：前几轮想自己起一个 Chrome 窗口来测，但每次都被 Windows 的
 * 前台锁挡住——`SetForegroundWindow` 从后台进程调用是会被拒绝的，于是窗口既没到
 * 前台、也没露出来，"对照组"全程失效，结论自然自相矛盾。
 *
 * 而 DSH 本身就是一个真实的 Electron / Chromium 窗口，此刻正在屏幕上、内容已知。
 * 直接拿它当被测对象，问题就只剩一个：**PrintWindow 能不能抓到它，还是只能给黑图。**
 *
 * 本脚本完全被动：只枚举窗口、读像素。不创建窗口、不改前台、不动光标、不看键盘。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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
const GetClientRect = bind(user32, 'int GetClientRect(void *hWnd, _Out_ void *rect)');
const PrintWindow = bind(user32, 'int PrintWindow(void *hWnd, void *hdcBlt, uint32 nFlags)');
const GetTopWindow = bind(user32, 'void *GetTopWindow(void *hWnd)');
const GetWindow = bind(user32, 'void *GetWindow(void *hWnd, uint32 cmd)');
const GetClassNameW = bind(user32, 'int GetClassNameW(void *hWnd, _Out_ char16_t *buf, int max)');
const GetWindowTextW = bind(user32, 'int GetWindowTextW(void *hWnd, _Out_ char16_t *buf, int max)');
const GetWindowThreadProcessId = bind(user32, 'uint32 GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *pid)');
const IsWindowVisible = bind(user32, 'int IsWindowVisible(void *hWnd)');
const GetForegroundWindow = bind(user32, 'void *GetForegroundWindow()');

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
const GW_HWNDNEXT = 2;

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

/** 基础统计：空白图（纯黑/纯白）与有内容的图在这一项上差异极大。 */
function stats(bgra) {
	const total = bgra.length / 4;
	let black = 0; let white = 0; let distinct = new Set();
	for (let i = 0; i < bgra.length; i += 4) {
		const b = bgra[i]; const g = bgra[i + 1]; const r = bgra[i + 2];
		if (r < 12 && g < 12 && b < 12) black += 1;
		else if (r > 243 && g > 243 && b > 243) white += 1;
		if (distinct.size < 4096) distinct.add((r << 16) | (g << 8) | b);
	}
	return {
		black: `${((black / total) * 100).toFixed(1)}%`,
		white: `${((white / total) * 100).toFixed(1)}%`,
		颜色种类: distinct.size >= 4096 ? '>=4096' : String(distinct.size),
	};
}

/** 两张同尺寸位图的平均绝对差（0 表示完全相同）。 */
function meanDiff(a, b) {
	if (a.length !== b.length) return Number.NaN;
	let sum = 0;
	for (let i = 0; i < a.length; i += 4) {
		sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
	}
	return sum / ((a.length / 4) * 3);
}

/** 按 PID 找出 DSH 自己的进程，避免猜错窗口。 */
const dshPids = new Set();
{
	const result = spawnSync('pwsh', ['-NoProfile', '-Command',
		"Get-Process | Where-Object { $_.ProcessName -match 'dsh|electron' } | Select-Object -ExpandProperty Id",
	], { encoding: 'utf8' });
	for (const line of (result.stdout ?? '').split('\n')) {
		const pid = Number(line.trim());
		if (Number.isInteger(pid) && pid > 0) dshPids.add(pid);
	}
}
console.log(`候选 DSH/Electron 进程: ${[...dshPids].join(', ') || '(未匹配到)'}`);

// 枚举顶层窗口，挑出属于这些进程、且足够大的可见窗口
const candidates = [];
{
	let handle = GetTopWindow(null);
	for (let guard = 0; guard < 3000 && handle != null && handle !== 0n; guard += 1) {
		const pidSlot = Buffer.alloc(4);
		GetWindowThreadProcessId(handle, pidSlot);
		const pid = pidSlot.readUInt32LE(0);
		if (IsWindowVisible(handle) !== 0) {
			const rect = Buffer.alloc(16);
			GetWindowRect(handle, rect);
			const w = rect.readInt32LE(8) - rect.readInt32LE(0);
			const h = rect.readInt32LE(12) - rect.readInt32LE(4);
			const cls = className(handle);
			if (w >= 600 && h >= 400) {
				candidates.push({
					handle, pid, w, h,
					left: rect.readInt32LE(0), top: rect.readInt32LE(4),
					cls, title: titleOf(handle),
					isDsh: dshPids.has(pid),
					isChromium: /chrome_widgetwin|intermediate d3d|renderwidgethost/i.test(cls),
				});
			}
		}
		handle = GetWindow(handle, GW_HWNDNEXT);
	}
}

console.log(`\n枚举到 ${candidates.length} 个较大的可见顶层窗口：`);
for (const c of candidates) {
	console.log(`  ${c.handle}  ${String(c.w).padStart(4)}x${String(c.h).padEnd(4)} pid=${String(c.pid).padEnd(6)} ${c.isDsh ? '[DSH]' : ''}${c.isChromium ? '[Chromium类]' : ''} ${c.cls.slice(0, 34)}  "${c.title.slice(0, 30)}"`);
}

// 优先测属于 DSH 进程、且类名是 Chromium 系的那个
const targets = candidates.filter((c) => c.isChromium || c.isDsh);
if (targets.length === 0) {
	console.log('\n没有找到 Chromium 系窗口可测');
} else {
	const foreground = GetForegroundWindow();
	for (const target of targets.slice(0, 3)) {
		console.log(`\n================ ${target.handle} ${target.cls} ${target.w}x${target.h} ================`);
		console.log(`  是否前台: ${target.handle === foreground ? '是' : '否'}`);

		const screen = captureScreen(target.left, target.top, target.w, target.h);
		console.log(`  屏幕位图            ${JSON.stringify(stats(screen))}`);

		const clientRect = Buffer.alloc(16);
		GetClientRect(target.handle, clientRect);
		const cw = clientRect.readInt32LE(8); const ch = clientRect.readInt32LE(12);

		const full = captureWindow(target.handle, target.w, target.h, PW_RENDERFULLCONTENT);
		console.log(`  PrintWindow +FULL   返回=${full.ok} ${JSON.stringify(stats(full.pixels))}`);
		console.log(`     与屏幕位图的平均像素差: ${meanDiff(screen, full.pixels).toFixed(1)}（0=完全一致，255=完全不同）`);

		const plain = captureWindow(target.handle, target.w, target.h, 0);
		console.log(`  PrintWindow 无标志  返回=${plain.ok} ${JSON.stringify(stats(plain.pixels))}`);

		// 存一份下来供人工核对
		const outDir = fileURLToPath(new URL('..', import.meta.url));
		writeFileSync(join(outDir, `printwindow-${target.handle}.raw`), full.pixels);
		console.log(`  已将 PrintWindow 结果存为 printwindow-${target.handle}.raw（BGRA ${target.w}x${target.h}）`);
		console.log(`  客户区 ${cw}x${ch}`);
	}
}

console.log('\n完成（本脚本全程未创建窗口、未改前台、未动光标）');
