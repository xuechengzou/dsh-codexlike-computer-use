/**
 * `capture-window.ts` 的单元测试：后台模式的 PrintWindow 截图与空白帧判定。
 *
 * 跑在假 Windows 上：假实现里 printWindowBgra 依赖的 PrintWindow 恒返回 1、
 * CreateSolidBrush/FillRect 是空实现，所以凡是需要断言「具体像素内容」的用例，
 * 都用 stub.functions 覆盖 GetDIBits 喂入可控像素（同时把 PrintWindow 也覆盖成
 * 返回 1，行为与真实系统一致）。
 *
 * 断言的期望值全部手算：颜色占比、不同颜色数都在注释里推了一遍，
 * 不允许用被测函数自己生成期望值。
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { stub } from 'koffi';
import { captureWindowBgra, isBlankCapture, DEFAULT_BLANK_THRESHOLDS } from '../lib/capture-window.js';
import { loadWin32 } from '../lib/win32.js';

const WINDOWS = process.platform === 'win32';

/** 每个用例重新加载的原生绑定；stub 复用同一棵窗口树。 */
let win32;

beforeEach(() => {
	stub.calls.length = 0;
	stub.functions.clear();
	stub.resetWindows();
});

if (WINDOWS) {
	win32 = await loadWin32();
}

/**
 * 让 stub 的 PrintWindow 把整幅位图填成指定的单一 BGRA 颜色。
 * GetDIBits 被调用时按 lines（高度）与 bits.length 反推行宽，逐像素填入。
 */
function stubPrintWindowSolid(b, g, r, a) {
	stub.functions.set('PrintWindow', () => 1);
	stub.functions.set('GetDIBits', (hdc, bitmap, start, lines, bits, info) => {
		if (!Buffer.isBuffer(bits)) return 0;
		const width = bits.length / (lines * 4);
		for (let y = 0; y < lines; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const offset = (y * width + x) * 4;
				bits[offset] = b;
				bits[offset + 1] = g;
				bits[offset + 2] = r;
				bits[offset + 3] = a;
			}
		}
		return lines;
	});
}

/** 构造一幅 BGRA 测试图：generator 收到像素序号，返回 [b, g, r, a]。 */
function makeBgra(pixelCount, generator) {
	const pixels = new Uint8Array(pixelCount * 4);
	for (let index = 0; index < pixelCount; index += 1) {
		const [b, g, r, a] = generator(index);
		pixels.set([b, g, r, a], index * 4);
	}
	return pixels;
}

/** 手工构造一个 TargetWindow（绕过 resolveTargetWindow，直接给 captureWindowBgra）。 */
function makeTarget(overrides = {}) {
	return {
		frameHandle: 0x6000n,
		surfaceHandle: 0x6000n,
		kind: 'gdi',
		title: '测试窗口',
		className: 'Notepad',
		processId: 8001,
		frame: { x: 100, y: 80, width: 208, height: 128 },
		client: { x: 106, y: 108, width: 200, height: 100 },
		dpi: 96,
		visible: true,
		minimized: false,
		...overrides,
	};
}

// ---- isBlankCapture：空白判据 ---------------------------------------------

test('isBlankCapture 纯黑图判为 blank', { skip: !WINDOWS }, () => {
	// 64 个像素全是 (0,0,0)：近黑比例 1.0 >= 0.999；颜色数 1 <= 4
	const pixels = makeBgra(64, () => [0, 0, 0, 0xff]);
	assert.equal(isBlankCapture(pixels), true);
});

test('isBlankCapture 纯白图判为 blank', { skip: !WINDOWS }, () => {
	// 64 个像素全是 (255,255,255)：近白比例 1.0 >= 0.999；颜色数 1 <= 4
	const pixels = makeBgra(64, () => [0xff, 0xff, 0xff, 0xff]);
	assert.equal(isBlankCapture(pixels), true);
});

test('isBlankCapture 非黑非白的单色图也判为 blank（颜色数判据）', { skip: !WINDOWS }, () => {
	// 纯品红 (255,0,255)：既不是近黑也不是近白，但颜色数只有 1 <= 4
	const pixels = makeBgra(64, () => [0xff, 0x00, 0xff, 0xff]);
	assert.equal(isBlankCapture(pixels), true);
});

test('isBlankCapture 只有 3 种颜色的图判为 blank', { skip: !WINDOWS }, () => {
	// 三种颜色循环：黑、白、品红。颜色数 3 <= 4；
	// 近黑比例 1/3、近白比例 1/3，都远低于 0.999，必须靠颜色数判据抓住
	const palette = [
		[0, 0, 0, 0xff],
		[0xff, 0xff, 0xff, 0xff],
		[0xff, 0, 0xff, 0xff],
	];
	const pixels = makeBgra(64, (index) => palette[index % 3]);
	assert.equal(isBlankCapture(pixels), true);
});

