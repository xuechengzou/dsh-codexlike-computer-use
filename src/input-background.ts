/**
 * 后台输入：把点击与打字投递到**不在前台**的窗口，全程不碰光标、不抢前台。
 *
 * 设计上有一条硬性纪律：本模块只使用 `PostMessage`。绝对禁止有人顺手把它改成
 * `SendInput` 或 `SetCursorPos` —— 那是前台模式（src/screen.ts + src/win32.ts 的
 * sendInput 通道）的职责，一旦在这里混用，后台模式"不抢用户鼠标键盘"的承诺就
 * 破产了，而且用户完全无法察觉（他正在打字，光标突然飞走）。
 *
 * 与前台模式的本质差异在于"消息 vs 硬件事件"：
 *
 *   - SendInput 注入的是硬件级事件，系统把它派发给**前台**窗口 —— 事件里有
 *     屏幕坐标，没有目标窗口，所以只能操作前台，且必然动光标。
 *   - PostMessage 是把消息塞进某个窗口的消息队列。事件本身没有坐标语义，
 *     坐标由 `lParam` 携带，目标由句柄携带 —— 所以才能指定"就打到这个窗口，
 *     就打在客户区的这个点"。
 *
 * 消息必须打到正确的句柄（由 window-target.ts 的 resolveTargetWindow 给出，
 * 键盘消息则进一步由本模块的 resolveTextTarget 二次寻址）：
 *   - Chromium/Electron 窗口：必须打到 `Chrome_RenderWidgetHostHWND` 渲染子窗口，
 *     实测打到顶层窗口毫无反应（顶层只是外壳，没有输入处理逻辑）。
 *   - GDI 窗口：键盘消息必须打到**具体控件**（Edit 等）——键盘消息不会从
 *     父窗口转发给子控件，打到顶层窗口会被直接丢掉。这是实测出的缺陷，
 *     修复方式是在 frameHandle 的后代里自动寻找文本输入控件。
 *
 * 已知的能力边界（来自实测，不是猜测）：
 *   - 在**不在前台**的 GDI 窗口上，模拟 WM_LBUTTONDOWN/UP 无效；但
 *     BM_CLICK、WM_CHAR、WM_SETTEXT 在经典 Win32 控件上生效。
 *   - 因此 GDI 后台点击先做命中测试：落点是按钮类控件时直接对它发
 *     BM_CLICK（可信）；否则才回落到模拟鼠标消息，并通过 `reliable`
 *     字段如实告诉调用方"这条消息序列不保证生效"，而不是静默假装成功。
 */

import type { Win32 } from './win32.js';
import { makeMouseLParam, type TargetWindow } from './window-target.js';

/** 鼠标消息号（Win32 SDK，不用 magic number 以免拼错难查）。 */
const WM_MOUSEMOVE = 0x200;
/** 文本输入：wParam 携带单个 UTF-16 码元。 */
const WM_CHAR = 0x102;
/**
 * 按钮的语义点击：发给按钮控件本身即触发一次点击，**不要求窗口在前台**
 *（实测按钮计数确实 +1 且前台窗口不变）——这是 GDI 目标后台点击唯一
 * 可信的路径。
 */
const BM_CLICK = 0x00f5;

/**
 * "像按钮"的类名特征（与 resolveTextTarget 的 TEXT_INPUT_CLASS 同一思路：
 * 类名是驱动消息分发的最可靠事实）：
 *   - `Button`：标准 Win32 按钮（对话框的确定/取消等）。
 *   - `WindowsForms10.BUTTON.*`：WinForms 的 Button 控件类。
 *   - 类名任意位置含 `Button`（含连写）：WPF 混合宿主等非前缀形态。
 */
const BUTTON_CLASS = /^(button|windowsforms\d+\.button\b)/i;
const BUTTON_CLASS_CONTAINS = /button/i;

/** 判定一个窗口类名是否属于按钮控件。 */
function isButtonClass(className: string): boolean {
	return BUTTON_CLASS.test(className) || BUTTON_CLASS_CONTAINS.test(className);
}
/** WM_CHAR 的 lParam：第 30/31 位描述键状态；普通字符输入用 0 即可。 */
const WM_CHAR_LPARAM = 0;

/**
 * 一次后台输入的结果。
 *
 * `delivered` 只统计投递成功的消息条数（PostMessage 返回 0 视为失败），
 * 它**不代表目标真的处理了这条消息** —— PostMessage 只保证入队成功，
 * 这正是 `reliable` 存在的原因。
 */
