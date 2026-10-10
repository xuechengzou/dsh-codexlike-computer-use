/**
 * `input-background.ts` 的单元测试：后台点击与打字的消息序列。
 *
 * 断言的核心是 **PostMessageW 的调用序列**（顺序、消息号、wParam、lParam 的
 * 坐标打包）—— 这是后台输入最有价值的验证点：消息打错句柄、坐标打包错 16 位、
 * 代理对漏投低代理，都无法从返回值看出来，只能从调用序列看出来。
 *
 * 原生层由 test/doubles/koffi/index.js 的假 Windows 承接（node_modules/koffi 是它的
 * 联接，见 scripts/link-doubles.mjs）。PostMessageW 的
 * 默认实现只返回 1（成功），因此用 stub.functions.set 记录每次调用的参数。
 * 全部期望值手算，不调用被测函数自己算。
 *
 * 跳到非 Windows 平台时整体跳过。
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { stub } from 'koffi';
import { backgroundClick, backgroundType, resolveTextTarget } from '../lib/input-background.js';
import { loadWin32 } from '../lib/win32.js';

const WINDOWS = process.platform === 'win32';

let win32;

/** PostMessageW 的参数记录；由 stub.functions.set 写入。 */
const posted = [];

beforeEach(() => {
	stub.calls.length = 0;
	stub.functions.clear();
	stub.foreground = 0x2000n;
	stub.windowTitle = 'Notepad';
	stub.windowClass = 'Notepad';
	stub.screen = { x: 0, y: 0, width: 1600, height: 900, monitors: 1 };
	stub.resetWindows();
	posted.length = 0;
	sent.length = 0;
	// 默认 PostMessageW 成功入队；这里顺手把参数抄下来供断言。
	// 返回 1 表示投递成功，与真实系统一致。
	stub.functions.set('PostMessageW', (hwnd, msg, wParam, lParam) => {
		posted.push({ hwnd, msg, wParam, lParam });
		return 1;
	});
});

if (WINDOWS) {
	win32 = await loadWin32();
}

/** 造一个 Chromium 顶层窗口 + 渲染子窗口的树，返回解析好的 target。 */
function makeChromiumTarget() {
	const frame = 0x4000n;
	stub.defineWindow(frame, {
		parent: null,
		className: 'Chrome_WidgetWin_1',
		title: 'Chrome',
		frame: { left: 50, top: 40, width: 1200, height: 800 },
		clientOffset: { x: 8, y: 31 },
		clientSize: { width: 1184, height: 761 },
	});
	stub.defineWindow(0x4100n, {
		parent: frame,
		className: 'Chrome_RenderWidgetHostHWND',
		frame: { left: 50, top: 40, width: 1184, height: 761 },
		clientOffset: { x: 8, y: 31 },
		clientSize: { width: 1184, height: 761 },
	});
	// 直接构造 target 对象（不经 resolveTargetWindow，那不是本模块的被测对象）
	return {
		frameHandle: frame,
		surfaceHandle: 0x4100n,
		kind: 'chromium',
		title: 'Chrome',
		className: 'Chrome_WidgetWin_1',
		processId: 7001,
		frame: { x: 50, y: 40, width: 1200, height: 800 },
		client: { x: 58, y: 71, width: 1184, height: 761 },
		dpi: 96,
		visible: true,
		minimized: false,
	};
}

/** 造一个 GDI 目标（surfaceHandle 等于顶层句柄）。 */
function makeGdiTarget() {
	return {
		frameHandle: 0x6000n,
		surfaceHandle: 0x6000n,
		kind: 'gdi',
		title: '记事本',
		className: 'Notepad',
		processId: 8001,
		frame: { x: 100, y: 80, width: 800, height: 600 },
		client: { x: 106, y: 108, width: 788, height: 566 },
		dpi: 96,
		visible: true,
		minimized: false,
	};
}

// ---- backgroundClick：Chromium --------------------------------------------

