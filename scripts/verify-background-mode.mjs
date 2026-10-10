if (process.env.DSH_COMPUTER_USE_ALLOW_DISRUPTIVE !== "1") {
    console.error("本脚本会创建窗口 / 抢占前台 / 移动光标，可能打扰到正在使用电脑的人。");
    console.error("确认此刻可以打扰时：设置 DSH_COMPUTER_USE_ALLOW_DISRUPTIVE=1 再运行。");
    process.exit(2);
}

const [{ spawn, spawnSync }, fs, os, path, url] = await Promise.all([
	import('node:child_process'),
	import('node:fs'),
	import('node:os'),
	import('node:path'),
	import('node:url'),
]);

const {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} = fs;
const { tmpdir } = os;
const { join } = path;
const { fileURLToPath } = url;

const { requireRealKoffi } = await import('./real-koffi.mjs');
requireRealKoffi();

const koffi = await import('koffi');
const api = koffi.default ?? koffi;
const user32 = api.load('user32.dll');
const gdi32 = api.load('gdi32.dll');
const bind = (lib, signature) => lib.func(signature);

const GetDC = bind(user32, 'void *GetDC(void *hWnd)');
const ReleaseDC = bind(user32, 'int ReleaseDC(void *hWnd, void *hDC)');
const GetWindowRect = bind(user32, 'int GetWindowRect(void *hWnd, _Out_ void *rect)');
const GetClientRect = bind(user32, 'int GetClientRect(void *hWnd, _Out_ void *rect)');
const PrintWindow = bind(user32, 'int PrintWindow(void *hWnd, void *hdcBlt, uint32 nFlags)');
const SetForegroundWindow = bind(user32, 'int SetForegroundWindow(void *hWnd)');
const GetForegroundWindow = bind(user32, 'void *GetForegroundWindow()');
const FindWindowW = bind(user32, 'void *FindWindowW(const char16_t *cls, const char16_t *name)');
const FindWindowExW = bind(user32, 'void *FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *name)');
const GetClassNameW = bind(user32, 'int GetClassNameW(void *hWnd, _Out_ char16_t *buf, int max)');
const GetWindowTextW = bind(user32, 'int GetWindowTextW(void *hWnd, _Out_ char16_t *buf, int max)');
const GetCursorPos = bind(user32, 'int GetCursorPos(_Out_ void *point)');
const PostMessageW = bind(user32, 'int PostMessageW(void *hWnd, uint32 msg, intptr_t wParam, intptr_t lParam)');
const SendMessageW = bind(user32, 'intptr_t SendMessageW(void *hWnd, uint32 msg, intptr_t wParam, intptr_t lParam)');
const SendMessageWText = bind(user32, 'intptr_t SendMessageW(void *hWnd, uint32 msg, intptr_t wParam, const char16_t *lParam)');
const SetWindowPos = bind(user32, 'int SetWindowPos(void *hWnd, void *after, int x, int y, int cx, int cy, uint32 flags)');
const GetTopWindow = bind(user32, 'void *GetTopWindow(void *hWnd)');
const GetWindow = bind(user32, 'void *GetWindow(void *hWnd, uint32 cmd)');
const GetWindowThreadProcessId = bind(user32, 'uint32 GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *pid)');
const IsWindowVisible = bind(user32, 'int IsWindowVisible(void *hWnd)');
const FillRect = bind(user32, 'int FillRect(void *hdc, _In_ void *rect, void *brush)');

const CreateCompatibleDC = bind(gdi32, 'void *CreateCompatibleDC(void *hdc)');
const CreateCompatibleBitmap = bind(gdi32, 'void *CreateCompatibleBitmap(void *hdc, int cx, int cy)');
const SelectObject = bind(gdi32, 'void *SelectObject(void *hdc, void *h)');
const BitBlt = bind(gdi32, 'int BitBlt(void *hdc, int x, int y, int cx, int cy, void *src, int x1, int y1, uint32 rop)');
const GetDIBits = bind(gdi32, 'int GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, _Out_ void *bits, _Inout_ void *info, uint32 usage)');
const DeleteObject = bind(gdi32, 'int DeleteObject(void *h)');
const DeleteDC = bind(gdi32, 'int DeleteDC(void *hdc)');
const CreateSolidBrush = bind(gdi32, 'void *CreateSolidBrush(uint32 color)');

const SRCCOPY = 0x00cc0020;
const PW_RENDERFULLCONTENT = 0x00000002;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_MOUSEMOVE = 0x0200;
const WM_CHAR = 0x0102;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_SETTEXT = 0x000c;
const BM_CLICK = 0x00f5;
const MK_LBUTTON = 0x0001;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const HWND_TOPMOST = -1n;
const GW_HWNDNEXT = 2;

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAINT_TARGET = join(PROJECT_ROOT, 'test', 'helpers', 'paint-target.ps1');
const BACKGROUND_TARGET = join(PROJECT_ROOT, 'test', 'helpers', 'background-target.ps1');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 句柄比较必须归一化：koffi 可能返回 bigint、number 或 null，
 * 直接比较会把同一个 hwnd 判成不相等，导致前台检测出现假阳性。
 */
