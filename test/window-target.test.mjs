/**
 * `window-target.ts` 的单元测试：把「一个窗口句柄」解析成「后台模式真正能操作的目标」。
 *
 * 这里不碰真实桌面——原生层由 test/doubles/koffi/index.js 的假 Windows 承接
 * （node_modules/koffi 是它的联接，见 scripts/link-doubles.mjs），
 * 它把窗口树暴露在 `globalThis.__koffiStub`（即 `stub`）。因此本测试验证的是
 * 插件自己的判定逻辑与坐标换算：窗口种类判定、Chromium 渲染子窗口的选取、
 * 图像坐标 → 客户区坐标的三段换算、以及 lParam 的 16 位打包。
 *
 * 全部期望值都用具体数字手写并手算核对，而不是调用被测函数自己算，
 * 否则就成了把实现照抄一遍的同义反复。
 *
 * 跳到非 Windows 平台时整体跳过：插件本身也只实现了 Windows 后端。
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { stub } from 'koffi';
import {
	classifyWindow,
	resolveTargetWindow,
	imagePointToClient,
	clientPointToScreen,
	makeMouseLParam,
	describeTarget,
} from '../lib/window-target.js';
import { loadWin32 } from '../lib/win32.js';

const WINDOWS = process.platform === 'win32';

/** 每个用例重新加载的原生绑定；stub 复用同一棵窗口树。 */
let win32;

beforeEach(() => {
	stub.calls.length = 0;
	stub.functions.clear();
	stub.foreground = 0x2000n;
	stub.windowTitle = 'Notepad';
	stub.windowClass = 'Notepad';
	stub.screen = { x: 0, y: 0, width: 1600, height: 900, monitors: 1 };
	stub.inputStructSize = 40;
	stub.resetWindows();
});

if (WINDOWS) {
	// loadWin32 内部会 import koffi（被替换成假实现），并缓存 Win32 绑定。
	win32 = await loadWin32();
}

// ---- classifyWindow -------------------------------------------------------

test('classifyWindow 识别 Chromium / Electron 系类名，大小写不敏感', { skip: !WINDOWS }, () => {
	// Chrome_WidgetWin_1 是 Chrome 与 Electron 的顶层窗口类
	assert.equal(classifyWindow('Chrome_WidgetWin_1'), 'chromium');
	// Electron 会把窗口类写成带 electron 的变体
	assert.equal(classifyWindow('Electron_WidgetWin_1'), 'chromium');
	assert.equal(classifyWindow('chromium.RenderWidgetHostHWND'), 'chromium');
	// 大小写不敏感：正则带了 i 标志
	assert.equal(classifyWindow('CHROME_WIDGETWIN_1'), 'chromium');
	assert.equal(classifyWindow('eLeCtRoN'), 'chromium');
});

test('classifyWindow 把其余类名判为 gdi', { skip: !WINDOWS }, () => {
	assert.equal(classifyWindow('Notepad'), 'gdi');
	// WindowsForms10.BUTTON.app.0.xxx 是 WinForms 控件，属于经典 GDI 通道
	assert.equal(classifyWindow('WindowsForms10.BUTTON.app.0.141b42a_r8_ad1'), 'gdi');
	assert.equal(classifyWindow(''), 'gdi');
});

// ---- resolveTargetWindow：Chromium 分支 --------------------------------

/** 造一棵 Chromium 顶层窗口 + 若干渲染子窗口的树，返回顶层句柄。 */
function makeChromiumTree({ minimized = false, visible = true, withSurface = true } = {}) {
	const frame = 0x4000n;
	stub.defineWindow(frame, {
		parent: null,
		className: 'Chrome_WidgetWin_1',
		title: 'Chrome',
		frame: { left: 50, top: 40, width: 1200, height: 800 },
		clientOffset: { x: 8, y: 31 },
		clientSize: { width: 1184, height: 761 },
		visible,
		pid: 7001,
	});
	if (withSurface) {
		// 真实 Chromium 会同时建出若干辅助渲染窗口；这里只放一个正常的，
		// 尺寸 >= 64 才能通过 MIN_SURFACE_EDGE 门槛。
		// 渲染子窗口填满顶层窗口的客户区，因此它的客户区原点同样落在 (58,71)。
		stub.defineWindow(0x4100n, {
			parent: frame,
			className: 'Chrome_RenderWidgetHostHWND',
			frame: { left: 50, top: 40, width: 1184, height: 761 },
			clientOffset: { x: 8, y: 31 },
			clientSize: { width: 1184, height: 761 },
		});
	}
	// 最小化与否走 IsIconic；stub 默认返回 0（未最小化），需要时覆盖
	if (minimized) {
		stub.functions.set('IsIconic', () => 1);
	}
	return frame;
}

