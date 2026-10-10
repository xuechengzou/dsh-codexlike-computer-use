/**
 * `koffi` 的测试替身：一个足以驱动整个插件的"假 Windows"。
 *
 * **这里没有一行 FFI 调用，它顶替的是真实的原生模块。** 真身就在 test/doubles/koffi/，
 * 随版本库提交；测试时由 scripts/link-doubles.mjs 在 node_modules/koffi 建一层联接，
 * 裸 `import 'koffi'` 才会落到这里。本目录绝不能被生产解析撞上（见该脚本顶部注释）。
 *
 * 存在的意义是让 `lib/*.js` 的**完整执行路径**（动作分派、参数校验、事件序列、
 * 窗口解析、输出值组装）可以在不触碰真实桌面的前提下被测到。真实 koffi 只负责
 * 把调用转给 user32/gdi32，因此这里替换掉它，语义损失最小，换来的是可重复、
 * 无副作用、能在 CI 里跑的测试。
 *
 * 双模：设置环境变量 `DSH_COMPUTER_USE_REAL_KOFFI` 指向真实的 koffi 入口时，
 * 本模块改为把 `load/struct/union/sizeof` 全部委派给它。这样原生冒烟测试
 * 跑的是**同一份 lib/win32.js**，而不是另一套并行的探针代码。
 *
 * 测试通过 `globalThis.__koffiStub` 改写行为与读取调用记录：
 *   - `windows`：假窗口树（见下方 defineWindow），支撑窗口分类与坐标换算的测试
 *   - `functions`：按 Win32 API 名覆盖实现
 *   - `calls`：按顺序记录每一次原生调用
 *   - `inputStructSize`：伪造错误的 INPUT 尺寸以验证自检守卫
 *
 * 窗口树的存在理由：真实系统里"顶层窗口 / 客户区 / Chromium 渲染子窗口"是三件
 * 不同的东西，坐标换算与输入投递全建立在它们的区别上。只返回单个假窗口的替身
 * 无法表达这个区别，也就测不到最容易出错的那部分。
 */
import { pathToFileURL } from 'node:url';

/** 真实 koffi 入口；未设置时使用下方的假实现。 */
const realEntry = process.env.DSH_COMPUTER_USE_REAL_KOFFI;
const realModule = realEntry === undefined ? null : await import(pathToFileURL(realEntry).href);
/** koffi 的 ESM 入口可能以默认导出或具名导出暴露工厂。 */
const real = realModule === null ? null : (realModule.default ?? realModule);

/** 默认实现：一个 1600x900、单显示器的桌面，光标在 (100, 200)。 */
const DEFAULT_SCREEN = { x: 0, y: 0, width: 1600, height: 900, monitors: 1 };

export const stub = {
	screen: { ...DEFAULT_SCREEN },
	/** 覆盖实现：`apiName -> (...args) => result`。 */
	functions: new Map(),
	/** 原生调用记录，按发生顺序。 */
	calls: [],
	/** 允许测试伪造 `sizeof(INPUT)`，用于验证结构体自检。 */
	inputStructSize: 40,
	/** 前台窗口句柄与信息，供窗口相关 API 使用。 */
	foreground: 0x2000n,
	/** 持有键盘焦点的控件句柄；0n 表示"焦点尚未落定"。 */
	focus: 0x2100n,
	windowTitle: 'Notepad',
	windowClass: 'Notepad',
	windowProcessId: 4242,
	/** 假窗口树：handle(bigint) → 窗口记录。 */
	windows: new Map(),
	/** 窗口树的 z 序（顶层窗口从前到后），供 GetTopWindow/GetWindow 使用。 */
	zOrder: [],
};

globalThis.__koffiStub = stub;

/**
 * 往假窗口树里放一个窗口。
 *
 * @param handle - 窗口句柄。
 * @param options.parent - 父窗口句柄；顶层窗口传 null。
 * @param options.className - 窗口类名；null 表示回落到 `stub.windowClass`。
 * @param options.title - 窗口标题；null 表示回落到 `stub.windowTitle`。
 * @param options.frame - 窗口矩形（屏幕坐标，含边框与标题栏）。
 * @param options.clientOffset - 客户区相对窗口矩形左上角的偏移。
 * @param options.clientSize - 客户区尺寸。
 * @returns 该窗口记录。
 */
