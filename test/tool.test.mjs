/**
 * `computer` 工具的完整执行路径测试。
 *
 * 原生层被替换成假 Windows（test/doubles/koffi/index.js，经 node_modules/koffi 联接解析），因此这里
 * 验证的是插件自己的逻辑：动作分派、参数校验、**注入的事件序列**、
 * 输出值与 `render` 的形状。事件序列是重点——分批、扫描码、扩展键标志、
 * 修饰键顺序任何一处错了，目标程序都不会报错，只会收到错误的输入。
 *
 * 跳到非 Windows 平台时整体跳过：插件本身也只实现了 Windows 后端。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { stub } from 'koffi';
import { Config } from '../lib/config.js';
import { registerComputerTool } from '../lib/tool.js';

const WINDOWS = process.platform === 'win32';

/**
 * 宿主包的真实入口。
 *
 * 本文件的 `defineTool` 是只透传定义的替身，因此输出值不会被任何 schema 校验——
 * 而 `additionalProperties: false` 下多返回一个字段，宿主会拒绝整次调用
 * （这个坑本项目踩过一次）。为了不把"新字段忘了写进 schema"留给运行时，
 * 这里在宿主可用时显式调用它**真实的**编译器与校验器过一遍。
 */
const HOST_TOOLS = join(
	process.env.DSH_HOST_NODE_MODULES ?? join(homedir(), '.dsh', 'profiles', 'node_modules'),
	'@deepseek-ai',
	'dsh-tools',
	'lib',
	'index.js',
);
const HOST_AVAILABLE = WINDOWS && existsSync(HOST_TOOLS);
const hostSchema = HOST_AVAILABLE ? await import(pathToFileURL(HOST_TOOLS).href) : {};

/** 用插件自己的 schema 解析配置，顺带覆盖默认值这条路径。 */
const configWith = (overrides = {}) => Config(overrides);

/** 构造一个只提供本插件所需面的假 ctx。 */
function makeContext({ attachments, llm } = {}) {
	const services = { attachments, llm };
	const registered = [];
	const sections = [];
	const ctx = {
		tools: { register: (definition) => { registered.push(definition); return () => {}; } },
		systemPrompt: { section: (section) => { sections.push(section); return () => {}; } },
		computerUse: { register: () => async () => {} },
		logger: { warn: () => {} },
		get: (name) => services[name],
	};
	return { ctx, registered, sections };
}

/** 一个声明支持图像输入的路由。 */
const imageCapable = {
	resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
};

/** 一个只支持文本的路由。 */
const textOnly = {
	resolveModelInfo: async () => ({ inputModalities: ['text'] }),
};

const agent = { id: 'session-1', session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'vision-model' } }) } };

/** 从 PNG 的 IHDR 里读出真实尺寸，让假附件服务如实回报尺寸。 */
function pngSize(data) {
	assert.equal(data.readUInt32BE(0), 0x89504e47, '应是 PNG');
	return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** 构造一个记录调用并如实回报尺寸的假附件服务。 */
function makeAttachments({ failFirst = false } = {}) {
	const saved = [];
	let calls = 0;
	return {
		saved,
		get saveCalls() {
			return calls;
		},
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
			if (failFirst && calls === 1) {
				const error = new Error('图片过大');
				error.code = 'IMAGE_TOO_LARGE';
				throw error;
			}
			const { width, height } = pngSize(input.data);
			saved.push({ ...input, width, height });
			return { attachmentId: `att-${calls}`, mediaType: input.mediaType, bytes: input.data.length, width, height, name: input.name };
		},
	};
}

/** 注册工具并取出定义。 */
function toolFor(configOverrides = {}, services = {}) {
	const { ctx, registered, sections } = makeContext({ llm: imageCapable, ...services });
	registerComputerTool(ctx, configWith(configOverrides));
	assert.equal(registered.length, 1, '应注册恰好一个工具');
	return { tool: registered[0], sections, ctx };
}

const exec = (overrides = {}) => ({ callId: 'call-1', signal: new AbortController().signal, agent, ...overrides });

/** 取出所有 SendInput 批次的事件数组。 */
const sendInputBatches = () => stub.calls.filter((call) => call.name === 'SendInput').map((call) => call.args[1]);

/**
 * 去掉批次开头的"牺牲"按键对（Shift 按下/抬起）。
 *
 * 每次键盘注入都会先送这一对，用于吸收焦点切换后的首次输入丢弃；
 * 断言真实内容时需要把它剥掉，否则下标会被整体平移。
 */
const withoutWarmup = (batch) => {
	assert.deepEqual(
		batch.slice(0, 2).map((event) => event.u.ki.wVk),
		[0x10, 0x10],
		'批次开头应是一对 VK_SHIFT 牺牲按键',
	);
	return batch.slice(2);
};

/** 取出某个原生 API 的全部调用参数。 */
const callsTo = (name) => stub.calls.filter((call) => call.name === name).map((call) => call.args);

beforeEach(() => {
	stub.calls.length = 0;
	stub.functions.clear();
	stub.foreground = 0x2000n;
	stub.windowTitle = 'Notepad';
	stub.windowClass = 'Notepad';
	stub.screen = { x: 0, y: 0, width: 1600, height: 900, monitors: 1 };
	stub.inputStructSize = 40;
	// 窗口树也要清干净：本文件里定义过窗口的用例会把它们留给后续用例，
	// 而 resetWindows 会补回一个与旧断言兼容的整屏前台窗口。
	stub.resetWindows();
});

test('快捷键与光标位置动作在非 Windows 上不可用时应给出明确诊断', { skip: WINDOWS }, async () => {
	const { tool } = toolFor();
	await assert.rejects(() => tool.execute({ action: 'cursor_position' }, exec()), /只实现了 Windows 后端/u);
});

test('cursor_position 回报当前光标与前台窗口', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor();
	const value = await tool.execute({ action: 'cursor_position' }, exec());
	assert.equal(value.action, 'cursor_position');
	assert.deepEqual(value.cursor, { x: 100, y: 200 });
	assert.equal(value.target.title, 'Notepad');
	assert.match(value.summary, /100, 200/u);
});

