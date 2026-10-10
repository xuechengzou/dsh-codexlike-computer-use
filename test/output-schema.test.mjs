/**
 * 输出契约测试：让每个动作的返回值都过一遍**宿主真实编译出来的** output schema。
 *
 * 存在的理由（来自一次真实缺陷）：宿主要在工具返回后校验输出值，而单元测试里的
 * `defineTool` 替身只把定义原样透传，既不编译 schema 也不校验值。于是
 * `target.rect` 的 schema 写成了 `{x,y,width,height}`、代码却返回 Win32 的
 * `{left,top,right,bottom}`，`image`/`region`/`desktop` 又被误标为必填——两个
 * 错误都让 tsc 无话可说（schema 是普通对象字面量，与 TS 类型没有关联），
 * 直到第一次真实调用才被宿主以 "missing required property" 挡下来。
 *
 * 这里把替身委派给宿主真实的 `defineTool` 取到编译结果，再用宿主真实的
 * `validateJsonSchemaValue` 逐动作校验，并顺带跑一遍 `render()`。
 *
 * 找不到宿主包（或非 Windows）时整体跳过——它验证的是与宿主的契约，
 * 没有宿主就无从谈起。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const hostRoot = process.env.DSH_HOST_NODE_MODULES ?? join(homedir(), '.dsh', 'profiles', 'node_modules');
const toolsEntry = join(hostRoot, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
const schemaEntry = join(hostRoot, '@deepseek-ai', 'schemastery', 'lib', 'index.mjs');
const AVAILABLE = process.platform === 'win32' && existsSync(toolsEntry) && existsSync(schemaEntry);

// 必须在动态导入 lib 之前设置：替身在模块求值期读取这些变量。
// 只委派 defineTool 与 schemastery；koffi 仍是测试替身，所以不会碰真实桌面。
if (AVAILABLE) {
	process.env.DSH_COMPUTER_USE_REAL_HOST_TOOLS = toolsEntry;
	process.env.DSH_COMPUTER_USE_REAL_HOST_SCHEMASTERY = schemaEntry;
}

const { registerComputerTool } = AVAILABLE ? await import('../lib/tool.js') : {};
const { Config } = AVAILABLE ? await import('../lib/config.js') : {};
const { validateJsonSchemaValue } = AVAILABLE ? await import(pathToFileURL(toolsEntry).href) : {};
const { stub } = AVAILABLE ? await import('koffi') : {};

/** 声明支持图像输入的假路由。 */
const imageCapable = { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) };
const agent = { id: 's1', session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'vision' } }) } };