export interface BackgroundInputResult {
	/** 实际投递出去的消息条数。 */
	readonly delivered: number;
	/**
	 * 这次输入是否**可以信任生效**。
	 *
	 * - Chromium/Electron 目标：投递到渲染子窗口，实测消息确实被页面处理，
	 *   为 `true`。
	 * - GDI 目标且落点命中按钮类控件：走 BM_CLICK 语义点击，实测生效，
	 *   为 `true`。
	 * - GDI 目标其余情况：实测"不在前台时模拟 WM_LBUTTONDOWN/UP 无效"，
	 *   消息可能入队但目标不会按点击语义响应，为 `false`。调用方应据此
	 *   决定是否提示用户改用前台模式，而不是把失败吞掉。
	 */
	readonly reliable: boolean;
	/** 给调用方看的一句话说明：可靠时解释选路，不可靠时解释原因。 */
	readonly note: string;
}

/** 投递一条消息；入队失败（返回 0）不在这里抛错，由调用方看 delivered 判断。 */
function post(win32: Win32, handle: bigint, message: number, wParam: number, lParam: number): number {
	return win32.postMessage(handle, message, wParam, lParam) ? 1 : 0;
}

/**
 * "像文本输入控件"的类名特征。
 *
 * 覆盖常见形态，判据只看类名前缀/形态（类名是驱动消息分发的最可靠事实）：
 *   - `Edit`：标准 Win32 编辑框（记事本、对话框里的输入框）。
 *   - `RichEdit` / `RICHEDIT50W` 等：写字板、各种 IM 输入区用的富文本框；
 *     `RICHEDIT50W` 里不含 "RichEdit" 连写，所以单独列一条。
 *   - `WindowsForms10.EDIT.app.*`：WinForms 的 TextBox 渲染出来的原生子控件。
 *   - `HwndWrapper` 之外的 `TextBox`：WPF 顶层是 `HwndSource`/`HwndWrapper`，
 *     内部控件没有 HWND，但部分混合宿主（WinForms 宿主 WPF）会出现
 *     类名含 `TextBox` 的子窗口，一并认了，代价是极小概率误选。
 */
const TEXT_INPUT_CLASS = /^(edit|richedit\d*\w*|windowsforms\d+\.edit\b)/i;

/** 额外兜底：类名里任何位置出现 TextBox（WPF 混合宿主等非前缀形态）。 */
const TEXT_INPUT_CLASS_CONTAINS = /textbox/i;

/** 文本控件搜索的后代窗口遍历上限：正常窗口树远小于此，只防异常树死循环。 */
const MAX_TEXT_TARGET_DESCENDANTS = 512;

/** 判定一个窗口类名是否属于文本输入控件。 */
function isTextInputClass(className: string): boolean {
	return TEXT_INPUT_CLASS.test(className) || TEXT_INPUT_CLASS_CONTAINS.test(className);
}

/** resolveTextTarget 的产出：投到哪个句柄、为什么。 */
export interface TextTarget {
	/** 键盘消息要投递到的句柄。 */
	readonly handle: bigint;
	/**
	 * 选路说明（会原样进入返回 note），调用方据此判断该不该相信这次输入：
	 * 渲染子窗口 / 找到的文本控件（带句柄）/ 回落到顶层（明示可能无效）。
	 */
	readonly strategy: string;
	/** 是否属于"有把握生效"的选路（Chromium 渲染子窗口或找到了文本控件）。 */
	readonly reliable: boolean;
}

/**
 * 解析键盘消息（WM_CHAR）真正该投递到的句柄。
 *
 * 实测结论（这是本函数存在的理由）：键盘消息不会从父窗口转发给子控件，
 * 子控件只在**自己持有焦点**时才处理键盘消息。因此：
 *   - Chromium：surfaceHandle 就是渲染子窗口，直接返回（实测有效，不动）。
 *   - GDI：surfaceHandle 等于顶层句柄，投过去必然被丢；必须在
 *     frameHandle 的后代里找到文本输入控件，投给**它**。
 *
 * 候选挑选规则：优先**可见**的（不可见控件往往也不处理投递的消息），
 * 同等可见性下取客户区面积最大的（记事本等会把 Edit 铺满客户区，而隐藏的
 * 查找框之类通常又小又不该被选中）。找不到任何候选时回落到 surfaceHandle
 *（即顶层），此时明说"回落、可能无效"，调用方据此降低信任。
 */