test('screenshot 捕获、缩放、持久化，并渲染成文本 + 图像两个块', { skip: !WINDOWS }, async () => {
	const attachments = makeAttachments();
	const { tool } = toolFor({ maxDimension: 800 }, { attachments });

	const value = await tool.execute({ action: 'screenshot' }, exec());

	// 1600x900 缩到长边 800 → 800x450
	assert.equal(value.region.width, 1600);
	assert.equal(value.desktop.width, 1600);
	assert.equal(value.image.width, 800);
	assert.equal(value.image.height, 450);
	assert.equal(value.scale, 800 / 1600);
	assert.equal(value.image.attachmentId, 'att-1');
	assert.equal(attachments.saveCalls, 1);

	const blocks = tool.output.render({ action: 'screenshot' }, value);
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].type, 'text');
	assert.equal(blocks[1].type, 'image');
	assert.equal(blocks[1].attachment.attachmentId, 'att-1');
	// 缩放时必须写清换算关系，否则模型会把图上的坐标当成屏幕坐标
	assert.match(blocks[0].text, /screen_x = 0 \+ image_x \/ 0\.50000/u);
});

test('screenshot 在 1:1 时明确告知坐标可直接使用', { skip: !WINDOWS }, async () => {
	const attachments = makeAttachments();
	const { tool } = toolFor({ maxDimension: 0 }, { attachments });

	const value = await tool.execute({ action: 'screenshot' }, exec());
	assert.equal(value.scale, 1);
	const blocks = tool.output.render({}, value);
	assert.match(blocks[0].text, /Image pixels equal screen pixels/u);
});

test('screenshot 的 region 会被裁剪到桌面内并作为抓取起点传给 BitBlt', { skip: !WINDOWS }, async () => {
	const attachments = makeAttachments();
	const { tool } = toolFor({ maxDimension: 0 }, { attachments });

	const value = await tool.execute({ action: 'screenshot', region: { x: 100, y: 50, width: 400, height: 300 } }, exec());

	// BitBlt(hdc, x, y, cx, cy, hdcSrc, x1, y1, rop)：抓取尺寸取参数 3/4，源坐标取参数 6/7
	const bitBlt = callsTo('BitBlt')[0];
	assert.equal(bitBlt[3], 400, '抓取宽度');
	assert.equal(bitBlt[4], 300, '抓取高度');
	assert.equal(bitBlt[6], 100, '源 X');
	assert.equal(bitBlt[7], 50, '源 Y');
	assert.deepEqual(value.region, { x: 100, y: 50, width: 400, height: 300 });
});

test('screenshot 在超出限时逐级重抓并如实回报重试次数', { skip: !WINDOWS }, async () => {
	const attachments = makeAttachments({ failFirst: true });
	const { tool } = toolFor({ maxDimension: 800 }, { attachments });

	const value = await tool.execute({ action: 'screenshot' }, exec());

	assert.equal(value.downscaleRetries, 1, '第二次尝试才成功');
	assert.equal(attachments.saveCalls, 2);
	assert.equal(value.image.width, 400, '第二级阶梯是配置值的一半');
});

test('screenshot 需要支持图像输入的模型', { skip: !WINDOWS }, async () => {
	const attachments = makeAttachments();
	const { ctx, registered } = makeContext({ attachments, llm: textOnly });
	registerComputerTool(ctx, configWith());
	await assert.rejects(
		() => registered[0].execute({ action: 'screenshot' }, exec()),
		/没有声明 image 输入能力/u,
	);
});

test('screenshot 在缺少附件服务时拒绝而不是静默降级', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor();
	await assert.rejects(() => tool.execute({ action: 'screenshot' }, exec()), /没有挂载/u);
});

test('left_click 先移动光标再下发按下/抬起，且前置 GetForegroundWindow 稳定检测', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true });
	await tool.execute({ action: 'left_click', x: 300, y: 400 }, exec());

	assert.deepEqual(callsTo('SetCursorPos')[0], [300, 400]);
	const batches = sendInputBatches();
	assert.equal(batches.length, 1, '一次成对下发按下与抬起');
	assert.deepEqual(batches[0].map((event) => event.u.mi.dwFlags), [0x0002, 0x0004]);
});

test('double_click 下发两组点击', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true });
	await tool.execute({ action: 'double_click', x: 10, y: 20 }, exec());
	assert.equal(sendInputBatches().length, 2);
});

test('left_click 省略坐标时在原地点击，不移动光标', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true });
	await tool.execute({ action: 'left_click' }, exec());
	assert.equal(callsTo('SetCursorPos').length, 0);
	assert.equal(sendInputBatches().length, 1);
});

test('left_click_drag 补插中间移动步并按下/抬起左键', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true, dragSteps: 4 });
	await tool.execute({ action: 'left_click_drag', start_x: 0, start_y: 0, x: 100, y: 100 }, exec());

	const positions = callsTo('SetCursorPos').map((args) => args.join(','));
	assert.equal(positions[0], '0,0', '先到起点');
	assert.equal(positions.at(-1), '100,100', '最后到终点');
	// dragSteps 是插值步数（最后一步即终点），因此调用数是 1 + dragSteps
	assert.equal(positions.length, 5);
	assert.deepEqual(positions, ['0,0', '25,25', '50,50', '75,75', '100,100'], '中间步应均匀分布，避免目标程序判定为瞬移');
	const batches = sendInputBatches();
	assert.equal(batches[0][0].u.mi.dwFlags, 0x0002, '先按下左键');
	assert.equal(batches.at(-1)[0].u.mi.dwFlags, 0x0004, '最后抬起左键');
});

test('scroll 向下 3 格下发负的滚轮增量', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true });
	await tool.execute({ action: 'scroll', scroll_direction: 'down', scroll_amount: 3 }, exec());
	const event = sendInputBatches()[0][0];
	assert.equal(event.u.mi.dwFlags, 0x0800);
	assert.equal(event.u.mi.mouseData, (-3 * 120) >>> 0);
});

test('scroll 向右走水平滚轮', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true });
	await tool.execute({ action: 'scroll', scroll_direction: 'right', scroll_amount: 1 }, exec());
	assert.equal(sendInputBatches()[0][0].u.mi.dwFlags, 0x1000);
});

test('scroll 缺少方向时报错', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true });
	await assert.rejects(() => tool.execute({ action: 'scroll' }, exec()), /需要 scroll_direction/u);
});