test('isBlankCapture 真实渐变内容判为非 blank', { skip: !WINDOWS }, () => {
	// B 通道随像素序号递升：64 个像素产生 64 种颜色（index & 0xff 各不相同），
	// 远超 maxDistinctColors=4；近黑/近白比例都几乎为 0
	const pixels = makeBgra(64, (index) => [index & 0xff, 0x40, 0x80, 0xff]);
	assert.equal(isBlankCapture(pixels), false);
});

test('isBlankCapture 黑底上有少量彩色内容时判为非 blank', { skip: !WINDOWS }, () => {
	// 64 个像素：第 0-3 个像素给 4 种不同的鲜艳颜色，其余 60 个全黑。
	// 颜色数 = 1（黑）+ 4 = 5 > 4 → 颜色数判据不命中；
	// 近黑比例 = 60/64 = 0.9375 < 0.999 → 近黑判据也不命中。
	// 这正是「少量内容落在黑底上」的场景，必须放行。
	const accents = [
		[0xff, 0, 0, 0xff],
		[0, 0xff, 0, 0xff],
		[0, 0, 0xff, 0xff],
		[0x80, 0x40, 0x20, 0xff],
	];
	const pixels = makeBgra(64, (index) => (index < 4 ? accents[index] : [0, 0, 0, 0xff]));
	assert.equal(isBlankCapture(pixels), false);
});

test('isBlankCapture 全透明 alpha 的图按 BGR 判定', { skip: !WINDOWS }, () => {
	// alpha 全 0、BGR 全 0：判据忽略 alpha，等价于纯黑图 → blank
	const transparentBlack = makeBgra(16, () => [0, 0, 0, 0]);
	assert.equal(isBlankCapture(transparentBlack), true);

	// alpha 全 0 但 BGR 是 64 色渐变：alpha 不参与判定，内容真实 → 非 blank
	const transparentColorful = makeBgra(64, (index) => [index & 0xff, 0x40, 0x80, 0]);
	assert.equal(isBlankCapture(transparentColorful), false);
});

test('isBlankCapture 极小尺寸：1x1 与 1x2', { skip: !WINDOWS }, () => {
	// 1x1 黑色：颜色数 1 <= 4 → blank
	assert.equal(isBlankCapture(new Uint8Array([0, 0, 0, 0xff])), true);
	// 1x1 白色：近白比例 1.0 → blank
	assert.equal(isBlankCapture(new Uint8Array([0xff, 0xff, 0xff, 0xff])), true);
	// 1x2 两个不同颜色：颜色数 2 <= 4 → 仍判 blank
	//（这么小的图无法与「只有底色」区分，宁可误报）
	assert.equal(isBlankCapture(new Uint8Array([0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff])), true);
});

test('isBlankCapture 空数组判为 blank', { skip: !WINDOWS }, () => {
	assert.equal(isBlankCapture(new Uint8Array(0)), true);
});

test('isBlankCapture 长度不是 4 的倍数时忽略末尾残片', { skip: !WINDOWS }, () => {
	// 16 个完整像素（64 字节，渐变非 blank）+ 3 字节残片：
	// 残片只当 0.75 个像素，必须被忽略而不是当成第 17 个像素
	const body = makeBgra(16, (index) => [index * 16, 0x40, 0x80, 0xff]);
	const pixels = new Uint8Array([...body, 0xff, 0xff, 0xff]);
	assert.equal(pixels.length, 67);
	assert.equal(isBlankCapture(pixels), false);
});

test('isBlankCapture 阈值可调：收紧颜色数上限后 3 色图放行', { skip: !WINDOWS }, () => {
	const palette = [
		[0, 0, 0, 0xff],
		[0xff, 0xff, 0xff, 0xff],
		[0xff, 0, 0xff, 0xff],
	];
	const pixels = makeBgra(64, (index) => palette[index % 3]);
	// 默认阈值：颜色数 3 <= 4 → blank
	assert.equal(isBlankCapture(pixels, DEFAULT_BLANK_THRESHOLDS), true);
	// 把颜色数上限收紧到 2：颜色数 3 > 2，近黑/近白比例各 1/3 < 0.999 → 非 blank
	assert.equal(
		isBlankCapture(pixels, { nearBlackRatio: 0.999, nearWhiteRatio: 0.999, maxDistinctColors: 2 }),
		false,
	);
});

// ---- captureWindowBgra ----------------------------------------------------