test('Chromium 窗口的 surfaceHandle 是渲染子窗口，客户区原点 = frame 原点 + clientOffset', { skip: !WINDOWS }, () => {
	const frame = makeChromiumTree();

	const result = resolveTargetWindow(win32, frame);
	assert.equal(result.ok, true);
	assert.equal(result.target.kind, 'chromium');
	assert.equal(result.target.frameHandle, frame);
	assert.equal(result.target.surfaceHandle, 0x4100n);

	// frame 原点 (50,40) + clientOffset (8,31) → 客户区屏幕原点 (58,71)。
	// 这是最容易整体偏移的一处：clientToScreen 已经把 clientOffset 加进去了，
	// 客户区原点必须等于 frame 原点 + clientOffset，而不是 frame 原点。
	assert.equal(result.target.client.x, 58);
	assert.equal(result.target.client.y, 71);
	assert.equal(result.target.client.width, 1184);
	assert.equal(result.target.client.height, 761);

	assert.equal(result.target.title, 'Chrome');
	assert.equal(result.target.processId, 7001);
	assert.equal(result.target.dpi, 96);
});

test('有多个渲染子窗口时必须选面积最大的（小窗口/零尺寸辅助窗口存在时仍选大的）', { skip: !WINDOWS }, () => {
	const frame = 0x4000n;
	stub.defineWindow(frame, {
		parent: null,
		className: 'Chrome_WidgetWin_1',
		title: 'Chrome',
		frame: { left: 0, top: 0, width: 1000, height: 700 },
		clientOffset: { x: 0, y: 0 },
		clientSize: { width: 1000, height: 700 },
	});

	// 实测踩过的坑：Chromium 会同时建出 12x10、0x0 这类辅助窗口，
	// 误选它们会拿到一张空白图。必须挑面积最大的渲染表面。
	stub.defineWindow(0x5100n, {
		parent: frame,
		className: 'Chrome_RenderWidgetHostHWND',
		clientSize: { width: 1000, height: 700 }, // 面积 700000，真正的渲染表面
	});
	stub.defineWindow(0x5101n, {
		parent: frame,
		className: 'Chrome_RenderWidgetHostHWND',
		clientSize: { width: 12, height: 10 }, // 面积 120，辅助窗口（且 < 64 被门槛过滤）
	});
	// 0x0 的辅助窗口同样存在；面积 0
	stub.defineWindow(0x5102n, {
		parent: frame,
		className: 'Chrome_RenderWidgetHostHWND',
		clientSize: { width: 0, height: 0 },
	});

	const result = resolveTargetWindow(win32, frame);
	assert.equal(result.ok, true);
	assert.equal(result.target.surfaceHandle, 0x5100n, '应选面积最大的渲染表面');
});

test('渲染子窗口嵌在更深的层级里也能被找到', { skip: !WINDOWS }, () => {
	const frame = 0x4000n;
	stub.defineWindow(frame, {
		parent: null,
		className: 'Chrome_WidgetWin_1',
		title: 'Chrome',
		frame: { left: 0, top: 0, width: 1000, height: 700 },
		clientOffset: { x: 0, y: 0 },
		clientSize: { width: 1000, height: 700 },
	});
	// 中间层：Intermediate D3D Window（不是投递目标，但会挡住直接子窗口的枚举）
	const intermediate = 0x5200n;
	stub.defineWindow(intermediate, {
		parent: frame,
		className: 'Intermediate D3D Window',
		clientSize: { width: 1000, height: 700 },
	});
	// 真正的渲染表面嵌在中间层之下，而不是顶层窗口的直接子窗口
	stub.defineWindow(0x5300n, {
		parent: intermediate,
		className: 'Chrome_RenderWidgetHostHWND',
		clientSize: { width: 1000, height: 700 },
	});

	const result = resolveTargetWindow(win32, frame);
	assert.equal(result.ok, true);
	assert.equal(result.target.surfaceHandle, 0x5300n, '应逐层深入找到深层渲染表面');
});

