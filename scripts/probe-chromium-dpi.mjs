// ---------------------------------------------------------------------------
// 打扰性守卫：本脚本会创建窗口，可能打扰到正在使用电脑的人。
// ---------------------------------------------------------------------------
if (process.env.DSH_COMPUTER_USE_ALLOW_DISRUPTIVE !== '1') {
	console.error('本脚本会创建窗口，可能打扰到正在使用电脑的人。');
	console.error('确认此刻可以打扰时：设置 DSH_COMPUTER_USE_ALLOW_DISRUPTIVE=1 再运行。');
	process.exit(2);
}

/**
 * 验证 Chromium 在**非 100% 缩放**下的坐标语义。
 *
 * 这是 objective 里唯一没有实测的一项：本实现全程假设"渲染子窗口的客户区坐标就是
 * 物理像素，Chromium 自己负责映射到 CSS 像素，因此投递客户区坐标不需要额外的 DPI 换算"。
 * 这个假设如果错，非 100% 缩放的机器上点击会整体偏移。
 *
 * 为什么之前没测：直接验证要改系统显示缩放（全局、打扰用户）。
 * 但 Chrome 自己有 `--force-device-scale-factor`，只影响本次启动的实例，
 * 可以在不改动用户环境的前提下把同一个问题问清楚。
 *
 * 判据：往渲染子窗口的客户区投递 (X, Y)，页面收到的 clientX/clientY 应当等于
 * X/dpr、Y/dpr（dpr = devicePixelRatio）。成立则说明"投客户区坐标即可"，
 * 不成立则必须引入按 dpr 的换算。
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
const bind = (signature) => user32.func(signature);

const GetWindowTextW = bind('int GetWindowTextW(void *hWnd, _Out_ char16_t *buf, int max)');
const GetClientRect = bind('int GetClientRect(void *hWnd, _Out_ void *rect)');
const FindWindowExW = bind('void *FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *name)');
const GetClassNameW = bind('int GetClassNameW(void *hWnd, _Out_ char16_t *buf, int max)');
const SetWindowPos = bind('int SetWindowPos(void *hWnd, void *after, int x, int y, int cx, int cy, uint32 flags)');
const PostMessageW = bind('int PostMessageW(void *hWnd, uint32 msg, intptr_t wParam, intptr_t lParam)');
const GetTopWindow = bind('void *GetTopWindow(void *hWnd)');
const GetWindow = bind('void *GetWindow(void *hWnd, uint32 cmd)');
const GetWindowThreadProcessId = bind('uint32 GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *pid)');

const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const MK_LBUTTON = 0x0001;
const SWP_NOACTIVATE = 0x0010;
const MIN_SURFACE_EDGE = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const makeLParam = (x, y) => (((y & 0xffff) << 16) | (x & 0xffff)) | 0;

const textOf = (handle, reader) => {
	const buffer = Buffer.alloc(1024);
	const written = reader(handle, buffer, 512);
	return written <= 0 ? '' : buffer.subarray(0, written * 2).toString('utf16le');
};

/**
 * 找出该进程的**应用窗口**。
 *
 * 不能只按"客户区够大"来挑：Chrome 会创建多个顶层窗口，其中一些是隐藏的辅助窗口，
 * 尺寸也够大，但它们没有渲染子窗口——挑错了就会报"未找到渲染子窗口"，
 * 看起来像 Chromium 的问题，实际是选错了对象。
 * 页面标题以 `DPI|` 开头，用它精确认人。
 */
function appWindowOfPid(pid) {
	const candidates = [];
	let handle = GetTopWindow(null);
	for (let guard = 0; guard < 3000 && handle != null && handle !== 0n; guard += 1) {
		const slot = Buffer.alloc(4);
		GetWindowThreadProcessId(handle, slot);
		if (slot.readUInt32LE(0) === pid) candidates.push(handle);
		handle = GetWindow(handle, 2);
	}
	return candidates.find((candidate) => textOf(candidate, GetWindowTextW).startsWith('DPI|')) ?? null;
}

/** 找面积最大的、足够大的渲染子窗口。 */
function largestRenderWidget(root) {
	let best = null;
	const queue = [root];
	while (queue.length > 0) {
		const parent = queue.shift();
		let previous = null;
		for (let guard = 0; guard < 400; guard += 1) {
			const child = FindWindowExW(parent, previous, null, null);
			if (child == null || child === 0n) break;
			if (textOf(child, GetClassNameW).toLowerCase().includes('renderwidgethost')) {
				const rect = Buffer.alloc(16);
				GetClientRect(child, rect);
				const width = rect.readInt32LE(8);
				const height = rect.readInt32LE(12);
				if (width >= MIN_SURFACE_EDGE && height >= MIN_SURFACE_EDGE && (best === null || width * height > best.width * best.height)) {
					best = { handle: child, width, height };
				}
			}
			queue.push(child);
			previous = child;
		}
	}
	return best;
}

const workDir = mkdtempSync(join(tmpdir(), 'dsh-dpi-probe-'));
const pagePath = join(workDir, 'dpi.html');
// 页面把 devicePixelRatio、视口尺寸与最后一次 mousedown 的 client 坐标写进标题
writeFileSync(pagePath, `<!doctype html><meta charset="utf-8"><title>DPI|dpr=0|vw=0|vh=0|x=-1|y=-1|n=0</title>
<style>html,body{margin:0;height:100%;background:#ff00ff}</style>
<script>
let n = 0, lx = -1, ly = -1;
const sync = () => { document.title = 'DPI|dpr=' + devicePixelRatio + '|vw=' + innerWidth + '|vh=' + innerHeight + '|x=' + lx + '|y=' + ly + '|n=' + n; };
document.addEventListener('mousedown', (e) => { n += 1; lx = Math.round(e.clientX); ly = Math.round(e.clientY); sync(); }, true);
document.addEventListener('mouseup', sync, true);
window.addEventListener('resize', sync);
sync();
</script>`, 'utf8');

