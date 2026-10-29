/**
 * 两件套工具的行为测试：模式门控、参数映射、状态切换。
 *
 * 这些用例刻意只覆盖**门控**与**映射**两层：底层动作语义由 `tool.test.mjs`
 * 逐条覆盖，这里再重复一遍等于维护两份期望。`loadWin32` 走 koffi 替身，
 * 因此非 Windows 平台整体跳过。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config } from '../lib/config.js';
import { createState } from '../lib/state.js';
import { registerTools } from '../lib/tools.js';

const WINDOWS = process.platform === 'win32';
const skip = WINDOWS ? false : '只在 Windows 上跑';

/** 构造只带必需服务的假 ctx，并注册两个工具。 */
function harness({ overrides = {}, mode = 'window', allowInput = true } = {}) {
	const registered = [];
	const ctx = {
		tools: { register: (definition) => { registered.push(definition); return () => {}; } },
		systemPrompt: { section: () => () => {} },
		logger: { warn() {} },
		get: () => undefined,
	};
	const config = Config(overrides);
	const state = createState({ inputMode: mode, allowInput });
	registerTools(ctx, config, state);
	const [observe, act] = registered;
	return { observe, act, state, registered };
}

/** 最小执行上下文。 */
const exec = () => ({ callId: 'call-1', signal: new AbortController().signal });

test('注册恰好两个工具，名字与顺序稳定', () => {
	const { registered } = harness();
	assert.deepEqual(registered.map((tool) => tool.name), ['computer_observe', 'computer_act']);
});

test('窗口模式下不带 target 的输入被拒绝，并指向观察工具', { skip }, async () => {
	const { act } = harness();
	await assert.rejects(
		() => act.execute({ action: 'click', x: 10, y: 10 }, exec()),
		(error) => /窗口模式/u.test(error.message) && /computer_observe/u.test(error.message) && /未执行/u.test(error.message),
	);
});

test('前台模式下带 target 的输入被拒绝', { skip }, async () => {
	const { act } = harness({ mode: 'foreground' });
	await assert.rejects(
		() => act.execute({ action: 'click', target: '1234', x: 10, y: 10 }, exec()),
		(error) => /前台模式/u.test(error.message) && /target/u.test(error.message),
	);
});

test('allowInput 为假时任何输入都被拒绝，但不需要输入的动作仍可用', { skip }, async () => {
	const { act } = harness({ overrides: { allowInput: false } });
	await assert.rejects(
		() => act.execute({ action: 'type', target: '1234', text: 'hi' }, exec()),
		/输入模拟已被关闭/u,
	);
	const waited = await act.execute({ action: 'wait', duration_ms: 1 }, exec());
	assert.equal(waited.action, 'wait');
});

test('窗口模式下 wait 不需要 target', { skip }, async () => {
	const { act } = harness();
	const value = await act.execute({ action: 'wait', duration_ms: 1 }, exec());
	assert.equal(value.action, 'wait');
	assert.ok(value.summary.includes('1ms'));
});

test('状态切换后门控立刻改变，无需重建工具', { skip }, async () => {
	const { act, state } = harness();
	await assert.rejects(() => act.execute({ action: 'click', x: 1, y: 1 }, exec()), /窗口模式/u);

	state.set({ inputMode: 'foreground' });
	// 前台模式下不带 target 应当直接落到原生层，不再被"窗口模式"拦下
	const value = await act.execute({ action: 'click', x: 1, y: 1 }, exec());
	assert.equal(value.action, 'left_click');
});

test('模式写错时被忽略，保持原值', () => {
	const state = createState({ inputMode: 'window', allowInput: true });
	assert.equal(state.get().inputMode, 'window');
	state.set({ inputMode: 'nonsense' });
	assert.equal(state.get().inputMode, 'window');
	state.set({ inputMode: 'both' });
	assert.equal(state.get().inputMode, 'both');
});

test('订阅者收到变更，取消订阅后不再收到', () => {
	const state = createState({ inputMode: 'window', allowInput: true });
	const seen = [];
	const off = state.subscribe((next) => seen.push(next.inputMode));
	state.set({ inputMode: 'foreground' });
	off();
	state.set({ inputMode: 'both' });
	assert.deepEqual(seen, ['foreground']);
});

test('observe 把 windows 目标映射成窗口枚举', { skip }, async () => {
	const { observe } = harness();
	const value = await observe.execute({ target: 'windows' }, exec());
	assert.equal(value.action, 'window');
	assert.ok(Array.isArray(value.windows));
});