test('找不到渲染子窗口时返回 ok:false，最小化与从未呈现给出不同 hint', { skip: !WINDOWS }, () => {
	// 未最小化：hint 指向「从未呈现」
	const frame = makeChromiumTree({ minimized: false, withSurface: false });
	const notMinimized = resolveTargetWindow(win32, frame);
	assert.equal(notMinimized.ok, false);
	assert.match(notMinimized.reason, /没有找到渲染表面/u);
	assert.match(notMinimized.hint, /从未真正显示|从未呈现/u);
	assert.doesNotMatch(notMinimized.hint, /最小化/u);

	// 最小化：hint 指向「先还原窗口」
	stub.resetWindows();
	const minimized = makeChromiumTree({ minimized: true, withSurface: false });
	const result = resolveTargetWindow(win32, minimized);
	assert.equal(result.ok, false);
	assert.match(result.reason, /没有找到渲染表面/u);
	assert.match(result.hint, /最小化/u);
});

// ---- resolveTargetWindow：GDI 分支与失败路径 ---------------------------

test('GDI 窗口的 surfaceHandle 等于顶层句柄', { skip: !WINDOWS }, () => {
	stub.defineWindow(0x6000n, {
		parent: null,
		className: 'Notepad',
		title: '记事本',
		frame: { left: 100, top: 80, width: 800, height: 600 },
		clientOffset: { x: 6, y: 28 },
		clientSize: { width: 788, height: 566 },
		pid: 8001,
	});

	const result = resolveTargetWindow(win32, 0x6000n);
	assert.equal(result.ok, true);
	assert.equal(result.target.kind, 'gdi');
	assert.equal(result.target.frameHandle, 0x6000n);
	assert.equal(result.target.surfaceHandle, 0x6000n, 'GDI 窗口没有独立渲染表面，surface 就是顶层句柄');
	assert.equal(result.target.client.x, 106); // 100 + 6
	assert.equal(result.target.client.y, 108); // 80 + 28
});

test('句柄为 0n 时返回明确失败', { skip: !WINDOWS }, () => {
	const result = resolveTargetWindow(win32, 0n);
	assert.equal(result.ok, false);
	assert.match(result.reason, /没有可用的窗口句柄/u);
	assert.ok(result.hint.length > 0);
});

test('句柄不在窗口树里时返回明确失败', { skip: !WINDOWS }, () => {
	// 0x9999n 从未被 defineWindow 登记；真实系统里 GetWindowRect 对失效句柄
	// 返回 0，windowInfo 据此判 undefined。stub 默认对未登记句柄回落成整块屏幕，
	// 因此这里覆盖 GetWindowRect，模拟「句柄已失效、读不到窗口矩形」。
	stub.functions.set('GetWindowRect', (handle) => (handle === 0x9999n ? 0 : 1));
	const result = resolveTargetWindow(win32, 0x9999n);
	assert.equal(result.ok, false);
	assert.match(result.reason, /已失效或无法读取/u);
});

test('客户区尺寸为 0 时返回明确失败', { skip: !WINDOWS }, () => {
	stub.defineWindow(0x7000n, {
		parent: null,
		className: 'Notepad',
		title: '空窗口',
		frame: { left: 0, top: 0, width: 0, height: 0 },
		clientOffset: { x: 0, y: 0 },
		clientSize: { width: 0, height: 0 },
	});

	const result = resolveTargetWindow(win32, 0x7000n);
	assert.equal(result.ok, false);
	assert.match(result.reason, /客户区尺寸无效/u);
});