test('Chromium 点击：三条消息的顺序与消息号，打到 surfaceHandle 而非 frameHandle', { skip: !WINDOWS }, () => {
	const target = makeChromiumTarget();
	const result = backgroundClick(win32, target, { x: 308, y: 241 });

	// 308 | (241 << 16) = 0x00F1_0134
	//   308 = 0x0134（低 16 位 x），241 = 0x00F1（高 16 位 y）
	const expectedLParam = (241 * 0x10000) + 308;

	assert.deepEqual(
		posted.map((call) => [call.hwnd, call.msg, call.wParam, call.lParam]),
		[
			// WM_MOUSEMOVE(0x200)：无按键状态
			[0x4100n, 0x200, 0, expectedLParam],
			// WM_LBUTTONDOWN(0x201)：wParam 带 MK_LBUTTON(1)
			[0x4100n, 0x201, 1, expectedLParam],
			// WM_LBUTTONUP(0x202)：按键已松开，wParam 回 0
			[0x4100n, 0x202, 0, expectedLParam],
		],
		'消息顺序必须是 MOVE → DOWN → UP，且全部打到渲染子窗口',
	);

	// 每一条都必须打到 surfaceHandle（0x4100），绝不能打到 frameHandle（0x4000）：
	// 打到顶层 Chrome_WidgetWin_1 实测毫无反应。
	for (const call of posted) {
		assert.notEqual(call.hwnd, 0x4000n, '不得把鼠标消息打到 Chromium 顶层窗口');
		assert.equal(call.hwnd, 0x4100n);
	}

	assert.equal(result.delivered, 3);
	assert.equal(result.reliable, true, 'Chromium 目标的点击应报告为可靠');
});

test('Chromium 点击：lParam 坐标打包用具体数字手算验证', { skip: !WINDOWS }, () => {
	const target = makeChromiumTarget();
	backgroundClick(win32, target, { x: 0x1234, y: 0x00ab });
	// 低 16 位 x = 0x1234，高 16 位 y = 0x00ab → lParam = 0x00ab1234
	const lParam = posted[0].lParam;
	assert.equal(lParam & 0xffff, 0x1234, '低 16 位应是 x');
	assert.equal((lParam >>> 16) & 0xffff, 0x00ab, '高 16 位应是 y');
	assert.equal(lParam >>> 0, 0x00ab1234, '完整值按无符号读回应是 0x00ab1234');
});

// ---- backgroundClick：GDI --------------------------------------------------

test('GDI 点击：消息照投但必须报告 reliable=false（不在前台时实测无效）', { skip: !WINDOWS }, () => {
	const target = makeGdiTarget();
	const result = backgroundClick(win32, target, { x: 10, y: 20 });

	// lParam = 20 << 16 | 10 = 0x0014_000A
	const expectedLParam = (20 * 0x10000) + 10;
	assert.deepEqual(
		posted.map((call) => [call.hwnd, call.msg, call.wParam, call.lParam]),
		[
			[0x6000n, 0x200, 0, expectedLParam],
			[0x6000n, 0x201, 1, expectedLParam],
			[0x6000n, 0x202, 0, expectedLParam],
		],
		'GDI 窗口同样投递完整序列，打到顶层句柄（surface === frame）',
	);

	assert.equal(result.delivered, 3);
	assert.equal(result.reliable, false, 'GDI 目标的点击必须显式报告不可靠');
	assert.ok(result.note.length > 0, '不可靠时必须给出说明，而不是假装成功');
});

// ---- backgroundClick：GDI 按钮命中测试（本次修复的核心） ------------------

/** 记录 SendMessageW 的调用参数，供按钮路径断言。 */
const sent = [];

/**
 * 造一个 GDI 顶层窗口（0x6000，客户区原点屏幕 (106,108)，788x566），
 * 并按传入的子控件清单登记子窗口；返回 makeGdiTarget()。
 * 子控件 frame 用屏幕坐标（与 defineWindow 语义一致）。
 */