export function resolveTextTarget(win32: Win32, target: TargetWindow): TextTarget {
	if (target.kind === 'chromium') {
		return {
			handle: target.surfaceHandle,
			strategy: 'Chromium 渲染子窗口（键盘消息直投渲染子窗口，实测生效）',
			reliable: true,
		};
	}

	// GDI：宽度优先遍历 frameHandle 的整棵后代树找文本控件。
	const queue = [...win32.childWindows(target.frameHandle)];
	let best: { handle: bigint; area: number } | undefined;
	let visited = 0;

	while (queue.length > 0 && visited < MAX_TEXT_TARGET_DESCENDANTS) {
		const handle = queue.shift();
		if (handle === undefined) break;
		visited += 1;
		const info = win32.windowInfo(handle);
		// 不可见的候选直接跳过：投给隐藏控件的消息同样会被丢弃，
		// 而"可见优先"也天然避开了隐藏的查找/替换辅助框。
		if (info !== undefined && isTextInputClass(info.className) && win32.isWindowVisible(handle)) {
			const client = win32.clientArea(handle);
			if (client !== undefined && client.width > 0 && client.height > 0) {
				const area = client.width * client.height;
				if (best === undefined || area > best.area) best = { handle, area };
			}
		}
		for (const child of win32.childWindows(handle)) queue.push(child);
	}

	if (best !== undefined) {
		return {
			handle: best.handle,
			strategy: `已在窗口后代中自动定位文本输入控件（句柄 ${best.handle}，类名 ${win32.windowInfo(best.handle)?.className ?? '?'}）`,
			reliable: true,
		};
	}

	// 回落：找不到像文本控件的子窗口时只能投顶层句柄。实测这样投
	// 键盘消息不会生效（父窗口不转发），必须如实说出来而不是假装成功。
	return {
		handle: target.surfaceHandle,
		strategy: '未在窗口后代中找到文本输入控件，已回落到顶层窗口句柄（键盘消息大概率不会被处理）',
		reliable: false,
	};
}

/**
 * 三种按键各自的消息号与"按下"时该带的 wParam 掩码。
 *
 * 必须按按键取对应的消息号：右键点击投递 WM_LBUTTONDOWN 的话，目标收到的是
 * 一次**左键**点击——UI 上表现为"点了但弹出的是左键行为"，而且它不会报错，
 * 只会静默地做错事。这类错误只有靠消息号区分才能避免。
 */
const MOUSE_MESSAGES = {
	left: { down: 0x0201, up: 0x0202, mask: 0x0001 },
	right: { down: 0x0204, up: 0x0205, mask: 0x0002 },
	middle: { down: 0x0207, up: 0x0208, mask: 0x0010 },
} as const;

/** 后台点击支持的按键名。 */
export type MouseButtonName = keyof typeof MOUSE_MESSAGES;

/**
 * 后台点击：把一次完整的按下/抬起投递到渲染表面。
 *
 * @param point - **客户区坐标**（用 imagePointToClient 从截图坐标换算而来）。
 *   PostMessage 携带的坐标是客户区坐标，与 SendMessage/前台模式的屏幕坐标
 *   语义不同，传错坐标系会整体偏移一个窗口原点。
 * @param button - 要投递的按键。默认左键，便于既有调用保持不变。
 */