// ---- imagePointToClient --------------------------------------------------

test('imagePointToClient 缩放为 1 时图像坐标即客户区偏移（原点相减）', { skip: !WINDOWS }, () => {
	// 截取区域原点 (0,0)，客户区原点 (58,71)，scale 1
	const mapping = { imageWidth: 1184, imageHeight: 761, originX: 0, originY: 0, scale: 1 };
	const client = { x: 58, y: 71, width: 1184, height: 761 };
	// 图像点 (100,200) → 屏幕 (100,200) → 客户区 (42,129)
	assert.deepEqual(imagePointToClient({ x: 100, y: 200 }, mapping, client), { x: 42, y: 129 });
});

test('imagePointToClient 缩放不为 1 时先除以缩放比', { skip: !WINDOWS }, () => {
	// scale 0.5：截图被降采样到一半，图像坐标要先 ÷0.5（即 ×2）回到屏幕坐标
	const mapping = { imageWidth: 592, imageHeight: 380, originX: 0, originY: 0, scale: 0.5 };
	const client = { x: 0, y: 0, width: 1184, height: 761 };
	// 图像点 (50,100) → 屏幕 (100,200) → 客户区 (100,200)
	assert.deepEqual(imagePointToClient({ x: 50, y: 100 }, mapping, client), { x: 100, y: 200 });
});

test('imagePointToClient 截取区域原点不为 0 时叠加偏移', { skip: !WINDOWS }, () => {
	// 截取的是屏幕上从 (100,50) 开始的一块
	const mapping = { imageWidth: 400, imageHeight: 300, originX: 100, originY: 50, scale: 1 };
	const client = { x: 0, y: 0, width: 400, height: 300 };
	// 图像点 (10,20) → 屏幕 (110,70) → 客户区 (110,70)
	assert.deepEqual(imagePointToClient({ x: 10, y: 20 }, mapping, client), { x: 110, y: 70 });
});

test('imagePointToClient 客户区原点不为 0 时减去客户区原点', { skip: !WINDOWS }, () => {
	const mapping = { imageWidth: 1184, imageHeight: 761, originX: 0, originY: 0, scale: 1 };
	const client = { x: 58, y: 71, width: 1184, height: 761 };
	// 图像点 (58,71) 正好落在客户区原点 → 客户区坐标 (0,0)
	assert.deepEqual(imagePointToClient({ x: 58, y: 71 }, mapping, client), { x: 0, y: 0 });
});

test('imagePointToClient 缩放、截取原点、客户区原点三者叠加', { skip: !WINDOWS }, () => {
	// 最完整的链路：截图从屏幕 (100,50) 抓起，缩放到 0.5，客户区原点 (58,71)
	const mapping = { imageWidth: 592, imageHeight: 380, originX: 100, originY: 50, scale: 0.5 };
	const client = { x: 58, y: 71, width: 1184, height: 761 };
	// 图像点 (40,60)：
	//   屏幕 X = 100 + 40/0.5 = 100 + 80 = 180
	//   屏幕 Y = 50 + 60/0.5  = 50 + 120 = 170
	//   客户区 X = 180 - 58 = 122，客户区 Y = 170 - 71 = 99
	assert.deepEqual(imagePointToClient({ x: 40, y: 60 }, mapping, client), { x: 122, y: 99 });
});

test('imagePointToClient 非整数除结果按四舍五入取整', { skip: !WINDOWS }, () => {
	// scale 0.4：除以缩放比会产生小数，最终应四舍五入到最近的整数
	const mapping = { imageWidth: 100, imageHeight: 100, originX: 0, originY: 0, scale: 0.4 };
	const client = { x: 0, y: 0, width: 250, height: 250 };
	// 图像点 (1,0)：屏幕 X = 1/0.4 = 2.5 → round 3
	// 图像点 (3,0)：屏幕 X = 3/0.4 = 7.5 → round 8（.5 向上取整）
	assert.deepEqual(imagePointToClient({ x: 1, y: 0 }, mapping, client), { x: 3, y: 0 });
	assert.deepEqual(imagePointToClient({ x: 3, y: 0 }, mapping, client), { x: 8, y: 0 });
});