function makeGdiTargetWithControls(controls) {
	stub.defineWindow(0x6000n, {
		parent: null,
		className: 'Notepad',
		title: '记事本',
		frame: { left: 100, top: 80, width: 800, height: 600 },
		clientOffset: { x: 6, y: 28 },
		clientSize: { width: 788, height: 566 },
	});
	for (const control of controls) stub.defineWindow(control.handle, control.options);
	stub.functions.set('SendMessageW', (hwnd, msg, wParam, lParam) => {
		sent.push({ hwnd, msg, wParam, lParam });
		return 1n;
	});
	return makeGdiTarget();
}

test('GDI 点击（核心修复）：落点命中 Button 子控件时改发 SendMessage(BM_CLICK)，不发 WM_LBUTTONDOWN', { skip: !WINDOWS }, () => {
	// 按钮在屏幕 (106,108) 起、788x566，即铺满客户区；客户区 (10,20) 必命中
	const target = makeGdiTargetWithControls([{
		handle: 0x6100n,
		options: {
			parent: 0x6000n,
			className: 'Button',
			title: '确定',
			frame: { left: 106, top: 108, width: 788, height: 566 },
			clientSize: { width: 788, height: 566 },
		},
	}]);

	const result = backgroundClick(win32, target, { x: 10, y: 20 });

	assert.deepEqual(
		sent.map((call) => [call.hwnd, call.msg, call.wParam, call.lParam]),
		[[0x6100n, 0x00f5, 0, 0]],
		'必须对按钮控件本身发 SendMessage(BM_CLICK, 0, 0)',
	);
	assert.equal(posted.length, 0, '命中按钮时不得再投递任何模拟鼠标消息（含 WM_LBUTTONDOWN）');
	assert.equal(result.reliable, true, 'BM_CLICK 实测生效，应报告为可靠');
	assert.match(result.note, /BM_CLICK/u);
	assert.match(result.note, /0x6100|24832/u, 'note 里写明实际点击的句柄');
});

test('GDI 点击：落点命中非按钮控件（Edit）时仍走鼠标三连且 reliable=false', { skip: !WINDOWS }, () => {
	const target = makeGdiTargetWithControls([{
		handle: 0x6100n,
		options: {
			parent: 0x6000n,
			className: 'Edit',
			frame: { left: 106, top: 108, width: 788, height: 566 },
			clientSize: { width: 788, height: 566 },
		},
	}]);

	const result = backgroundClick(win32, target, { x: 10, y: 20 });

	assert.equal(sent.length, 0, '非按钮控件不得发 BM_CLICK');
	assert.deepEqual(
		posted.map((call) => call.msg),
		[0x200, 0x201, 0x202],
		'落点不是按钮类控件时回落到鼠标三连',
	);
	for (const call of posted) assert.equal(call.hwnd, 0x6000n);
	assert.equal(result.reliable, false);
});

test('GDI 点击：落点不在任何子控件上（窗口空白处）时回落到鼠标消息', { skip: !WINDOWS }, () => {
	// 按钮只占客户区左上角 100x30（屏幕 (106,108)~(206,138)）；
	// 点击客户区 (400,300) 在按钮之外
	const target = makeGdiTargetWithControls([{
		handle: 0x6100n,
		options: {
			parent: 0x6000n,
			className: 'Button',
			frame: { left: 106, top: 108, width: 100, height: 30 },
			clientSize: { width: 100, height: 30 },
		},
	}]);

	const result = backgroundClick(win32, target, { x: 400, y: 300 });

	assert.equal(sent.length, 0);
	assert.deepEqual(posted.map((call) => call.msg), [0x200, 0x201, 0x202]);
	for (const call of posted) assert.equal(call.hwnd, 0x6000n);
	assert.equal(result.reliable, false);
});