const toHandle = (value) => {
	if (value == null || value === 0 || value === 0n) return 0n;
	if (typeof value === 'bigint') return value;
	if (typeof value === 'number') return BigInt(value);
	return BigInt(value);
};

/**
 * 鼠标消息要把 x/y 封进 lParam 的低/高 16 位；
 * 这里显式截断到 16 位，避免 JS 的符号位扩展污染坐标。
 */
const makeLParam = (x, y) => (((y & 0xffff) << 16) | (x & 0xffff));

const ownedPids = new Set();
const tempDirs = [];

const registerPid = (child) => {
	if (child.pid !== undefined) ownedPids.add(child.pid);
	return child;
};

/**
 * 只按 PID 精确清理自己启动的进程，避免误杀用户已有应用。
 */
const killPid = (pid) => {
	if (pid === undefined || pid === null) return;
	spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
	ownedPids.delete(pid);
};

const mkTempDir = (prefix) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
};

const className = (handle) => {
	const buffer = Buffer.alloc(512);
	const written = GetClassNameW(handle, buffer, 256);
	return written <= 0 ? '' : buffer.subarray(0, written * 2).toString('utf16le');
};

const titleOf = (handle) => {
	const buffer = Buffer.alloc(2048);
	const written = GetWindowTextW(handle, buffer, 1024);
	return written <= 0 ? '' : buffer.subarray(0, written * 2).toString('utf16le');
};

const cursorNow = () => {
	const buffer = Buffer.alloc(8);
	GetCursorPos(buffer);
	return { x: buffer.readInt32LE(0), y: buffer.readInt32LE(4) };
};

/**
 * PowerShell 靶窗口会持续覆写 JSON，读取时经常撞上半写状态；
 * 必须允许短暂失败并重试，否则会把文件竞争误判成窗口异常。
 */
const readJsonRetry = (filePath, retries = 6) => {
	for (let i = 0; i < retries; i += 1) {
		try {
			return JSON.parse(readFileSync(filePath, 'utf8'));
		} catch {
			// ignore
		}
	}
	return null;
};

const waitForJson = async (filePath, predicate, timeoutMs, label) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(filePath)) {
			const json = readJsonRetry(filePath);
			if (json !== null && predicate(json)) return json;
		}
		await sleep(120);
	}
	throw new Error(`${label} 超时`);
};

const waitFor = async (fn, timeoutMs, label) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = fn();
		if (value) return value;
		await sleep(120);
	}
	throw new Error(`${label} 超时`);
};

const readBitmap = (memDc, bitmap, width, height) => {
	const header = Buffer.alloc(40);
	header.writeUInt32LE(40, 0);
	header.writeInt32LE(width, 4);
	header.writeInt32LE(-height, 8);
	header.writeUInt16LE(1, 12);
	header.writeUInt16LE(32, 14);
	header.writeUInt32LE(0, 16);
	header.writeUInt32LE(width * height * 4, 20);
	const pixels = Buffer.alloc(width * height * 4);
	GetDIBits(memDc, bitmap, 0, height, pixels, header, 0);
	return pixels;
};

const captureScreen = (left, top, width, height) => {
	const screenDc = GetDC(null);
	const memDc = CreateCompatibleDC(screenDc);
	const bitmap = CreateCompatibleBitmap(screenDc, width, height);
	const previous = SelectObject(memDc, bitmap);
	try {
		BitBlt(memDc, 0, 0, width, height, screenDc, left, top, SRCCOPY);
		return readBitmap(memDc, bitmap, width, height);
	} finally {
		SelectObject(memDc, previous);
		DeleteObject(bitmap);
		DeleteDC(memDc);
		ReleaseDC(null, screenDc);
	}
};

const capturePrintWindow = (handle, width, height, flags) => {
	const screenDc = GetDC(null);
	const memDc = CreateCompatibleDC(screenDc);
	const bitmap = CreateCompatibleBitmap(screenDc, width, height);
	const previous = SelectObject(memDc, bitmap);
	try {
		// 先刷白底：未渲染区域会表现为白色，便于和有效内容区分。
		const whiteBrush = CreateSolidBrush(0x00ffffff);
		const rect = Buffer.alloc(16);
		rect.writeInt32LE(0, 0);
		rect.writeInt32LE(0, 4);
		rect.writeInt32LE(width, 8);
		rect.writeInt32LE(height, 12);
		FillRect(memDc, rect, whiteBrush);
		DeleteObject(whiteBrush);
		const ok = PrintWindow(handle, memDc, flags);
		return { ok, pixels: readBitmap(memDc, bitmap, width, height) };
	} finally {
		SelectObject(memDc, previous);
		DeleteObject(bitmap);
		DeleteDC(memDc);
		ReleaseDC(null, screenDc);
	}
};

