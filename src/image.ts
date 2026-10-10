/**
 * 截图的输出契约：值 schema、持久化，以及给模型看的文本外壳。
 *
 * 这里刻意复刻宿主 `read_image` 的三段式设计——工具输出值只携带**纯 JSON**
 * 的图像元数据，`render()` 再把元数据重新包装成 `ImageBlock`。这样输出值
 * 可以原样进会话日志、被压缩器处理，而图像本身由附件服务持有。
 *
 * 两条截图通道共用这套外壳：全屏/区域截图（像素来自屏幕）与后台窗口截图
 * （像素来自 `PrintWindow`）。它们的外壳必须是**不同**的——前者报屏幕坐标，
 * 后者报目标窗口的客户区坐标，两套坐标系混起来模型必然点偏。
 */

import type { WindowCapture } from './capture-window.js';
import type { AttachmentService, ImageAttachmentRef } from './contracts.js';
import { bgraToRgb, downscaleBgra, encodePng, fitWithin } from './png.js';
import { captureScreenshot, desktopBounds, type Bounds, type CaptureRequest, type CaptureResult } from './screen.js';
import type { Win32 } from './win32.js';
import type { TargetWindow } from './window-target.js';

/**
 * 图像元数据的字段定义，供两种用法复用。
 *
 * 之所以要拆出字段表：`required: true` 在 DSL 里修饰的是**它自己作为某个对象
 * 属性的那一层**。直接把它挂到输出 schema 的 `image` 上，会让"每次调用都必须
 * 返回图像"成为硬要求，于是 `cursor_position`、`click` 之类全部校验失败。
 */
const IMAGE_PROPERTIES = {
	attachmentId: { type: 'string', required: true },
	mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
	bytes: { type: 'integer', required: true },
	width: { type: 'integer', required: true },
	height: { type: 'integer', required: true },
	name: { type: 'string' },
	originalDimensions: {
		type: 'object',
		additionalProperties: false,
		properties: {
			width: { type: 'integer', required: true },
			height: { type: 'integer', required: true },
		},
	},
} as const;

/** 独立使用时的图像值 schema（自身为必填项）。 */
export const IMAGE_VALUE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: true,
	properties: IMAGE_PROPERTIES,
} as const;

/**
 * 作为**可选**字段嵌进别的对象时用的图像 schema。
 *
 * 与 {@link IMAGE_VALUE_SCHEMA} 的唯一差别是不带 `required: true`——
 * 只有 `screenshot` 返回图像，其它动作的返回值里没有这个字段。
 */
export const OPTIONAL_IMAGE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: IMAGE_PROPERTIES,
} as const;

/** 截图动作的输出值。 */
export interface ScreenshotValue {
	image: {
		attachmentId: string;
		mediaType: 'image/png';
		bytes: number;
		width: number;
		height: number;
		name?: string;
		originalDimensions?: { width: number; height: number };
	};
	/** 缩放前抓取的屏幕区域。 */
	region: { x: number; y: number; width: number; height: number };
	/** 虚拟桌面范围。 */
	desktop: { x: number; y: number; width: number; height: number; monitors: number };
	/** 图像坐标 → 屏幕坐标的换算系数。 */
	scale: number;
	/** 捕获时刻的光标位置，供模型判断下一步落点。 */
	cursor: { x: number; y: number };
	/** 捕获与编码耗时（毫秒）。 */
	elapsedMs: number;
	/** 为满足部署体积限制而重试的次数；0 表示一次成功。 */
	downscaleRetries: number;
}

/**
 * 输出值里的窗口摘要。
 *
 * 与 `window` 动作列出的条目同形，所以模型可以把列出来的句柄原样贴回 `target`。
 * `handle` 是十进制**字符串**：句柄在原生层是 bigint，直接放进输出值会让
 * JSON 序列化抛错（值要进会话日志，必须是纯 JSON）。
 */
export interface WindowSummary {
	/** 窗口句柄的十进制字符串；原样回传即可，模型不需要理解它。 */
	handle: string;
	title: string;
	/** `chromium` 或 `gdi`，决定后台输入是否可靠。 */
	kind: string;
	/** 客户区尺寸（不是窗口外框）。 */
	width: number;
	height: number;
	minimized: boolean;
}

/** 后台截图（带 `target` 的 screenshot）的输出值：比屏幕截图多一个窗口摘要。 */
export interface WindowScreenshotValue extends ScreenshotValue {
	window: WindowSummary;
}