test('type 走 Unicode 注入，换行走虚拟键 Return 并带上扫描码', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true, typingChunkSize: 32 });
	await tool.execute({ action: 'type', text: 'Hi\n' }, exec());

	// H、i 各一对，再加 Return 一对
	const batch = withoutWarmup(sendInputBatches()[0]);
	assert.equal(batch.length, 6);

	const [hDown, hUp, iDown, iUp, returnDown, returnUp] = batch;
	assert.equal(hDown.u.ki.wScan, 'H'.charCodeAt(0));
	assert.equal(hDown.u.ki.wVk, 0);
	assert.equal(hDown.u.ki.dwFlags, 0x0004, '应使用 KEYEVENTF_UNICODE');
	assert.equal(hUp.u.ki.dwFlags, 0x0004 | 0x0002, '抬起应叠加 KEYEVENTF_KEYUP');
	assert.equal(iDown.u.ki.wScan, 'i'.charCodeAt(0));

	assert.equal(returnDown.u.ki.wVk, 0x0d, '换行必须走虚拟键，否则多数控件不响应');
	assert.equal(returnDown.u.ki.dwFlags, 0, '虚拟键路径不应带 UNICODE 标志');
	assert.equal(returnDown.u.ki.wScan, 0x0d, '应带上扫描码');
	assert.equal(returnUp.u.ki.dwFlags, 0x0002);
});

test('牺牲按键对被放在首批最前面，与真实内容同批投递', { skip: !WINDOWS }, async () => {
	// 批次上限取得比总事件数大，确保牺牲对与全部内容落在同一批
	const { tool } = toolFor({ allowForegroundInput: true, typingChunkSize: 16 });
	await tool.execute({ action: 'type', text: 'ab' }, exec());

	const first = sendInputBatches()[0];
	assert.deepEqual(
		first.slice(0, 2).map((event) => ({ vk: event.u.ki.wVk, flags: event.u.ki.dwFlags })),
		[{ vk: 0x10, flags: 0 }, { vk: 0x10, flags: 0x0002 }],
		'首批前两个事件应是 Shift 按下/抬起',
	);
	// 与真实内容同批：系统丢弃开头事件时被吃掉的才是牺牲对，而不是真实字符
	assert.equal(first.length, 6, '牺牲对 2 个 + 两个字符各 1 对');
	assert.equal(first[2].u.ki.wScan, 'a'.charCodeAt(0));
});

test('warmupInjection 关闭后不再插入牺牲按键对', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true, warmupInjection: false, typingChunkSize: 4 });
	await tool.execute({ action: 'type', text: 'ab' }, exec());

	const first = sendInputBatches()[0];
	assert.equal(first.length, 4, '关掉暖机后只应有真实内容的 4 个事件');
	assert.equal(first[0].u.ki.wScan, 'a'.charCodeAt(0));

	stub.calls.length = 0;
	await tool.execute({ action: 'key', keys: 'Escape' }, exec());
	const keyBatch = sendInputBatches()[0];
	assert.deepEqual(keyBatch.map((event) => event.u.ki.wVk), [0x1b, 0x1b], '组合键路径同样不再插入');
});

test('type 发送多字节字符（中文与 emoji）按 UTF-16 码元逐个注入', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true, typingChunkSize: 64 });
	await tool.execute({ action: 'type', text: '中' }, exec());
	const batch = withoutWarmup(sendInputBatches()[0]);
	assert.equal(batch[0].u.ki.wScan, 0x4e2d, '中文按码元注入');

	stub.calls.length = 0;
	// 🚀 = U+1F680，需要代理对
	await tool.execute({ action: 'type', text: '🚀' }, exec());
	const surrogate = withoutWarmup(sendInputBatches()[0]);
	assert.equal(surrogate.length, 4, '代理对拆成两个码元、各一对事件');
	assert.equal(surrogate[0].u.ki.wScan, 0xd83d);
	assert.equal(surrogate[2].u.ki.wScan, 0xde80);
});

test('type 按 chunkSize 分批，批次间留出让出时间', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true, typingChunkSize: 8, typingChunkDelayMs: 1 });
	await tool.execute({ action: 'type', text: 'abcdefghij' }, exec());

	const batches = sendInputBatches();
	assert.equal(batches.length, 3, '10 个字符 = 20 个事件 + 2 个牺牲事件，按 8/8/6 分三批');
	assert.deepEqual(batches.map((batch) => batch.length), [8, 8, 6]);
});

test('type 归一化 CRLF 与单独 CR，避免产生双换行', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true, typingChunkSize: 64 });
	await tool.execute({ action: 'type', text: 'a\r\nb\rc' }, exec());
	const returns = sendInputBatches()[0].filter((event) => event.u.ki.wVk === 0x0d);
	assert.equal(returns.length / 2, 2, '两个换行 → 两对 Return 事件');
});

test('type 超过配置上限时拒绝', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true, maxTextLength: 4 });
	await assert.rejects(() => tool.execute({ action: 'type', text: 'abcde' }, exec()), /最多注入 4 个字符/u);
});

test('type 在注入前等待焦点控件就绪，而不是固定 sleep', { skip: !WINDOWS }, async () => {
	// 模拟点击后的两步落定：顶层窗口先成为前台，焦点控件随后才出现
	let focusReads = 0;
	stub.functions.set('GetGUIThreadInfo', (threadId, info) => {
		focusReads += 1;
		info.writeUInt32LE(72, 0);
		// 前两次读数里焦点控件尚未落定（0），之后稳定
		info.writeBigUInt64LE(focusReads < 3 ? 0n : 0x2100n, 16);
		return 1;
	});

	const { tool } = toolFor({ allowForegroundInput: true, settleMs: 2000 });
	await tool.execute({ action: 'type', text: 'ok' }, exec());

	assert.ok(focusReads >= 3, `应等到焦点控件有稳定读数（实际读取 ${focusReads} 次）`);
});

test('等待超时后仍继续注入，不因焦点读数异常而卡死', { skip: !WINDOWS }, async () => {
	// 焦点永远读不到：真实场景里可能是目标进程无响应
	stub.functions.set('GetGUIThreadInfo', (threadId, info) => {
		info.writeUInt32LE(72, 0);
		info.writeBigUInt64LE(0n, 16);
		return 1;
	});

	const { tool } = toolFor({ allowForegroundInput: true, settleMs: 60 });
	const started = Date.now();
	await tool.execute({ action: 'type', text: 'x' }, exec());
	assert.ok(Date.now() - started >= 40, '应确实等待到接近超时');
	assert.equal(sendInputBatches().length, 1, '超时后仍要完成注入，而不是静默放弃');
});

test('key 组合键按修饰键在前、抬起逆序下发', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true });
	await tool.execute({ action: 'key', keys: 'ctrl+shift+s' }, exec());

	const batch = withoutWarmup(sendInputBatches()[0]);
	assert.deepEqual(batch.map((event) => event.u.ki.wVk), [0x11, 0x10, 0x53, 0x53, 0x10, 0x11]);
	assert.deepEqual(batch.map((event) => event.u.ki.dwFlags), [0, 0, 0, 0x0002, 0x0002, 0x0002]);
});

