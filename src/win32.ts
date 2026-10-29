/**
 * Win32 原生绑定层。
 *
 * 通过 koffi 直接调用 user32 / gdi32，因此鼠标键盘注入与屏幕捕获都在
 * 进程内完成，没有为每个动作拉起子进程的开销（实测单击 ~25ms、
 * 捕获+编码 ~30-120ms）。
 *
 * 三条硬约束：
 * 1. koffi 是原生模块，**懒加载**——顶层 `import` 会让 koffi 缺失或
 *    非 Windows 环境下的整个宿主加载失败，而不是让本插件优雅降级。
 * 2. 所有结构体按 x64 自然对齐手工定义；`INPUT` 必须恰好 40 字节，
 *    否则 SendInput 会静默丢弃事件而不是报错。
 * 3. FFI 是不透明边界，类型安全靠"每签名一处转换"：全部签名集中声明在
 *    {@link NativeFunctions}，`bind` 是唯一做不安全转换的地方，其余
 *    调用点都是完整类型化的。
 *
 * 只声明本插件真正调用的符号，绑定失败时立刻抛出可读错误。
 */

import { defineType } from './koffi-registry.js';
import type { KoffiLibrary, KoffiModule, KoffiType } from './koffi-types.js';

/** 光标/屏幕坐标点。 */
export interface Point {
	x: number;
	y: number;
}

/** Win32 窗口矩形（含左右上下边界）。 */
export interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** 前台窗口的身份信息，用于向模型报告"输入到底发给了谁"。 */
export interface WindowInfo {
	handle: bigint;
	title: string;
	className: string;
	processId: number;
	rect: Rect;
}

/**
 * 客户区在屏幕坐标下的位置与尺寸。
 *
 * 结构与 `screen.ts` 的 `Bounds` 一致，但这里不复用那个类型：
 * `screen.ts` 依赖本模块，反向导入会形成循环。
 */
export interface ClientArea {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** SendInput 的事件类型常量。 */
export const INPUT_MOUSE = 0;
export const INPUT_KEYBOARD = 1;

/** 鼠标事件标志。 */
export const MOUSEEVENTF = {
	MOVE: 0x0001,
	LEFTDOWN: 0x0002,
	LEFTUP: 0x0004,
	RIGHTDOWN: 0x0008,
	RIGHTUP: 0x0010,
	MIDDLEDOWN: 0x0020,
	MIDDLEUP: 0x0040,
	WHEEL: 0x0800,
	HWHEEL: 0x1000,
	ABSOLUTE: 0x8000,
} as const;

/** 键盘事件标志。 */
export const KEYEVENTF = {
	EXTENDEDKEY: 0x0001,
	KEYUP: 0x0002,
	UNICODE: 0x0004,
	SCANCODE: 0x0008,
} as const;

/** GetSystemMetrics 索引。 */
export const SM = {
	CXSCREEN: 0,
	CYSCREEN: 1,
	XVIRTUALSCREEN: 76,
	YVIRTUALSCREEN: 77,
	CXVIRTUALSCREEN: 78,
	CYVIRTUALSCREEN: 79,
	CMONITORS: 80,
} as const;

/** 一个待注入的输入事件；与 Win32 INPUT 结构一一对应。 */
export type InputEvent =
	| { kind: 'mouse'; dx: number; dy: number; mouseData: number; flags: number }
	| { kind: 'key'; virtualKey: number; scanCode: number; flags: number };

/** 绑定完成后的原生调用集合。 */
export interface Win32 {
	/** 屏幕度量与光标。 */
	screenMetrics(index: number): number;
	cursorPosition(): Point;
	setCursorPosition(x: number, y: number): boolean;
	/** 窗口。 */
	foregroundWindow(): bigint;
	windowInfo(handle: bigint): WindowInfo | undefined;
	/**
	 * 前台窗口所在线程当前持有键盘焦点的**控件**句柄。
	 *
	 * 顶层窗口成为前台 ≠ 它的子控件拿到焦点：点击之后 Windows 要把焦点
	 * 派发到具体控件（WM_SETFOCUS），这段时间内注入的按键会被系统丢弃。
	 * 因此键盘注入前必须等这个句柄就绪，只看 `foregroundWindow` 不够。
	 *
	 * @returns 焦点控件句柄；无法判定时返回 0n。
	 */
	focusedControl(): bigint;
	/** 输入。 */
	sendInput(events: readonly InputEvent[]): number;
	/** 虚拟键 → 键盘扫描码（MAPVK_VK_TO_VSC）；0 表示该键无扫描码。 */
	virtualKeyToScanCode(virtualKey: number): number;
	/** 屏幕捕获；返回自顶向下、每像素 4 字节的 BGRA。 */
	captureBgra(x: number, y: number, width: number, height: number): Uint8Array;
	/** 自检值：INPUT 结构的实际字节数。 */
	inputStructSize: number;