const analyzePixels = (pixels) => {
	let magenta = 0;
	let cyan = 0;
	let black = 0;
	let white = 0;
	let other = 0;
	const total = pixels.length / 4;
	for (let i = 0; i < pixels.length; i += 4) {
		const b = pixels[i];
		const g = pixels[i + 1];
		const r = pixels[i + 2];
		if (r > 200 && g < 70 && b > 200) magenta += 1;
		else if (r < 70 && g > 200 && b > 200) cyan += 1;
		else if (r < 20 && g < 20 && b < 20) black += 1;
		else if (r > 235 && g > 235 && b > 235) white += 1;
		else other += 1;
	}
	const ratio = (count) => (count / total) * 100;
	return {
		total,
		magenta,
		cyan,
		black,
		white,
		other,
		magentaRatio: ratio(magenta),
		cyanRatio: ratio(cyan),
		blackRatio: ratio(black),
		whiteRatio: ratio(white),
	};
};

/**
 * 前台审计单独聚合成一个结论，避免每个子实验各说各话，
 * 用户能一眼看出到底哪一步可能抢走了焦点。
 */
const foregroundChecks = [];

/**
 * 被操作的窗口句柄集合。
 *
 * 第 3 条的**真正不变量**是"前台从未变成被操作的那个窗口"，
 * 而不是"前台必须是某个特定窗口"。后者是错误的前提：
 * `SetForegroundWindow` 从后台进程调用会被 Windows 前台锁拒绝，
 * 于是"遮挡窗口应该是前台"永远不成立，会把本来正确的测量判成失败。
 */
const targetHandles = new Set();
const registerTarget = (handle) => {
	const normalized = toHandle(handle);
	if (normalized !== null) targetHandles.add(normalized);
	return normalized;
};

const recordForeground = (step, expectedHandle) => {
	const actual = toHandle(GetForegroundWindow());
	foregroundChecks.push({ step, expected: toHandle(expectedHandle), actual });
	return actual;
};

const cursorBaseline = cursorNow();
const cursorChanges = [];

/**
 * 先判断环境里有没有人在用鼠标。
 *
 * 用户正在用电脑时，光标本来就在动。此时把任何位移算成"被脚本移动了"是错的，
 * 反过来把噪声当成"没动"也是错的——两者都是在伪造结论。所以先连续采样：
 * 只要起始阶段光标就自己在动，本项就明确报"无法判定"，而不是给一个看似精确、
 * 实则毫无意义的数字。
 */
let cursorInUse = false;
const probeCursorStability = async () => {
	const samples = [cursorNow()];
	for (let index = 0; index < 3; index += 1) {
		await sleep(200);
		samples.push(cursorNow());
	}
	cursorInUse = samples.some((sample) => sample.x !== samples[0].x || sample.y !== samples[0].y);
	return samples;
};

/**
 * 光标变化不能立刻定罪：真实环境里用户可能正好动了鼠标。
 * 先二次采样再记录，报告里如实给出“可能是用户移动”的空间。
 */
const recordCursor = async (step) => {
	const now = cursorNow();
	if (now.x === cursorBaseline.x && now.y === cursorBaseline.y) return;
	await sleep(220);
	const again = cursorNow();
	cursorChanges.push({ step, first: now, second: again });
};

const launchPaint = async ({ outPath, title, color, left, top, width, height }) => {
	if (existsSync(outPath)) unlinkSync(outPath);
	const child = registerPid(spawn('pwsh', [
		'-NoProfile',
		'-ExecutionPolicy', 'Bypass',
		'-File', PAINT_TARGET,
		'-OutPath', outPath,
		'-Title', title,
		'-Color', color,
		'-Left', String(left),
		'-Top', String(top),
		'-Width', String(width),
		'-Height', String(height),
	], { stdio: 'ignore' }));
	const state = await waitForJson(outPath, (json) => Number(json?.hwnd) > 0, 12000, `窗口 ${title}`);
	return { child, state };
};

const launchBackgroundTarget = async ({ outPath, title, left, top }) => {
	if (existsSync(outPath)) unlinkSync(outPath);
	const child = registerPid(spawn('pwsh', [
		'-NoProfile',
		'-ExecutionPolicy', 'Bypass',
		'-File', BACKGROUND_TARGET,
		'-OutPath', outPath,
		'-Title', title,
		'-Left', String(left),
		'-Top', String(top),
	], { stdio: 'ignore' }));
	const state = await waitForJson(
		outPath,
		(json) => Number(json?.form) > 0 && Number(json?.button) > 0 && Number(json?.box) > 0,
		12000,
		`窗口 ${title}`,
	);
	return { child, state };
};