test('key 对方向键带上扩展标志', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true });
	await tool.execute({ action: 'key', keys: 'Down' }, exec());
	const batch = withoutWarmup(sendInputBatches()[0]);
	assert.equal(batch[0].u.ki.dwFlags & 0x0001, 0x0001, '缺扩展标志会变成小键盘的 2');
	assert.equal(batch[1].u.ki.dwFlags & 0x0001, 0x0001, '抬起同样要带');
});

test('key 与 hold_key 在结果里回报接收按键的窗口', { skip: !WINDOWS }, async () => {
	stub.windowTitle = '记事本';
	const { tool } = toolFor({ allowForegroundInput: true });
	const value = await tool.execute({ action: 'key', keys: 'Escape' }, exec());
	assert.equal(value.target.title, '记事本');
	assert.match(value.summary, /记事本/u);
});

test('hold_key 先全部按下、等待、再全部抬起', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true });
	await tool.execute({ action: 'hold_key', keys: 'shift', duration_ms: 30 }, exec());
	const batches = sendInputBatches();
	assert.equal(batches.length, 2);
	assert.deepEqual(withoutWarmup(batches[0]).map((event) => event.u.ki.wVk), [0x10]);
	assert.deepEqual(batches[1].map((event) => event.u.ki.dwFlags), [0x0002]);
});

test('wait 在超过配置上限时拒绝，并回报等待后的光标', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ maxWaitMs: 50 });
	await assert.rejects(() => tool.execute({ action: 'wait', duration_ms: 51 }, exec()), /最多等待 50ms/u);

	const value = await tool.execute({ action: 'wait', duration_ms: 1 }, exec());
	assert.deepEqual(value.cursor, { x: 100, y: 200 });
});

test('allowInput 关闭后只允许看与等待', { skip: !WINDOWS }, async () => {
	const attachments = makeAttachments();
	const { tool } = toolFor({ allowInput: false, maxDimension: 0 }, { attachments });

	for (const args of [{ action: 'left_click', x: 1, y: 1 }, { action: 'type', text: 'x' }, { action: 'key', keys: 'a' }]) {
		await assert.rejects(() => tool.execute(args, exec()), /输入模拟已被配置关闭/u);
	}

	// 只读动作仍然可用
	await tool.execute({ action: 'screenshot' }, exec());
	await tool.execute({ action: 'cursor_position' }, exec());
	assert.equal(sendInputBatches().length, 0, '关闭后不得有任何输入注入');
});

// ---- 前台输入门控（allowForegroundInput，默认关闭）----------------------------
//
// 门控的全部意义是"模型在用户不知情时不得碰到输入层"：只断言报错是不够的，
// 必须同时断言 stub.calls 里没有任何 SendInput——否则一个"报了错但先注入了"
// 的实现也能通过测试。

test('默认配置下不带 target 的输入动作被拦下，且没有碰到 SendInput', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor();

	for (const args of [
		{ action: 'type', text: 'hello' },
		{ action: 'left_click', x: 1, y: 1 },
		{ action: 'mouse_move', x: 1, y: 1 },
		{ action: 'double_click', x: 1, y: 1 },
		{ action: 'triple_click', x: 1, y: 1 },
		{ action: 'right_click', x: 1, y: 1 },
		{ action: 'middle_click', x: 1, y: 1 },
		{ action: 'left_click_drag', start_x: 0, start_y: 0, x: 1, y: 1 },
		{ action: 'scroll', scroll_direction: 'down' },
		{ action: 'key', keys: 'Escape' },
		{ action: 'hold_key', keys: 'shift', duration_ms: 10 },
	]) {
		await assert.rejects(
			() => tool.execute(args, exec()),
			(error) => {
				// 错误信息必须同时给出两条出路：后台模式（target）与部署方开启（allowForegroundInput）
				assert.match(error.message, /target/u, `${args.action} 的错误必须指向后台模式`);
				assert.match(error.message, /allowForegroundInput/u, `${args.action} 的错误必须指向配置开关`);
				assert.match(error.message, /未执行任何输入/u);
				return true;
			},
		);
	}
	// 关键断言：被拦下的调用绝不能已经注入了任何东西，也不能挪光标
	assert.equal(callsTo('SendInput').length, 0, '门控必须在任何 SendInput 之前返回');
	assert.deepEqual(callsTo('SetCursorPos'), []);
});

test('默认配置下不带 target 的 screenshot 与只读动作不受门控', { skip: !WINDOWS }, async () => {
	const attachments = makeAttachments();
	const { tool } = toolFor({ maxDimension: 0 }, { attachments });

	// screenshot 不产生输入：它只是读屏幕，必须保持可用——这是模型看屏幕的主要手段
	const shot = await tool.execute({ action: 'screenshot' }, exec());
	assert.equal(shot.action, 'screenshot');
	assert.equal(shot.image.attachmentId, 'att-1');

	await tool.execute({ action: 'cursor_position' }, exec());
	await tool.execute({ action: 'wait', duration_ms: 1 }, exec());
	const listed = await tool.execute({ action: 'window' }, exec());
	assert.ok(Array.isArray(listed.windows));
});

test('带 target 的后台输入在默认配置下不受前台门控影响', { skip: !WINDOWS }, async () => {
	defineChromiumWindow();
	const posted = recordPostMessage();
	const { tool } = toolFor();

	const value = await tool.execute({ action: 'left_click', target: '16384', x: 100, y: 100 }, exec());
	assert.equal(value.background.reliable, true);
	assert.ok(posted.length > 0, '后台点击应走 PostMessage');
	assert.equal(callsTo('SendInput').length, 0);
});

test('allowForegroundInput=true 后不带 target 的输入恢复原有行为', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true });

	await tool.execute({ action: 'left_click', x: 300, y: 400 }, exec());
	assert.deepEqual(callsTo('SetCursorPos')[0], [300, 400]);
	assert.equal(sendInputBatches().length, 1, '按下/抬起仍应成对下发');

	await tool.execute({ action: 'type', text: 'hi' }, exec());
	assert.ok(sendInputBatches().length > 1, 'type 仍走 Unicode 注入');
});

