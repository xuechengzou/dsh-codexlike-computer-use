/**
 * 验证：带**消息泵**的 layered 窗口能否真正显示。
 *
 * 结论来自前几轮踩坑：
 * 1. 窗口建好、`IsWindowVisible=true`、`WS_EX_TOPMOST` 也对，但屏幕上什么都没有；
 * 2. 原因是普通 node 进程没有消息循环，`WM_ERASEBKGND`/`WM_PAINT` 从不派发，
 *    layered 窗口的内容永远为空 → 全透明；
 * 3. 所以探针必须自己泵消息（插件里由 Electron 主进程提供，不必自建）。
 *
 * 另外：koffi 在 `lib.func()` 时解析类型名，**结构体必须先注册再用**，
 * 否则报 `Unknown or invalid type name`（我因此白跑了两轮）。
 *
 * 用法：node scripts/probe-window-visible.mjs [毫秒数]
 */
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/administor/.dsh/profiles/desktop/package.json');
const koffi = require('koffi');

const DURATION = Number(process.argv[2] ?? 6000);

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

// ---- 结构体先注册，再绑定函数 -------------------------------------------
const WNDCLASSEXA = koffi.struct('DSH_WNDCLASSEXA', {
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

const POINT = koffi.struct('DSH_POINT', { x: 'int32', y: 'int32' });
const MSG = koffi.struct('DSH_MSG', {
	hwnd: 'void *',
	message: 'uint32',
	wParam: 'uint64',
	lParam: 'int64',
	time: 'uint32',
	pt: POINT,
});

const getModuleHandle = kernel32.func('void *GetModuleHandleW(str16 name)');
const getProcAddress = kernel32.func('void *GetProcAddress(void *module, str name)');
const registerClassEx = user32.func('uint16 RegisterClassExA(_In_ DSH_WNDCLASSEXA *wc)');
const createWindowEx = user32.func(
	'void *CreateWindowExA(uint32 exStyle, str className, str windowName, uint32 style, int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)',
);
const showWindow = user32.func('bool ShowWindow(void *hwnd, int cmd)');
const setLayeredWindowAttributes = user32.func('bool SetLayeredWindowAttributes(void *hwnd, uint32 key, uint8 alpha, uint32 flags)');
const getSystemMetrics = user32.func('int GetSystemMetrics(int index)');
const createSolidBrush = gdi32.func('void *CreateSolidBrush(uint32 color)');
const peekMessage = user32.func('bool PeekMessageW(_Out_ DSH_MSG *msg, void *hwnd, uint32 min, uint32 max, uint32 remove)');
const translateMessage = user32.func('bool TranslateMessage(_In_ DSH_MSG *msg)');
const dispatchMessage = user32.func('intptr DispatchMessageW(_In_ DSH_MSG *msg)');

const vx = getSystemMetrics(76);
const vy = getSystemMetrics(77);
const vw = getSystemMetrics(78);
const vh = getSystemMetrics(79);
console.log(`虚拟屏幕 ${vw}x${vh} @ (${vx},${vy})`);

const hInstance = getModuleHandle(null);
const className = 'DshProbeVisible2';
const brush = createSolidBrush(0x00ff5020);
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

const hwnd = createWindowEx(
	WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED,
	className,
	'DSH Probe Visible 2',
	WS_POPUP | WS_VISIBLE,
	vx + 200, vy + 150, 640, 360,
	null, null, hInstance, null,
);
if (hwnd === null) {
	console.error('CreateWindowExA 失败');
	process.exit(1);
}

const applied = setLayeredWindowAttributes(hwnd, 0, 180, 0x00000002);
showWindow(hwnd, 5);
console.log(`hwnd=${hwnd} alpha=${applied}`);

/** 排空一次消息队列，让窗口真正绘制。 */
function pump() {
	const msg = {};
	while (peekMessage(msg, null, 0, 0, 1) === true) {
		translateMessage(msg);
		dispatchMessage(msg);
	}
}

const pumpTimer = setInterval(pump, 16);
setTimeout(() => {
	clearInterval(pumpTimer);
	showWindow(hwnd, 0);
	console.log('隐藏并退出');
	process.exit(0);
}, DURATION);