/** 把输出值里的图像元数据还原成 `ImageBlock` 需要的引用。 */
export function imageRefFromValue(image: ScreenshotValue['image']): ImageAttachmentRef {
	return {
		attachmentId: image.attachmentId,
		mediaType: image.mediaType,
		bytes: image.bytes,
		width: image.width,
		height: image.height,
		...(image.name === undefined ? {} : { name: image.name }),
		...(image.originalDimensions === undefined ? {} : { originalDimensions: { ...image.originalDimensions } }),
	};
}

/**
 * 生成截图旁边给模型的文本外壳。
 *
 * 显式给出坐标换算关系，而不是让模型自己除：截图被缩放时，"图上的这个点"
 * 与"屏幕上的那个点"之间的换算是最容易出错的一步，写清楚比让模型猜便宜得多。
 */
export function formatScreenshot(value: ScreenshotValue): string {
	const { region, image, scale, cursor } = value;
	const regionText = `${region.x},${region.y} ${region.width}x${region.height}`;
	const lines = [
		`<screenshot region="${regionText}" desktop="${value.desktop.x},${value.desktop.y} ${value.desktop.width}x${value.desktop.height}" monitors="${value.desktop.monitors}" cursor="${cursor.x},${cursor.y}" captured-in-ms="${value.elapsedMs}" />`,
		'<coordinate-space>',
		scale === 1
			? 'Image pixels equal screen pixels: pass image coordinates directly to mouse actions.'
			: `Image is scaled by ${scale.toFixed(5)}. Convert with screen_x = ${region.x} + image_x / ${scale.toFixed(5)}, screen_y = ${region.y} + image_y / ${scale.toFixed(5)}. Mouse actions take SCREEN pixels.`,
		'</coordinate-space>',
		`<content>${image.mediaType} screenshot, ${image.width}x${image.height} px, ${image.bytes} bytes${value.downscaleRetries > 0 ? `, re-captured ${value.downscaleRetries} time(s) smaller to satisfy deployment image limits` : ''}</content>`,
	];
	return lines.join('\n');
}

/**
 * 生成**后台截图**旁边给模型的文本外壳。
 *
 * 与全屏截图的外壳有两处必须说清的不同：
 *
 * 1. 坐标空间是**该窗口的客户区**，不是屏幕。后台点击投递的正是客户区坐标，
 *    而屏幕坐标在这里毫无用处（窗口可能在前台、也可能被压在别的窗口后面）。
 * 2. 换算关系写成公式，同时点明"不要把图上的像素预先换算掉"：换算由工具在
 *    点击时完成，模型多做一次除法反而会点偏（这正是 hidden state 最容易
 *    失败的地方，所以要说在明处，而不是让模型猜）。
 */
export function formatWindowScreenshot(value: WindowScreenshotValue): string {
	const { window, region, image, scale } = value;
	const clientText = `${region.x},${region.y} ${region.width}x${region.height}`;
	const target = window.handle;
	// 标题里的引号会破坏标签的属性结构：真标题仍然原样放在 <content> 与值里
	const titleAttribute = window.title.replace(/"/gu, "'");
	const lines = [
		`<screenshot window="${titleAttribute}" target="${target}" kind="${window.kind}" client="${clientText}" image="${image.width}x${image.height}" desktop="${value.desktop.x},${value.desktop.y} ${value.desktop.width}x${value.desktop.height}" monitors="${value.desktop.monitors}" captured-in-ms="${value.elapsedMs}" />`,
		'<coordinate-space>',
		'A background capture: the window was NOT brought to front, and the cursor was not moved.',
		scale === 1
			? `Image pixels equal window CLIENT-area pixels: pass image coordinates directly as x/y to mouse actions with target="${target}". They are client coordinates, not screen pixels.`
			: `Image is scaled by ${scale.toFixed(5)}: client_x = image_x / ${scale.toFixed(5)}, client_y = image_y / ${scale.toFixed(5)}, with the origin at the window's client area (not the screen). Pass the image pixels as you read them off this image — the tool applies this conversion for target="${target}"; do not pre-convert them yourself.`,
		`Coordinates from this image are only valid with target="${target}".`,
		'</coordinate-space>',
		`<content>${image.mediaType} capture of the client area of window "${window.title}" [${window.kind}], ${image.width}x${image.height} px, ${image.bytes} bytes${value.downscaleRetries > 0 ? `, re-captured ${value.downscaleRetries} time(s) smaller to satisfy deployment image limits` : ''}</content>`,
	];
	return lines.join('\n');
}

/** 附件服务在体积/像素超限时使用的错误码。 */
const RECOVERABLE_CODES = new Set(['IMAGE_TOO_LARGE', 'IMAGE_TOO_MANY_PIXELS', 'IMAGE_DIMENSION_TOO_LARGE']);

/** 从附件错误里读码；非附件错误返回 undefined。 */
function attachmentCode(error: unknown): string | undefined {
	if (typeof error === 'object' && error !== null && 'code' in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === 'string') return code;
	}
	return undefined;
}