test('deniedKeys 拦下组合键，且写法大小写与顺序不敏感', { skip: !WINDOWS }, async () => {
	const { tool } = toolFor({ allowForegroundInput: true, deniedKeys: ['ctrl+alt+Delete'] });
	await assert.rejects(() => tool.execute({ action: 'key', keys: 'Ctrl+Alt+del' }, exec()), /已被部署配置禁止/u);
	await assert.rejects(() => tool.execute({ action: 'hold_key', keys: 'alt+ctrl+delete', duration_ms: 10 }, exec()), /已被部署配置禁止/u);

	// 未被禁止的组合照常下发
	await tool.execute({ action: 'key', keys: 'ctrl+c' }, exec());
	assert.equal(sendInputBatches().length, 1);
});

test('未知动作与缺失参数都给出可纠正的错误', { skip: !WINDOWS }, async () => {
	// 缺失参数的校验在输入门控之后，因此这个用例也必须显式开启前台模式
	const { tool } = toolFor({ allowForegroundInput: true });
	await assert.rejects(() => tool.execute({ action: 'nope' }, exec()), /未知动作/u);
	await assert.rejects(() => tool.execute({ action: 'mouse_move', x: 1 }, exec()), /需要整数参数 y/u);
	await assert.rejects(() => tool.execute({ action: 'type' }, exec()), /需要非空字符串参数 text/u);
	await assert.rejects(() => tool.execute({ action: 'left_click_drag', start_x: 0, start_y: 0 }, exec()), /需要终点坐标/u);
});

test('工具定义具备宿主所需的形状', { skip: !WINDOWS }, async () => {
	const { tool, sections } = toolFor();

	assert.equal(tool.name, 'computer');
	assert.equal(typeof tool.description, 'string');
	assert.ok(tool.description.length > 100, '描述应说明坐标空间与安全边界');
	assert.ok(tool.parameters.action.enum.includes('screenshot'));
	assert.ok(tool.parameters.action.enum.includes('left_click_drag'));
	assert.equal(tool.parameters.action.required, true);
	assert.equal(tool.output.schema.additionalProperties, false);

	// 输入动作必须串行：桌面的光标与焦点是全局共享状态
	assert.equal(tool.isConcurrencySafe({ action: 'left_click' }), false);
	assert.equal(tool.isConcurrencySafe({ action: 'screenshot' }), false);

	// 卡片标题便于人读，且不泄漏图像内容
	const call = tool.presentCall({ action: 'type', text: 'a'.repeat(60) });
	assert.equal(call.card, 'generic');
	assert.equal(call.kind, 'execute');
	assert.ok(call.title.length < 80, '标题应被截断');
	assert.equal(tool.presentCall({ action: 'screenshot' }).kind, 'read');

	assert.deepEqual(sections, [], 'registerComputerTool 不负责提示词段落');
});

// ---- 后台模式：window 动作、target 参数、后台截图与后台输入 ------------------
//
// 这一组验证的是"mode 选择"这条链路：`window` 动作给出的句柄能不能当真目标用、
// 带 target 的动作有没有真的走后台通道（不发 SendInput、不挪光标）、以及
// 实测不可靠的那条路（GDI 窗口）有没有如实回报而不是假装成功。
//
// 窗口树全部由假 Windows 提供（stub.defineWindow），不创建真实窗口。

/** 造一棵 Chromium 顶层窗口 + 渲染子窗口：句柄 16384，客户区 1184x761，客户区原点 (58,71)。 */
function defineChromiumWindow() {
	const frame = 0x4000n;
	stub.defineWindow(frame, {
		parent: null,
		className: 'Chrome_WidgetWin_1',
		title: 'Chrome',
		frame: { left: 50, top: 40, width: 1200, height: 800 },
		clientOffset: { x: 8, y: 31 },
		clientSize: { width: 1184, height: 761 },
	});
	stub.defineWindow(0x4100n, {
		parent: frame,
		className: 'Chrome_RenderWidgetHostHWND',
		frame: { left: 50, top: 40, width: 1184, height: 761 },
		clientOffset: { x: 8, y: 31 },
		clientSize: { width: 1184, height: 761 },
	});
	return frame;
}

/** 造一个普通 GDI 窗口：句柄 24576，客户区 200x100（后台点击对它是不可靠的）。 */
function defineGdiWindow({ title = '记事本' } = {}) {
	const handle = 0x6000n;
	stub.defineWindow(handle, {
		parent: null,
		className: 'Notepad',
		title,
		frame: { left: 100, top: 80, width: 208, height: 128 },
		clientOffset: { x: 6, y: 28 },
		clientSize: { width: 200, height: 100 },
	});
	return handle;
}

/** 收集 PostMessageW 的调用参数；默认实现只返回 1，看不到打过什么。 */
function recordPostMessage() {
	const posted = [];
	stub.functions.set('PostMessageW', (hwnd, msg, wParam, lParam) => {
		posted.push({ hwnd, msg, wParam, lParam });
		return 1;
	});
	return posted;
}

/** 让 PrintWindow 交出指定单色（用于制造"空白帧"）。 */
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

test('window 动作列出可后台操作的窗口，handle 是十进制字符串，并过滤不可见/零客户区/系统壳窗口', { skip: !WINDOWS }, async () => {
	defineChromiumWindow();
	defineGdiWindow();
	// 无标题的普通窗口：应列出，标题回落到 (untitled)
	stub.defineWindow(0xa000n, { parent: null, className: 'Notepad', title: '', clientSize: { width: 300, height: 200 } });
	// 不可见窗口
	stub.defineWindow(0x7000n, { parent: null, className: 'Notepad', title: '隐藏窗口', visible: false });
	// 系统壳窗口：无标题 + Shell_TrayWnd
	stub.defineWindow(0x8000n, { parent: null, className: 'Shell_TrayWnd', title: '' });
	// 客户区为 0 的窗口：拿不到可操作目标
	stub.defineWindow(0x9000n, { parent: null, className: 'Notepad', title: '零尺寸', clientSize: { width: 0, height: 0 } });
	// 只有 0x6000 报告最小化
	stub.functions.set('IsIconic', (handle) => (handle === 0x6000n ? 1 : 0));

	const { tool } = toolFor();
	const value = await tool.execute({ action: 'window' }, exec());

	// 顺序即 z 序：后定义的在前（stub 的 defineWindow 把新顶层窗口插到最前）
	assert.deepEqual(
		value.windows.map((entry) => [entry.handle, entry.title, entry.kind, entry.width, entry.height, entry.minimized]),
		[
			['40960', '(untitled)', 'gdi', 300, 200, false],
			['24576', '记事本', 'gdi', 200, 100, true],
			['16384', 'Chrome', 'chromium', 1184, 761, false],
			['8192', 'Notepad', 'gdi', 1600, 900, false],
		],
		'只应列出可见、客户区非空、非系统壳的窗口，且 Chromium 报的是渲染子窗口的客户区',
	);
	for (const entry of value.windows) {
		assert.equal(typeof entry.handle, 'string', 'bigint 句柄必须转成字符串，否则 JSON 序列化会抛错');
		assert.match(entry.handle, /^\d+$/u);
	}
	// 输出值要能进会话日志：bigint 混进去会直接在这里抛错
	assert.doesNotThrow(() => JSON.parse(JSON.stringify(value)));

	assert.match(value.summary, /4 of 4 window/u);
	assert.match(value.summary, /handle=16384 "Chrome" \[chromium\] client 1184x761/u);
	assert.match(value.summary, /\(minimized\)/u);
	assert.doesNotMatch(value.summary, /隐藏窗口|零尺寸/u);

	// 枚举窗口是只读动作：不投递消息、不动光标
	assert.deepEqual(sendInputBatches(), [], 'window 动作不得注入任何输入');
	assert.equal(callsTo('SetCursorPos').length, 0);
});

