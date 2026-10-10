/**
 * 截图输出契约测试：降采样阶梯与文本外壳。
 *
 * 这两处都不涉及原生调用，却是模型侧最容易出错的地方：阶梯决定了超限时
 * 能否自愈，外壳决定了模型能不能把图上的坐标正确换回屏幕坐标。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downscaleLadder, formatScreenshot, imageRefFromValue } from '../lib/image.js';

test('配置为具体上限时，阶梯按配置值逐级减半', () => {
	assert.deepEqual(downscaleLadder(800, 8192), [800, 400, 200]);
});

test('配置值超过部署边长上限时先被夹到上限', () => {
	assert.deepEqual(downscaleLadder(4000, 1568), [1568, 2000, 1000]);
});

test('配置为 0（原生尺寸）时先受部署上限约束，再退回原生与常用尺寸', () => {
	assert.deepEqual(downscaleLadder(0, 2048), [2048, 0, 1568]);
	assert.deepEqual(downscaleLadder(0, undefined), [0, 1568]);
});

test('阶梯内不出现重复值，避免无意义地重抓同一尺寸', () => {
	assert.deepEqual(downscaleLadder(200, 8192), [200, 100, 50]);
	assert.deepEqual(downscaleLadder(4, 8192), [4, 2, 1]);
});

test('imageRefFromValue 还原成 ImageBlock 需要的引用，且不带上空字段', () => {
	const ref = imageRefFromValue({ attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 100, height: 50 });
	assert.deepEqual(Object.keys(ref).sort(), ['attachmentId', 'bytes', 'height', 'mediaType', 'width']);

	const withMeta = imageRefFromValue({
		attachmentId: 'a2',
		mediaType: 'image/png',
		bytes: 10,
		width: 100,
		height: 50,
		name: 'screen.png',
		originalDimensions: { width: 200, height: 100 },
	});
	assert.equal(withMeta.name, 'screen.png');
	assert.deepEqual(withMeta.originalDimensions, { width: 200, height: 100 });
	assert.notEqual(withMeta.originalDimensions, undefined);
});

const value = (overrides = {}) => ({
	image: { attachmentId: 'a1', mediaType: 'image/png', bytes: 1234, width: 1600, height: 900 },
	region: { x: 0, y: 0, width: 1600, height: 900 },
	desktop: { x: 0, y: 0, width: 1600, height: 900, monitors: 1 },
	scale: 1,
	cursor: { x: 100, y: 200 },
	elapsedMs: 42,
	downscaleRetries: 0,
	...overrides,
});

test('1:1 截图的外壳直接声明图坐标即屏幕坐标', () => {
	const text = formatScreenshot(value());
	assert.match(text, /Image pixels equal screen pixels/u);
	assert.match(text, /pass image coordinates directly to mouse actions/u);
	assert.match(text, /cursor="100,200"/u);
	assert.doesNotMatch(text, /scaled by/u);
});

test('缩放过的截图给出确定的换算公式', () => {
	const text = formatScreenshot(value({
		scale: 0.5,
		region: { x: 100, y: 50, width: 800, height: 400 },
		image: { attachmentId: 'a1', mediaType: 'image/png', bytes: 1234, width: 400, height: 200 },
	}));
	assert.match(text, /screen_x = 100 \+ image_x \/ 0\.50000/u);
	assert.match(text, /screen_y = 50 \+ image_y \/ 0\.50000/u);
});

test('为满足部署限制而重抓时在外壳中说明', () => {
	const text = formatScreenshot(value({ downscaleRetries: 2 }));
	assert.match(text, /re-captured 2 time\(s\) smaller/u);
});

test('外壳回报区域、桌面与显示器数量，便于模型判断坐标空间', () => {
	const text = formatScreenshot(value({
		region: { x: -1920, y: 0, width: 1920, height: 1080 },
		desktop: { x: -1920, y: 0, width: 3520, height: 1080, monitors: 2 },
	}));
	assert.match(text, /region="-1920,0 1920x1080"/u);
	assert.match(text, /desktop="-1920,0 3520x1080"/u);
	assert.match(text, /monitors="2"/u);
});