/**
 * 构造降采样重试阶梯。
 *
 * 部署的图像上限无法在插件里预先得知（取决于 profile 配置），因此策略是：
 * 先按用户配置的尺寸抓一次；若附件服务以"太大"为由拒绝，就换更小的尺寸
 * 重抓，而不是把失败直接抛给模型。屏幕内容重抓的代价只有几十毫秒。
 */
export function downscaleLadder(configured: number, maxImageDimension: number | undefined): number[] {
	const rungs: number[] = [];
	const push = (value: number): void => {
		if (value > 0 && !rungs.includes(value)) rungs.push(value);
	};
	if (configured <= 0) {
		// 0 = 原生尺寸优先，但先受部署边长上限约束
		if (maxImageDimension !== undefined) push(maxImageDimension);
		rungs.push(0);
		push(1568);
	} else {
		push(Math.min(configured, maxImageDimension ?? configured));
		push(Math.floor(configured / 2));
		push(Math.floor(configured / 4));
	}
	if (rungs.length === 0) rungs.push(0);
	return rungs;
}

/** 一次成功捕获 + 持久化的结果。 */
export interface StoredScreenshot {
	value: ScreenshotValue;
	ref: ImageAttachmentRef;
}

/**
 * 附件服务以"太大"为由拒绝时，这一条通道的可行下一步。
 *
 * 屏幕截图可以缩小抓取区域，窗口截图不行——客户区尺寸由目标窗口决定，
 * 唯一能调的是缩放后的长边。把差异写成一张表，两条通道才能共用同一段
 * 重试与错误翻译逻辑，而不必各写一遍。
 */
interface RejectionAdvice {
	/** 解码后像素数超限。 */
	readonly pixels: string;
	/** 单边长度超限。 */
	readonly dimension: string;
	/** 编码后字节数超限。 */
	readonly bytes: string;
}

const SCREEN_ADVICE: RejectionAdvice = {
	pixels: '请用 region 只抓取需要的窗口区域，或调低 maxDimension',
	dimension: '请调低 maxDimension',
	bytes: '请用 region 缩小抓取范围，或调低 maxDimension',
};

const WINDOW_ADVICE: RejectionAdvice = {
	pixels: '请调低 maxDimension（窗口客户区尺寸由目标决定，无法用 region 缩小）',
	dimension: '请调低 maxDimension',
	bytes: '请调低 maxDimension',
};

/** 一次"产出 PNG"的结果；屏幕捕获与窗口捕获都归约成这个形状。 */
interface CapturedPng {
	readonly png: Buffer;
	/** 编码后的图像尺寸（可能已降采样）。 */
	readonly width: number;
	readonly height: number;
	/**
	 * 被编码内容的区域（屏幕坐标，缩放前）。
	 *
	 * 它同时是换算系数的分母：`scale = 图像宽 / region.width`。屏幕截图时这是
	 * 抓取的屏幕区域，窗口截图时是客户区本身。
	 */
	readonly region: Bounds;
	readonly elapsedMs: number;
}

/**
 * 按降采样阶梯反复"产出 PNG → 交给附件服务"，直到被接受。
 *
 * 屏幕截图与窗口截图只差"像素从哪来"：阶梯、重试判定、错误翻译与输出值组装
 * 完全一样。共用一份实现是为了不让两条通道的失败处理各自漂移——部署的图像
 * 上限无法在插件里预先得知，这套自愈逻辑必须两边同时正确。
 */