test('window 动作的 limit 受配置上限约束：模型只能要得更少', { skip: !WINDOWS }, async () => {
	defineChromiumWindow();
	defineGdiWindow();
	stub.defineWindow(0xa000n, { parent: null, className: 'Notepad', title: '', clientSize: { width: 300, height: 200 } });

	const { tool } = toolFor({ windowListLimit: 2 });
	const limited = await tool.execute({ action: 'window', limit: 1 }, exec());
	assert.equal(limited.windows.length, 1, 'limit=1 只列一个');
	assert.match(limited.summary, /1 of 4 window/u, 'summary 要说明总共匹配了多少个');

	// 配置上限是硬顶：模型要 10 个也只能拿到 2 个
	const capped = await tool.execute({ action: 'window', limit: 10 }, exec());
	assert.equal(capped.windows.length, 2);
	assert.match(capped.summary, /2 of 4 window/u);

	await assert.rejects(() => tool.execute({ action: 'window', limit: 0 }, exec()), /limit 必须是正整数/u);
});

test('window 动作在 allowInput=false 与 requireApproval 下仍可用（它不产生输入）', { skip: !WINDOWS }, async () => {
	defineChromiumWindow();
	const { tool } = toolFor({ allowInput: false, requireApproval: true });
	const value = await tool.execute({ action: 'window' }, exec());
	assert.ok(value.windows.length > 0);
});

test('带 target 的 screenshot 抓渲染子窗口，外壳给出图像坐标 → 客户区坐标的换算公式', { skip: !WINDOWS }, async () => {
	defineChromiumWindow();
	const attachments = makeAttachments();
	// 1184 缩到 592 → scale 恰好 0.5，便于手算
	const { tool } = toolFor({ maxDimension: 592 }, { attachments });

	const value = await tool.execute({ action: 'screenshot', target: '16384' }, exec());

	assert.equal(value.window.handle, '16384');
	assert.equal(value.window.kind, 'chromium');
	assert.equal(value.window.width, 1184);
	assert.equal(value.window.height, 761);
	// 截图区域记的是客户区在屏幕坐标下的位置，客户区尺寸是缩放前的
	assert.deepEqual(value.region, { x: 58, y: 71, width: 1184, height: 761 });
	assert.equal(value.image.width, 592);
	assert.equal(value.scale, 0.5);
	// 抓的必须是渲染子窗口，抓顶层 Chrome_WidgetWin_1 拿不到内容
	assert.equal(callsTo('PrintWindow')[0][0], 0x4100n);

	const blocks = tool.output.render({ action: 'screenshot', target: '16384' }, value);
	assert.equal(blocks.length, 2);
	assert.equal(blocks[1].type, 'image');
	// 外壳必须让模型能把图上的点换算成客户区坐标，且点明这不是屏幕坐标
	assert.match(blocks[0].text, /client_x = image_x \/ 0\.50000/u);
	assert.match(blocks[0].text, /client_y = image_y \/ 0\.50000/u);
	assert.match(blocks[0].text, /target="16384"/u);
	assert.match(blocks[0].text, /client="58,71 1184x761"/u);
	assert.doesNotMatch(blocks[0].text, /screen_x/u, '后台截图的外壳不得给出屏幕坐标公式');
});

test('带 target 的 screenshot 在空白帧时返回错误而不是成功', { skip: !WINDOWS }, async () => {
	defineGdiWindow();
	// PrintWindow 返回成功但只铺了一层底色 —— 实测最常见的"假成功"
	stubPrintWindowSolid(0xff, 0xff, 0xff, 0xff);
	const attachments = makeAttachments();
	const { tool } = toolFor({}, { attachments });

	await assert.rejects(
		() => tool.execute({ action: 'screenshot', target: '24576' }, exec()),
		/空白帧.*不响应 PrintWindow|空白帧[\s\S]*从未真正呈现/su,
	);
	assert.equal(attachments.saveCalls, 0, '空白帧不得被编码成附件交给模型');
});

test('backgroundCaptureEnabled=false 时带 target 的 screenshot 在抓图前就明确报错', { skip: !WINDOWS }, async () => {
	defineGdiWindow();
	const attachments = makeAttachments();
	const { tool } = toolFor({ backgroundCaptureEnabled: false }, { attachments });

	await assert.rejects(
		() => tool.execute({ action: 'screenshot', target: '24576' }, exec()),
		/后台截图已被配置关闭（backgroundCaptureEnabled: false）/u,
	);
	assert.equal(callsTo('PrintWindow').length, 0, '关掉后不应真的去抓图');
	assert.equal(attachments.saveCalls, 0);
});

test('最小化窗口的后台截图转成"先还原窗口"的可读错误', { skip: !WINDOWS }, async () => {
	defineGdiWindow();
	stub.functions.set('IsIconic', () => 1);
	const { tool } = toolFor({}, { attachments: makeAttachments() });

	await assert.rejects(
		() => tool.execute({ action: 'screenshot', target: '24576' }, exec()),
		/后台截图失败：.*最小化.*还原窗口/su,
	);
});

