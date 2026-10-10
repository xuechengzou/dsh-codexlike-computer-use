/**
 * 把"一个窗口句柄"解析成"后台模式真正能操作的目标"。
 *
 * 后台模式的全部难点集中在这里。原因是真实系统里这三件事是三样东西：
 *
 *   - **顶层窗口**：有标题、类名，出现在任务栏与 z 序里。
 *   - **客户区**：顶层窗口去掉边框与标题栏之后的那块，坐标原点≠窗口原点。
 *   - **渲染表面**：Chromium/Electron 把网页内容画在一个**独立的子窗口**里
 *     （`Chrome_RenderWidgetHostHWND`），顶层窗口只是外壳。
 *
 * 实测结论（详见 README「后台模式」一节，全部在真实窗口上量过）：
 *
 *   - 往 Chromium 的**顶层窗口**投递鼠标消息毫无反应；必须打到渲染子窗口。
 *   - 打对了坐标就是精确的：投递客户区 (308,241)，页面记录到的正是 `MD-308x241`。
 *   - `PrintWindow` 对"上过屏"的 Chromium 窗口有效，对从未呈现过的窗口拿不到帧。
 *
 * 所以本模块的职责是：判定窗口种类、找出真正的投递目标、给出坐标系原点，
 * 并在做不到的时候说清楚**为什么**做不到——而不是退回前台模式让用户莫名其妙
 * 地看到光标被抢走。
 */
import type { ClientArea, Win32 } from './win32.js';

/** 窗口种类：决定截图与输入各走哪条通道。 */
export type WindowKind = 'chromium' | 'gdi';

/** 解析成功的目标窗口。 */
export interface TargetWindow {
	/** 顶层窗口句柄：用于标题、类名、存活判断。 */
	readonly frameHandle: bigint;
	/** 实际接收消息与渲染内容的句柄。GDI 窗口下等于 `frameHandle`。 */
	readonly surfaceHandle: bigint;
	readonly kind: WindowKind;
	readonly title: string;
	readonly className: string;
	readonly processId: number;
	/** 顶层窗口矩形（屏幕坐标）。 */
	readonly frame: ClientArea;
	/** 渲染表面的客户区（屏幕坐标）：截图坐标与投递坐标都基于它。 */
	readonly client: ClientArea;
	readonly dpi: number;
	readonly visible: boolean;
	readonly minimized: boolean;
}

/** 解析失败：带上原因与可执行的下一步，而不是一个空结果。 */
export interface TargetFailure {
	readonly ok: false;
	readonly reason: string;
	readonly hint: string;
}

/** 解析成功。 */
export interface TargetSuccess {
	readonly ok: true;
	readonly target: TargetWindow;
}

export type TargetResolution = TargetSuccess | TargetFailure;

/**
 * Chromium / Electron 系窗口的类名特征。
 *
 * `Chrome_WidgetWin_1` 是 Chrome 与 Electron 的顶层窗口类；
 * `Intermediate D3D Window` 是它的 GPU 合成子窗口（**不是**投递目标，
 * 实测往它投递没有反应，列在这里只是为了在诊断信息里认得出它）。
 */
const CHROMIUM_FRAME_CLASS = /chrome_widgetwin|chromium|electron/i;
/** Chromium 真正接收输入与渲染内容的那层子窗口。 */
const CHROMIUM_SURFACE_CLASS = /renderwidgethost/i;

/** 表面至少要有这么大，才可能装得下真实内容而不是辅助窗口。 */
const MIN_SURFACE_EDGE = 64;

/**
 * 判定窗口种类。
 *
 * 只依据类名，不做进程名、也不做"有没有子窗口"的猜测：
 * 类名是驱动实际分发的那一条事实，猜错会让投递静默失败。
 */
export function classifyWindow(className: string): WindowKind {
	return CHROMIUM_FRAME_CLASS.test(className) ? 'chromium' : 'gdi';
}

/** 在窗口的后代里找渲染表面。找到面积最大的那个，找不到返回 undefined。 */
function findChromiumSurface(win32: Win32, frameHandle: bigint): bigint | undefined {
	// 宽度优先逐层找：渲染表面通常就在顶层窗口下面一层，
	// 但也见过被嵌在一个中间层里的情况，所以整棵树都要走。
	const queue = [...win32.childWindows(frameHandle)];
	let best: { handle: bigint; area: number } | undefined;

	while (queue.length > 0) {
		const handle = queue.shift();
		if (handle === undefined) break;
		const info = win32.windowInfo(handle);
		if (info !== undefined && CHROMIUM_SURFACE_CLASS.test(info.className)) {
			const client = win32.clientArea(handle);
			if (client !== undefined && client.width >= MIN_SURFACE_EDGE && client.height >= MIN_SURFACE_EDGE) {
				const area = client.width * client.height;
				// 取面积最大的那个：Chromium 会同时建出若干个辅助渲染窗口，
				// 实测其中有 12x10 与 0x0 这种，误选它们会拿到一张空白图。
				if (best === undefined || area > best.area) best = { handle, area };
			}
		}
		for (const child of win32.childWindows(handle)) queue.push(child);
	}

	return best?.handle;
}

/**
 * 把一个窗口句柄解析成可操作的后台目标。
 *
 * @param win32 - 原生绑定。
 * @param handle - 顶层窗口句柄。
 */