export function backgroundClick(
	win32: Win32,
	target: TargetWindow,
	point: { x: number; y: number },
	button: MouseButtonName = 'left',
): BackgroundInputResult {
	// 无论哪种目标，鼠标消息都打到 surfaceHandle：Chromium 是渲染子窗口，
	// GDI 恰好等于顶层句柄。GDI 分支在此之前会先做命中测试，落点是按钮
	// 类控件时走 BM_CLICK 语义点击提前返回，不会走到这里的鼠标三连。
	const lParam = makeMouseLParam(point);
	const messages = MOUSE_MESSAGES[button];

	const buttonLabel = button === 'left' ? '左键' : button === 'right' ? '右键' : '中键';

	// GDI 分支先做一次命中测试：实测铁律是 WM_LBUTTONDOWN/UP 对不在前台的
	// 普通 Win32 窗口无效，但 BM_CLICK 发给按钮控件本身确实生效且不改前台。
	// 因此落点是按钮类控件时走语义点击，否则才回落到模拟鼠标消息并如实
	// 报告不可靠。BM_CLICK 只表达"左键语义点击"，非左键不走这条路——
	// 把右键静默退化成左键比"点了但没生效"更难被发现。
	if (target.kind === 'gdi' && button === 'left') {
		const hit = win32.childWindowFromPoint(target.surfaceHandle, point.x, point.y);
		if (hit !== 0n && hit !== target.surfaceHandle) {
			const className = win32.windowInfo(hit)?.className ?? '';
			if (isButtonClass(className)) {
				// SendMessage 的返回值是目标处理后的结果，不表示成败；
				// delivered 记 1 表示语义点击已发出。
				win32.sendMessage(hit, BM_CLICK, 0, 0);
				return {
					delivered: 1,
					reliable: true,
					note: `落点（${point.x},${point.y}）命中按钮控件（句柄 ${hit}，类名 ${className}），已发送 BM_CLICK 语义点击，窗口无需在前台`,
				};
			}
		}
	}

	// 消息顺序必须完整复现一次真实点击：先 MOVE 让目标更新悬停状态
	//（某些 UI 依赖 hover 才显示可点元素），再 DOWN、再 UP。顺序错了或
	// 缺了 MOVE，网页上的部分点击处理（依赖 mouseover 的那种）不会触发。
	// MOVE 的 wParam 用 0：真实系统在按键按下期间才会带掩码，这里还没按下。
	let delivered = 0;
	delivered += post(win32, target.surfaceHandle, WM_MOUSEMOVE, 0, lParam);
	delivered += post(win32, target.surfaceHandle, messages.down, messages.mask, lParam);
	delivered += post(win32, target.surfaceHandle, messages.up, 0, lParam);

	if (target.kind === 'chromium') {
		return {
			delivered,
			reliable: true,
			note: `已把${buttonLabel}点击投递到 Chromium 渲染子窗口（客户区 ${point.x},${point.y}），窗口无需在前台`,
		};
	}

	// GDI 分支：消息照投（部分控件、以及窗口恰好在前景时是生效的），
	// 但必须如实报告不可靠。实测铁律：WM_LBUTTONDOWN/UP 对不在前台的
	// 普通 Win32 窗口无效 —— 这是与 Chromium 渲染子窗口（不检查前台态）
	// 最大的行为差异。宁可让调用方降级到前台模式，也不能让他以为点到了。
	return {
		delivered,
		reliable: false,
		note: `${buttonLabel}点击已投递到「${target.title}」，但落点不是按钮类控件（或不是左键），而模拟鼠标消息在非前台的普通 Win32 窗口上不生效；如未生效请改用前台模式点击`,
	};
}

/**
 * 后台打字：把文本按 UTF-16 码元逐个 WM_CHAR 投递到渲染表面。
 *
 * 码元逐个投递（而不是 WM_SETTEXT 一把设入）是有意的：WM_SETTEXT 会
 * **整体替换**控件内容，无法实现"追加""在光标处插入"，而且对 Chromium
 * 的输入框根本不生效；WM_CHAR 走的是目标自己的文本输入路径，行为与
 * 真人打字一致。
 */
export function backgroundType(win32: Win32, target: TargetWindow, text: string): BackgroundInputResult {
	// 键盘消息必须寻址到真正处理它的控件（见 resolveTextTarget 的注释）：
	// 投到"顶层窗口句柄"这个缺陷的实测表现就是——消息如实入队、
	// 但目标窗口的文本框一个字也没多出来。
	const destination = resolveTextTarget(win32, target);

	let delivered = 0;
	for (let index = 0; index < text.length; index += 1) {
		let codeUnit = text.charCodeAt(index);
		// WM_CHAR 语义下文本框认 CR 而不是 LF：直接投 LF 会出现"没换行"
		// 或多出一个空块（部分控件把 LF 显示为乱符）。这里在源文本层面
		// 归一成 CR，与真实键盘回车（产生 CR）一致。
		if (codeUnit === 0x0a) codeUnit = 0x0d;
		delivered += post(win32, destination.handle, WM_CHAR, codeUnit, WM_CHAR_LPARAM);
		// 代理对：U+10000 以上的字符在 JS 字符串里天然就是两个码元
		//（高代理 0xD800–0xDBFF、低代理 0xDC00–0xDFFF），charCodeAt 会
		// 把它们原样交出来 —— 这正是我们要的。但必须**成对**投递：
		// 只送高代理会送出一个无效码元，目标把它丢弃后整段文本在 emoji
		// 处静默丢字。这里的处理是"两个码元都按原样投出"，靠 for 循环
		// 的自然步进把低代理留给下一轮，无需在这里做拼接。
	}

	const reliable = destination.reliable;
	const note = reliable
		? `已把 ${text.length} 个码元投递到句柄 ${destination.handle}（${destination.strategy}）`
		: `已把 ${text.length} 个码元投递到「${target.title}」；${destination.strategy}`;
	return { delivered, reliable, note };
}