/** 从 PNG 的 IHDR 读出尺寸，让假附件服务如实回报。 */
function pngSize(data) {
	assert.equal(data.readUInt32BE(0), 0x89504e47);
	return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** 记录并如实回报尺寸的假附件服务。 */
function makeAttachments() {
	let calls = 0;
	return {
		imageLimits: {
			maxImageBytes: 8 * 1024 * 1024,
			maxImagesPerMessage: 20,
			maxMessageImageBytes: 32 * 1024 * 1024,
			maxImagePixels: 40_000_000,
			maxImageDimension: 8192,
			mediaTypes: ['image/png'],
		},
		async saveImage(input) {
			calls += 1;
			const { width, height } = pngSize(input.data);
			return { attachmentId: `att-${calls}`, mediaType: input.mediaType, bytes: input.data.length, width, height, name: input.name };
		},
	};
}

/** 注册工具、取出定义（此时真实 defineTool 已经编译过 schema）。 */
function makeTool() {
	const registered = [];
	const services = { attachments: makeAttachments(), llm: imageCapable };
	const ctx = {
		tools: { register: (definition) => { registered.push(definition); return () => {}; } },
		systemPrompt: { section: () => () => {} },
		logger: { warn: () => {} },
		get: (serviceName) => services[serviceName],
	};
	// allowForegroundInput: 前台模式默认关闭，而本文件的用例专测前台路径的输出形状，
	// 必须显式开启才能走到输入层；断言本身不因此放宽
	registerComputerTool(ctx, Config({ maxDimension: 0, allowForegroundInput: true }));
	assert.equal(registered.length, 1);
	return registered[0];
}

const exec = () => ({ callId: 'c1', signal: new AbortController().signal, agent });

/** 每个动作一组代表性的参数；覆盖必填与可选坐标两条路径。 */
const CASES = [
	['screenshot', { action: 'screenshot' }],
	['screenshot + region', { action: 'screenshot', region: { x: 0, y: 0, width: 40, height: 30 } }],
	['cursor_position', { action: 'cursor_position' }],
	['mouse_move', { action: 'mouse_move', x: 5, y: 6 }],
	['left_click（带坐标）', { action: 'left_click', x: 5, y: 6 }],
	['left_click（原地）', { action: 'left_click' }],
	['right_click', { action: 'right_click', x: 1, y: 2 }],
	['middle_click', { action: 'middle_click', x: 1, y: 2 }],
	['double_click', { action: 'double_click', x: 1, y: 2 }],
	['triple_click', { action: 'triple_click', x: 1, y: 2 }],
	['left_click_drag（x/y）', { action: 'left_click_drag', start_x: 0, start_y: 0, x: 9, y: 9 }],
	['left_click_drag（end_x/end_y）', { action: 'left_click_drag', start_x: 0, start_y: 0, end_x: 4, end_y: 4 }],
	['scroll 垂直', { action: 'scroll', scroll_direction: 'down', scroll_amount: 2 }],
	['scroll 水平带坐标', { action: 'scroll', scroll_direction: 'left', scroll_amount: 1, x: 3, y: 3 }],
	['type', { action: 'type', text: 'hi\n' }],
	['key', { action: 'key', keys: 'ctrl+shift+s' }],
	['hold_key', { action: 'hold_key', keys: 'shift', duration_ms: 1 }],
	['wait', { action: 'wait', duration_ms: 1 }],
];

test('输出 schema 能编译，且只有 action/summary 是必填', { skip: !AVAILABLE }, () => {
	const tool = makeTool();
	const schema = tool.output.schema;
	assert.equal(schema.type, 'object');
	assert.deepEqual(schema.required, ['action', 'summary'], '其余字段都必须是可选的，否则非截图动作全会校验失败');
	assert.equal(schema.additionalProperties, false);
	for (const optional of ['image', 'region', 'desktop', 'scale', 'elapsedMs', 'downscaleRetries', 'cursor', 'target']) {
		assert.ok(optional in schema.properties, `schema 应声明 ${optional}`);
	}
});

test('每个动作的返回值都通过宿主真实的输出校验', { skip: !AVAILABLE }, async (t) => {
	const tool = makeTool();
	const schema = tool.output.schema;

	for (const [label, args] of CASES) {
		await t.test(label, async () => {
			stub.calls.length = 0;
			const value = await tool.execute(args, exec());

			const violations = validateJsonSchemaValue(schema, value);
			assert.deepEqual(violations, [], `${label} 的输出值不符合契约：${violations.join('; ')}`);

			// 输出值必须是可无损序列化的纯 JSON（要进会话日志）
			assert.equal(typeof value.action, 'string');
			assert.equal(typeof value.summary, 'string');
			assert.doesNotThrow(() => JSON.parse(JSON.stringify(value)));

			// render 必须能在该值上跑出内容块
			const blocks = tool.output.render(args, value);
			assert.ok(Array.isArray(blocks) && blocks.length > 0, 'render 应产出至少一个内容块');
			assert.equal(blocks[0].type, 'text');
		});
	}
});

test('target.rect 用 x/y/width/height 而不是 Win32 的左右上下', { skip: !AVAILABLE }, async () => {
	const tool = makeTool();
	const value = await tool.execute({ action: 'cursor_position' }, exec());
	assert.deepEqual(Object.keys(value.target.rect).sort(), ['height', 'width', 'x', 'y']);
	// 假 Windows 的窗口矩形是整屏 1600x900
	assert.deepEqual(value.target.rect, { x: 0, y: 0, width: 1600, height: 900 });
	assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), []);
});

test('只有 screenshot 渲染出图像块，其余动作只有文本', { skip: !AVAILABLE }, async () => {
	const tool = makeTool();

	const shot = await tool.execute({ action: 'screenshot' }, exec());
	const shotBlocks = tool.output.render({ action: 'screenshot' }, shot);
	assert.equal(shotBlocks.length, 2);
	assert.equal(shotBlocks[1].type, 'image');
	assert.equal(shotBlocks[1].attachment.attachmentId, shot.image.attachmentId);
	assert.deepEqual(validateJsonSchemaValue(tool.output.schema, shot), []);

	const cursor = await tool.execute({ action: 'cursor_position' }, exec());
	const cursorBlocks = tool.output.render({ action: 'cursor_position' }, cursor);
	assert.equal(cursorBlocks.length, 1);
	assert.equal(cursorBlocks[0].type, 'text');
	assert.equal(cursor.image, undefined, '非截图动作不得带 image 字段');
	assert.deepEqual(validateJsonSchemaValue(tool.output.schema, cursor), []);
});