const findTopWindowsByPid = (pid) => {
	const handles = [];
	let handle = GetTopWindow(null);
	for (let guard = 0; guard < 3000 && handle != null && handle !== 0n; guard += 1) {
		const pidBuffer = Buffer.alloc(4);
		GetWindowThreadProcessId(handle, pidBuffer);
		if (pidBuffer.readUInt32LE(0) === pid && IsWindowVisible(handle) !== 0) {
			const rect = Buffer.alloc(16);
			GetWindowRect(handle, rect);
			const width = rect.readInt32LE(8) - rect.readInt32LE(0);
			const height = rect.readInt32LE(12) - rect.readInt32LE(4);
			if (width >= 300 && height >= 200) {
				handles.push({ handle, width, height, area: width * height, cls: className(handle) });
			}
		}
		handle = GetWindow(handle, GW_HWNDNEXT);
	}
	handles.sort((a, b) => b.area - a.area);
	return handles;
};

/**
 * 渲染子窗口至少要这么大才算"真内容表面"。
 *
 * Chromium 会同时建出若干类名相同的辅助窗口，实测见过 12x10 与 0x0 的。
 * 只按"面积最大"挑是不够的：真表面还没建出来时，最大的那个就是辅助窗口，
 * 于是消息送达、坐标全错。用尺寸门槛把这个窗口期排除掉。
 */
const MIN_RENDER_WIDGET_EDGE = 200;

const findLargestRenderWidget = (rootHandle) => {
	const queue = [rootHandle];
	let best = null;
	while (queue.length > 0) {
		const parent = queue.shift();
		let previous = null;
		for (let guard = 0; guard < 400; guard += 1) {
			const child = FindWindowExW(parent, previous, null, null);
			if (child == null || child === 0n) break;
			const cls = className(child);
			if (cls.toLowerCase().includes('renderwidgethost')) {
				const rect = Buffer.alloc(16);
				GetClientRect(child, rect);
				const width = rect.readInt32LE(8);
				const height = rect.readInt32LE(12);
				const area = width * height;
				if (width > 0 && height > 0 && (best === null || area > best.area)) {
					best = { handle: child, width, height, cls, area };
				}
			}
			queue.push(child);
			previous = child;
		}
	}
	return best;
};

const parseChromeTitle = (title) => {
	const match = /^BGV\|md=(\d+)\|kd=(\d+)\|x=(-?\d+)\|y=(-?\d+)\|key=([^|]*)\|vw=(\d+)\|vh=(\d+)$/u.exec(title);
	if (match === null) return null;
	return {
		md: Number(match[1]),
		kd: Number(match[2]),
		x: Number(match[3]),
		y: Number(match[4]),
		key: decodeURIComponent(match[5]),
		viewportWidth: Number(match[6]),
		viewportHeight: Number(match[7]),
	};
};

const resultByPoint = new Map();

const setResult = (point, title, status, detail) => {
	resultByPoint.set(point, { point, title, status, detail });
};

const runPoint1 = async () => {
	const temp = mkTempDir('dsh-verify-bg-cap-');
	const bottomOut = join(temp, 'bottom.json');
	const coverOut = join(temp, 'cover.json');
	let bottom = null;
	let cover = null;
	try {
		bottom = await launchPaint({
			outPath: bottomOut,
			title: 'VERIFY-BG-MAGENTA',
			color: 'Magenta',
			left: 220,
			top: 120,
			width: 600,
			height: 420,
		});
		cover = await launchPaint({
			outPath: coverOut,
			title: 'VERIFY-BG-COVER',
			color: 'Cyan',
			left: 180,
			top: 90,
			width: 700,
			height: 500,
		});

		const bottomHandle = toHandle(BigInt(bottom.state.hwnd));
		const coverHandle = toHandle(BigInt(cover.state.hwnd));
		SetForegroundWindow(coverHandle);
		await sleep(700);
		recordForeground('1.截图前', coverHandle);
		await recordCursor('1.截图后');

		const left = Number(bottom.state.left);
		const top = Number(bottom.state.top);
		const width = Number(bottom.state.width);
		const height = Number(bottom.state.height);
		const printResult = capturePrintWindow(bottomHandle, width, height, PW_RENDERFULLCONTENT);
		const screenPixels = captureScreen(left, top, width, height);
		const printStats = analyzePixels(printResult.pixels);
		const screenStats = analyzePixels(screenPixels);

		// 要证明的是「目标窗口不在前台、且被盖住」，不是「此刻谁在前台」。
		// 早先这里要求"前台必须是遮挡窗口"，但 SetForegroundWindow 会被系统前台锁
		// 拒绝，那个前提永远不成立——于是 PrintWindow 抓到 89.68% 品红这种
		// 明确成功的结果被误判成了失败。
		registerTarget(bottomHandle);
		const targetIsForeground = toHandle(GetForegroundWindow()) === toHandle(bottomHandle);
		const pass = printResult.ok === 1 && printStats.magentaRatio > 50 && screenStats.magentaRatio < 10 && !targetIsForeground;
		setResult(
			1,
			'后台 GDI 截图',
			pass ? '通过' : '失败',
			`PrintWindow返回=${printResult.ok}，PrintWindow品红=${printStats.magentaRatio.toFixed(2)}%（${printStats.magenta}/${printStats.total}），屏幕位图品红=${screenStats.magentaRatio.toFixed(2)}%（${screenStats.magenta}/${screenStats.total}），目标是否前台=${targetIsForeground}`,
		);
	} catch (error) {
		setResult(1, '后台 GDI 截图', '失败', `异常：${error.message}`);
	} finally {
		if (bottom?.child?.pid !== undefined) killPid(bottom.child.pid);
		if (cover?.child?.pid !== undefined) killPid(cover.child.pid);
	}
};