test('GDI 点击（核心修复）：按钮嵌在更深的层级里也能被命中测试找到', { skip: !WINDOWS }, () => {
	// WinForms 常见形态：按钮藏在中间容器（0x6400）之下
	const target = makeGdiTargetWithControls([
		{
			handle: 0x6400n,
			options: {
				parent: 0x6000n,
				className: 'WindowsForms10.Window.8.app.0.141b42a_r8_ad1',
				frame: { left: 106, top: 108, width: 788, height: 566 },
				clientSize: { width: 788, height: 566 },
			},
		},
		{
			handle: 0x6500n,
			options: {
				parent: 0x6400n,
				className: 'WindowsForms10.BUTTON.app.0.141b42a_r8_ad1',
				frame: { left: 106, top: 108, width: 788, height: 566 },
				clientSize: { width: 788, height: 566 },
			},
		},
	]);

	const result = backgroundClick(win32, target, { x: 10, y: 20 });

	assert.deepEqual(
		sent.map((call) => [call.hwnd, call.msg]),
		[[0x6500n, 0x00f5]],
		'必须穿过中间容器命中最深层的 WinForms 按钮',
	);
	assert.equal(posted.length, 0);
	assert.equal(result.reliable, true);
});

test('GDI 点击（核心修复）：不可见的按钮控件不应被命中', { skip: !WINDOWS }, () => {
	// 唯一的按钮不可见：BM_CLICK 投给它同样不生效，命中测试必须跳过它
	//（与 resolveTextTarget 只选可见的理由一致）
	const target = makeGdiTargetWithControls([{
		handle: 0x6100n,
		options: {
			parent: 0x6000n,
			className: 'Button',
			visible: false,
			frame: { left: 106, top: 108, width: 788, height: 566 },
			clientSize: { width: 788, height: 566 },
		},
	}]);

	const result = backgroundClick(win32, target, { x: 10, y: 20 });

	assert.equal(sent.length, 0, '不可见按钮不得收到 BM_CLICK');
	assert.deepEqual(posted.map((call) => call.msg), [0x200, 0x201, 0x202]);
	assert.equal(result.reliable, false);
});

test('GDI 点击：非左键不走 BM_CLICK（避免右键静默退化成左键）', { skip: !WINDOWS }, () => {
	const target = makeGdiTargetWithControls([{
		handle: 0x6100n,
		options: {
			parent: 0x6000n,
			className: 'Button',
			frame: { left: 106, top: 108, width: 788, height: 566 },
			clientSize: { width: 788, height: 566 },
		},
	}]);

	const result = backgroundClick(win32, target, { x: 10, y: 20 }, 'right');

	assert.equal(sent.length, 0, '右键不得静默退化成 BM_CLICK 左键语义点击');
	assert.deepEqual(posted.map((call) => call.msg), [0x200, 0x204, 0x205]);
	assert.equal(result.reliable, false);
});

test('投递失败时 delivered 只统计成功的条数', { skip: !WINDOWS }, () => {
	const target = makeGdiTarget();
	// 第二条（WM_LBUTTONDOWN）入队失败：真实系统里队列满或句柄中途失效会出现 0
	let n = 0;
	stub.functions.set('PostMessageW', (hwnd, msg, wParam, lParam) => {
		posted.push({ hwnd, msg, wParam, lParam });
		n += 1;
		return n === 2 ? 0 : 1;
	});

	const result = backgroundClick(win32, target, { x: 0, y: 0 });
	assert.equal(result.delivered, 2, '三条里成功了两条');
	assert.equal(posted.length, 3, '失败不应中断后续投递');
});

// ---- backgroundType --------------------------------------------------------

test('代理对：投递 "𝄞"(U+1D11E) 送出两个 WM_CHAR，码元分别为 0xD834 与 0xDD1E', { skip: !WINDOWS }, () => {
	const target = makeChromiumTarget();
	// U+1D11E 在 UTF-16 里是高代理 0xD834 + 低代理 0xDD1E；
	// 只投高代理会把一个无效码元送进目标，emoji 处静默丢字。
	const result = backgroundType(win32, target, '𝄞');

	assert.deepEqual(
		posted.map((call) => [call.hwnd, call.msg, call.wParam, call.lParam]),
		[
			[0x4100n, 0x102, 0xd834, 0],
			[0x4100n, 0x102, 0xdd1e, 0],
		],
		'代理对必须拆成高低两个码元成对投递',
	);
	assert.equal(result.delivered, 2);
});