async function storeWithLadder(
	win32: Win32,
	attachments: AttachmentService,
	ladder: readonly number[],
	namePrefix: string,
	advice: RejectionAdvice,
	produce: (maxDimension: number) => CapturedPng,
): Promise<StoredScreenshot> {
	let lastError: unknown;

	for (let attempt = 0; attempt < ladder.length; attempt += 1) {
		const captured = produce(ladder[attempt]!);
		let ref: ImageAttachmentRef;
		try {
			ref = await attachments.saveImage({
				data: captured.png,
				mediaType: 'image/png',
				name: `${namePrefix}-${captured.width}x${captured.height}.png`,
			});
		} catch (error) {
			const code = attachmentCode(error);
			if (code !== undefined && RECOVERABLE_CODES.has(code) && attempt < ladder.length - 1) {
				lastError = error;
				continue;
			}
			if (code === 'IMAGE_TOO_MANY_PIXELS') {
				throw new Error(
					`截图被附件服务拒绝：解码后像素超过部署上限 ${attachments.imageLimits.maxImagePixels}；${advice.pixels}`,
					{ cause: error },
				);
			}
			if (code === 'IMAGE_DIMENSION_TOO_LARGE') {
				throw new Error(
					`截图被附件服务拒绝：边长超过部署上限 ${attachments.imageLimits.maxImageDimension}px；${advice.dimension}`,
					{ cause: error },
				);
			}
			if (code === 'IMAGE_TOO_LARGE') {
				throw new Error(
					`截图被附件服务拒绝：编码体积超过部署上限 ${attachments.imageLimits.maxImageBytes} 字节；${advice.bytes}`,
					{ cause: error },
				);
			}
			throw error;
		}

		const desktop = desktopBounds(win32);
		const value: ScreenshotValue = {
			image: {
				attachmentId: ref.attachmentId,
				mediaType: 'image/png',
				bytes: ref.bytes,
				width: ref.width,
				height: ref.height,
				...(ref.name === undefined ? {} : { name: ref.name }),
				...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
			},
			region: captured.region,
			desktop,
			// 若附件服务做过额外缩减，真实换算系数由服务返回的尺寸决定
			scale: ref.width / captured.region.width,
			cursor: win32.cursorPosition(),
			elapsedMs: captured.elapsedMs,
			downscaleRetries: attempt,
		};
		return { value, ref };
	}

	throw new Error('截图在逐级降采样后仍被附件服务拒绝', { cause: lastError });
}

/**
 * 抓取一张**屏幕**截图并持久化。
 *
 * @param win32 - 原生绑定。
 * @param attachments - 已挂载的附件服务。
 * @param request - 捕获请求（不含 `maxDimension`，由阶梯决定）。
 * @param configuredMaxDimension - 配置的长边上限。
 * @param pngLevel - zlib 压缩级别。
 * @returns 输出值与可持久引用的图像。
 * @throws 阶梯耗尽仍被拒时，抛出指名部署上限的可读错误。
 */
export function captureAndStore(
	win32: Win32,
	attachments: AttachmentService,
	request: Omit<CaptureRequest, 'maxDimension' | 'pngLevel'>,
	configuredMaxDimension: number,
	pngLevel: number,
): Promise<StoredScreenshot> {
	return storeWithLadder(
		win32,
		attachments,
		downscaleLadder(configuredMaxDimension, attachments.imageLimits.maxImageDimension),
		'screen',
		SCREEN_ADVICE,
		(maxDimension) => {
			const capture: CaptureResult = captureScreenshot(win32, { ...request, maxDimension, pngLevel });
			return {
				png: capture.png,
				width: capture.width,
				height: capture.height,
				region: capture.region,
				elapsedMs: capture.elapsedMs,
			};
		},
	);
}

/**
 * 把一次**后台窗口**截图缩放、编码并持久化。
 *
 * 与 `captureAndStore` 的差别只有像素来源：这里的像素已经由 `captureWindowBgra`
 * 用 PrintWindow 抓好（不经过屏幕，也不需要窗口在前台），因此不再调用屏幕捕获，
 * 直接缩放 + 编码。`region` 记的是窗口客户区在屏幕坐标下的位置与缩放前的尺寸，
 * 于是 `scale` 表达的正是"图像像素 → 客户区像素"的比例——后台点击要的就是这个
 * 坐标系下的坐标，把它随图一起回报，模型才不会把两套坐标系搞混。
 *
 * 调用方必须**先确认 `capture.blank` 为假**：空白帧能编码成一张合法的 PNG，
 * 但把它交给模型等于让模型在纯色图上找按钮。
 *
 * @param target - 已解析的后台目标。
 * @param capture - `captureWindowBgra` 的产物。
 * @param startedAt - 本次后台截图的起点（含 PrintWindow 抓取），用于如实回报耗时。
 */
export function storeWindowCapture(
	win32: Win32,
	attachments: AttachmentService,
	target: TargetWindow,
	capture: WindowCapture,
	configuredMaxDimension: number,
	pngLevel: number,
	startedAt: number = Date.now(),
): Promise<StoredScreenshot> {
	return storeWithLadder(
		win32,
		attachments,
		downscaleLadder(configuredMaxDimension, attachments.imageLimits.maxImageDimension),
		'window',
		WINDOW_ADVICE,
		(maxDimension) => {
			const size = fitWithin(capture.width, capture.height, maxDimension);
			const scaled = downscaleBgra(capture.pixels, capture.width, capture.height, size.width, size.height);
			const png = encodePng(bgraToRgb(scaled, size.width, size.height), size.width, size.height, pngLevel);
			return {
				png,
				width: size.width,
				height: size.height,
				region: { x: target.client.x, y: target.client.y, width: capture.width, height: capture.height },
				elapsedMs: Date.now() - startedAt,
			};
		},
	);
}

