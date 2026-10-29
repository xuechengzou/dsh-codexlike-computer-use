import { defineType } from '../koffi-registry.js';
/**
 * UI Automation 的 COM 调用层（Windows，经 koffi 直接调 vtable）。
 *
 * 为什么不用现成的原生插件：整条链路只需要 uiautomationcore / ole32 两个系统
 * DLL，koffi 已经能把 C 函数调通；多一个编译型依赖就要多一份预编译产物、
 * 多一套随 Electron ABI 失效的风险。
 *
 * 三条实测得出的硬约束，改这里之前先读：
 *
 * 1. **vtable 必须两跳**。对象地址处存的是 vtable 指针，方法指针在 vtable 里。
 *    只跳一次会把对象数据当函数地址调用——表现为进程直接死于 0xC0000005。
 * 2. **BSTR 不能按零终止字符串解码**。BSTR 是 `[4 字节字节长度][UTF-16…][NUL]`，
 *    指针指向字符区；用 `koffi.decode(ptr, 'str16')` 解码会崩，按长度前缀读
 *    `uint16` 才对。
 * 3. **每个拿到手的接口都必须 Release**。COM 没有 GC，遍历一棵树会创建成百
 *    上千个元素引用。
 *
 * 本模块不 import `koffi`：由调用方注入（插件里是动态 import，探针脚本里是
 * profile 里的真实副本），因此同一份代码在两种环境下跑的是同一条路径。
 */

/** koffi 里本模块用到的窄面。 */
export interface KoffiLike {
	load(path: string): { func(prototype: string): (...args: unknown[]) => unknown };
	proto(prototype: string): unknown;
	call(pointer: bigint, type: unknown, ...args: unknown[]): unknown;
	decode(pointer: bigint, type: string, length?: number): unknown;
	struct(name: string, members: Record<string, string>): unknown;
}

/** 屏幕坐标矩形（与 Win32 RECT 同序）。 */
export interface UiaBounds {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** 由元素执行一次 UIA 动作的结果。 */
export type PatternOutcome =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: 'unsupported' | 'failed'; readonly hresult?: number };

/** 一个可访问性元素句柄。 */
export interface UiaElement {
	/** 原生接口指针；仅供内部与调试使用。 */
	readonly pointer: bigint;
	/** 控件类型 id（UIA_*ControlTypeId）。 */
	controlType(): number;
	/** 名称；取不到时返回空串。 */
	name(): string;
	/** AutomationId；取不到时返回空串。 */
	automationId(): string;
	/** 窗口类名；取不到时返回空串。 */
	className(): string;
	/** 是否屏外（不可见/被折叠）。 */
	isOffscreen(): boolean;
	/** 是否启用。 */
	isEnabled(): boolean;
	/** 包围盒；取不到时返回 undefined。 */
	bounds(): UiaBounds | undefined;
	/** 控制视图里的第一个子元素。 */
	firstChild(): UiaElement | null;
	/** 控制视图里的下一个兄弟元素。 */
	nextSibling(): UiaElement | null;
	/** InvokePattern：按下按钮/菜单项。 */
	invoke(): PatternOutcome;
	/** ValuePattern：写入文本。 */
	setValue(text: string): PatternOutcome;
	/** TogglePattern：切换勾选状态。 */
	toggle(): PatternOutcome;
	/** SelectionItemPattern：选中列表项。 */
	select(): PatternOutcome;
	/** 释放这份引用；重复调用安全。 */
	release(): void;
}

/** UI Automation 会话。 */
export interface Uia {
	/** 由窗口句柄取元素；失败返回 null。 */
	elementFromHandle(handle: bigint): UiaElement | null;
	/** 释放 IUIAutomation 与线程上的 COM 初始化。 */
	dispose(): void;
}

/** 可选跟踪：排查访问违例时用 `DSH_UIA_TRACE=1` 打开。 */
function trace(message: string): void {
	if (process.env.DSH_UIA_TRACE === '1') console.error('[uia]', message);
}

/** IUnknown 的固定三槽。 */
const RELEASE_SLOT = 2;

/** 各接口里用到的方法序号（0 起，不含 IUnknown 三槽）。 */
const IUIAUTOMATION = {
	elementFromHandle: 3,
	controlViewWalker: 11,
} as const;

const IUIAUTOMATION_ELEMENT = {
	controlType: 18,
	name: 20,
	isEnabled: 25,
	automationId: 26,
	className: 27,
	isOffscreen: 35,
	boundingRectangle: 40,
} as const;

const IUIAUTOMATION_TREE_WALKER = {
	firstChild: 1,
	nextSibling: 3,
} as const;