const runPoint2AndAudit = async () => {
	const temp = mkTempDir('dsh-verify-bg-input-');
	const targetOut = join(temp, 'target.json');
	const coverOut = join(temp, 'cover.json');
	let target = null;
	let cover = null;
	try {
		target = await launchBackgroundTarget({
			outPath: targetOut,
			title: 'VERIFY-BG-TARGET',
			left: 240,
			top: 160,
		});
		cover = await launchPaint({
			outPath: coverOut,
			title: 'VERIFY-BG-INPUT-COVER',
			color: 'Cyan',
			left: 170,
			top: 120,
			width: 740,
			height: 520,
		});

		const current = readJsonRetry(targetOut);
		if (current === null) throw new Error('读取靶窗口状态失败');
		const formHandle = registerTarget(BigInt(current.form));
		const buttonHandle = toHandle(BigInt(current.button));
		const boxHandle = toHandle(BigInt(current.box));
		const coverHandle = toHandle(BigInt(cover.state.hwnd));

		SetForegroundWindow(coverHandle);
		await sleep(700);
		recordForeground('2.准备阶段', coverHandle);
		await recordCursor('2.准备阶段');

		const readState = () => {
			const snapshot = readJsonRetry(targetOut);
			if (snapshot === null) throw new Error('读取 target.json 失败');
			return snapshot;
		};

		const buttonRect = Buffer.alloc(16);
		GetClientRect(buttonHandle, buttonRect);
		const clickX = Math.max(1, Math.round(buttonRect.readInt32LE(8) / 2));
		const clickY = Math.max(1, Math.round(buttonRect.readInt32LE(12) / 2));
		const clickLp = makeLParam(clickX, clickY);

		const bmBefore = readState().clicks;
		const bmReturn = Number(SendMessageW(buttonHandle, BM_CLICK, 0, 0));
		await sleep(500);
		const bmAfter = readState().clicks;
		recordForeground('2.BM_CLICK', coverHandle);
		await recordCursor('2.BM_CLICK');

		const chars = 'BG';
		const charBefore = readState().text;
		for (const c of chars) {
			PostMessageW(boxHandle, WM_CHAR, c.charCodeAt(0), 0);
			await sleep(50);
		}
		await sleep(500);
		const charAfter = readState().text;
		recordForeground('2.WM_CHAR', coverHandle);
		await recordCursor('2.WM_CHAR');

		const setTextValue = 'WM_SETTEXT_OK';
		const setBefore = readState().text;
		const setReturn = Number(SendMessageWText(boxHandle, WM_SETTEXT, 0, setTextValue));
		await sleep(500);
		const setAfter = readState().text;
		recordForeground('2.WM_SETTEXT', coverHandle);
		await recordCursor('2.WM_SETTEXT');

		const mouseBefore = readState().clicks;
		PostMessageW(buttonHandle, WM_MOUSEMOVE, 0, clickLp);
		PostMessageW(buttonHandle, WM_LBUTTONDOWN, MK_LBUTTON, clickLp);
		PostMessageW(buttonHandle, WM_LBUTTONUP, 0, clickLp);
		await sleep(500);
		const mouseAfter = readState().clicks;
		recordForeground('2.WM_LBUTTONDOWN/UP', coverHandle);
		await recordCursor('2.WM_LBUTTONDOWN/UP');

		const bmOk = bmAfter === bmBefore + 1;
		const charOk = charAfter.includes(chars);
		const setOk = setAfter === setTextValue;
		const pass = bmOk && charOk && setOk;

		setResult(
			2,
			'后台 GDI 输入',
			pass ? '通过' : '失败',
			`BM_CLICK: ${bmBefore}->${bmAfter}（返回${bmReturn}）；WM_CHAR: ${JSON.stringify(charBefore)}->${JSON.stringify(charAfter)}；WM_SETTEXT: ${JSON.stringify(setBefore)}->${JSON.stringify(setAfter)}（返回${setReturn}）；WM_LBUTTONDOWN/UP: ${mouseBefore}->${mouseAfter}（投递坐标 ${clickX},${clickY}）`,
		);

		void formHandle;
	} catch (error) {
		setResult(2, '后台 GDI 输入', '失败', `异常：${error.message}`);
	} finally {
		if (target?.child?.pid !== undefined) killPid(target.child.pid);
		if (cover?.child?.pid !== undefined) killPid(cover.child.pid);
	}
};