	// ---- 以下为后台模式所需：全部不要求窗口在前台 --------------------------

	/**
	 * 窗口客户区的屏幕坐标原点与尺寸。
	 *
	 * 后台输入投递的是**客户区坐标**，因此这个原点是"截图上的像素"与
	 * "要投递的坐标"之间唯一的换算依据。
	 */
	clientArea(handle: bigint): ClientArea | undefined;
	/** 窗口 DPI（96 表示 100% 缩放）。 */
	windowDpi(handle: bigint): number;
	/** 窗口是否可见。 */
	isWindowVisible(handle: bigint): boolean;
	/** 窗口是否已最小化。最小化时渲染被系统挂起，任何截图都拿不到内容。 */
	isMinimized(handle: bigint): boolean;
	/** 直接子窗口句柄列表，顺序按 z 序。 */
	childWindows(handle: bigint): bigint[];
	/**
	 * 命中测试：在 parent 的后代窗口里找包含指定点的最深层子窗口。
	 *
	 * 绑定的是 `ChildWindowFromPointEx` 而不是 `ChildWindowFromPoint`：
	 * Ex 版能跳过不可见与禁用的窗口（CWP_SKIPINVISIBLE | CWP_SKIPDISABLED）。
	 * 不可见的按钮投了 `BM_CLICK` 同样不生效，因此命中测试必须直接绕过
	 * 它们——与 `resolveTextTarget` 里"只选可见"是同一个理由。
	 *
	 * @param x - 相对 parent **客户区**的横坐标（与鼠标消息 lParam 同一坐标系）。
	 * @param y - 相对 parent **客户区**的纵坐标。
	 * @returns 命中的子窗口句柄；点落在 parent 内但不在任何子控件上时返回
	 *   parent 自身；点在 parent 之外或调用失败时返回 0n。
	 */
	childWindowFromPoint(parent: bigint, x: number, y: number): bigint;
	/** 枚举顶层窗口句柄，按 z 序从前到后。 */
	topLevelWindows(): bigint[];
	/**
	 * 用 `PrintWindow` 让**窗口自己**把内容渲染到位图，不要求它在前台。
	 *
	 * @returns `ok` 为 PrintWindow 的返回值；`pixels` 可能仍然是一张空白图，
	 * 因此调用方必须检查内容而不是只看 `ok`。
	 */
	printWindowBgra(handle: bigint, width: number, height: number): { readonly ok: boolean; readonly pixels: Uint8Array };
	/** 投递消息：不阻塞，也不要求目标在前台。 */
	postMessage(handle: bigint, message: number, wParam: number, lParam: number): boolean;
	/** 同步发送消息：不要求目标在前台，返回目标处理后的结果。 */
	sendMessage(handle: bigint, message: number, wParam: number, lParam: number): bigint;
	/** 直接设置窗口/控件文本（内部即 `WM_SETTEXT`）。 */
	setWindowText(handle: bigint, text: string): boolean;
}

/** 全部原生函数的一处签名声明。签名照抄 Win32 SDK。 */
interface NativeFunctions {
	getDC(hWnd: bigint | null): bigint | null;
	releaseDC(hWnd: bigint | null, hDC: bigint): number;
	getSystemMetrics(index: number): number;
	getCursorPos(point: Point): number;
	setCursorPos(x: number, y: number): number;
	getForegroundWindow(): bigint | null;
	getWindowTextW(handle: bigint, buffer: Buffer, capacity: number): number;
	getClassNameW(handle: bigint, buffer: Buffer, capacity: number): number;
	getWindowRect(handle: bigint, rect: Rect): number;
	getClientRect(handle: bigint, rect: Rect): number;
	clientToScreen(handle: bigint, point: Point): number;
	getDpiForWindow(handle: bigint): number;
	isWindowVisible(handle: bigint): number;
	isIconic(handle: bigint): number;
	findWindowExW(parent: bigint | null, after: bigint | null, cls: string | null, name: string | null): bigint | null;
	childWindowFromPointEx(parent: bigint, point: Point, flags: number): bigint | null;
	getTopWindow(hWnd: bigint | null): bigint | null;
	getWindow(hWnd: bigint, command: number): bigint | null;
	printWindow(handle: bigint, hdc: bigint, flags: number): number;
	postMessageW(handle: bigint, message: number, wParam: number, lParam: number): number;
	sendMessageW(handle: bigint, message: number, wParam: number, lParam: number): bigint;
	setWindowTextW(handle: bigint, text: string): number;
	createSolidBrush(color: number): bigint | null;
	fillRect(hdc: bigint, rect: Rect, brush: bigint): number;
	getWindowThreadProcessId(handle: bigint, slot: Buffer): number;
	getGUIThreadInfo(threadId: number, info: Buffer): number;
	mapVirtualKeyW(virtualKey: number, mapType: number): number;
	sendInput(count: number, inputs: unknown, size: number): number;
	setProcessDpiAware(): number;
	createCompatibleDC(hdc: bigint): bigint | null;
	createCompatibleBitmap(hdc: bigint, cx: number, cy: number): bigint | null;
	selectObject(hdc: bigint, object: bigint): bigint | null;
	bitBlt(hdc: bigint, x: number, y: number, cx: number, cy: number, hdcSrc: bigint, x1: number, y1: number, rop: number): number;
	getDIBits(hdc: bigint, bitmap: bigint, start: number, lines: number, bits: Buffer, info: Buffer, usage: number): number;
	deleteObject(object: bigint): number;
	deleteDC(hdc: bigint): number;
}

/** 唯一的 FFI 转换点：把 koffi 的不透明函数断言成本层声明的签名。 */
function bind<K extends keyof NativeFunctions>(library: KoffiLibrary, signature: string): NativeFunctions[K] {
	return library.func(signature) as unknown as NativeFunctions[K];
}

const BITMAPINFOHEADER_SIZE = 40;
const SRCCOPY = 0x00cc0020;
const DIB_RGB_COLORS = 0;
const MAPVK_VK_TO_VSC = 0;
const MAX_WINDOW_TEXT = 512;
const MAX_CLASS_NAME = 256;

/**
 * x64 下 `GUITHREADINFO` 的字节数：
 * cbSize+flags（8）+ 6 个指针（48）+ rcCaret（16）= 72。
 * Windows 会校验 cbSize，填错会直接失败，因此这个值不能猜。
 */
const GUITHREADINFO_SIZE = 72;
/** `hwndFocus` 在结构体里的字节偏移：cbSize+flags(8) + hwndActive(8)。 */
const GUITHREADINFO_FOCUS_OFFSET = 16;

/**
 * `PrintWindow` 的 `PW_RENDERFULLCONTENT`。
 *
 * 对 DirectComposition / GPU 合成的窗口（Chrome、Electron、UWP）**必须**带这个标志：
 * 实测不带时返回值为 1（成功）却给出纯黑图（98.1% 黑、仅 2 种颜色），
 * 也就是"看起来成功了但什么也没拿到"。
 */
const PW_RENDERFULLCONTENT = 0x00000002;

/** `FindWindowExW` 枚举子窗口的循环上限，仅用于防住异常的父链。 */
const MAX_CHILD_WINDOWS = 4096;

/** `GetWindow` 的 `GW_HWNDNEXT`：z 序里的下一个窗口。 */
const GW_HWNDNEXT = 2;

/**
 * `ChildWindowFromPointEx` 的标志：跳过不可见（0x1）与禁用（0x2）窗口。
 * 跳过的理由与命中测试的使用场景一致：要给"用户看得到的那个按钮"发语义点击，
 * 隐藏/禁用控件命中了也只是在替真正的落点挡枪。
 */
const CWP_SKIP_INVISIBLE_DISABLED = 0x0003;

/**
 * koffi 的模块说明符。刻意用变量而不是字面量：
 * koffi 未安装时字面量导入会让 `tsc` 直接报错，而这里需要的是
 * "类型检查照常通过、运行期再给出可读诊断"。
 */
const KOFFI_SPECIFIER = 'koffi';

let pending: Promise<Win32> | undefined;

/**
 * 载入并缓存原生绑定。
 *
 * 失败原因被压缩成一句话：非 Windows、koffi 未安装、或某个符号在
 * 该系统上不存在。调用方直接把它作为工具错误返回给模型。
 */
export function loadWin32(): Promise<Win32> {
	pending ??= createWin32().catch((error: unknown) => {
		// 失败的 promise 不能留缓存，否则后续调用永远拿到同一个错误而不重试
		pending = undefined;
		throw error;
	});
	return pending;
}

/** 读取一个 Win32 窗口文本类字段（UTF-16 缓冲 + 截断到首个 NUL）。 */
function readWindowText(reader: (handle: bigint, buffer: Buffer, capacity: number) => number, handle: bigint, capacity: number): string {
	const buffer = Buffer.alloc(capacity * 2);
	const written = reader(handle, buffer, capacity);
	if (written <= 0) return '';
	return buffer.subarray(0, written * 2).toString('utf16le');
}

async function createWin32(): Promise<Win32> {
	if (process.platform !== 'win32') {
		throw new Error(`computer-use 目前只实现了 Windows 后端（当前平台 ${process.platform}）`);
	}

	let koffi: KoffiModule;
	try {
		// 用变量说明符而不是字面量：koffi 可能未安装，字面量导入会让 tsc
		// 直接报"找不到模块"，而这里要的正是"运行期再失败、并给出可读诊断"。
		koffi = (await import(KOFFI_SPECIFIER)) as unknown as KoffiModule;
	} catch (error) {
		throw new Error('computer-use 需要 koffi 原生模块，但加载失败；请在插件目录执行 npm install koffi', { cause: error });
	}


	const user32 = koffi.load('user32.dll');
	const gdi32 = koffi.load('gdi32.dll');

	// ---- 结构体（x64 自然对齐） -------------------------------------------
	const POINT: KoffiType = defineType('POINT', () => koffi.struct('POINT', { x: 'int32', y: 'int32' }));
	const RECT: KoffiType = defineType('RECT', () => koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' }));
	const MOUSEINPUT: KoffiType = defineType('MOUSEINPUT', () => koffi.struct('MOUSEINPUT', {
		dx: 'int32',
		dy: 'int32',
		mouseData: 'uint32',
		dwFlags: 'uint32',
		time: 'uint32',
		dwExtraInfo: 'uint64',
	}));
	const KEYBDINPUT: KoffiType = defineType('KEYBDINPUT', () => koffi.struct('KEYBDINPUT', {
		wVk: 'uint16',
		wScan: 'uint16',
		dwFlags: 'uint32',
		time: 'uint32',
		dwExtraInfo: 'uint64',
	}));
	const HARDWAREINPUT: KoffiType = defineType('HARDWAREINPUT', () => koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' }));
	const INPUTUNION: KoffiType = defineType('INPUTUNION', () => koffi.union('INPUTUNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }));
	const INPUT: KoffiType = defineType('INPUT', () => koffi.struct('INPUT', { type: 'uint32', u: INPUTUNION }));

	const inputStructSize = koffi.sizeof(INPUT);
	if (inputStructSize !== 40) {
		throw new Error(`computer-use: INPUT 结构体被绑定为 ${inputStructSize} 字节，x64 下应为 40；输入注入会被系统静默丢弃`);
	}

	// POINT/RECT 会被 koffi 以值语义写入，因此必须作为类型传入；
	// 这里显式引用一次，避免"声明了却没用"被误删。
	void POINT;
	void RECT;

	// ---- 签名绑定 ----------------------------------------------------------
	const getDC = bind<'getDC'>(user32, 'void *GetDC(void *hWnd)');
	const releaseDC = bind<'releaseDC'>(user32, 'int ReleaseDC(void *hWnd, void *hDC)');
	const getSystemMetrics = bind<'getSystemMetrics'>(user32, 'int GetSystemMetrics(int nIndex)');
	const getCursorPos = bind<'getCursorPos'>(user32, 'int GetCursorPos(_Out_ POINT *p)');
	const setCursorPos = bind<'setCursorPos'>(user32, 'int SetCursorPos(int X, int Y)');
	const getForegroundWindow = bind<'getForegroundWindow'>(user32, 'void *GetForegroundWindow()');
	const getWindowTextW = bind<'getWindowTextW'>(user32, 'int GetWindowTextW(void *hWnd, _Out_ char16_t *lpString, int nMaxCount)');
	const getClassNameW = bind<'getClassNameW'>(user32, 'int GetClassNameW(void *hWnd, _Out_ char16_t *lpString, int nMaxCount)');
	const getWindowRect = bind<'getWindowRect'>(user32, 'int GetWindowRect(void *hWnd, _Out_ RECT *lpRect)');
	const getClientRect = bind<'getClientRect'>(user32, 'int GetClientRect(void *hWnd, _Out_ RECT *lpRect)');
	const clientToScreen = bind<'clientToScreen'>(user32, 'int ClientToScreen(void *hWnd, _Inout_ POINT *lpPoint)');
	const getDpiForWindow = bind<'getDpiForWindow'>(user32, 'uint32 GetDpiForWindow(void *hWnd)');
	const isWindowVisible = bind<'isWindowVisible'>(user32, 'int IsWindowVisible(void *hWnd)');
	const isIconic = bind<'isIconic'>(user32, 'int IsIconic(void *hWnd)');
	const findWindowExW = bind<'findWindowExW'>(user32, 'void *FindWindowExW(void *hWndParent, void *hWndChildAfter, const char16_t *lpszClass, const char16_t *lpszWindow)');
	// 注意 POINT 是**按值**传递的结构体：必须用已注册的 POINT 类型名，
	// 不能拆成 (int32 x, int32 y)——那样 x64 下寄存器会错位，详见调用处的注释。
	const childWindowFromPointEx = bind<'childWindowFromPointEx'>(user32, 'void *ChildWindowFromPointEx(void *hWnd, POINT pt, uint32 uFlags)');
	const getTopWindow = bind<'getTopWindow'>(user32, 'void *GetTopWindow(void *hWnd)');
	const getWindow = bind<'getWindow'>(user32, 'void *GetWindow(void *hWnd, uint32 uCmd)');
	const printWindow = bind<'printWindow'>(user32, 'int PrintWindow(void *hwnd, void *hdcBlt, uint32 nFlags)');
	const postMessageW = bind<'postMessageW'>(user32, 'int PostMessageW(void *hWnd, uint32 Msg, intptr_t wParam, intptr_t lParam)');
	const sendMessageW = bind<'sendMessageW'>(user32, 'intptr_t SendMessageW(void *hWnd, uint32 Msg, intptr_t wParam, intptr_t lParam)');
	const setWindowTextW = bind<'setWindowTextW'>(user32, 'int SetWindowTextW(void *hWnd, const char16_t *lpString)');
	const createSolidBrush = bind<'createSolidBrush'>(gdi32, 'void *CreateSolidBrush(uint32 color)');
	const fillRect = bind<'fillRect'>(user32, 'int FillRect(void *hdc, _In_ RECT *lprc, void *hbr)');
	const getWindowThreadProcessId = bind<'getWindowThreadProcessId'>(user32, 'uint32 GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)');
	const getGUIThreadInfo = bind<'getGUIThreadInfo'>(user32, 'int GetGUIThreadInfo(uint32 idThread, _Inout_ void *pgui)');
	const mapVirtualKeyW = bind<'mapVirtualKeyW'>(user32, 'uint32 MapVirtualKeyW(uint32 uCode, uint32 uMapType)');
	const sendInput = bind<'sendInput'>(user32, 'uint32 SendInput(uint32 cInputs, _In_ INPUT *pInputs, int cbSize)');
	const setProcessDpiAware = bind<'setProcessDpiAware'>(user32, 'int SetProcessDPIAware()');

	const createCompatibleDC = bind<'createCompatibleDC'>(gdi32, 'void *CreateCompatibleDC(void *hdc)');
	const createCompatibleBitmap = bind<'createCompatibleBitmap'>(gdi32, 'void *CreateCompatibleBitmap(void *hdc, int cx, int cy)');
	const selectObject = bind<'selectObject'>(gdi32, 'void *SelectObject(void *hdc, void *h)');
	const bitBlt = bind<'bitBlt'>(gdi32, 'int BitBlt(void *hdc, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, uint32 rop)');
	const getDIBits = bind<'getDIBits'>(gdi32, 'int GetDIBits(void *hdc, void *hbm, uint32 start, uint32 cLines, _Out_ void *lpvBits, _Inout_ void *lpbmi, uint32 usage)');
	const deleteObject = bind<'deleteObject'>(gdi32, 'int DeleteObject(void *ho)');
	const deleteDC = bind<'deleteDC'>(gdi32, 'int DeleteDC(void *hdc)');

	try {
		// DPI 感知只能设置一次且在窗口创建前生效；宿主（Electron）通常已设置，
		// 因此这里只做"能设就设"，失败无害。
		setProcessDpiAware();
	} catch {
		// 已设置过会被拒绝，与坐标正确性无关
	}

	/**
	 * 在一块内存 DC 上跑一次绘制，并把结果取回成自顶向下的 BGRA。
	 *
	 * `captureBgra`（抓屏幕）与 `printWindowBgra`（让窗口自绘）只差"往内存 DC 里
	 * 画什么"，而设备上下文与位图的创建/释放顺序完全一样。这段顺序一处分神就会
	 * 泄漏 GDI 对象，因此两处共用一份实现，而不是各写一遍。
	 *
	 * @param draw - 收到内存 DC 与屏幕 DC，返回 false 表示绘制失败。
	 * @param failure - 绘制失败时抛出的说明。
	 */
	function renderToMemory(
		width: number,
		height: number,
		draw: (memoryDc: bigint, screenDc: bigint) => boolean,
		failure: string,
	): Uint8Array {
		if (width <= 0 || height <= 0) throw new Error(`非法尺寸 ${width}x${height}`);
		const screenDc = getDC(null);
		if (screenDc == null) throw new Error('GetDC(NULL) 失败，无法访问屏幕设备上下文');

		let memoryDc: bigint | null = null;
		let bitmap: bigint | null = null;
		let previous: bigint | null = null;
		try {
			memoryDc = createCompatibleDC(screenDc);
			if (memoryDc == null) throw new Error('CreateCompatibleDC 失败');
			bitmap = createCompatibleBitmap(screenDc, width, height);
			if (bitmap == null) throw new Error('CreateCompatibleBitmap 失败');
			previous = selectObject(memoryDc, bitmap);

			if (!draw(memoryDc, screenDc)) throw new Error(failure);

			// BITMAPINFOHEADER：负高度表示自顶向下，省掉一次整幅垂直翻转
			const header = Buffer.alloc(BITMAPINFOHEADER_SIZE);
			header.writeUInt32LE(BITMAPINFOHEADER_SIZE, 0);
			header.writeInt32LE(width, 4);
			header.writeInt32LE(-height, 8);
			header.writeUInt16LE(1, 12);
			header.writeUInt16LE(32, 14);
			header.writeUInt32LE(0, 16); // BI_RGB
			header.writeUInt32LE(width * height * 4, 20);

			const pixels = Buffer.alloc(width * height * 4);
			const scanned = getDIBits(memoryDc, bitmap, 0, height, pixels, header, DIB_RGB_COLORS);
			if (scanned === 0) throw new Error('GetDIBits 失败，无法读取位图像素');
			return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length);
		} finally {
			// bitmap 与 previous 都只在 memoryDc 非空之后才可能被赋值，
			// 因此这个外层判断同时保证了 GDI 对象不会泄漏。
			if (memoryDc != null) {
				if (previous != null) selectObject(memoryDc, previous);
				if (bitmap != null) deleteObject(bitmap);
				deleteDC(memoryDc);
			}
			releaseDC(null, screenDc);
		}
	}

	function windowInfo(handle: bigint): WindowInfo | undefined {
		if (handle === 0n) return undefined;
		const rect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
		if (getWindowRect(handle, rect) === 0) return undefined;
		const processIdSlot = Buffer.alloc(4);
		getWindowThreadProcessId(handle, processIdSlot);
		return {
			handle,
			title: readWindowText(getWindowTextW, handle, MAX_WINDOW_TEXT),
			className: readWindowText(getClassNameW, handle, MAX_CLASS_NAME),
			processId: processIdSlot.readUInt32LE(0),
			rect: { ...rect },
		};
	}

	return {
		inputStructSize,

		screenMetrics(index) {
			return getSystemMetrics(index);
		},

		cursorPosition() {
			const point: Point = { x: 0, y: 0 };
			if (getCursorPos(point) === 0) throw new Error('GetCursorPos 调用失败，无法读取光标位置');
			return { x: point.x, y: point.y };
		},

		setCursorPosition(x, y) {
			return setCursorPos(x, y) !== 0;
		},

		foregroundWindow() {
			return getForegroundWindow() ?? 0n;
		},

		windowInfo,

		focusedControl() {
			const foreground = getForegroundWindow();
			if (foreground == null || foreground === 0n) return 0n;
			// 只要线程 id；进程 id 槽位丢掉即可
			const threadId = getWindowThreadProcessId(foreground, Buffer.alloc(4));
			if (threadId === 0) return 0n;

			const info = Buffer.alloc(GUITHREADINFO_SIZE);
			info.writeUInt32LE(GUITHREADINFO_SIZE, 0);
			if (getGUIThreadInfo(threadId, info) === 0) return 0n;
			return info.readBigUInt64LE(GUITHREADINFO_FOCUS_OFFSET);
		},

		sendInput(events) {
			if (events.length === 0) return 0;
			// 一次 SendInput 承载整批事件：系统按批投递，顺序有保证，
			// 也避免逐事件调用之间被其它输入插入。
			const payload = events.map((event) => event.kind === 'mouse'
				? {
					type: INPUT_MOUSE,
					u: { mi: { dx: event.dx, dy: event.dy, mouseData: event.mouseData, dwFlags: event.flags, time: 0, dwExtraInfo: 0 } },
				}
				: {
					type: INPUT_KEYBOARD,
					u: { ki: { wVk: event.virtualKey, wScan: event.scanCode, dwFlags: event.flags, time: 0, dwExtraInfo: 0 } },
				});
			return sendInput(payload.length, payload, inputStructSize);
		},

		virtualKeyToScanCode(virtualKey) {
			return mapVirtualKeyW(virtualKey, MAPVK_VK_TO_VSC);
		},

		captureBgra(x, y, width, height) {
			return renderToMemory(width, height, (memoryDc, screenDc) => bitBlt(memoryDc, 0, 0, width, height, screenDc, x, y, SRCCOPY) !== 0,
				'BitBlt 失败，无法把屏幕内容复制到位图');
		},

		// ---- 后台模式所需：以下全部不要求窗口在前台 --------------------------

		clientArea(handle) {
			if (handle === 0n) return undefined;
			const rect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
			if (getClientRect(handle, rect) === 0) return undefined;
			// GetClientRect 给的是相对客户区原点的矩形，必须再用 ClientToScreen
			// 把原点换算到屏幕坐标——这正是不换算就会整体偏移的原因。
			const origin: Point = { x: 0, y: 0 };
			clientToScreen(handle, origin);
			return { x: origin.x, y: origin.y, width: rect.right - rect.left, height: rect.bottom - rect.top };
		},

		windowDpi(handle) {
			const dpi = getDpiForWindow(handle);
			// 老系统或句柄失效时返回 0；按 100% 处理，避免除零
			return dpi === 0 ? 96 : dpi;
		},

		isWindowVisible(handle) {
			return isWindowVisible(handle) !== 0;
		},

		isMinimized(handle) {
			return isIconic(handle) !== 0;
		},

		childWindows(handle) {
			const children: bigint[] = [];
			let previous: bigint | null = null;
			// 上限只是防"父链异常导致死循环"，正常窗口远达不到
			for (let guard = 0; guard < MAX_CHILD_WINDOWS; guard += 1) {
				const child = findWindowExW(handle, previous, null, null);
				if (child == null || child === 0n) break;
				children.push(child);
				previous = child;
			}
			return children;
		},

		childWindowFromPoint(parent, x, y) {
			if (parent === 0n) return 0n;
			// POINT 必须按**值**传：真实原型是 ChildWindowFromPointEx(HWND, POINT, UINT)，
			// x64 调用约定下这个 8 字节结构体整体放在一个寄存器里。若把签名拆成
			// (hWnd, int32 x, int32 y, uint32 flags)，寄存器就会整体错位，y 会跑到
			// flags 的位置，函数返回一个无意义的句柄——而且不报错。
			// 这种错误单元测试测不出来（替身是按声明的签名实现的），只有真实调用才暴露。
			const point: Point = { x, y };
			return childWindowFromPointEx(parent, point, CWP_SKIP_INVISIBLE_DISABLED) ?? 0n;
		},

		topLevelWindows() {
			const windows: bigint[] = [];
			// 用 GetTopWindow + GetWindow(GW_HWNDNEXT) 逐个走，而不是 EnumWindows：
			// EnumWindows 需要传回调，回调跨 FFI 边界是最容易出错、也最难测的一处。
			let current = getTopWindow(null);
			for (let guard = 0; guard < MAX_CHILD_WINDOWS; guard += 1) {
				if (current == null || current === 0n) break;
				windows.push(current);
				current = getWindow(current, GW_HWNDNEXT);
			}
			return windows;
		},

		printWindowBgra(handle, width, height) {
			let succeeded = false;
			const pixels = renderToMemory(width, height, (memoryDc) => {
				// 先铺白底：这样"窗口什么都没画"表现为白色，而不是一块未初始化内存。
				// 黑图失败与白图失败的含义完全不同，铺底才能把它们区分开。
				const brush = createSolidBrush(0x00ffffff);
				if (brush != null) {
					const rect: Rect = { left: 0, top: 0, right: width, bottom: height };
					fillRect(memoryDc, rect, brush);
					deleteObject(brush);
				}
				succeeded = printWindow(handle, memoryDc, PW_RENDERFULLCONTENT) !== 0;
				// 即使 PrintWindow 返回 0 也继续取回像素：调用方需要看内容来判断，
				// 而不是只依赖这个返回值（它经常在内容为空时仍然返回成功）。
				return true;
			}, 'PrintWindow 失败');
			return { ok: succeeded, pixels };
		},

		postMessage(handle, message, wParam, lParam) {
			return postMessageW(handle, message, wParam, lParam) !== 0;
		},

		sendMessage(handle, message, wParam, lParam) {
			return sendMessageW(handle, message, wParam, lParam);
		},

		setWindowText(handle, text) {
			return setWindowTextW(handle, text) !== 0;
		},
	};
}