/** UIA pattern id 与接口 IID（UIAutomationClient.idl）。 */
const PATTERN_INVOKE = { id: 10000, iid: 'FB377FBE-8EA6-46D5-9C73-6499642D3059' } as const;
const PATTERN_VALUE = { id: 10002, iid: 'A94CD8B1-0844-4CD6-9D2D-640537AB39E9' } as const;
const PATTERN_TOGGLE = { id: 10015, iid: '94CF8058-9B8D-4AB9-8BFD-4CD0A33C8C70' } as const;
const PATTERN_SELECTION_ITEM = { id: 10010, iid: 'A8EFA66A-0FDA-421A-9194-EA380C3F4944' } as const;

/** 元素的 `GetCurrentPattern` 方法序号。 */
const ELEMENT_GET_CURRENT_PATTERN = 13;

/** CLSID/IID（UIAutomationClient.idl）。 */
const CLSID_CUIAUTOMATION = 'FF48DBA4-60EF-4201-AA87-54103EEF594E';
const IID_IUIAUTOMATION = '30CBE57D-D9D0-452A-AB13-7AC5AC4825EE';

const CLSCTX_INPROC_SERVER = 0x1;
/**
 * 宿主里跑的是普通 node 线程，没有消息泵：必须用 MTA。
 * STA（0x2）要求调用线程泵消息来跨套间编组，放在宿主里迟早会卡死。
 */
const COINIT_MULTITHREADED = 0x0;
const S_OK = 0;
const S_FALSE = 1;

/**
 * 把 `{xxxxxxxx-…}` 文本拆成 GUID 的四个字段。
 *
 * @param text - GUID 文本，花括号可有可无。
 * @returns 与 C `GUID` 布局一致的普通对象。
 */
function guidFields(text: string): { Data1: number; Data2: number; Data3: number; Data4: number[] } {
	const hex = text.replace(/[{}]/gu, '').replaceAll('-', '');
	const bytes: number[] = [];
	for (let index = 0; index < 16; index += 1) bytes.push(Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
	return {
		Data1: ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0,
		Data2: (bytes[4]! << 8) | bytes[5]!,
		Data3: (bytes[6]! << 8) | bytes[7]!,
		Data4: bytes.slice(8),
	};
}

/**
 * 由 BSTR 指针读出字符串。
 *
 * BSTR 前置 4 字节字节长度，因此不需要依赖零终止；越界读取也不会发生。
 *
 * @param koffi - koffi 模块。
 * @param pointer - BSTR 指针（指向字符区）。
 * @returns 解码结果；长度为负或异常时返回空串。
 */
function decodeBstr(koffi: KoffiLike, pointer: bigint): string {
	if (pointer === 0n) return '';
	const bytes = Number(koffi.decode(pointer - 4n, 'int32'));
	if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 1024 * 1024) return '';
	const units = (koffi.decode(pointer, 'uint16', bytes / 2) as number[]).slice(0, 8192);
	return String.fromCharCode(...units);
}

/**
 * 建立 UIA 会话。
 *
 * @param koffi - 已加载的 koffi 模块。
 * @returns 会话对象。
 * @throws 当系统不提供 UIAutomation、或 COM 初始化失败时。
 */
