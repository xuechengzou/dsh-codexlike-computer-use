/**
 * PNG 编码器与缩放的正确性测试。
 *
 * 不只检查"产出了字节"，而是把生成的 PNG **解回来**逐像素比对：
 * 编码器是自己写的，chunk 顺序、CRC、滤波字节、行序任何一处错了，
 * 图片在别处都会显示成花屏或直接打不开，而这类错误在自检里最容易漏。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { bgraToRgb, downscaleBgra, encodePng, fitWithin } from '../lib/png.js';

test('encodePng 产出可被解回的结构，且像素与输入一致', () => {
	const width = 3;
	const height = 2;
	// 自顶向下的 RGB
	const rgb = Uint8Array.from([
		255, 0, 0, 0, 255, 0, 0, 0, 255,
		10, 20, 30, 40, 50, 60, 70, 80, 90,
	]);

	const png = encodePng(rgb, width, height, 6);

	// 文件签名
	assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

	// 逐 chunk 解析并校验 CRC
	const chunks = [];
	let offset = 8;
	while (offset < png.length) {
		const length = png.readUInt32BE(offset);
		const type = png.toString('ascii', offset + 4, offset + 8);
		const data = png.subarray(offset + 8, offset + 8 + length);
		const crc = png.readUInt32BE(offset + 8 + length);
		chunks.push({ type, data, crc });
		offset += 12 + length;
	}
	assert.deepEqual(chunks.map((chunk) => chunk.type), ['IHDR', 'IDAT', 'IEND']);
	assert.equal(offset, png.length, 'chunk 应恰好铺满整个文件');

	for (const chunk of chunks) {
		const body = Buffer.concat([Buffer.from(chunk.type, 'ascii'), chunk.data]);
		assert.equal(crc32(body), chunk.crc, `${chunk.type} 的 CRC 应为标准值`);
	}

	// IHDR 字段
	const ihdr = chunks[0].data;
	assert.equal(ihdr.readUInt32BE(0), width);
	assert.equal(ihdr.readUInt32BE(4), height);
	assert.equal(ihdr[8], 8, '位深应为 8');
	assert.equal(ihdr[9], 2, 'colour type 应为 2（truecolour）');
	assert.equal(ihdr[12], 0, '应为非隔行');

	// 解压后应是 "每条扫描线一个滤波字节 + RGB" 的自顶向下排布
	const raw = inflateSync(chunks[1].data);
	const stride = width * 3 + 1;
	assert.equal(raw.length, stride * height);
	for (let y = 0; y < height; y += 1) {
		assert.equal(raw[y * stride], 0, '每条扫描线都应用滤波 0（None）');
	}
	assert.deepEqual([...raw.subarray(1, 1 + width * 3)], [...rgb.subarray(0, width * 3)], '第一行像素应保持自顶向下顺序');
	assert.deepEqual(
		[...raw.subarray(stride + 1, stride + 1 + width * 3)],
		[...rgb.subarray(width * 3, width * 3 * 2)],
		'第二行像素不得被垂直翻转',
	);
});

test('encodePng 拒绝尺寸与缓冲区不匹配的输入', () => {
	assert.throws(() => encodePng(new Uint8Array(10), 3, 3, 6), /不符/u);
});

test('bgraToRgb 丢弃 alpha 并换出 RGB 通道顺序', () => {
	const bgra = Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]);
	assert.deepEqual([...bgraToRgb(bgra, 2, 1)], [3, 2, 1, 6, 5, 4]);
});

test('downscaleBgra 做面积平均而不是最近邻', () => {
	// 2x2 缩到 1x1：四个像素的均值
	const bgra = Uint8Array.from([
		0, 0, 0, 255,
		100, 0, 0, 255,
		0, 200, 0, 255,
		0, 0, 60, 255,
	]);
	const scaled = downscaleBgra(bgra, 2, 2, 1, 1);
	assert.equal(scaled.length, 4);
	assert.equal(scaled[0], 25); // B 均值
	assert.equal(scaled[1], 50); // G 均值
	assert.equal(scaled[2], 15); // R 均值
	assert.equal(scaled[3], 255);
});

test('downscaleBgra 在尺寸不变时原样返回', () => {
	const bgra = Uint8Array.from([1, 2, 3, 4]);
	assert.equal(downscaleBgra(bgra, 1, 1, 1, 1), bgra);
});

test('downscaleBgra 处理非整数缩放比且保持尺寸自洽', () => {
	// 5x3 → 3x2：宽高比都不是整数，验证权重归一化后不产生空像素
	const width = 5;
	const height = 3;
	const bgra = new Uint8Array(width * height * 4);
	for (let index = 0; index < width * height; index += 1) {
		bgra[index * 4] = 255;
		bgra[index * 4 + 3] = 255;
	}
	const scaled = downscaleBgra(bgra, width, height, 3, 2);
	assert.equal(scaled.length, 3 * 2 * 4);
	for (let index = 0; index < 3 * 2; index += 1) {
		assert.equal(scaled[index * 4], 255, '纯色区域缩放后应仍是纯色');
		assert.equal(scaled[index * 4 + 3], 255);
	}
});

test('fitWithin 只等比缩到上限内，并把极小值夹到 1', () => {
	assert.deepEqual(fitWithin(1600, 900, 0), { width: 1600, height: 900 }, '0 表示不缩放');
	assert.deepEqual(fitWithin(1600, 900, 800), { width: 800, height: 450 });
	assert.deepEqual(fitWithin(900, 1600, 800), { width: 450, height: 800 }, '以长边为准');
	assert.deepEqual(fitWithin(800, 600, 1000), { width: 800, height: 600 }, '本就在上限内时不动');
	assert.deepEqual(fitWithin(10000, 10, 100), { width: 100, height: 1 }, '极扁图片退化为 1 像素高');
});

/** 标准 CRC-32，独立于实现再算一遍。 */
function crc32(buffer) {
	let c = 0xffffffff;
	for (const byte of buffer) {
		c ^= byte;
		for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	return (c ^ 0xffffffff) >>> 0;
}