test('换行：发送 "a\\nb" 时第三个 WM_CHAR 的 wParam 是 0x0D 而不是 0x0A', { skip: !WINDOWS }, () => {
	const target = makeChromiumTarget();
	backgroundType(win32, target, 'a\nb');

	const wParams = posted.map((call) => call.wParam);
	assert.deepEqual(wParams, [0x61, 0x0d, 0x62], 'WM_CHAR 语义下文本框认 CR 而不是 LF');
	assert.equal(posted[0].msg, 0x102);
	assert.equal(posted[0].lParam, 0);
});

test('混合文本：ASCII + 中文 + 代理对 + 换行，码元总数正确', { skip: !WINDOWS }, () => {
	const target = makeChromiumTarget();
	// 'a' + '中' + '𝄞'（两个码元）+ '\n' → JS 字符串长度 5（𝄞 占 2）
	const text = 'a中𝄞\n';
	const result = backgroundType(win32, target, text);

	assert.equal(text.length, 5, '前置核对：𝄞 在 JS 字符串里占两个码元');
	assert.equal(posted.length, 5, '每个码元一条 WM_CHAR');
	assert.equal(result.delivered, 5);

	// 逐个手算：a=0x61，中=0x4E2D，𝄞=D834+DD1E，\n→CR=0x0D
	assert.deepEqual(
		posted.map((call) => call.wParam),
		[0x61, 0x4e2d, 0xd834, 0xdd1e, 0x0d],
	);
	// 全部打到 surfaceHandle
	for (const call of posted) assert.equal(call.hwnd, 0x4100n);
});

test('空字符串不投递任何消息', { skip: !WINDOWS }, () => {
	const target = makeChromiumTarget();
	const result = backgroundType(win32, target, '');
	assert.equal(posted.length, 0);
	assert.equal(result.delivered, 0);
});

test('GDI 打字：无文本控件时回落到顶层句柄，reliable=false 且 note 说明回落', { skip: !WINDOWS }, () => {
	const target = makeGdiTarget();
	const result = backgroundType(win32, target, 'hi');
	assert.equal(posted.length, 2);
	// 这个目标没有任何 Edit 类后代，只能回落到顶层句柄（surface === frame）
	assert.equal(posted[0].hwnd, 0x6000n, '找不到文本控件时回落到顶层句柄');
	assert.equal(posted[0].msg, 0x102);
	assert.equal(posted[0].wParam, 0x68);
	assert.equal(posted[1].wParam, 0x69);
	assert.equal(result.delivered, 2);
	assert.equal(result.reliable, false, '回落到顶层时键盘消息不会被处理，必须报告不可靠');
	assert.match(result.note, /回落/u, 'note 必须说明回落了，调用方才能判断该不该相信这次输入');
});

// ---- GDI 打字的控件寻址（本次修复的核心） --------------------------------

/** 造一个 GDI 顶层窗口（0x6000）+ 一个 Edit 子控件（0x6100），返回 target 与句柄。 */
function makeGdiTargetWithEdit({ edit = {} } = {}) {
	stub.defineWindow(0x6000n, {
		parent: null,
		className: 'Notepad',
		title: '记事本',
		frame: { left: 100, top: 80, width: 800, height: 600 },
		clientOffset: { x: 6, y: 28 },
		clientSize: { width: 788, height: 566 },
	});
	stub.defineWindow(0x6100n, {
		parent: 0x6000n,
		className: 'Edit',
		title: '',
		frame: { left: 106, top: 108, width: 788, height: 566 },
		clientOffset: { x: 0, y: 0 },
		clientSize: { width: 788, height: 566 },
		...edit,
	});
	return makeGdiTarget();
}