// ---- clientPointToScreen --------------------------------------------------

test('clientPointToScreen 把客户区坐标加回客户区原点', { skip: !WINDOWS }, () => {
	const client = { x: 58, y: 71, width: 1184, height: 761 };
	// 客户区 (0,0) → 屏幕 (58,71)
	assert.deepEqual(clientPointToScreen({ x: 0, y: 0 }, client), { x: 58, y: 71 });
	// 客户区 (100,200) → 屏幕 (158,271)
	assert.deepEqual(clientPointToScreen({ x: 100, y: 200 }, client), { x: 158, y: 271 });
});

// ---- makeMouseLParam ------------------------------------------------------

test('makeMouseLParam 低 16 位是 x、高 16 位是 y', { skip: !WINDOWS }, () => {
	const lParam = makeMouseLParam({ x: 0x1234, y: 0xabcd });
	assert.equal(lParam & 0xffff, 0x1234, '低 16 位应是 x');
	assert.equal((lParam >>> 16) & 0xffff, 0xabcd, '高 16 位应是 y');
	// 实现末尾的 | 0 强制成有符号 32 位，所以完整值按无符号读回才是 0xabcd1234
	assert.equal(lParam >>> 0, 0xabcd1234);
});

test('makeMouseLParam 负坐标与超界值不污染另一个分量', { skip: !WINDOWS }, () => {
	// 负 x：-1 的补码 0xffff，应留在低 16 位，高 16 位是 y 不受影响
	const neg = makeMouseLParam({ x: -1, y: 0x0011 });
	assert.equal(neg & 0xffff, 0xffff, '低 16 位是 -1 的补码');
	assert.equal((neg >>> 16) & 0xffff, 0x0011, '高 16 位仍应是 y，不被负 x 污染');

	// 超界 x：0x12345 只保留低 16 位 0x2345，y 不受影响
	const overflow = makeMouseLParam({ x: 0x12345, y: 0x0002 });
	assert.equal(overflow & 0xffff, 0x2345, '超界 x 被截断到低 16 位');
	assert.equal((overflow >>> 16) & 0xffff, 0x0002, '高 16 位仍应是 y');

	// 超界 y：0x1_0001 只保留低 16 位 0x0001，x 不受影响
	const overflowY = makeMouseLParam({ x: 0x0005, y: 0x10001 });
	assert.equal(overflowY & 0xffff, 0x0005, '低 16 位仍应是 x');
	assert.equal((overflowY >>> 16) & 0xffff, 0x0001, '超界 y 被截断到高 16 位');
});

// ---- describeTarget -------------------------------------------------------

test('describeTarget 区分 Chromium 与 GDI 措辞，并标注最小化/不可见', { skip: !WINDOWS }, () => {
	const base = {
		frameHandle: 0x4000n,
		surfaceHandle: 0x4100n,
		title: 'Chrome',
		className: 'Chrome_WidgetWin_1',
		processId: 7001,
		frame: { x: 50, y: 40, width: 1200, height: 800 },
		client: { x: 58, y: 71, width: 1184, height: 761 },
		dpi: 96,
	};

	const chromium = describeTarget({ ...base, kind: 'chromium', visible: true, minimized: false });
	assert.match(chromium, /Chromium\/Electron/u);
	assert.match(chromium, /渲染子窗口/u);
	assert.match(chromium, /1184x761/u);
	assert.doesNotMatch(chromium, /已最小化|不可见/u);

	const gdi = describeTarget({ ...base, kind: 'gdi', className: 'Notepad', title: '记事本', visible: true, minimized: false });
	assert.match(gdi, /普通 Win32 窗口/u);
	assert.doesNotMatch(gdi, /渲染子窗口/u);

	// 最小化 + 不可见同时出现，两个标志都要在描述里
	const flagged = describeTarget({ ...base, kind: 'gdi', visible: false, minimized: true });
	assert.match(flagged, /已最小化/u);
	assert.match(flagged, /不可见/u);
});