const parse = (title) => {
	const m = /^DPI\|dpr=([\d.]+)\|vw=(\d+)\|vh=(\d+)\|x=(-?\d+)\|y=(-?\d+)\|n=(\d+)$/u.exec(title);
	return m === null ? null : { dpr: Number(m[1]), vw: Number(m[2]), vh: Number(m[3]), x: Number(m[4]), y: Number(m[5]), n: Number(m[6]) };
};

/** 跑一轮：用给定的缩放因子启动 Chrome，投递一个已知坐标，比对页面收到的值。 */
async function run(scaleFactor) {
	const profileDir = join(workDir, `profile-${scaleFactor}`);
	const chrome = spawn(CHROME, [
		`--user-data-dir=${profileDir}`,
		'--no-first-run', '--no-default-browser-check',
		`--force-device-scale-factor=${scaleFactor}`,
		'--window-size=900,700', '--window-position=80,80',
		`--app=file:///${pagePath.replaceAll('\\', '/')}`,
	], { stdio: 'ignore' });

	const stop = () => {
		if (chrome.pid !== undefined) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
	};
	void stop;

	try {
		let top = null;
		for (let attempt = 0; attempt < 80 && top == null; attempt += 1) {
			await sleep(250);
			if (chrome.pid !== undefined) top = appWindowOfPid(chrome.pid);
		}
		if (top == null) throw new Error(`缩放 ${scaleFactor}: Chrome 窗口未出现`);

		// 置顶但不激活——与插件的行为一致，也避免抢用户前台
		SetWindowPos(top, -1n, 80, 80, 900, 700, SWP_NOACTIVATE);

		// 必须在改完尺寸之后再找渲染子窗口：Chromium 在尺寸变化时会重建它
		let widget = null;
		for (let attempt = 0; attempt < 60 && widget == null; attempt += 1) {
			await sleep(300);
			widget = largestRenderWidget(top);
		}
		if (widget == null) throw new Error(`缩放 ${scaleFactor}: 未找到足够大的渲染子窗口`);

		// 等页面布局稳定：连续两次读到同一个视口尺寸
		let settled = null;
		for (let attempt = 0; attempt < 25 && settled == null; attempt += 1) {
			const first = parse(textOf(top, GetWindowTextW));
			await sleep(400);
			const second = parse(textOf(top, GetWindowTextW));
			if (first && second && first.vw === second.vw && first.vh === second.vh && first.vw >= 200) settled = second;
		}
		if (settled == null) throw new Error(`缩放 ${scaleFactor}: 页面布局未稳定`);

		const postX = Math.round(widget.width * 0.4);
		const postY = Math.round(widget.height * 0.35);
		const lp = makeLParam(postX, postY);

		let after = settled;
		for (let attempt = 1; attempt <= 3 && after.n <= settled.n; attempt += 1) {
			PostMessageW(widget.handle, WM_MOUSEMOVE, 0, lp);
			PostMessageW(widget.handle, WM_LBUTTONDOWN, MK_LBUTTON, lp);
			PostMessageW(widget.handle, WM_LBUTTONUP, 0, lp);
			for (let wait = 0; wait < 8; wait += 1) {
				await sleep(300);
				const now = parse(textOf(top, GetWindowTextW));
				if (now && now.n > settled.n) { after = now; break; }
			}
		}
		return { top, widget, settled, after, postX, postY, stop };
	} catch (error) {
		stop();
		await sleep(600);
		throw error;
	}
}

try {
	for (const factor of [1, 1.5, 2]) {
		const result = await run(factor);
		try {
			const { widget, settled, after, postX, postY } = result;
			console.log(`\n===== --force-device-scale-factor=${factor} =====`);
			console.log(`  渲染子窗口客户区 ${widget.width}x${widget.height}，devicePixelRatio=${settled.dpr}`);
		 console.log(`  页面视口 ${settled.vw}x${settled.vh}`);
			console.log(`  投递客户区坐标 (${postX}, ${postY})`);
			console.log(`  页面收到 clientX/Y = (${after.x}, ${after.y})，事件计数 ${settled.n} → ${after.n}`);
			if (after.n <= settled.n) {
				console.log('  ✗ 页面未收到事件，无法判定');
				continue;
			}
			const expectedX = postX / settled.dpr;
			const expectedY = postY / settled.dpr;
			const okX = Math.abs(after.x - expectedX) <= 1;
			const okY = Math.abs(after.y - expectedY) <= 1;
			console.log(`  期望（按 dpr 换算）(${expectedX.toFixed(1)}, ${expectedY.toFixed(1)})`);
			console.log(`  结论：${okX && okY ? '✓ 投递客户区坐标即可，Chromium 自己按 dpr 映射，无需额外换算' : '✗ 与 dpr 换算不符，坐标链路需要修正'}`);
			// 顺带确认另一条：视口尺寸与客户区尺寸的比例是否就是 dpr
			console.log(`  视口/客户区 = ${(widget.width / settled.vw).toFixed(3)}（dpr=${settled.dpr}）`);
		} finally {
			result.stop();
			await sleep(800);
		}
	}
} finally {
	rmSync(workDir, { recursive: true, force: true });
	console.log('\n已清理');
}