test('Chromium 打字：WM_CHAR 仍投给渲染子窗口（surfaceHandle），不投顶层', { skip: !WINDOWS }, () => {
	const target = makeChromiumTarget();
	const result = backgroundType(win32, target, 'ab');
	assert.equal(posted.length, 2);
	assert.equal(posted[0].hwnd, 0x4100n, 'Chromium 键盘消息必须打到渲染子窗口');
	assert.equal(posted[1].hwnd, 0x4100n);
	for (const call of posted) {
		assert.notEqual(call.hwnd, 0x4000n, '不得把键盘消息打到 Chromium 顶层窗口');
		assert.equal(call.msg, 0x102);
	}
	assert.equal(result.reliable, true);
	assert.match(result.note, /0x4100|16640/u, 'note 里写明实际使用的句柄');
});

test('GDI 打字（核心修复）：有 Edit 子控件时 WM_CHAR 投给那个子控件，不是顶层窗口', { skip: !WINDOWS }, () => {
	const target = makeGdiTargetWithEdit();
	const result = backgroundType(win32, target, 'hi');

	assert.equal(posted.length, 2);
	assert.equal(posted[0].hwnd, 0x6100n, 'WM_CHAR 必须投给 Edit 子控件（0x6100）');
	assert.equal(posted[1].hwnd, 0x6100n);
	assert.notEqual(posted[0].hwnd, 0x6000n, '绝不能投给顶层窗口（会被直接丢弃）');
	assert.equal(posted[0].msg, 0x102);
	assert.equal(posted[0].wParam, 0x68);
	assert.equal(result.delivered, 2);
	assert.equal(result.reliable, true, '寻址到了具体控件，应报告为可靠');
	assert.match(result.note, /0x6100|24832/u, 'note 里必须说清用的是哪个句柄');
	assert.match(result.note, /文本输入控件/u, 'note 里必须说清用的是哪种策略');
});

test('resolveTextTarget：Chromium 目标返回渲染子窗口（已实测有效，不许改）', { skip: !WINDOWS }, () => {
	const target = makeChromiumTarget();
	const resolved = resolveTextTarget(win32, target);
	assert.equal(resolved.handle, 0x4100n);
	assert.equal(resolved.reliable, true);
	assert.match(resolved.strategy, /渲染子窗口/u);
});

test('GDI 打字（核心修复）：多个候选时选中面积较大的那个', { skip: !WINDOWS }, () => {
	stub.defineWindow(0x6000n, {
		parent: null,
		className: 'Notepad',
		title: '记事本',
		frame: { left: 100, top: 80, width: 800, height: 600 },
		clientOffset: { x: 6, y: 28 },
		clientSize: { width: 788, height: 566 },
	});
	// 两个可见的 Edit：一个大的（0x6100，788x566），一个小的（0x6200，200x20）
	stub.defineWindow(0x6100n, {
		parent: 0x6000n,
		className: 'Edit',
		frame: { left: 106, top: 108, width: 788, height: 566 },
		clientSize: { width: 788, height: 566 },
	});
	stub.defineWindow(0x6200n, {
		parent: 0x6000n,
		className: 'Edit',
		frame: { left: 106, top: 60, width: 200, height: 20 },
		clientSize: { width: 200, height: 20 },
	});
	const result = backgroundType(win32, makeGdiTarget(), 'x');
	assert.equal(posted[0].hwnd, 0x6100n, '面积大的候选（0x6100）应被选中，而不是 0x6200');
	assert.equal(result.reliable, true);
});

test('GDI 打字（核心修复）：不可见的 Edit 子控件不应被选中', { skip: !WINDOWS }, () => {
	stub.defineWindow(0x6000n, {
		parent: null,
		className: 'Notepad',
		title: '记事本',
		frame: { left: 100, top: 80, width: 800, height: 600 },
		clientOffset: { x: 6, y: 28 },
		clientSize: { width: 788, height: 566 },
	});
	// 唯一的 Edit 是不可见的：投给它的消息同样会被丢弃，绝不能选它；
	// 这时应回落到顶层并如实报告。
	stub.defineWindow(0x6300n, {
		parent: 0x6000n,
		className: 'Edit',
		visible: false,
		frame: { left: 106, top: 108, width: 788, height: 566 },
		clientSize: { width: 788, height: 566 },
	});
	const resolved = resolveTextTarget(win32, makeGdiTarget());
	assert.notEqual(resolved.handle, 0x6300n, '不可见的 Edit 不应被选中');
	assert.equal(resolved.handle, 0x6000n, '无可见候选时回落到顶层句柄');
	assert.equal(resolved.reliable, false);
	assert.match(resolved.strategy, /回落/u);
});