export function defineWindow(handle, options = {}) {
	const record = {
		handle,
		parent: options.parent ?? null,
		className: options.className ?? null,
		title: options.title ?? null,
		frame: options.frame ?? { left: 0, top: 0, width: stub.screen.width, height: stub.screen.height },
		clientOffset: options.clientOffset ?? { x: 0, y: 0 },
		clientSize: options.clientSize ?? { width: stub.screen.width, height: stub.screen.height },
		visible: options.visible ?? true,
		dpi: options.dpi ?? 96,
		pid: options.pid ?? stub.windowProcessId,
	};
	stub.windows.set(handle, record);
	if (record.parent === null && !stub.zOrder.includes(handle)) stub.zOrder.unshift(handle);
	return record;
}
stub.defineWindow = defineWindow;

/** 清空窗口树，并恢复一个与旧断言兼容的默认全屏窗口。 */
stub.resetWindows = () => {
	stub.windows.clear();
	stub.zOrder.length = 0;
	defineWindow(stub.foreground, { title: null, className: null });
};

/** 取窗口记录；找不到返回 undefined。 */
const lookup = (handle) => (typeof handle === 'bigint' ? stub.windows.get(handle) : undefined);

/** 窗口类名：记录优先，其次回落到 stub 级默认值。 */
const classOf = (record) => record?.className ?? stub.windowClass;
/** 窗口标题：记录优先，其次回落到 stub 级默认值。 */
const titleOf = (record) => record?.title ?? stub.windowTitle;

/** 记录里的客户区在屏幕上的位置。 */
const clientScreenRect = (record) => ({
	left: record.frame.left + record.clientOffset.x,
	top: record.frame.top + record.clientOffset.y,
	width: record.clientSize.width,
	height: record.clientSize.height,
});

/** 记录的直接子窗口，按定义顺序。 */
const childrenOf = (parent) => [...stub.windows.values()].filter((record) => record.parent === parent);

/** 记录的所有后代窗口（宽度优先），用于找 Chromium 渲染子窗口。 */
const descendantsOf = (parent) => {
	const out = [];
	const queue = [...childrenOf(parent)];
	while (queue.length > 0) {
		const record = queue.shift();
		out.push(record);
		queue.push(...childrenOf(record.handle));
	}
	return out;
};
stub.descendantsOf = descendantsOf;

/** 记录一次调用并按需委派给覆盖实现。 */
function invoke(name, args) {
	stub.calls.push({ name, args });
	const override = stub.functions.get(name);
	if (override !== undefined) return override(...args);
	return defaults[name]?.(...args);
}

/** 从 C 签名里取出函数名：`int GetSystemMetrics(int n)` → `GetSystemMetrics`。 */
function functionName(signature) {
	const match = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/u.exec(signature);
	if (match === null) throw new Error(`测试替身无法解析签名 "${signature}"`);
	return match[1];
}

/** 按 UTF-16LE 写入文本并返回写入的码元数。 */
function writeUtf16(buffer, capacity, text) {
	const limit = Math.min(capacity - 1, text.length);
	for (let index = 0; index < limit; index += 1) buffer.writeUInt16LE(text.charCodeAt(index), index * 2);
	buffer.writeUInt16LE(0, limit * 2);
	return limit;
}

const SM = { CXSCREEN: 0, CYSCREEN: 1, XVIRTUALSCREEN: 76, YVIRTUALSCREEN: 77, CXVIRTUALSCREEN: 78, CYVIRTUALSCREEN: 79, CMONITORS: 80 };

const handles = { next: 0x1000n };
function nextHandle() {
	handles.next += 0x100n;
	return handles.next;
}

/** 写 RECT（left, top, right, bottom）。 */
function writeRect(target, left, top, right, bottom) {
	if (Buffer.isBuffer(target)) {
		target.writeInt32LE(left, 0);
		target.writeInt32LE(top, 4);
		target.writeInt32LE(right, 8);
		target.writeInt32LE(bottom, 12);
		return;
	}
	target.left = left;
	target.top = top;
	target.right = right;
	target.bottom = bottom;
}