test('带 target 的 left_click 按最近一次截图的缩放把图像坐标换回客户区坐标', { skip: !WINDOWS }, async () => {
	defineChromiumWindow();
	const posted = recordPostMessage();
	const { tool } = toolFor({ maxDimension: 592 }, { attachments: makeAttachments() });

	// 先截图：1184 → 592，scale = 0.5
	const shot = await tool.execute({ action: 'screenshot', target: '16384' }, exec());
	assert.equal(shot.scale, 0.5);
	stub.calls.length = 0;

	// 模型读到的图像点 (100,200) → 客户区 (200,400)
	const value = await tool.execute({ action: 'left_click', target: '16384', x: 100, y: 200 }, exec());

	assert.equal(value.background.coordinateSource, 'image');
	assert.deepEqual(value.background.point, { x: 200, y: 400 });
	assert.match(value.summary, /converted to client-area coordinates/u);
	// lParam 低 16 位 x、高 16 位 y：400 << 16 | 200
	assert.deepEqual(
		posted.map((call) => [call.hwnd, call.msg, call.wParam, call.lParam]),
		[
			[0x4100n, 0x200, 0, (400 * 0x10000) + 200],
			[0x4100n, 0x201, 1, (400 * 0x10000) + 200],
			[0x4100n, 0x202, 0, (400 * 0x10000) + 200],
		],
		'后台点击必须打到渲染子窗口，且坐标换算后才是投递坐标',
	);
	// 后端模式的两条硬纪律：不挪光标、不注入前台事件
	assert.deepEqual(callsTo('SetCursorPos'), []);
	assert.equal(callsTo('SendInput').length, 0, '后台点击绝不能退化成 SendInput');
});

test('带 target 的 click 在没有该窗口截图时把坐标当客户区坐标，并在 summary 里说明', { skip: !WINDOWS }, async () => {
	defineChromiumWindow();
	const posted = recordPostMessage();
	const { tool } = toolFor();

	// 没有截图记录 → 坐标按"已是客户区坐标"处理
	const value = await tool.execute({ action: 'right_click', target: '16384', x: 300, y: 240 }, exec());

	assert.equal(value.background.coordinateSource, 'client');
	assert.deepEqual(value.background.point, { x: 300, y: 240 });
	assert.match(value.summary, /CLIENT-area pixels: this window has no usable screenshot/u);
	assert.equal(posted[0].lParam, (240 * 0x10000) + 300);
	// 按键语义必须保住：早先后台投递固定发左键消息，右键请求会被静默降级成左键，
	// 模型于是以为上下文菜单打开了、实际触发的是左键行为。现在消息号按按键分派，
	// 因此这里断言的是"确实是右键"，而**不是**旧实现那句降级警告。
	assert.match(value.summary, /右键点击/u, 'summary 必须说明实际投递的是右键，不能含糊成"点击"');
	assert.doesNotMatch(value.summary, /NOT preserved/u, '按键语义已保住，不该再出现降级警告');
	assert.equal(posted[1].msg, 0x0204, '第二条消息应是 WM_RBUTTONDOWN');
	assert.equal(value.background.reliable, true, 'reliable/note 仍按投递层实测结论原样透传');
	assert.ok(value.background.note.length > 0);
});

test('窗口尺寸在截图后变化时，旧截图不再用于换算（退回客户区坐标并说明原因）', { skip: !WINDOWS }, async () => {
	defineChromiumWindow();
	const posted = recordPostMessage();
	const { tool } = toolFor({ maxDimension: 592 }, { attachments: makeAttachments() });
	await tool.execute({ action: 'screenshot', target: '16384' }, exec());

	// 客户区尺寸被改小：那张截图与现在的客户区已经对不上
	stub.defineWindow(0x4100n, {
		parent: 0x4000n,
		className: 'Chrome_RenderWidgetHostHWND',
		clientSize: { width: 600, height: 400 },
	});

	const value = await tool.execute({ action: 'left_click', target: '16384', x: 100, y: 100 }, exec());
	assert.equal(value.background.coordinateSource, 'client');
	assert.deepEqual(value.background.point, { x: 100, y: 100 });
	assert.match(value.summary, /client size changed since this window was last screenshotted/u);
	assert.equal(posted[0].lParam, (100 * 0x10000) + 100);
});

test('窗口截图同样逐级降采样重抓，scale 随附件服务返回的尺寸走', { skip: !WINDOWS }, async () => {
	defineChromiumWindow();
	const attachments = makeAttachments({ failFirst: true });
	const { tool } = toolFor({ maxDimension: 592 }, { attachments });

	const value = await tool.execute({ action: 'screenshot', target: '16384' }, exec());

	assert.equal(value.downscaleRetries, 1, '第二次尝试才成功');
	assert.equal(attachments.saveCalls, 2);
	assert.equal(value.image.width, 296, '第二级阶梯是配置值的一半');
	assert.equal(value.scale, 296 / 1184);

	// 点击必须按 0.25 的比例换算：图像 (100,100) → 客户区 (400,400)
	const posted = recordPostMessage();
	await tool.execute({ action: 'left_click', target: '16384', x: 100, y: 100 }, exec());
	assert.equal(posted[0].lParam, (400 * 0x10000) + 400);
});

test('带 target 的 type 把 reliable/note 透传出来，且不等待焦点、不产生前台输入', { skip: !WINDOWS }, async () => {
	defineChromiumWindow();
	const posted = recordPostMessage();
	const { tool } = toolFor();

	const value = await tool.execute({ action: 'type', target: '16384', text: 'hi\n' }, exec());

	assert.equal(value.background.reliable, true);
	assert.match(value.background.note, /Chromium 渲染子窗口/u);
	assert.equal(value.background.delivered, 3, '两个字母 + 一个换行（CR）');
	assert.ok(value.summary.includes(value.background.note), 'note 必须原样出现在模型读到的那句话里');

	// 全部打到渲染子窗口，换行走 CR（0x0d）
	assert.deepEqual(posted.map((call) => [call.hwnd, call.msg, call.wParam]), [
		[0x4100n, 0x102, 0x68],
		[0x4100n, 0x102, 0x69],
		[0x4100n, 0x102, 0x0d],
	]);
	assert.equal(callsTo('SendInput').length, 0, '后台打字不得注入前台事件');
	assert.equal(callsTo('GetGUIThreadInfo').length, 0, '后台打字与前台焦点无关，不该去等焦点落定');
	assert.deepEqual(callsTo('SetCursorPos'), []);
});

test('GDI 目标的 type 如实回报 reliable=false，并提醒改用前台模式', { skip: !WINDOWS }, async () => {
	defineGdiWindow();
	const posted = recordPostMessage();
	const { tool } = toolFor();

	const value = await tool.execute({ action: 'type', target: '24576', text: 'hi' }, exec());

	assert.equal(value.background.reliable, false, '普通 Win32 窗口不在前台时文本输入可能不被处理，必须如实回报');
	assert.equal(value.background.delivered, 2);
	assert.ok(value.background.note.length > 0);
	assert.match(value.summary, /UNRELIABLE/u);
	assert.match(value.summary, /foreground mode|omit target/u, '不可靠时要给出可执行的下一步');
	assert.equal(posted[0].hwnd, 0x6000n);
});