test('GDI 打字：嵌套在中间层里的文本控件也能找到（宽度优先遍历整棵树）', { skip: !WINDOWS }, () => {
	stub.defineWindow(0x6000n, {
		parent: null,
		className: 'Notepad',
		title: '记事本',
		frame: { left: 100, top: 80, width: 800, height: 600 },
		clientOffset: { x: 6, y: 28 },
		clientSize: { width: 788, height: 566 },
	});
	// WinForms 常见形态：Edit 藏在中间容器（0x6400）下面，且类名是
	// WindowsForms10.EDIT.app.*；必须穿过中间层并匹配 WinForms 前缀。
	stub.defineWindow(0x6400n, {
		parent: 0x6000n,
		className: 'WindowsForms10.Window.8.app.0.141b42a_r8_ad1',
		frame: { left: 106, top: 108, width: 788, height: 566 },
		clientSize: { width: 788, height: 566 },
	});
	stub.defineWindow(0x6500n, {
		parent: 0x6400n,
		className: 'WindowsForms10.EDIT.app.0.141b42a_r8_ad1',
		frame: { left: 106, top: 108, width: 788, height: 566 },
		clientSize: { width: 788, height: 566 },
	});
	const resolved = resolveTextTarget(win32, makeGdiTarget());
	assert.equal(resolved.handle, 0x6500n, '应穿过中间层找到 WinForms Edit（0x6500）');
	assert.equal(resolved.reliable, true);
});

test('后台输入绝不触碰 SendInput / SetCursorPos（这是模块的立身之本）', { skip: !WINDOWS }, () => {
	const chromium = makeChromiumTarget();
	const gdi = makeGdiTarget();
	backgroundClick(win32, chromium, { x: 1, y: 2 });
	backgroundType(win32, gdi, 'x');

	const names = new Set(stub.calls.map((call) => call.name));
	assert.equal(names.has('SendInput'), false, '后台模式不得使用 SendInput（会注入前台硬件事件）');
	assert.equal(names.has('SetCursorPos'), false, '后台模式不得挪动光标');
});

test('按键语义：right/middle 各自用对应的消息号，不会静默退化成左键', { skip: !WINDOWS }, () => {
	const target = makeChromiumTarget();

	// 右键：WM_RBUTTONDOWN/UP，按下时带 MK_RBUTTON(0x0002)
	backgroundClick(win32, target, { x: 10, y: 20 }, 'right');
	assert.deepEqual(posted.map((entry) => entry.msg), [0x0200, 0x0204, 0x0205]);
	assert.equal(posted[1].wParam, 0x0002, '按下时 wParam 应为 MK_RBUTTON');
	assert.equal(posted[2].wParam, 0, '抬起时不应带按键掩码');

	// 中键：WM_MBUTTONDOWN/UP，按下时带 MK_MBUTTON(0x0010)
	posted.length = 0;
	backgroundClick(win32, target, { x: 10, y: 20 }, 'middle');
	assert.deepEqual(posted.map((entry) => entry.msg), [0x0200, 0x0207, 0x0208]);
	assert.equal(posted[1].wParam, 0x0010, '按下时 wParam 应为 MK_MBUTTON');

	// 不传按键时默认左键，既有调用行为不变
	posted.length = 0;
	backgroundClick(win32, target, { x: 10, y: 20 });
	assert.deepEqual(posted.map((entry) => entry.msg), [0x0200, 0x0201, 0x0202]);
	assert.equal(posted[1].wParam, 0x0001, '按下时 wParam 应为 MK_LBUTTON');
});
