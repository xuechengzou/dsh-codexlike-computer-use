/**
 * 屏幕级"正在使用"指示器探针：透明、置顶、鼠标穿透的原生窗口 + GDI 逐帧呼吸边框。
 *
 * 先用探针跑，是因为原生窗口参数写错的后果（黑窗、抢焦点、不显示）在插件里
 * 只能靠重启宿主验证一次；这里可以直接跑、直接截图看效果。
 *
 * 实现要点：
 * - 用 **ANSI** 窗口 API（RegisterClassExA/CreateWindowExA/DrawTextA），
 *   类名与标签都是 ASCII，避免宽字符缓冲区的编码问题。
 * - 窗口过程直接用 `DefWindowProc`（经 GetProcAddress 取地址），因此**不需要**
 *   koffi 回调；所有绘制都走 `UpdateLayeredWindow`，不依赖 WM_PAINT。
 * - WS_EX_LAYERED|TRANSPARENT|TOPMOST|TOOLWINDOW|NOACTIVATE：
 *   鼠标穿透、不进 Alt-Tab、不抢焦点。
 *
 * 用法：node scripts/probe-overlay.mjs [毫秒数]
 */
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/administor/.dsh/profiles/desktop/package.json');
const koffi = require('koffi');

const DURATION = Number(process.argv[2] ?? 4000);

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

const WNDCLASSEXA = koffi.struct('WNDCLASSEXA', {
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

const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
	biSize: 'uint32',
	biWidth: 'int32',
	biHeight: 'int32',
	biPlanes: 'uint16',
	biBitCount: 'uint16',
	biCompression: 'uint32',
	biSizeImage: 'uint32',
	biXPelsPerMeter: 'int32',
	biYPelsPerMeter: 'int32',
	biClrUsed: 'uint32',
	biClrImportant: 'uint32',
});

const MSG = koffi.struct('OVL_MSG', {
	hwnd: 'void *', message: 'uint32', wParam: 'uint64', lParam: 'int64', time: 'uint32',
	pt: koffi.struct('OVL_POINT', { x: 'int32', y: 'int32' }),
});

const RECT = koffi.struct('OVL_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const BLENDFUNCTION = koffi.struct('OVL_BLEND', {
	BlendOp: 'uint8',
	BlendFlags: 'uint8',
	SourceConstantAlpha: 'uint8',
	AlphaFormat: 'uint8',
});

const getModuleHandle = kernel32.func('void *GetModuleHandleW(str16 name)');
const getProcAddress = kernel32.func('void *GetProcAddress(void *module, str name)');
const registerClassEx = user32.func('uint16 RegisterClassExA(_In_ WNDCLASSEXA *wc)');
const createWindowEx = user32.func(
	'void *CreateWindowExA(uint32 exStyle, str className, str windowName, uint32 style, int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)',
);
const showWindow = user32.func('bool ShowWindow(void *hwnd, int cmd)');
const getDc = user32.func('void *GetDC(void *hwnd)');
const updateLayeredWindow = user32.func(
	'bool UpdateLayeredWindow(void *hwnd, void *dstDc, _In_ OVL_RECT *dst, void *size, void *srcDc, _In_ OVL_RECT *src, uint32 colorKey, _In_ OVL_BLEND *blend, uint32 flags)',
);
const getSystemMetrics = user32.func('int GetSystemMetrics(int index)');
const peekMessage = user32.func('bool PeekMessageW(_Out_ OVL_MSG *msg, void *hwnd, uint32 min, uint32 max, uint32 remove)');
const translateMessage = user32.func('bool TranslateMessage(_In_ OVL_MSG *msg)');
const dispatchMessage = user32.func('intptr DispatchMessageW(_In_ OVL_MSG *msg)');
// DrawText 属于 user32，不在 gdi32
const drawTextA = user32.func('int DrawTextA(void *hdc, str text, int count, _Inout_ OVL_RECT *rect, uint32 format)');
const createCompatibleDC = gdi32.func('void *CreateCompatibleDC(void *hdc)');
const createDIBSection = gdi32.func(
	'void *CreateDIBSection(void *hdc, _In_ BITMAPINFOHEADER *info, uint32 usage, _Out_ void **bits, void *section, uint32 offset)',
);
const selectObject = gdi32.func('void *SelectObject(void *hdc, void *object)');
const setBkMode = gdi32.func('int SetBkMode(void *hdc, int mode)');
const setTextColor = gdi32.func('uint32 SetTextColor(void *hdc, uint32 color)');
const createFontA = gdi32.func(
	'void *CreateFontA(int height, int width, int escapement, int orientation, int weight, uint32 italic, uint32 underline, uint32 strikeOut, uint32 charSet, uint32 outPrecision, uint32 clipPrecision, uint32 quality, uint32 pitchAndFamily, str face)',
);
const msvcrt = koffi.load('msvcrt.dll');
const memcpy = msvcrt.func('void *memcpy(void *dest, void *src, uintptr count)');

