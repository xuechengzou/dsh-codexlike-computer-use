/**
 * 屏幕边框指示器：agent 正在操作这台机器时，屏幕四周亮一圈呼吸边框。
 *
 * 触发点是 **agent 状态**（`agent/status`：`running` ⇄ `idle`），即"整个 turn
 * 期间常亮、turn 结束淡出"，而不是每次工具调用闪一下。
 *
 * 三条实测得出的硬约束，改这里之前必读：
 *
 * 1. **不要用 `UpdateLayeredWindow`**。这台机器上它返回 true、DIB 内容正确、
 *    窗口 visible/topmost 也对，屏幕上就是没有。可行路径是"背景画刷 +
 *    `SetLayeredWindowAttributes`"。
 * 2. **窗口裁成边框**：`SetWindowRgn` 用外壳矩形减去内缩矩形，只留一圈 8px。
 *    这样不需要窗口过程、不需要 WM_PAINT、也不需要逐像素合成。
 * 3. **必须同步重绘一次**：宿主的消息循环不保证给这个窗口派发 WM_ERASEBKGND，
 *    而 layered 窗口没内容就等于全透明。`InvalidateRect` + `UpdateWindow`
 *    自己触发即可，不依赖消息泵。
 */

/** 指示器强度档位。 */
export type OverlayKind = 'observe' | 'act';

/** koffi 的窄面。 */
interface KoffiLike {
	load(path: string): { func(prototype: string): (...args: unknown[]) => unknown };
	struct(name: string, members: Record<string, string>): unknown;
	sizeof(type: unknown): number;
}

/** 帧状态。 */
interface Frame {
	kind: OverlayKind;
	phase: number;
	setAlpha(alpha: number): void;
	repaint(): void;
	timer: ReturnType<typeof setInterval> | undefined;
}

/** 边框宽度（像素）。 */
const BORDER = 8;

/** 动画帧间隔。 */
const TICK_MS = 40;

/** 释放后淡出时长（毫秒）。 */
const FADE_MS = 500;

/** 当前持有者数量：多个 agent 同时跑时，最后一个释放才熄灭。 */
let holders = 0;

let frame: Frame | undefined;
let pending: Promise<Frame | undefined> | undefined;

/**
 * 建立边框窗口。
 *
 * @param koffi - 已加载的 koffi。
 * @returns 帧状态；平台不支持时返回 undefined。
 */