const defaults = {
	GetDC: () => nextHandle(),
	ReleaseDC: () => 1,
	GetSystemMetrics: (index) => {
		switch (index) {
			case SM.CXSCREEN:
			case SM.CXVIRTUALSCREEN:
				return stub.screen.width;
			case SM.CYSCREEN:
			case SM.CYVIRTUALSCREEN:
				return stub.screen.height;
			case SM.XVIRTUALSCREEN:
				return stub.screen.x;
			case SM.YVIRTUALSCREEN:
				return stub.screen.y;
			case SM.CMONITORS:
				return stub.screen.monitors;
			default:
				return 0;
		}
	},
	GetCursorPos: (point) => {
		point.x = 100;
		point.y = 200;
		return 1;
	},
	SetCursorPos: () => 1,
	GetForegroundWindow: () => stub.foreground,
	GetWindowRect: (handle, rect) => {
		if (handle === 0n || handle == null) return 0;
		const record = lookup(handle);
		if (record !== undefined) {
			writeRect(rect, record.frame.left, record.frame.top, record.frame.left + record.frame.width, record.frame.top + record.frame.height);
			return 1;
		}
		// 未登记的句柄沿用旧行为：整块屏幕。既有断言依赖这一点。
		writeRect(rect, 0, 0, stub.screen.width, stub.screen.height);
		return 1;
	},
	GetClientRect: (handle, rect) => {
		if (handle === 0n || handle == null) return 0;
		const record = lookup(handle);
		if (record !== undefined) {
			// GetClientRect 返回的是**相对客户区原点**的矩形，left/top 恒为 0
			writeRect(rect, 0, 0, record.clientSize.width, record.clientSize.height);
			return 1;
		}
		writeRect(rect, 0, 0, stub.screen.width, stub.screen.height);
		return 1;
	},
	ClientToScreen: (handle, point) => {
		const record = lookup(handle);
		if (record === undefined) return 0;
		const rect = clientScreenRect(record);
		point.x += rect.left;
		point.y += rect.top;
		return 1;
	},
	ScreenToClient: (handle, point) => {
		const record = lookup(handle);
		if (record === undefined) return 0;
		const rect = clientScreenRect(record);
		point.x -= rect.left;
		point.y -= rect.top;
		return 1;
	},
	GetWindowTextW: (handle, buffer, capacity) => writeUtf16(buffer, capacity, titleOf(lookup(handle))),
	GetClassNameW: (handle, buffer, capacity) => writeUtf16(buffer, capacity, classOf(lookup(handle))),
	GetWindowThreadProcessId: (handle, slot) => {
		slot.writeUInt32LE(lookup(handle)?.pid ?? stub.windowProcessId, 0);
		return 1;
	},
	GetDpiForWindow: (handle) => lookup(handle)?.dpi ?? 96,
	IsWindowVisible: (handle) => (lookup(handle)?.visible ?? true) ? 1 : 0,
	IsIconic: () => 0,
	FindWindowW: (cls, name) => {
		for (const record of stub.windows.values()) {
			if (record.parent !== null) continue;
			const classMatches = cls == null || classOf(record).toLowerCase().includes(String(cls).toLowerCase());
			const titleMatches = name == null || titleOf(record) === String(name);
			if (classMatches && titleMatches) return record.handle;
		}
		return null;
	},
	FindWindowExW: (parent, after, cls, name) => {
		if (parent === 0n || parent == null) return null;
		const siblings = childrenOf(parent);
		let seen = after === 0n || after == null;
		for (const record of siblings) {
			if (!seen) {
				if (record.handle === after) seen = true;
				continue;
			}
			const classMatches = cls == null || classOf(record).toLowerCase().includes(String(cls).toLowerCase());
			const titleMatches = name == null || titleOf(record) === String(name);
			if (classMatches && titleMatches) return record.handle;
		}
		return null;
	},
	// 签名必须与 src/win32.ts 的绑定一致：POINT 是按值传递的结构体，因此这里收一个对象
	ChildWindowFromPointEx: (parent, point, flags) => {
		const record = lookup(parent);
		if (record === undefined) return null;
		const rect = clientScreenRect(record);
		// 点在 parent 客户区之外：返回 0（null），与真实语义一致
		if (point.x < 0 || point.y < 0 || point.x >= rect.width || point.y >= rect.height) return null;
		// 换算到屏幕坐标后按窗口树递归：命中最深的那个子窗口
		const screenX = rect.left + point.x;
		const screenY = rect.top + point.y;
		const skipInvisible = (flags & 0x1) !== 0;
		let current = record;
		for (;;) {
			const hit = childrenOf(current.handle).find((child) => {
				if (skipInvisible && !child.visible) return false;
				const f = child.frame;
				return screenX >= f.left && screenX < f.left + f.width
					&& screenY >= f.top && screenY < f.top + f.height;
			});
			if (hit === undefined) return current.handle;
			current = hit;
		}
	},
	GetTopWindow: () => stub.zOrder[0] ?? null,
	GetWindow: (handle, command) => {
		// GW_HWNDNEXT = 2
		if (command !== 2) return null;
		const index = stub.zOrder.indexOf(handle);
		return index === -1 ? null : (stub.zOrder[index + 1] ?? null);
	},
	GetGUIThreadInfo: (threadId, info) => {
		// 真实布局（x64，72 字节）：cbSize+flags 后紧跟 hwndActive、hwndFocus
		info.writeUInt32LE(72, 0);
		info.writeBigUInt64LE(stub.focus, 16);
		return 1;
	},
	MapVirtualKeyW: (virtualKey) => virtualKey & 0xff,
	SendInput: (count, inputs) => {
		// 真实 SendInput 会把事件交给系统；这里只如实回报接纳数量，
		// 测试通过 stub.calls 断言事件内容与分批方式。
		return Array.isArray(inputs) ? inputs.length : count;
	},
	PostMessageW: () => 1,
	SendMessageW: () => 1,
	SetWindowTextW: () => 1,
	PrintWindow: () => 1,
	CreateSolidBrush: () => nextHandle(),
	FillRect: () => 1,
	SetProcessDPIAware: () => 1,
	CreateCompatibleDC: () => nextHandle(),
	CreateCompatibleBitmap: () => nextHandle(),
	SelectObject: () => nextHandle(),
	BitBlt: () => 1,
	GetDIBits: (hdc, bitmap, start, lines, bits, info) => {
		if (!Buffer.isBuffer(bits)) return 0;
		// 填一个可辨识的渐变 + 少量高对比像素，让缩放与编码有真实内容可处理
		for (let y = 0; y < lines; y += 1) {
			for (let x = 0; x < stub.screen.width; x += 1) {
				const offset = (y * stub.screen.width + x) * 4;
				if (offset + 3 >= bits.length) break;
				bits[offset] = x & 0xff;
				bits[offset + 1] = y & 0xff;
				bits[offset + 2] = (x ^ y) & 0xff;
				bits[offset + 3] = 0xff;
			}
		}
		return lines;
	},
	DeleteObject: () => 1,
	DeleteDC: () => 1,
};

// ---- koffi 公开面 ---------------------------------------------------------

/** 是否正在委派给真实的 koffi。 */
export const usingRealKoffi = real !== null;

export function load(dllPath) {
	if (real !== null) return real.load(dllPath);
	return {
		func(signature) {
			const name = functionName(signature);
			return (...args) => invoke(name, args);
		},
	};
}

export function struct(name, members) {
	if (real !== null) return real.struct(name, members);
	return { __koffiType: 'struct', name };
}

export function union(name, members) {
	if (real !== null) return real.union(name, members);
	return { __koffiType: 'union', name };
}

export function pointer(type) {
	if (real !== null) return real.pointer(type);
	return { __koffiType: 'pointer', type };
}

export function sizeof(type) {
	if (real !== null) return real.sizeof(type);
	if (type?.__koffiType === 'struct' && type.name === 'INPUT') return stub.inputStructSize;
	return 8;
}