const vx = getSystemMetrics(76);
const vy = getSystemMetrics(77);
const vw = getSystemMetrics(78);
const vh = getSystemMetrics(79);
console.log(`虚拟屏幕 ${vw}x${vh} @ (${vx},${vy})`);

const hInstance = getModuleHandle(null);
const className = 'DshComputerUseOverlay';
const wc = {
	cbSize: koffi.sizeof(WNDCLASSEXA),
	style: 0,
	lpfnWndProc: getProcAddress(getModuleHandle('user32.dll'), 'DefWindowProcA'),
	cbClsExtra: 0,
	cbWndExtra: 0,
	hInstance,
	hIcon: null,
	hCursor: null,
	hbrBackground: null,
	lpszMenuName: null,
	lpszClassName: className,
	hIconSm: null,
};

if (registerClassEx(wc) === 0) {
	console.error('RegisterClassExA 失败');
	process.exit(1);
}

const WS_POPUP = 0x80000000;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_TRANSPARENT = 0x00000020;
const WS_EX_TOPMOST = 0x00000008;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;

const hwnd = createWindowEx(
	WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
	className,
	'DSH Computer Use Overlay',
	WS_POPUP | 0x10000000, // WS_VISIBLE
	vx, vy, vw, vh,
	null, null, hInstance, null,
);
if (hwnd === null) {
	console.error('CreateWindowExA 失败');
	process.exit(1);
}

const screenDc = getDc(null);
const memDc = createCompatibleDC(screenDc);
const header = {
	biSize: koffi.sizeof(BITMAPINFOHEADER),
	biWidth: vw,
	biHeight: -vh,
	biPlanes: 1,
	biBitCount: 32,
	biCompression: 0,
	biSizeImage: vw * vh * 4,
	biXPelsPerMeter: 0,
	biYPelsPerMeter: 0,
	biClrUsed: 0,
	biClrImportant: 0,
};
const bits = [null];
const bitmap = createDIBSection(memDc, header, 0, bits, null, 0);
if (bitmap === null || bits[0] === null) {
	console.error('CreateDIBSection 失败');
	process.exit(1);
}
selectObject(memDc, bitmap);

const pixels = new Uint8Array(vw * vh * 4);
selectObject(memDc, createFontA(16, 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 5, 0, 'Segoe UI'));
setBkMode(memDc, 1);

/**
 * 画一帧：圆角发光线框 + 右上角标签。
 *
 * @param intensity - 0..1 亮度。
 * @param rgb - 强调色。
 * @param label - 右上角文本（ASCII）。
 */