test('target 指向不支持的动作或非法句柄时明确报错，且不执行任何输入', { skip: !WINDOWS }, async () => {
	defineChromiumWindow();
	const { tool } = toolFor();

	for (const args of [
		{ action: 'mouse_move', target: '16384', x: 1, y: 1 },
		{ action: 'double_click', target: '16384', x: 1, y: 1 },
		{ action: 'scroll', target: '16384', scroll_direction: 'down' },
		{ action: 'key', target: '16384', keys: 'Escape' },
		{ action: 'wait', target: '16384', duration_ms: 1 },
		{ action: 'cursor_position', target: '16384' },
		{ action: 'window', target: '16384' },
	]) {
		await assert.rejects(() => tool.execute(args, exec()), /不支持 target/u, `${args.action} 必须拒绝 target`);
	}
	await assert.rejects(() => tool.execute({ action: 'left_click', target: '0x1.5', x: 1, y: 1 }, exec()), /不是合法的窗口句柄/u);
	await assert.rejects(() => tool.execute({ action: 'left_click', target: '', x: 1, y: 1 }, exec()), /需要窗口句柄的字符串形式/u);
	// 句柄失效（不在窗口树里）：GetWindowRect 会失败
	stub.functions.set('GetWindowRect', (handle) => (handle === 0x9999n ? 0 : 1));
	await assert.rejects(() => tool.execute({ action: 'left_click', target: '39321', x: 1, y: 1 }, exec()), /已失效或无法读取/u);

	assert.deepEqual(sendInputBatches(), [], '被拒绝的调用不得发出任何输入');
	assert.deepEqual(callsTo('SetCursorPos'), []);
});

test('后台点击缺少坐标时明确报错（没有"在光标处点击"这种语义）', { skip: !WINDOWS }, async () => {
	defineChromiumWindow();
	const { tool } = toolFor();
	await assert.rejects(() => tool.execute({ action: 'left_click', target: '16384' }, exec()), /需要 x\/y/u);
	// region 是屏幕矩形，后台截图固定抓整个客户区，同时给必然得到一个与请求不符的结果
	await assert.rejects(
		() => tool.execute({ action: 'screenshot', target: '16384', region: { x: 0, y: 0, width: 10, height: 10 } }, exec()),
		/target 与 region 不能同时使用/u,
	);
});

test('换算后的坐标落在客户区之外时给出告警（越界坐标会被静默回绕）', { skip: !WINDOWS }, async () => {
	defineChromiumWindow();
	recordPostMessage();
	const { tool } = toolFor();

	// 客户区只有 1184x761，1200 已越界
	const outside = await tool.execute({ action: 'left_click', target: '16384', x: 1200, y: 10 }, exec());
	assert.match(outside.summary, /WARNING: client-area \(1200, 10\) is outside/u);

	// 界内不告警
	const inside = await tool.execute({ action: 'left_click', target: '16384', x: 100, y: 100 }, exec());
	assert.doesNotMatch(inside.summary, /WARNING/u);
});

test('回归：不带 target 时即使桌面上有可后台操作的窗口，也一字不变地走前台模式', { skip: !WINDOWS }, async () => {
	defineChromiumWindow();
	const attachments = makeAttachments();
	// 这个用例专测前台路径本身，必须显式开启前台模式
	const { tool } = toolFor({ allowForegroundInput: true, maxDimension: 0 }, { attachments });

	// 点击：仍是 SetCursorPos + SendInput
	await tool.execute({ action: 'left_click', x: 300, y: 400 }, exec());
	assert.deepEqual(callsTo('SetCursorPos')[0], [300, 400]);
	assert.equal(sendInputBatches().length, 1);

	// 打字：仍是 SendInput，且照旧等待焦点落定
	await tool.execute({ action: 'type', text: 'hi' }, exec());
	assert.ok(callsTo('GetGUIThreadInfo').length > 0, '前台打字必须等焦点落定');
	assert.ok(sendInputBatches().length > 1);

	// 截图：仍是整屏 BitBlt，不碰 PrintWindow，也不带 window 字段
	const value = await tool.execute({ action: 'screenshot' }, exec());
	const blocks = tool.output.render({ action: 'screenshot' }, value);
	assert.equal(value.window, undefined);
	assert.equal(value.background, undefined);
	assert.deepEqual(value.region, { x: 0, y: 0, width: 1600, height: 900 });
	assert.match(blocks[0].text, /Image pixels equal screen pixels/u);
	assert.equal(callsTo('PrintWindow').length, 0, '前台截图不得改走 PrintWindow');

	// 整条链路都没有消息投递
	assert.equal(stub.calls.filter((call) => call.name === 'PostMessageW').length, 0);
});

test('新增的输出字段都在 schema 里声明：过一遍宿主真实的编译器与校验器', { skip: !HOST_AVAILABLE }, async () => {
	defineChromiumWindow();
	const { tool } = toolFor({ maxDimension: 592 }, { attachments: makeAttachments() });

	// defineTool 的替身只透传定义，所以这里显式执行宿主对 output.schema 做的那一步编译
	const schema = hostSchema.valueSchemaSpecToJsonSchema(tool.output.schema);
	for (const name of ['windows', 'window', 'background']) {
		assert.ok(name in schema.properties, `schema 必须声明 ${name}，否则宿主会以 "is not a declared property" 拒绝整次调用`);
	}
	assert.equal(schema.additionalProperties, false);

	/** 每个新返回值都要零违规，包括可选字段缺席的形态。 */
	const check = (label, value) => {
		assert.deepEqual(hostSchema.validateJsonSchemaValue(schema, value), [], `${label} 违反输出契约`);
	};

	check('window', await tool.execute({ action: 'window' }, exec()));
	check('后台 screenshot', await tool.execute({ action: 'screenshot', target: '16384' }, exec()));
	check('后台 left_click（有截图记录）', await tool.execute({ action: 'left_click', target: '16384', x: 10, y: 10 }, exec()));
	check('后台 type', await tool.execute({ action: 'type', target: '16384', text: 'x' }, exec()));
	check('前台 cursor_position', await tool.execute({ action: 'cursor_position' }, exec()));

	// 没有该窗口截图记录时的点击：不带 coordinateSource/point 的形态同样要合规
	defineGdiWindow();
	check('后台 click（无截图记录）', await tool.execute({ action: 'right_click', target: '24576', x: 5, y: 5 }, exec()));
});

