/**
 * 屏幕边框指示器：**区域裁剪 + 整体 alpha**，不碰逐像素合成。
 *
 * 为什么换路线：`UpdateLayeredWindow` 在这台机器上连不透明填充都不合成
 * （API 返回 true、DIB 内容正确、窗口 visible/topmost 也对，屏幕上就是没有）。
 * 而"背景画刷 + SetLayeredWindowAttributes"已经被纯色窗口验证可行。
 *
 * 于是把窗口裁成**只剩边框**：外壳矩形减去内缩矩形，得到一圈 8px 的框。
 * 画刷负责上色、SLWA 负责整体透明度（呼吸动画就是反复改 alpha）。
 * 好处：不需要窗口过程、不需要 WM_PAINT、不需要 DIB。
 *
 * 用法：node scripts/probe-overlay-region.mjs [毫秒数]
 */
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/administor/.dsh/profiles/desktop/package.json');
const koffi = require('koffi');

const DURATION = Number(process.argv[2] ?? 6000);

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

const WNDCLASSEXA = koffi.struct('RG_WNDCLASSEXA', {
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
const POINT = koffi.struct('RG_POINT', { x: 'int32', y: 'int32' });
const MSG = koffi.struct('RG_MSG', {
	hwnd: 'void *', message: 'uint32', wParam: 'uint64', lParam: 'int64', time: 'uint32', pt: POINT,
});

const getModuleHandle = kernel32.func('void *GetModuleHandleW(str16 name)');
const getProcAddress = kernel32.func('void *GetProcAddress(void *module, str name)');
const registerClassEx = user32.func('uint16 RegisterClassExA(_In_ RG_WNDCLASSEXA *wc)');
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
const peekMessage = user32.func('bool PeekMessageW(_Out_ RG_MSG *msg, void *hwnd, uint32 min, uint32 max, uint32 remove)');
const translateMessage = user32.func('bool TranslateMessage(_In_ RG_MSG *msg)');
const dispatchMessage = user32.func('intptr DispatchMessageW(_In_ RG_MSG *msg)');

const vx = getSystemMetrics(76);
const vy = getSystemMetrics(77);
const vw = getSystemMetrics(78);
const vh = getSystemMetrics(79);
const BORDER = 8;
console.log(`虚拟屏幕 ${vw}x${vh} @ (${vx},${vy})，边框 ${BORDER}px`);

const hInstance = getModuleHandle(null);
const className = 'DshOverlayRegion';
const brush = createSolidBrush(0x00ff9040); // BGR：橙蓝之间的强调色
const wc = {
	cbSize: koffi.sizeof(WNDCLASSEXA),
	style: 0,
	lpfnWndProc: getProcAddress(getModuleHandle('user32.dll'), 'DefWindowProcA'),
	cbClsExtra: 0,
	cbWndExtra: 0,
	hInstance,
	hIcon: null,
	hCursor: null,
	hbrBackground: brush,
	lpszMenuName: null,
	lpszClassName: className,
	hIconSm: null,
};
if (registerClassEx(wc) === 0) {
	console.error('RegisterClassExA 失败');
	process.exit(1);
}

const WS_POPUP = 0x80000000;
const WS_VISIBLE = 0x10000000;
const WS_EX_TOPMOST = 0x00000008;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_NOACTIVATE = 0x08000000;

const hwnd = createWindowEx(
	WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
	className,
	'DSH Computer Use Frame',
	WS_POPUP | WS_VISIBLE,
	vx, vy, vw, vh,
	null, null, hInstance, null,
);
if (hwnd === null) {
	console.error('CreateWindowExA 失败');
	process.exit(1);
}

// 外壳减去内缩 → 只剩一圈边框
const outer = createRectRgn(0, 0, vw, vh);
const inner = createRectRgn(BORDER, BORDER, vw - BORDER, vh - BORDER);
const RGN_DIFF = 4;
combineRgn(outer, outer, inner, RGN_DIFF);
setWindowRgn(hwnd, outer, true);

showWindow(hwnd, 5);
setLayeredWindowAttributes(hwnd, 0, 200, 0x00000002);
invalidateRect(hwnd, null, true);
updateWindow(hwnd);
console.log(`hwnd=${hwnd} 区域已设置`);

/** 排空消息队列（背景画刷的擦除靠它）。 */
function pump() {
	const msg = {};
	while (peekMessage(msg, null, 0, 0, 1) === true) {
		translateMessage(msg);
		dispatchMessage(msg);
	}
}

// 呼吸：反复改整体 alpha
const started = Date.now();
const timer = setInterval(() => {
	const seconds = (Date.now() - started) / 1000;
	const alpha = Math.round(90 + 110 * (0.5 + 0.5 * Math.sin(seconds * Math.PI * 1.2)));
	setLayeredWindowAttributes(hwnd, 0, alpha, 0x00000002);
	invalidateRect(hwnd, null, true);
	updateWindow(hwnd);
	if (Date.now() - started > DURATION) {
		clearInterval(timer);
		showWindow(hwnd, 0);
		console.log('隐藏并退出');
		process.exit(0);
	}
}, 40);