function createFrame(koffi: KoffiLike): Frame | undefined {
	if (process.platform !== 'win32') return undefined;

	const user32 = koffi.load('user32.dll');
	const gdi32 = koffi.load('gdi32.dll');
	const kernel32 = koffi.load('kernel32.dll');

	const WNDCLASSEXA = koffi.struct('DshOverlayClass', {
		cbSize: 'uint32',
		style: 'uint32',
		lpfnWndProc: 'void *',
		cbClsExtra: 'int',
		cbWndExtra: 'int',
		hInstance: 'void *',
		hIcon: 'void *',
		hCursor: 'void *',
		hbrBackground: 'void *',
		lpszMenuName: 'str',
		lpszClassName: 'str',
		hIconSm: 'void *',
	});

	const getModuleHandle = kernel32.func('void *GetModuleHandleW(str16 name)');
	const getProcAddress = kernel32.func('void *GetProcAddress(void *module, str name)');
	const registerClassEx = user32.func('uint16 RegisterClassExA(_In_ DshOverlayClass *wc)');
	const createWindowEx = user32.func(
		'void *CreateWindowExA(uint32 exStyle, str className, str windowName, uint32 style, int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)',
	);
	const showWindow = user32.func('bool ShowWindow(void *hwnd, int cmd)');
	const setLayeredWindowAttributes = user32.func('bool SetLayeredWindowAttributes(void *hwnd, uint32 key, uint8 alpha, uint32 flags)');
	const setWindowRgn = user32.func('int SetWindowRgn(void *hwnd, void *region, bool redraw)');
	const getSystemMetrics = user32.func('int GetSystemMetrics(int index)');
	const createSolidBrush = gdi32.func('void *CreateSolidBrush(uint32 color)');
	const createRectRgn = gdi32.func('void *CreateRectRgn(int left, int top, int right, int bottom)');
	const combineRgn = gdi32.func('int CombineRgn(void *dst, void *src1, void *src2, int mode)');
	const invalidateRect = user32.func('bool InvalidateRect(void *hwnd, void *rect, bool erase)');
	const updateWindow = user32.func('bool UpdateWindow(void *hwnd)');

	const vx = Number(getSystemMetrics(76));
	const vy = Number(getSystemMetrics(77));
	const vw = Number(getSystemMetrics(78));
	const vh = Number(getSystemMetrics(79));
	if (vw <= 0 || vh <= 0) return undefined;

	const instance = getModuleHandle(null);
	const className = 'DshComputerUseFrame';
	const brush = createSolidBrush(0x00ff9040);

	const wc = {
		cbSize: koffi.sizeof(WNDCLASSEXA),
		style: 0,
		lpfnWndProc: getProcAddress(getModuleHandle('user32.dll'), 'DefWindowProcA'),
		cbClsExtra: 0,
		cbWndExtra: 0,
		hInstance: instance,
		hIcon: null,
		hCursor: null,
		hbrBackground: brush,
		lpszMenuName: null,
		lpszClassName: className,
		hIconSm: null,
	};
	// 类可能已被上一次加载注册过（宿主 HMR）：失败不致命
	registerClassEx(wc);

	const hwnd = createWindowEx(
		0x00080000 | 0x00000008 | 0x00000080 | 0x08000000, // LAYERED | TOPMOST | TOOLWINDOW | NOACTIVATE
		className,
		'DSH Computer Use Frame',
		0x80000000 | 0x10000000, // WS_POPUP | WS_VISIBLE
		vx, vy, vw, vh,
		null, null, instance, null,
	) as bigint | null;
	if (hwnd === null) return undefined;

	const outer = createRectRgn(0, 0, vw, vh);
	const inner = createRectRgn(BORDER, BORDER, vw - BORDER, vh - BORDER);
	combineRgn(outer, outer, inner, 4); // RGN_DIFF：只剩一圈边框
	setWindowRgn(hwnd, outer, true);
	setLayeredWindowAttributes(hwnd, 0, 0, 0x00000002);
	showWindow(hwnd, 5);
	// 同步画一次：宿主不一定给这个窗口派发 WM_ERASEBKGND
	invalidateRect(hwnd, null, true);
	updateWindow(hwnd);

	return {
		kind: 'act',
		phase: 0,
		timer: undefined,
		setAlpha: (alpha: number) => {
			setLayeredWindowAttributes(hwnd, 0, alpha, 0x00000002);
		},
		repaint: () => {
			invalidateRect(hwnd, null, true);
			updateWindow(hwnd);
		},
	};
}

/**
 * 取（或延迟建立）帧。
 *
 * @returns 帧；平台不支持时 undefined。
 */
async function getFrame(): Promise<Frame | undefined> {
	if (frame !== undefined) return frame;
	if (pending === undefined) {
		pending = (async () => {
			try {
				const module = await import('koffi');
				const koffi = (module as { default?: unknown }).default ?? module;
				frame = createFrame(koffi as KoffiLike);
				return frame;
			} catch {
				return undefined;
			}
		})();
	}
	return pending;
}

/**
 * 启动动画循环（幂等）。
 *
 * @param current - 帧状态。
 */
function ensureTicking(current: Frame): void {
	if (current.timer !== undefined) return;
	let fading = false;
	current.timer = setInterval(() => {
		if (holders === 0) fading = true;

		if (fading) {
			// 淡出：每 tick 减一点，到 0 停表
			current.phase = Math.max(0, current.phase - (255 / (FADE_MS / TICK_MS)));
			current.setAlpha(Math.round(current.phase));
			if (current.phase <= 0) {
				if (current.timer !== undefined) clearInterval(current.timer);
				current.timer = undefined;
			}
			return;
		}

		// 亮度按正弦呼吸；phase 同时作为淡出时的亮度载体
		current.phase = 150 + 70 * (0.5 + 0.5 * Math.sin(Date.now() / 260));
		current.setAlpha(Math.round(current.phase));
	}, TICK_MS);
}

/**
 * 点亮指示器（引用计数）。
 *
 * 每个 agent turn 开始时调用一次，结束时 `releaseOverlay` 一次；
 * 最后一个持有者释放后才淡出。
 */
export function holdOverlay(): void {
	holders += 1;
	void getFrame().then((current) => {
		if (current === undefined) return;
		current.repaint();
		ensureTicking(current);
	});
}

/** 释放一次持有。 */
export function releaseOverlay(): void {
	holders = Math.max(0, holders - 1);
}
