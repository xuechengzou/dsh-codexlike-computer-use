/**
 * 屏幕捕获流水线：桌面度量 → GDI32 抓取 → 可选区域裁剪 → 可选缩放 → PNG。
 *
 * 坐标空间是**物理屏幕像素**（虚拟桌面原点可能为负，例如副屏在主屏左侧）。
 * 插件全程只用一个坐标空间：截图上的像素就是 SetCursorPos 接受的像素，
 * 模型不需要做任何换算——这是让"看图点准"可靠的前提。
 */

import { bgraToRgb, downscaleBgra, encodePng, fitWithin } from './png.js';
import { SM, type Win32 } from './win32.js';

/** 一个以左上角加尺寸描述的区域（屏幕坐标）。 */
export interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** 虚拟桌面矩形（可含负坐标）。 */
export interface DesktopBounds extends Bounds {
	monitors: number;
}

/** 一次捕获请求。 */
export interface CaptureRequest {
	/** 只抓取该区域；省略表示整个虚拟桌面。 */
	region?: Bounds | undefined;
	/** 长边上限；`<= 0` 表示不缩放。 */
	maxDimension: number;
	/** zlib 压缩级别。 */
	pngLevel: number;
}

/** 一次捕获结果。 */
export interface CaptureResult {
	png: Buffer;
	/** 输出图像尺寸。 */
	width: number;
	height: number;
	/** 抓取的屏幕区域（缩放前）。 */
	region: Bounds;
	/** 图像像素相对屏幕像素的缩放比；1 表示一一对应。 */
	scale: number;
	/** 从发起捕获到编码完成的毫秒数。 */
	elapsedMs: number;
}

/** 读取虚拟桌面范围与显示器数量。 */
export function desktopBounds(win32: Win32): DesktopBounds {
	const width = win32.screenMetrics(SM.CXVIRTUALSCREEN);
	const height = win32.screenMetrics(SM.CYVIRTUALSCREEN);
	if (width <= 0 || height <= 0) {
		throw new Error('无法读取虚拟桌面尺寸；屏幕可能处于锁定或无人值守状态');
	}
	return {
		x: win32.screenMetrics(SM.XVIRTUALSCREEN),
		y: win32.screenMetrics(SM.YVIRTUALSCREEN),
		width,
		height,
		monitors: Math.max(1, win32.screenMetrics(SM.CMONITORS)),
	};
}

/** 把模型给出的区域裁剪到桌面范围内，并拒绝完全落在桌面之外的区域。 */
export function clampRegion(region: Bounds, desktop: DesktopBounds): Bounds {
	if (region.width <= 0 || region.height <= 0) {
		throw new Error(`region 尺寸必须为正，收到 ${region.width}x${region.height}`);
	}
	const left = Math.max(region.x, desktop.x);
	const top = Math.max(region.y, desktop.y);
	const right = Math.min(region.x + region.width, desktop.x + desktop.width);
	const bottom = Math.min(region.y + region.height, desktop.y + desktop.height);
	if (right - left <= 0 || bottom - top <= 0) {
		throw new Error(
			`region (${region.x},${region.y} ${region.width}x${region.height}) 不在桌面范围 `
			+ `(${desktop.x},${desktop.y} ${desktop.width}x${desktop.height}) 内`,
		);
	}
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 抓取并编码一张截图。
 *
 * 缩放使用面积平均，且缩放比与结果一起返回：调用方据此把"图上的坐标"
 * 换回"屏幕的坐标"，避免模型自己做除法。
 */
export function captureScreenshot(win32: Win32, request: CaptureRequest): CaptureResult {
	const started = Date.now();
	const desktop = desktopBounds(win32);
	const region = request.region === undefined
		? { x: desktop.x, y: desktop.y, width: desktop.width, height: desktop.height }
		: clampRegion(request.region, desktop);

	const bgra = win32.captureBgra(region.x, region.y, region.width, region.height);
	const target = fitWithin(region.width, region.height, request.maxDimension);
	const scaled = downscaleBgra(bgra, region.width, region.height, target.width, target.height);
	const png = encodePng(bgraToRgb(scaled, target.width, target.height), target.width, target.height, request.pngLevel);

	return {
		png,
		width: target.width,
		height: target.height,
		region,
		scale: target.width / region.width,
		elapsedMs: Date.now() - started,
	};
}