const runPoint5 = async () => {
	const temp = mkTempDir('dsh-verify-bg-chrome-');
	const page = join(temp, 'page.html');
	const profile = join(temp, 'profile');
	const coverOut = join(temp, 'cover.json');
	let chrome = null;
	let cover = null;
	try {
		if (!existsSync(CHROME)) throw new Error(`未找到 Chrome：${CHROME}`);

		writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>BGV|md=0|kd=0|x=-1|y=-1|key=-|vw=0|vh=0</title>
<style>html,body{margin:0;height:100%;background:#ff00ff}#pad{position:absolute;left:20px;top:20px;width:520px;height:300px;font:20px Consolas}</style>
<textarea id="pad" autofocus>background verify</textarea>
<script>
let md=0,kd=0,lastX=-1,lastY=-1,lastKey='-';
// 把视口尺寸也写进标题：它是"页面已完成布局"的唯一可观测信号。
// 刚改过窗口尺寸时渲染器还在重排，此时投递的消息会被丢掉——本检查曾经的
// 间歇性失败就出在这里，而固定 sleep 挡不住，必须等页面自己报告尺寸。
const sync=()=>{document.title=` + "`BGV|md=${md}|kd=${kd}|x=${lastX}|y=${lastY}|key=${encodeURIComponent(lastKey)}|vw=${innerWidth}|vh=${innerHeight}`" + `;};
document.addEventListener('mousedown',(e)=>{md+=1;lastX=Math.round(e.clientX);lastY=Math.round(e.clientY);sync();},true);
document.addEventListener('keydown',(e)=>{kd+=1;lastKey=e.key;sync();},true);
document.addEventListener('mouseup',()=>{sync();},true);
window.addEventListener('resize',()=>{sync();});
window.addEventListener('load',()=>{document.getElementById('pad').focus();sync();});
</script>`, 'utf8');

		chrome = registerPid(spawn(CHROME, [
			`--user-data-dir=${profile}`,
			'--no-first-run',
			'--no-default-browser-check',
			'--window-size=920,700',
			'--window-position=640,90',
			`--app=file:///${page.replaceAll('\\', '/')}`,
		], { stdio: 'ignore' }));

		cover = await launchPaint({
			outPath: coverOut,
			title: 'VERIFY-CHROME-FG-COVER',
			color: 'Cyan',
			left: 40,
			top: 40,
			width: 520,
			height: 320,
		});

		const topInfo = await waitFor(() => {
			if (chrome.pid === undefined) return null;
			const windows = findTopWindowsByPid(chrome.pid);
			return windows[0] ?? null;
		}, 15000, 'Chrome 顶层窗口');
		const chromeTop = registerTarget(topInfo.handle);

		const coverHandle = toHandle(BigInt(cover.state.hwnd));
		SetForegroundWindow(coverHandle);
		await sleep(500);
		recordForeground('5.设置遮挡窗前台', coverHandle);
		await recordCursor('5.设置遮挡窗前台');

		SetWindowPos(chromeTop, HWND_TOPMOST, 680, 80, 860, 680, SWP_NOACTIVATE | SWP_SHOWWINDOW);
		await sleep(900);
		recordForeground('5.SetWindowPos NOACTIVATE', coverHandle);
		await recordCursor('5.SetWindowPos NOACTIVATE');

		// **必须在这之后才去找渲染子窗口**。
		// Chromium 在窗口尺寸变化时会重建渲染子窗口，先取句柄再改尺寸的话，
		// 拿到的就是一个已经失效的旧句柄 —— 往它投递不会有任何反应，而且
		// 不报错、不超时，只表现为"页面收不到消息"。这个顺序错误曾让本检查
		// 在功能完全正常的情况下反复报失败。
		//
		// 光等"存在一个渲染子窗口"也不够：Chromium 会同时建出若干辅助窗口，
		// 实测其中有 12x10 与 0x0 这种。若在真内容表面建出来之前就取到辅助窗口，
		// 消息会送达但坐标全错（实测投递 (8,6) 而页面回报 (2,1)）。
		// 因此这里要求它**足够大**，而不是仅仅存在。
		const widget = await waitFor(() => {
			const candidate = findLargestRenderWidget(chromeTop);
			if (candidate === null) return null;
			return candidate.width >= MIN_RENDER_WIDGET_EDGE && candidate.height >= MIN_RENDER_WIDGET_EDGE ? candidate : null;
		}, 15000, '足够大的 RenderWidgetHost 子窗口');
		await sleep(400);

		const readTitleState = () => {
			const title = titleOf(chromeTop);
			return { title, parsed: parseChromeTitle(title) };
		};

		const beforeState = await waitFor(() => {
			const state = readTitleState();
			return state.parsed === null ? null : state;
		}, 10000, 'Chrome 页面标题初始化');

		// 等页面**自己报告**布局已经稳定，而不是靠固定 sleep 猜。
		//
		// 判据是"连续两次采样视口尺寸相同且足够大"，而不是"视口尺寸精确等于
		// 渲染子窗口的客户区尺寸"：后者看起来更严格，实际是不成立的假设——
		// 两者分属 CSS 像素与物理像素两套坐标系，窗口边框、缩放、滚动条任何
		// 一处不同就会永远等不到，于是把"已经可以投递了"误判成"永远没就绪"。
		let settled = null;
		for (let attempt = 0; attempt < 25 && settled === null; attempt += 1) {
			const first = readTitleState().parsed;
			await sleep(400);
			const second = readTitleState().parsed;
			if (first !== null && second !== null
				&& first.viewportWidth === second.viewportWidth && first.viewportHeight === second.viewportHeight
				&& first.viewportWidth >= 200 && first.viewportHeight >= 200) {
				settled = second;
			}
		}
		if (settled === null) {
			const state = readTitleState();
			throw new Error(
				`页面布局迟迟没有稳定；诊断：标题 "${state.title}"，`
				+ `渲染子窗口 ${widget.width}x${widget.height} hwnd=${widget.handle}`,
			);
		}

		const mouseX = Math.max(5, Math.round(widget.width * 0.63));
		const mouseY = Math.max(5, Math.round(widget.height * 0.58));
		const mouseLp = makeLParam(mouseX, mouseY);

		/**
		 * 投递一次并等结果；失败就重投，最多三次。
		 *
		 * 重试不是"掩盖失败"：投递到 Chromium 的是异步消息，渲染器在重排、
		 * 切换合成器或忙的时候确实会丢事件。允许有限重试才测得出"这条路通不通"，
		 * 而固定单次投递测到的只是"这一次运气如何"。三次都不成才算失败，
		 * 且失败信息里必须带上足以定位的诊断。
		 */
		let afterMouse = null;
		for (let attempt = 1; attempt <= 3 && afterMouse === null; attempt += 1) {
			PostMessageW(widget.handle, WM_MOUSEMOVE, 0, mouseLp);
			PostMessageW(widget.handle, WM_LBUTTONDOWN, MK_LBUTTON, mouseLp);
			PostMessageW(widget.handle, WM_LBUTTONUP, 0, mouseLp);
			try {
				afterMouse = await waitFor(() => {
					const state = readTitleState();
					if (state.parsed === null) return null;
					if (state.parsed.md <= beforeState.parsed.md) return null;
					return state;
				}, 2500, 'Chrome mousedown 计数增长');
			} catch (error) {
				if (attempt === 3) {
					// 把定位所需的全部事实一次说完，避免下次还要重新排查：
					// 子窗口选对了没有、坐标是什么、页面自称的视口多大、前台是谁。
					throw new Error(
						`${error.message}；诊断：投递目标 hwnd=${widget.handle} 客户区 ${widget.width}x${widget.height}，`
						+ `投递坐标 (${mouseX},${mouseY})，页面标题 "${readTitleState().title}"，`
						+ `页面视口 ${beforeState.parsed.viewportWidth}x${beforeState.parsed.viewportHeight}，`
						+ `前台 hwnd=${toHandle(GetForegroundWindow())}（Chrome=${chromeTop}）`,
					);
				}
				await sleep(500);
			}
		}
		recordForeground('5.PostMessage 鼠标', coverHandle);
		await recordCursor('5.PostMessage 鼠标');

		const VK_K = 0x4b;
		PostMessageW(widget.handle, WM_KEYDOWN, VK_K, 0);
		PostMessageW(widget.handle, WM_CHAR, 'k'.charCodeAt(0), 0);
		PostMessageW(widget.handle, WM_KEYUP, VK_K, 0);
		const afterKey = await waitFor(() => {
			const state = readTitleState();
			if (state.parsed === null) return null;
			if (state.parsed.kd <= afterMouse.parsed.kd) return null;
			return state;
		}, 6000, 'Chrome keydown 计数增长');
		recordForeground('5.PostMessage 键盘', coverHandle);
		await recordCursor('5.PostMessage 键盘');

		const mouseCountDelta = afterMouse.parsed.md - beforeState.parsed.md;
		const keyCountDelta = afterKey.parsed.kd - afterMouse.parsed.kd;
		const coordExact = afterMouse.parsed.x === mouseX && afterMouse.parsed.y === mouseY;
		const pass = mouseCountDelta >= 1 && keyCountDelta >= 1 && coordExact;

		setResult(
			5,
			'Chromium 后台输入',
			pass ? '通过' : '失败',
			`RenderWidget=${widget.cls} ${widget.width}x${widget.height}；鼠标计数 +${mouseCountDelta}（md ${beforeState.parsed.md}->${afterMouse.parsed.md}）；键盘计数 +${keyCountDelta}（kd ${afterMouse.parsed.kd}->${afterKey.parsed.kd}）；投递坐标 (${mouseX},${mouseY}) 页面回报 (${afterMouse.parsed.x},${afterMouse.parsed.y})；末次键=${JSON.stringify(afterKey.parsed.key)}`,
		);
	} catch (error) {
		setResult(5, 'Chromium 后台输入', '失败', `异常：${error.message}`);
	} finally {
		if (chrome?.pid !== undefined) killPid(chrome.pid);
		if (cover?.child?.pid !== undefined) killPid(cover.child.pid);
	}
};

