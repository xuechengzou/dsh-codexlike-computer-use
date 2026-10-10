/**
 * 真实原生层的冒烟测试。
 *
 * 与单元测试的区别在于：这里替换的 koffi 替身会**委派给真实的 koffi**，
 * 因此跑的是同一份 `lib/win32.js`，真的调 user32/gdi32。只有这样才能证明
 * 结构体布局、DPI 坐标、BitBlt/GetDIBits 参数在实际系统上成立。
 *
 * 两层开关，避免默认测试打扰用户的桌面：
 *   - `DSH_COMPUTER_USE_REAL_KOFFI`：指向真实 koffi 入口，启用原生冒烟
 *   - `DSH_COMPUTER_USE_LIVE_INPUT=1`：额外启用输入注入验证；会短暂抢走焦点，
 *     因此输入全部打向本测试自己创建的置顶靶窗口，不触碰其它程序
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { usingRealKoffi } from 'koffi';
import { downscaleLadder } from '../lib/image.js';
import { captureScreenshot, desktopBounds } from '../lib/screen.js';
import { click, settleKeyboardTarget, typeText, MOUSE_BUTTONS } from '../lib/input.js';
import { parseChord } from '../lib/keys.js';
import { loadWin32 } from '../lib/win32.js';
import { formatScreenshot } from '../lib/image.js';
import { pressChord } from '../lib/input.js';

const LIVE = process.platform === 'win32' && usingRealKoffi;
const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 解析 PNG 的 IHDR，确认捕获产物是结构正确的图像。 */
function pngSize(png) {
	assert.equal(png.readUInt32BE(0), 0x89504e47, '应是 PNG 签名');
	assert.equal(png.toString('ascii', 12, 16), 'IHDR');
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test('原生绑定可加载，且 INPUT 结构体尺寸正确', { skip: !LIVE }, async () => {
	const win32 = await loadWin32();
	assert.equal(win32.inputStructSize, 40, 'x64 下 INPUT 必须是 40 字节，否则 SendInput 会静默丢事件');
});

test('能读到真实的桌面度量和光标位置', { skip: !LIVE }, async () => {
	const win32 = await loadWin32();
	const desktop = desktopBounds(win32);
	assert.ok(desktop.width >= 640, `桌面宽度异常：${desktop.width}`);
	assert.ok(desktop.height >= 480, `桌面高度异常：${desktop.height}`);
	assert.ok(desktop.monitors >= 1);

	const cursor = win32.cursorPosition();
	assert.ok(Number.isInteger(cursor.x) && Number.isInteger(cursor.y));
	// 光标应落在虚拟桌面内；越界说明坐标空间（DPI 感知）判断错了
	assert.ok(cursor.x >= desktop.x && cursor.x <= desktop.x + desktop.width, `光标 x=${cursor.x} 超出桌面`);
	assert.ok(cursor.y >= desktop.y && cursor.y <= desktop.y + desktop.height, `光标 y=${cursor.y} 超出桌面`);
});

test('全屏捕获产出尺寸正确、体积合理的 PNG', { skip: !LIVE }, async () => {
	const win32 = await loadWin32();
	const capture = captureScreenshot(win32, { maxDimension: 0, pngLevel: 6 });

	const size = pngSize(capture.png);
	assert.equal(size.width, capture.region.width);
	assert.equal(size.height, capture.region.height);
	assert.equal(capture.scale, 1);
	// 一块真屏幕不会压成几百字节，也不会膨胀到几十兆
	assert.ok(capture.png.length > 5_000, `PNG 只有 ${capture.png.length} 字节，可能是空白画面`);
	assert.ok(capture.png.length < 30_000_000, `PNG 达 ${capture.png.length} 字节，压缩可能失效`);
	assert.ok(capture.elapsedMs < 5_000, `捕获耗时 ${capture.elapsedMs}ms，明显偏慢`);
});

test('缩放捕获得到的图像尺寸与换算系数自洽', { skip: !LIVE }, async () => {
	const win32 = await loadWin32();
	const desktop = desktopBounds(win32);
	const capture = captureScreenshot(win32, { maxDimension: 400, pngLevel: 6 });

	const size = pngSize(capture.png);
	assert.ok(Math.max(size.width, size.height) <= 400, `最长边 ${Math.max(size.width, size.height)} 超过上限`);
	assert.equal(size.width, capture.width);
	assert.equal(size.height, capture.height);
	assert.ok(Math.abs(capture.scale - size.width / desktop.width) < 1e-9);
});

test('区域捕获只抓指定范围，且裁剪到桌面内', { skip: !LIVE }, async () => {
	const win32 = await loadWin32();
	const capture = captureScreenshot(win32, { region: { x: 10, y: 10, width: 200, height: 120 }, maxDimension: 0, pngLevel: 6 });
	assert.deepEqual(capture.region, { x: 10, y: 10, width: 200, height: 120 });
	const size = pngSize(capture.png);
	assert.deepEqual(size, { width: 200, height: 120 });
});

test('真实捕获的产物能生成可读的坐标换算外壳', { skip: !LIVE }, async () => {
	const win32 = await loadWin32();
	const capture = captureScreenshot(win32, { maxDimension: 400, pngLevel: 6 });
	const text = formatScreenshot({
		image: { attachmentId: 'live', mediaType: 'image/png', bytes: capture.png.length, width: capture.width, height: capture.height },
		region: capture.region,
		desktop: desktopBounds(win32),
		scale: capture.scale,
		cursor: win32.cursorPosition(),
		elapsedMs: capture.elapsedMs,
		downscaleRetries: 0,
	});
	assert.match(text, /screen_x =/u);
});

test('降采样阶梯在真实尺寸下可用', { skip: !LIVE }, async () => {
	const win32 = await loadWin32();
	const desktop = desktopBounds(win32);
	const ladder = downscaleLadder(desktop.width, undefined);
	assert.ok(ladder.length >= 2);
	assert.equal(ladder[0], desktop.width);
});

// ---- 输入注入（需显式开启；短暂抢焦点，但只打向自建靶窗口） -----------------

const TARGET_TITLE = 'DSH-COMPUTER-USE-LIVE-TARGET';
const TARGET_SCRIPT = join(PROJECT, 'test', 'helpers', 'input-target.ps1');
const RESULT_PATH = join(PROJECT, 'test', 'helpers', 'live-input-result.json');

test('输入注入：点击、Unicode 打字、组合键都落到靶窗口', { skip: !LIVE || process.env.DSH_COMPUTER_USE_LIVE_INPUT !== '1' }, async () => {
	assert.ok(existsSync(TARGET_SCRIPT), `缺少靶窗口脚本 ${TARGET_SCRIPT}`);
	if (existsSync(RESULT_PATH)) unlinkSync(RESULT_PATH);

	// 本用例验证的是**旧的前台注入路径**（SendInput + 需要焦点），它天生要抢走
	// 用户的前台焦点与键盘——这与本插件「不抢鼠标键盘」的目标相悖，因此被
	// DSH_COMPUTER_USE_LIVE_INPUT 关在门后，只在无人使用电脑时手动跑。
	//
	// 后台路径（不碰光标、不抢前台）的验证在：
	//   scripts/verify-background-mode.mjs   真实窗口，5 条能力
	//   scripts/verify-no-activate.mjs       靶窗口确实不抢前台
	// 那两条才是本插件的主路径，日常验收跑它们即可。
	const target = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TARGET_SCRIPT, '-OutPath', RESULT_PATH, '-Title', TARGET_TITLE, '-Activate'], { stdio: 'ignore' });

	try {
		// 靶窗口自建后自行激活；这里等它出现
		const koffi = await import('koffi');
		const user32 = koffi.load('user32.dll');
		const findWindow = user32.func('void *FindWindowW(const char16_t *lpClassName, const char16_t *lpWindowName)');
		const getWindowRect = user32.func('int GetWindowRect(void *hWnd, _Out_ void *lpRect)');

		let handle = null;
		for (let attempt = 0; attempt < 80 && handle == null; attempt += 1) {
			await sleep(250);
			handle = findWindow(null, TARGET_TITLE);
		}
		assert.ok(handle != null, '靶窗口未出现');

		await sleep(800);
		const win32 = await loadWin32();
		await settleKeyboardTarget(win32, 2000);

		// 靶窗口置顶，因此点击一定落在它身上；文本框填满客户区
		const buffer = Buffer.alloc(16);
		getWindowRect(handle, buffer);
		const rect = { left: buffer.readInt32LE(0), top: buffer.readInt32LE(4), right: buffer.readInt32LE(8), bottom: buffer.readInt32LE(12) };
		const centreX = Math.round((rect.left + rect.right) / 2);
		const centreY = Math.round((rect.top + rect.bottom) / 2);

		await click(win32, MOUSE_BUTTONS.left, 1, { x: centreX, y: centreY }, 60);
		await settleKeyboardTarget(win32, 2000);

		const line1 = 'Hello 中文测试 123 !@#';
		await typeText(win32, line1, 8, 12);
		pressChord(win32, parseChord('Return'));
		await typeText(win32, 'second line ěščř', 8, 12);
		await sleep(700);

		const observed = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(RESULT_PATH, 'utf8')));
		assert.equal(observed.text, `${line1}\r\nsecond line ěščř`, '靶窗口收到的文本应与注入完全一致');
		assert.ok(observed.mouseDown.length > 0, '靶窗口应记录到鼠标按下');
		assert.ok(observed.keyDown.length > 0, '靶窗口应记录到键盘事件');
	} finally {
		target.kill();
		await sleep(300);
	}
});