function paint(intensity, rgb, label) {
	const [r, g, b] = rgb;
	pixels.fill(0);
	if (process.env.DSH_OVERLAY_FULL === '1') {
		for (let i = 0; i < pixels.length; i += 4) {
			pixels[i] = 200; pixels[i + 1] = 90; pixels[i + 2] = 40; pixels[i + 3] = 255;
		}
		memcpy(bits[0], koffi.as(pixels, 'uint8 *'), pixels.length);
		const blendFull = { BlendOp: 0, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: 1 };
		const dstFull = { left: vx, top: vy, right: vx + vw, bottom: vy + vh };
		const srcFull = { left: 0, top: 0, right: vw, bottom: vh };
		return updateLayeredWindow(hwnd, null, dstFull, null, memDc, srcFull, 0, blendFull, 2);
	}
	const thickness = 16;
	const radius = 24;
	const glow = 28;
	const reach = thickness + glow + radius;
	for (let y = 0; y < vh; y += 1) {
		const insetY = Math.min(y, vh - 1 - y);
		if (insetY > reach) continue;
		for (let x = 0; x < vw; x += 1) {
			const insetX = Math.min(x, vw - 1 - x);
			// 只有**同时**远离四条边才跳过；只看 x 会把上下边缘的中间整段裁掉
			if (insetX > reach && insetY > reach) continue;
			const nx = Math.max(radius - x, x - (vw - 1 - radius), 0);
			const ny = Math.max(radius - y, y - (vh - 1 - radius), 0);
			const d = Math.hypot(nx, ny);
			let alpha = 0;
			if (d <= thickness) alpha = 1;
			else if (d <= thickness + glow) alpha = 1 - (d - thickness) / glow;
			if (alpha <= 0) continue;
			const index = (y * vw + x) * 4;
			// AC_SRC_ALPHA 要求**预乘**：颜色先乘 alpha，否则 DWM 合成时整层等于透明
			const a = Math.round(alpha * 255 * intensity);
			const k = a / 255;
			pixels[index] = Math.round(b * 0.6 * k);
			pixels[index + 1] = Math.round(g * 0.75 * k);
			pixels[index + 2] = Math.round(r * k);
			pixels[index + 3] = a;
		}
	}
	memcpy(bits[0], koffi.as(pixels, 'uint8 *'), pixels.length);

	setTextColor(memDc, 0x00000000 | (0 << 16) | 0); // placeholder, reset below
	const color = Math.round(intensity * 255);
	setTextColor(memDc, (color << 16) | (color << 8) | color);
	const rect = { left: vw - 300, top: 16, right: vw - 20, bottom: 48 };
	drawTextA(memDc, label, -1, rect, 0x00000002 | 0x00000004 | 0x00000020);

	const blend = { BlendOp: 0, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: 1 };
	const dst = { left: vx, top: vy, right: vx + vw, bottom: vy + vh };
	const src = { left: 0, top: 0, right: vw, bottom: vh };
	const updated = updateLayeredWindow(hwnd, null, null, null, memDc, src, 0, blend, 2);
	if (!globalThis.__reported) {
		globalThis.__reported = true;
		const offset = (4 * vw + 800) * 4;
		const readBack = koffi.decode(bits[0], 'uint8', offset + 8);
		const probe = readBack.slice(offset, offset + 8);
		console.log('首帧诊断 UpdateLayeredWindow =', updated);
		console.log('  DIB 边框像素 =', Array.from(probe));
		console.log('  应为         =', Array.from(pixels.slice(offset, offset + 8)));
	}
}

showWindow(hwnd, 5);

/** 排空消息队列，让 layered 窗口真正绘制。 */
function pump() {
	const msg = {};
	while (peekMessage(msg, null, 0, 0, 1) === true) {
		translateMessage(msg);
		dispatchMessage(msg);
	}
}
const pumpTimer = setInterval(pump, 16);
paint(1.0, [90, 170, 255], 'COMPUTER USE - WINDOW MODE');
pump();

const started = Date.now();
const timer = setInterval(() => {
	const seconds = (Date.now() - started) / 1000;
	const breath = 1.0; // 诊断模式：恒定最亮，排除"截图正好落在呼吸波谷"
	paint(breath, [90, 170, 255], 'COMPUTER USE - WINDOW MODE');
	if (Date.now() - started > DURATION) {
		clearInterval(timer);
		clearInterval(pumpTimer);
		showWindow(hwnd, 0);
		console.log('指示器已隐藏，退出');
		process.exit(0);
	}
}, 33);
