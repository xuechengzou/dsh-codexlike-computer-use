/**
 * 最小 PNG 编码器与面积平均缩放。
 *
 * 只用 `node:zlib`，因此插件不引入任何图像库。输出为 8-bit truecolour
 * （colour type 2）——屏幕像素不透明，省掉 alpha 通道能显著减小体积。
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

/** 标准 PNG chunk 校验和。 */
function crc32(buffer: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** 组装一个 PNG chunk：长度 + 类型 + 数据 + CRC。 */
function chunk(type: string, data: Uint8Array): Buffer {
	const out = Buffer.alloc(data.length + 12);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	Buffer.from(data).copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

/** 把自顶向下的 RGB 像素编码为 PNG。 */
export function encodePng(rgb: Uint8Array, width: number, height: number, level = 6): Buffer {
	if (rgb.length !== width * height * 3) {
		throw new Error(`encodePng: 像素缓冲区 ${rgb.length} 字节与 ${width}x${height} 的 RGB 尺寸不符`);
	}

	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // 位深
	header[9] = 2; // colour type：truecolour
	header[10] = 0; // 压缩方法：deflate
	header[11] = 0; // 滤波方法：自适应
	header[12] = 0; // 非隔行

	// 每条扫描线前置一个滤波字节（0 = None）
	const stride = width * 3;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y += 1) {
		raw[y * (stride + 1)] = 0;
		Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw, { level })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

/**
 * 一维区间权重表：把 `sourceLength` 个采样映射到 `targetLength` 个输出，
 * 每个输出记录覆盖到的源区间与归一化权重。缩放系数任意（含放大）都成立。
 */
function intervalWeights(sourceLength: number, targetLength: number): Array<{ start: number; end: number; weights: Float64Array }> {
	const ratio = sourceLength / targetLength;
	const plan: Array<{ start: number; end: number; weights: Float64Array }> = [];
	for (let index = 0; index < targetLength; index += 1) {
		const low = index * ratio;
		const high = Math.min((index + 1) * ratio, sourceLength);
		const start = Math.floor(low);
		const end = Math.min(Math.max(Math.ceil(high), start + 1), sourceLength);
		const weights = new Float64Array(end - start);
		let total = 0;
		for (let source = start; source < end; source += 1) {
			const overlap = Math.min(high, source + 1) - Math.max(low, source);
			const weight = overlap > 0 ? overlap : 0;
			weights[source - start] = weight;
			total += weight;
		}
		if (total <= 0) {
			// 退化情形（极端缩放比）：退化为最近邻，保证权重和恒为 1
			const nearest = Math.min(start, sourceLength - 1);
			weights.fill(0);
			weights[nearest - start] = 1;
			total = 1;
		}
		for (let i = 0; i < weights.length; i += 1) weights[i]! /= total;
		plan.push({ start, end, weights });
	}
	return plan;
}

/**
 * 面积平均缩放自顶向下的 BGRA 像素。
 *
 * 用面积平均而不是最近邻：屏幕文字与细线在缩小后仍可辨认，这对
 * "模型读图定位坐标"是关键的画质差异。
 */
export function downscaleBgra(
	bgra: Uint8Array,
	width: number,
	height: number,
	targetWidth: number,
	targetHeight: number,
): Uint8Array {
	if (targetWidth === width && targetHeight === height) return bgra;

	const columns = intervalWeights(width, targetWidth);
	const rows = intervalWeights(height, targetHeight);

	// 水平方向先降，得到 targetWidth x height 的中间缓冲
	const intermediate = new Uint8Array(targetWidth * height * 4);
	for (let y = 0; y < height; y += 1) {
		const sourceRow = y * width * 4;
		const targetRow = y * targetWidth * 4;
		for (let x = 0; x < targetWidth; x += 1) {
			const plan = columns[x]!;
			let b = 0;
			let g = 0;
			let r = 0;
			let a = 0;
			for (let i = 0; i < plan.weights.length; i += 1) {
				const weight = plan.weights[i]!;
				if (weight === 0) continue;
				const offset = sourceRow + (plan.start + i) * 4;
				b += bgra[offset]! * weight;
				g += bgra[offset + 1]! * weight;
				r += bgra[offset + 2]! * weight;
				a += bgra[offset + 3]! * weight;
			}
			const out = targetRow + x * 4;
			intermediate[out] = Math.round(b);
			intermediate[out + 1] = Math.round(g);
			intermediate[out + 2] = Math.round(r);
			intermediate[out + 3] = Math.round(a);
		}
	}

	// 垂直方向收敛到目标高度
	const result = new Uint8Array(targetWidth * targetHeight * 4);
	for (let y = 0; y < targetHeight; y += 1) {
		const plan = rows[y]!;
		const targetRow = y * targetWidth * 4;
		for (let x = 0; x < targetWidth; x += 1) {
			let b = 0;
			let g = 0;
			let r = 0;
			let a = 0;
			for (let i = 0; i < plan.weights.length; i += 1) {
				const weight = plan.weights[i]!;
				if (weight === 0) continue;
				const offset = (plan.start + i) * targetWidth * 4 + x * 4;
				b += intermediate[offset]! * weight;
				g += intermediate[offset + 1]! * weight;
				r += intermediate[offset + 2]! * weight;
				a += intermediate[offset + 3]! * weight;
			}
			const out = targetRow + x * 4;
			result[out] = Math.round(b);
			result[out + 1] = Math.round(g);
			result[out + 2] = Math.round(r);
			result[out + 3] = Math.round(a);
		}
	}
	return result;
}

/** 自顶向下的 BGRA 转 RGB，丢弃恒为 255 的 alpha 通道。 */
export function bgraToRgb(bgra: Uint8Array, width: number, height: number): Uint8Array {
	const rgb = new Uint8Array(width * height * 3);
	for (let i = 0, j = 0; i < bgra.length; i += 4, j += 3) {
		rgb[j] = bgra[i + 2]!;
		rgb[j + 1] = bgra[i + 1]!;
		rgb[j + 2] = bgra[i]!;
	}
	return rgb;
}

/** 计算等比缩放到上限内所需的尺寸；`maxDimension <= 0` 表示不缩放。 */
export function fitWithin(width: number, height: number, maxDimension: number): { width: number; height: number } {
	if (maxDimension <= 0) return { width, height };
	const longest = Math.max(width, height);
	if (longest <= maxDimension) return { width, height };
	const ratio = maxDimension / longest;
	return {
		width: Math.max(1, Math.round(width * ratio)),
		height: Math.max(1, Math.round(height * ratio)),
	};
}