const finalizePoint3 = () => {
	if (foregroundChecks.length === 0) {
		setResult(3, '前台未被抢走', '失败', '没有采到任何前台检查点，无法验证');
		return;
	}

	// 判据是「前台从未落到被操作的窗口上」，而不是「前台一直是某个特定窗口」。
	// 用户当时可能正在用别的程序，那个程序持有前台是完全正常的。
	const stole = foregroundChecks.filter((entry) => entry.actual !== null && targetHandles.has(entry.actual));
	const distinct = new Set(foregroundChecks.map((entry) => String(entry.actual)));
	const constant = distinct.size === 1 ? '全程未变' : `中途变过 ${distinct.size} 个值（属于环境噪声，与本次操作无关的话不算失败）`;

	if (stole.length === 0) {
		setResult(
			3,
			'前台未被抢走',
			'通过',
			`共检查 ${foregroundChecks.length} 次，前台从未落到被操作窗口上；前台值${constant}`,
		);
		return;
	}

	const details = stole.map((entry) => `${entry.step}: 前台变成了被操作窗口 ${entry.actual}`).join('；');
	setResult(3, '前台未被抢走', '失败', `${stole.length}/${foregroundChecks.length} 次检查里前台落到了被操作窗口上：${details}`);
};

const finalizePoint4 = () => {
	// 环境不稳定时给出"无法判定"，而不是从噪声里编一个结论出来。
	if (cursorInUse) {
		setResult(
			4,
			'光标未被移动',
			'不确定',
			`起始探测阶段光标自己就在动，说明用户正在使用鼠标，本项无法判定（期间记录到 ${cursorChanges.length} 次位移，无法区分是谁造成的）。要在无人操作时重跑才能得到确定结论`,
		);
		return;
	}
	if (cursorChanges.length === 0) {
		setResult(
			4,
			'光标未被移动',
			'通过',
			`基线 (${cursorBaseline.x},${cursorBaseline.y})，检查点未发现变化`,
		);
		return;
	}
	const details = cursorChanges
		.map((entry) => `${entry.step}: 首次(${entry.first.x},${entry.first.y}) 复采(${entry.second.x},${entry.second.y})`)
		.join('；');
	setResult(
		4,
		'光标未被移动',
		'不确定',
		`基线 (${cursorBaseline.x},${cursorBaseline.y})，发现 ${cursorChanges.length} 次变化（可能是用户移动鼠标）：${details}`,
	);
};

const printSummary = () => {
	console.log('===== 后台模式真实环境验证 =====');
	for (const point of [1, 2, 3, 4, 5]) {
		const item = resultByPoint.get(point) ?? {
			point,
			title: `条目${point}`,
			status: '失败',
			detail: '未执行',
		};
		console.log(`${point}. ${item.title}：${item.status}`);
		console.log(`   ${item.detail}`);
	}
	const entries = [...resultByPoint.values()];
	const passed = entries.filter((item) => item.status === '通过').length;
	const failed = entries.filter((item) => item.status === '失败').length;
	const uncertain = entries.filter((item) => item.status === '不确定').length;
	console.log(`通过 ${passed}/5（失败 ${failed}，不确定 ${uncertain}）`);
};

try {
	await runPoint1();
	await runPoint2AndAudit();
	await runPoint5();
	finalizePoint3();
	finalizePoint4();
} finally {
	for (const pid of [...ownedPids]) killPid(pid);
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	printSummary();
}