test('输入注入：键盘事件在焦点未稳定时不会提前送出', { skip: !LIVE || process.env.DSH_COMPUTER_USE_LIVE_INPUT !== '1' }, async () => {
	const win32 = await loadWin32();
	const started = Date.now();
	const settled = await settleKeyboardTarget(win32, 400);
	assert.ok(settled.foreground !== 0n, '应能读到稳定的前台窗口');
	assert.ok(settled.focus !== 0n, '应能读到持有焦点的控件——这才是键盘输入的投递目标');
	assert.ok(Date.now() - started <= 1200, '焦点稳定检测不应无谓地消耗满超时');
});

/**
 * 真实原生层的命中测试回归。
 *
 * 这条测试的存在理由很具体：`ChildWindowFromPointEx` 的 `POINT` 是**按值传递**的结构体，
 * 一旦把绑定签名写成 `(hWnd, int32 x, int32 y, uint32 flags)`，x64 下寄存器会整体错位，
 * 函数返回一个无意义的句柄——而且不报错。
 *
 * 这种错误**单元测试永远抓不到**：假 Windows 是按声明的签名实现的，怎么声明它都"对"。
 * 只有真实调用才能暴露它。所以它必须留在这里，而不是留在单元测试里。
 */
test('命中测试：真实调用的 childWindowFromPoint 能找到已知的子控件', { skip: !LIVE }, async () => {
	const TARGET = join(PROJECT, 'test', 'helpers', 'background-target.ps1');
	const OUT = join(PROJECT, 'test', 'helpers', 'live-hittest-result.json');
	if (existsSync(OUT)) unlinkSync(OUT);

	// 不加 -Activate：本用例不验证输入，不需要抢焦点
	const target = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TARGET, '-OutPath', OUT, '-Title', 'DSH-HITTEST-TARGET', '-Left', '200', '-Top', '160'], { stdio: 'ignore' });

	try {
		let state = null;
		for (let attempt = 0; attempt < 60 && state === null; attempt += 1) {
			await sleep(300);
			if (!existsSync(OUT)) continue;
			try {
				const parsed = JSON.parse(readFileSync(OUT, 'utf8'));
				// 客户区为 0 说明窗口还没显示出来，此时命中测试没有意义
				if (parsed.form && parsed.rect?.width > 0) state = parsed;
			} catch {
				// 靶窗口持续覆写该文件，撞上半写状态就重试
			}
		}
		assert.ok(state !== null, '靶窗口未就绪');

		const win32 = await loadWin32();
		const frame = BigInt(state.form);
		const button = BigInt(state.button);
		const box = BigInt(state.box);

		// 靶脚本把按钮放在窗体客户区 (30,30)、尺寸 180x70，文本框在 (30,130)
		const onButton = win32.childWindowFromPoint(frame, 120, 65);
		assert.equal(onButton, button, '落点应命中的是按钮子控件（绑定签名写错时会返回无意义句柄，这条就会红）');

		const onBox = win32.childWindowFromPoint(frame, 260, 190);
		assert.equal(onBox, box, '落点应命中的是文本框子控件');
	} finally {
		target.kill();
		await sleep(300);
		if (existsSync(OUT)) unlinkSync(OUT);
	}
});