test('GDI 窗口：用 surfaceHandle（== frameHandle）抓客户区尺寸的像素', { skip: !WINDOWS }, () => {
	// 喂入渐变：B = x & 0xff、G = y & 0xff、R = 0x55，每行 200 像素 → B 在每行内
	// 取遍 0-199 共 200 种值，颜色数远超 4，判为真实内容。
	// 手算抽查：像素 (3,1) 的偏移 = (1*200 + 3)*4 = 812，
	// BGRA = [0x03, 0x01, 0x55, 0xff]。
	stub.functions.set('PrintWindow', () => 1);
	stub.functions.set('GetDIBits', (hdc, bitmap, start, lines, bits, info) => {
		if (!Buffer.isBuffer(bits)) return 0;
		const width = bits.length / (lines * 4);
		for (let y = 0; y < lines; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const offset = (y * width + x) * 4;
				bits[offset] = x & 0xff;
				bits[offset + 1] = y & 0xff;
				bits[offset + 2] = 0x55;
				bits[offset + 3] = 0xff;
			}
		}
		return lines;
	});

	const target = makeTarget();
	assert.equal(target.surfaceHandle, target.frameHandle, 'GDI 窗口的 surface 就是顶层句柄');

	const capture = captureWindowBgra(win32, target);
	assert.equal(capture.width, 200);
	assert.equal(capture.height, 100);
	assert.equal(capture.pixels.length, 200 * 100 * 4);
	assert.equal(capture.blank, false, '渐变内容不应判为空白');

	// 手算抽查像素 (3,1)：B = 3，G = 1，R = 0x55，A = 0xff
	assert.equal(capture.pixels[812], 0x03);
	assert.equal(capture.pixels[813], 0x01);
	assert.equal(capture.pixels[814], 0x55);
	assert.equal(capture.pixels[815], 0xff);

	// 断言用的确实是 surfaceHandle：stub.calls 里记下的 PrintWindow 第一个参数
	const printCalls = stub.calls.filter((call) => call.name === 'PrintWindow');
	assert.equal(printCalls.length, 1);
	assert.equal(printCalls[0].args[0], 0x6000n, 'GDI 窗口必须抓 surfaceHandle（此处即顶层句柄）');
});

test('Chromium 窗口：抓的是渲染子窗口 surfaceHandle 而不是顶层句柄', { skip: !WINDOWS }, () => {
	stubPrintWindowSolid(0x12, 0x34, 0x56, 0xff); // 单色 → 判 blank，正好顺带验证 blank 通路

	const target = makeTarget({
		frameHandle: 0x4000n,
		surfaceHandle: 0x4100n,
		kind: 'chromium',
		className: 'Chrome_WidgetWin_1',
		title: 'Chrome',
	});

	const capture = captureWindowBgra(win32, target);
	assert.equal(capture.width, 200);
	assert.equal(capture.height, 100);
	assert.equal(capture.pixels.length, 200 * 100 * 4);
	// 单色图：颜色数 1 <= 4 → blank
	assert.equal(capture.blank, true);
	// 每个像素都是喂入的颜色；抽查第一个与最后一个像素
	assert.deepEqual([...capture.pixels.slice(0, 4)], [0x12, 0x34, 0x56, 0xff]);
	assert.deepEqual([...capture.pixels.slice(-4)], [0x12, 0x34, 0x56, 0xff]);

	const printCalls = stub.calls.filter((call) => call.name === 'PrintWindow');
	assert.equal(printCalls.length, 1);
	assert.equal(printCalls[0].args[0], 0x4100n, 'Chromium 必须抓渲染子窗口，不是顶层句柄');
});

test('PrintWindow 返回 0 时仍返回像素并照常判定 blank', { skip: !WINDOWS }, () => {
	// PrintWindow 返回 0（失败），GetDIBits 拿到的是白底预填后的纯白图。
	// 本模块不看 ok，只看像素：纯白 → blank:true。
	stub.functions.set('PrintWindow', () => 0);
	stub.functions.set('GetDIBits', (hdc, bitmap, start, lines, bits, info) => {
		if (!Buffer.isBuffer(bits)) return 0;
		bits.fill(0xff); // 模拟「白底预填、什么都没画」
		return lines;
	});

	const capture = captureWindowBgra(win32, makeTarget());
	assert.equal(capture.blank, true, 'PrintWindow 失败的纯白帧必须判 blank，不能看返回值');
	assert.equal(capture.pixels.length, 200 * 100 * 4);
});

test('最小化的窗口直接抛错，不发起截图', { skip: !WINDOWS }, () => {
	const target = makeTarget({ minimized: true });
	assert.throws(
		() => captureWindowBgra(win32, target),
		/最小化.*空白帧.*还原窗口/su,
	);
	// 必须一个 PrintWindow 调用都没有：最小化时拍是必然空白，不该硬拍
	const printCalls = stub.calls.filter((call) => call.name === 'PrintWindow');
	assert.equal(printCalls.length, 0, '最小化时不应调用 PrintWindow');
});

test('客户区尺寸无效时抛错', { skip: !WINDOWS }, () => {
	const target = makeTarget({ client: { x: 106, y: 108, width: 0, height: 100 } });
	assert.throws(
		() => captureWindowBgra(win32, target),
		/客户区尺寸无效/u,
	);
});