export function resolveTargetWindow(win32: Win32, handle: bigint): TargetResolution {
	if (handle === 0n) {
		return { ok: false, reason: '没有可用的窗口句柄', hint: '先用 computer 的 window 动作列出窗口，再用返回的句柄指定目标' };
	}

	const info = win32.windowInfo(handle);
	if (info === undefined) {
		return {
			ok: false,
			reason: `窗口句柄 ${handle} 已失效或无法读取`,
			hint: '目标窗口可能已经关闭；重新列出窗口后再试',
		};
	}

	const kind = classifyWindow(info.className);
	const minimized = win32.isMinimized(handle);
	const visible = win32.isWindowVisible(handle);

	let surfaceHandle = handle;
	if (kind === 'chromium') {
		const surface = findChromiumSurface(win32, handle);
		if (surface === undefined) {
			// 这一条是实测出来的：从未被呈现过的 Chromium 窗口不产出渲染表面。
			// 与其退回前台模式偷偷抢走光标，不如把原因说清楚。
			return {
				ok: false,
				reason: `窗口「${info.title}」是 Chromium/Electron 窗口，但没有找到渲染表面`,
				hint: minimized
					? '窗口处于最小化状态时 Chromium 不产出渲染表面；请先还原窗口'
					: '该窗口可能从未真正显示过（Chromium 对完全被遮挡且从未呈现的窗口不产出帧）；请先让它显示一次',
			};
		}
		surfaceHandle = surface;
	}

	const client = win32.clientArea(surfaceHandle);
	if (client === undefined || client.width <= 0 || client.height <= 0) {
		return {
			ok: false,
			reason: `窗口「${info.title}」的客户区尺寸无效`,
			hint: '窗口可能正在最小化或尺寸为零；请先还原窗口',
		};
	}

	return {
		ok: true,
		target: {
			frameHandle: handle,
			surfaceHandle,
			kind,
			title: info.title,
			className: info.className,
			processId: info.processId,
			frame: { x: info.rect.left, y: info.rect.top, width: info.rect.right - info.rect.left, height: info.rect.bottom - info.rect.top },
			client,
			dpi: win32.windowDpi(handle),
			visible,
			minimized,
		},
	};
}

// ---- 坐标换算 -------------------------------------------------------------

/** 一次截图与原始区域之间的对应关系。 */
export interface CaptureMapping {
	/** 截图图像的像素尺寸。 */
	readonly imageWidth: number;
	readonly imageHeight: number;
	/** 被截取区域在屏幕坐标下的原点。 */
	readonly originX: number;
	readonly originY: number;
	/**
	 * 截图相对原始区域的缩放比例（1 表示 1:1）。
	 *
	 * 截图超过尺寸上限时会被降采样，此时模型看到的坐标是**图像坐标**，
	 * 必须先除以这个比例才能回到屏幕坐标。
	 */
	readonly scale: number;
}

/** 图像上的一个点。 */
export interface ImagePoint {
	readonly x: number;
	readonly y: number;
}

/**
 * 把"模型从截图上读到的坐标"换算成"要投递给渲染表面的客户区坐标"。
 *
 * 这条链路有三段，任何一段漏掉都会整体偏移：
 *   图像坐标 --÷scale--> 被截区域的偏移 --+origin--> 屏幕坐标 --−客户区原点--> 客户区坐标
 *
 * 之所以最终要落到**客户区坐标**：实测投递给渲染表面的正是客户区坐标，
 * 而投递给 GDI 窗口的鼠标消息同样以客户区为原点。两种窗口在这一点上一致。
 */
export function imagePointToClient(point: ImagePoint, mapping: CaptureMapping, client: ClientArea): { x: number; y: number } {
	const screenX = mapping.originX + point.x / mapping.scale;
	const screenY = mapping.originY + point.y / mapping.scale;
	return { x: Math.round(screenX - client.x), y: Math.round(screenY - client.y) };
}

/**
 * 把客户区坐标换算回屏幕坐标。
 *
 * 前台模式（`SetCursorPos` + `SendInput`）需要的是屏幕坐标，后台模式需要的是
 * 客户区坐标，两者必须能互相换算，否则"同一张截图、两种模式"就必然有一边点偏。
 */
export function clientPointToScreen(point: ImagePoint, client: ClientArea): { x: number; y: number } {
	return { x: point.x + client.x, y: point.y + client.y };
}

/** 把鼠标客户区坐标打包成消息的 `lParam`（低 16 位 x，高 16 位 y）。 */
export function makeMouseLParam(point: ImagePoint): number {
	// 必须与 0xffff 相与后再拼接：负坐标或超界值会污染另一个分量，
	// 这是消息投递里最容易出错、又最难从现象上看出来的一处。
	const x = point.x & 0xffff;
	const y = point.y & 0xffff;
	return ((y << 16) | x) | 0;
}

/** 给模型看的一句话描述，用于结果里的 `target` 字段与错误信息。 */
export function describeTarget(target: TargetWindow): string {
	const kind = target.kind === 'chromium' ? 'Chromium/Electron（投递到渲染子窗口）' : '普通 Win32 窗口';
	const flags = [target.minimized ? '已最小化' : undefined, target.visible ? undefined : '不可见'].filter((flag) => flag !== undefined);
	const suffix = flags.length === 0 ? '' : `，${flags.join('、')}`;
	return `「${target.title}」${kind}，客户区 ${target.client.width}x${target.client.height}${suffix}`;
}