export function createUia(koffi: KoffiLike): Uia {
	// 同样要防重：宿主 HMR 重载插件时 koffi 的全局类型表里已有这些名字
	const guid = defineType('DshUiaGuid', () => koffi.struct('DshUiaGuid', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: 'uint8[8]' }));
	const rect = defineType('DshUiaRect', () => koffi.struct('DshUiaRect', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' }));

	const ole32 = koffi.load('ole32.dll');
	const coInitializeEx = ole32.func('int CoInitializeEx(void *reserved, uint32 coInit)');
	const coCreateInstance = ole32.func(
		'int CoCreateInstance(_In_ DshUiaGuid *rclsid, void *outer, uint32 clsctx, _In_ DshUiaGuid *riid, _Out_ void **out)',
	);
	const coUninitialize = ole32.func('void CoUninitialize()');
	const oleaut32 = koffi.load('oleaut32.dll');
	const sysAllocString = oleaut32.func('void *SysAllocString(str16 text)');
	const sysFreeString = oleaut32.func('void SysFreeString(void *bstr)');

	const initialized = coInitializeEx(null, COINIT_MULTITHREADED) as number;
	if (initialized < 0) throw new Error(`UIA: CoInitializeEx 失败（0x${(initialized >>> 0).toString(16)}）`);

	const clsid = guidFields(CLSID_CUIAUTOMATION);
	const iid = guidFields(IID_IUIAUTOMATION);
	trace('coInitializeEx ok');
	const automationOut: Array<bigint | null> = [null];
	const created = coCreateInstance(clsid, null, CLSCTX_INPROC_SERVER, iid, automationOut) as number;
	if (created !== S_OK || automationOut[0] === null) {
		coUninitialize();
		throw new Error(`UIA: 拿不到 IUIAutomation（0x${(created >>> 0).toString(16)}）`);
	}
	const automation = automationOut[0]!;
	trace(`IUIAutomation=${automation}`);

	// ---- vtable 与方法声明 ------------------------------------------------
	const releaseProto = koffi.proto('uint32 DshUiaRelease(void *self)');
	const elementFromHandleProto = koffi.proto(
		'int DshUiaElementFromHandle(void *self, void *hwnd, _Out_ void **element)',
	);
	const getWalkerProto = koffi.proto('int DshUiaGetControlViewWalker(void *self, _Out_ void **walker)');
	const controlTypeProto = koffi.proto('int DshUiaControlType(void *self, _Out_ int *value)');
	const stringGetterProto = koffi.proto('int DshUiaStringGetter(void *self, _Out_ void **value)');
	const boolGetterProto = koffi.proto('int DshUiaBoolGetter(void *self, _Out_ int *value)');
	const rectGetterProto = koffi.proto('int DshUiaRectGetter(void *self, _Out_ DshUiaRect *value)');
	const firstChildProto = koffi.proto('int DshUiaFirstChild(void *self, void *element, _Out_ void **child)');
	const nextSiblingProto = koffi.proto('int DshUiaNextSibling(void *self, void *element, _Out_ void **sibling)');
	const queryInterfaceProto = koffi.proto('int DshUiaQueryInterface(void *self, _In_ DshUiaGuid *riid, _Out_ void **out)');
	const getCurrentPatternProto = koffi.proto('int DshUiaGetCurrentPattern(void *self, int patternId, _Out_ void **pattern)');
	const noArgPatternProto = koffi.proto('int DshUiaPatternNoArgs(void *self)');
	const setValuePatternProto = koffi.proto('int DshUiaSetValue(void *self, void *bstr)');

	/**
	 * 读第 index 个 vtable 槽。
	 *
	 * @param pointer - 对象地址。
	 * @param index - 槽序号（含 IUnknown 三槽，从 0 起）。
	 * @returns 函数地址。
	 */
	const slot = (pointer: bigint, index: number): bigint => {
		const vtable = koffi.decode(pointer, 'void *') as bigint;
		const slots = koffi.decode(vtable, 'void *', index + 1) as bigint[];
		return slots[index]!;
	};

	/**
	 * 一次方法调用。
	 *
	 * @param pointer - 对象地址。
	 * @param index - 槽序号。
	 * @param proto - 方法类型声明。
	 * @param args - 参数（不含 this）。
	 * @returns HRESULT。
	 */
	const invoke = (pointer: bigint, methodIndex: number, proto: unknown, ...args: unknown[]): number =>
		Number(koffi.call(slot(pointer, 3 + methodIndex), proto, pointer, ...args));

	/**
	 * 取一个 pattern 接口。
	 *
	 * 两步：元素的 GetCurrentPattern 只给 IUnknown，具体 pattern 接口要
	 * QueryInterface 拿到——直接按 pattern 的方法序号调 IUnknown 会崩。
	 *
	 * @param element - 元素指针。
	 * @param pattern - pattern id 与接口 IID。
	 * @returns pattern 接口指针；不支持或失败时 null。
	 */
	const patternHandle = (element: bigint, pattern: { id: number; iid: string }): bigint | null => {
		const unknownOut: Array<bigint | null> = [null];
		const got = invoke(element, ELEMENT_GET_CURRENT_PATTERN, getCurrentPatternProto, pattern.id, unknownOut);
		if (got !== S_OK || unknownOut[0] === null) return null;
		const unknown = unknownOut[0]!;
		const ifaceOut: Array<bigint | null> = [null];
		const queried = Number(koffi.call(slot(unknown, 0), queryInterfaceProto, unknown, guidFields(pattern.iid), ifaceOut));
		koffi.call(slot(unknown, RELEASE_SLOT), releaseProto, unknown);
		if (queried !== S_OK || ifaceOut[0] === null) return null;
		return ifaceOut[0]!;
	};

	/**
	 * 调一个无参 pattern 方法，并释放接口。
	 *
	 * @param element - 元素指针。
	 * @param pattern - pattern id 与 IID。
	 * @returns 结果。
	 */
	const callSimplePattern = (element: bigint, pattern: { id: number; iid: string }, proto: unknown): PatternOutcome => {
		const iface = patternHandle(element, pattern);
		if (iface === null) return { ok: false, reason: 'unsupported' };
		const result = Number(koffi.call(slot(iface, 3), proto, iface));
		koffi.call(slot(iface, RELEASE_SLOT), releaseProto, iface);
		return result === S_OK ? { ok: true } : { ok: false, reason: 'failed', hresult: result };
	};

	/** 包装一个元素指针。 */
	const wrap = (pointer: bigint): UiaElement => {
		let alive = true;
		const release = (): void => {
			if (!alive) return;
			alive = false;
			koffi.call(slot(pointer, RELEASE_SLOT), releaseProto, pointer);
		};

		const readString = (methodIndex: number): string => {
			if (!alive) return '';
			const out: Array<bigint | null> = [null];
			const result = invoke(pointer, methodIndex, stringGetterProto, out);
			if (result !== S_OK || out[0] === null) return '';
			const text = decodeBstr(koffi, out[0]!);
			return text;
		};

		const readBool = (methodIndex: number): boolean => {
			if (!alive) return false;
			const out = [0];
			const result = invoke(pointer, methodIndex, boolGetterProto, out);
			return result === S_OK && out[0] !== 0;
		};

		const readInt = (methodIndex: number): number => {
			if (!alive) return 0;
			const out = [0];
			const result = invoke(pointer, methodIndex, controlTypeProto, out);
			return result === S_OK ? out[0]! : 0;
		};

		/** 取一个子/兄弟元素指针。 */
		const readElement = (methodIndex: number, proto: unknown): UiaElement | null => {
			if (!alive) return null;
			const out: Array<bigint | null> = [null];
			const walker = ensureWalker();
			if (walker === null) return null;
			const result = Number(koffi.call(slot(walker, 3 + methodIndex), proto, walker, pointer, out));
			if (result !== S_OK || out[0] === null) return null;
			return wrap(out[0]!);
		};

		return {
			pointer,
			controlType: () => readInt(IUIAUTOMATION_ELEMENT.controlType),
			name: () => readString(IUIAUTOMATION_ELEMENT.name),
			automationId: () => readString(IUIAUTOMATION_ELEMENT.automationId),
			className: () => readString(IUIAUTOMATION_ELEMENT.className),
			isOffscreen: () => readBool(IUIAUTOMATION_ELEMENT.isOffscreen),
			isEnabled: () => readBool(IUIAUTOMATION_ELEMENT.isEnabled),
			bounds: () => {
				if (!alive) return undefined;
				const out = [{ left: 0, top: 0, right: 0, bottom: 0 }];
				const result = invoke(pointer, IUIAUTOMATION_ELEMENT.boundingRectangle, rectGetterProto, out);
				return result === S_OK ? out[0] : undefined;
			},
			invoke: () => callSimplePattern(pointer, PATTERN_INVOKE, noArgPatternProto),
			toggle: () => callSimplePattern(pointer, PATTERN_TOGGLE, noArgPatternProto),
			select: () => callSimplePattern(pointer, PATTERN_SELECTION_ITEM, noArgPatternProto),
			setValue: (text: string) => {
				if (!alive) return { ok: false, reason: 'failed' };
				const iface = patternHandle(pointer, PATTERN_VALUE);
				if (iface === null) return { ok: false, reason: 'unsupported' };
				const bstr = sysAllocString(text) as bigint | null;
				if (bstr === null) {
					koffi.call(slot(iface, RELEASE_SLOT), releaseProto, iface);
					return { ok: false, reason: 'failed' };
				}
				const result = Number(koffi.call(slot(iface, 3), setValuePatternProto, iface, bstr));
				sysFreeString(bstr);
				koffi.call(slot(iface, RELEASE_SLOT), releaseProto, iface);
				return result === S_OK ? { ok: true } : { ok: false, reason: 'failed', hresult: result };
			},
			firstChild: () => readElement(IUIAUTOMATION_TREE_WALKER.firstChild, firstChildProto),
			nextSibling: () => readElement(IUIAUTOMATION_TREE_WALKER.nextSibling, nextSiblingProto),
			release,
		};
	};

	/** 控制视图 walker；懒创建，dispose 时释放。 */
	let walkerPointer: bigint | null = null;
	const ensureWalker = (): bigint | null => {
		if (walkerPointer !== null) return walkerPointer;
		const out: Array<bigint | null> = [null];
		const result = invoke(automation, IUIAUTOMATION.controlViewWalker, getWalkerProto, out);
		if (result !== S_OK || out[0] === null) return null;
		walkerPointer = out[0]!;
		return walkerPointer;
	};
	trace('declaring protos…');
	ensureWalker();
	trace(`walker=${walkerPointer}`);

	return {
		elementFromHandle(handle) {
			const out: Array<bigint | null> = [null];
			const result = invoke(automation, IUIAUTOMATION.elementFromHandle, elementFromHandleProto, handle, out);
			if (result !== S_OK || out[0] === null) return null;
			return wrap(out[0]!);
		},
		dispose() {
			if (walkerPointer !== null) {
				koffi.call(slot(walkerPointer, RELEASE_SLOT), releaseProto, walkerPointer);
				walkerPointer = null;
			}
			if (automation !== null) koffi.call(slot(automation, RELEASE_SLOT), releaseProto, automation);
			coUninitialize();
		},
	};
}
