/**
 * 后台模式的窗口截图：PrintWindow 抓像素 + 空白帧判定。
 *
 * 为什么需要单独的「空白判定」而不是只看 PrintWindow 的返回值：
 * 实测 PrintWindow 经常返回成功、却交出一张纯色图（纯黑或纯白）——
 * 典型场景是窗口从未被呈现过、或渲染进程此刻没有可给的帧。调用方
 * 如果只看 ok 就把这张图发给模型，模型会在一张白图上凭空找按钮。
 * 因此本模块把「拿到像素」与「像素是否可信」绑在一起返回。
 *
 * 职责边界：本模块只产出可信的 BGRA 像素。PNG 编码与缩放归 src/image.ts，
 * 坐标换算归 src/window-target.ts，这里一概不做。
 */
import type { TargetWindow } from './window-target.js';
import type { Win32 } from './win32.js';

/** 一次后台窗口截图的结果。 */
export interface WindowCapture {
	/** BGRA，自顶向下，长度恒为 width * height * 4。 */
	readonly pixels: Uint8Array;
	readonly width: number;
	readonly height: number;
	/**
	 * 是否为空白帧。为 true 时像素本身没有意义，调用方不应把它当内容用；
	 * 常见处理是提示「窗口可能从未呈现或渲染已挂起，请让它显示一次再试」。
	 */
	readonly blank: boolean;
}

/**
 * 空白判定的可调阈值。
 *
 * 之所以把三条判据分开暴露而不是合成一个分数：三者对应三种**不同成因**的
 * 失败（纯黑 = 没画、纯白 = 只铺了底、少色 = 渲染挂起前的残留底色），
 * 调用方调阈值时需要能分别收紧或放松。
 */
export interface BlankThresholds {
	/**
	 * 采样像素中「近黑」比例达到此值判为空白。默认 0.999：
	 * 真实黑图是全零像素，留 0.1% 的容差只是为了不因个别抗锯齿边缘误判。
	 */
	readonly nearBlackRatio: number;
	/** 采样像素中「近白」比例达到此值判为空白。默认 0.999，理由同上。 */
	readonly nearWhiteRatio: number;
	/**
	 * 不同 BGR 颜色数不超过此值判为空白。默认 4：
	 * 真实窗口内容（哪怕只是一个纯色按钮加白底，边缘抗锯齿也轻易超过 4 种颜色），
	 * 而「渲染没给帧」时通常只剩 1-2 种底色。
	 */
	readonly maxDistinctColors: number;
}

/** 默认阈值，取值依据见 BlankThresholds 各字段注释。 */
export const DEFAULT_BLANK_THRESHOLDS: BlankThresholds = {
	nearBlackRatio: 0.999,
	nearWhiteRatio: 0.999,
	maxDistinctColors: 4,
};

/** 「近黑」的通道容差：BGR 三通道都不超过此值才算近黑。 */
const NEAR_BLACK_MAX = 8;
/** 「近白」的通道容差：BGR 三通道都不低于此值才算近白。 */
const NEAR_WHITE_MIN = 248;

/** 采样像素数上限：1080p 全幅有 200 万像素，逐像素统计纯属浪费；均匀抽样足够代表整幅。 */
const MAX_SAMPLED_PIXELS = 4096;

/**
 * 判定一帧 BGRA 像素是否为「空白帧」（没有真实内容）。
 *
 * 三条判据任一命中即为空白：
 *   1. 近黑比例 >= nearBlackRatio（PrintWindow 没画出内容时的典型表现）；
 *   2. 近白比例 >= nearWhiteRatio（printWindowBgra 自带白底预填，「只铺了底」
 *      就表现为一整幅白）；
 *   3. 不同 BGR 颜色数 <= maxDistinctColors（渲染挂起前的残留底色）。
 *
 * 判定时忽略 alpha：PrintWindow 走 GetDIBits 取回的 alpha 语义不可靠
 * （全透明 alpha 配全零 BGR，正好会被判据 1 抓住，因此不需要单独处理）。
 *
 * 空数组直接判空白。极小图（如 1x1）只要颜色数不超标也会被判空白——
 * 这么小的图本来就无法与纯色底区分，宁可误报也不放行。
 *
 * @param pixels - BGRA，长度应为 4 的倍数；不是时忽略末尾不足一个像素的部分。
 */
export function isBlankCapture(pixels: Uint8Array, thresholds: BlankThresholds = DEFAULT_BLANK_THRESHOLDS): boolean {
	const pixelCount = Math.floor(pixels.length / 4);
	if (pixelCount === 0) return true;

	// 均匀抽样：步长向下取整后从头走，覆盖整幅而不会偏向某一角
	const stride = Math.max(1, Math.floor(pixelCount / MAX_SAMPLED_PIXELS));
	let sampled = 0;
	let nearBlack = 0;
	let nearWhite = 0;
	const colors = new Set<number>();

	for (let index = 0; index < pixelCount; index += stride) {
		const offset = index * 4;
		// 循环上界由 pixelCount = floor(length/4) 保证 offset+2 必然在界内
		const blue = pixels[offset]!;
		const green = pixels[offset + 1]!;
		const red = pixels[offset + 2]!;
		sampled += 1;
		if (blue <= NEAR_BLACK_MAX && green <= NEAR_BLACK_MAX && red <= NEAR_BLACK_MAX) nearBlack += 1;
		if (blue >= NEAR_WHITE_MIN && green >= NEAR_WHITE_MIN && red >= NEAR_WHITE_MIN) nearWhite += 1;
		// BGR 压成一个 24 位整数做集合键；超过上限后停止收集（集合已不会再缩小），
		// 但近黑/近白计数必须走完整幅采样，不能跟着提前退出
		if (colors.size <= thresholds.maxDistinctColors) {
			colors.add((red << 16) | (green << 8) | blue);
		}
	}

	if (colors.size <= thresholds.maxDistinctColors) return true;
	if (nearBlack / sampled >= thresholds.nearBlackRatio) return true;
	if (nearWhite / sampled >= thresholds.nearWhiteRatio) return true;
	return false;
}

/**
 * 用 PrintWindow 抓取一个后台窗口的渲染表面。
 *
 * 尺寸取 target.client 的宽高：client 是「屏幕坐标下的位置 + 尺寸」，
 * 截图只关心尺寸，位置由坐标换算那层（window-target.ts）去管。
 * Chromium 窗口必须抓 surfaceHandle（渲染子窗口），抓顶层句柄只会得到外壳。
 *
 * 最小化的窗口直接抛错而不是返回 blank:true：
 * 最小化时系统挂起渲染，拍出来**必然**是空白帧，这是确定的失败而不是
 * 「可能没内容」；抛错能把「请先还原窗口」这个可执行的下一步带给调用方，
 * 而 blank:true 会把这个原因抹平成一次普通的空白结果。
 *
 * @throws 窗口已最小化，或客户区尺寸无效。
 */
export function captureWindowBgra(win32: Win32, target: TargetWindow): WindowCapture {
	if (target.minimized) {
		throw new Error(
			`窗口「${target.title}」处于最小化状态，渲染已被系统挂起，后台截图必然得到空白帧；请先还原窗口再试`,
		);
	}

	const { width, height } = target.client;
	if (width <= 0 || height <= 0) {
		throw new Error(`窗口「${target.title}」的客户区尺寸无效（${width}x${height}），无法截图`);
	}

	const { pixels } = win32.printWindowBgra(target.surfaceHandle, width, height);
	return {
		pixels,
		width,
		height,
		blank: isBlankCapture(pixels),
	};
}
