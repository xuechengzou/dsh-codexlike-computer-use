/**
 * 配置解析与跨字段校验测试。
 *
 * 跨字段约束（例如"打字间隔不得为 0"）必须在这里挡住：schema 只能表达
 * 单字段类型，若不在加载期报错，就会等到模型第一次调用 type 时才以一种
 * 很难归因的方式失败。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertConfig, Config } from '../lib/config.js';

test('默认配置可解析，且给出面向开箱可用的取值', () => {
	const config = Config({});
	assert.equal(config.enabled, true);
	assert.equal(config.allowInput, true);
	assert.equal(config.allowForegroundInput, false, '前台模式必须默认关闭：不碰用户的鼠标键盘是默认行为而不是承诺');
	assert.equal(config.maxDimension, 1568);
	assert.equal(config.pngLevel, 6);
	assert.equal(config.maxWaitMs, 10_000);
	assert.equal(config.requireApproval, false, '默认不强制审批：审批策略为 never 的会话会把它变成拒绝');
	assert.deepEqual(config.deniedKeys, []);
	// 后台模式的默认值：截图允许、窗口清单限额 20
	assert.equal(config.backgroundCaptureEnabled, true, '后台截图默认开启；关掉它会让带 target 的 screenshot 直接报错');
	assert.equal(config.windowListLimit, 20);
	// 打字间隔是可靠性参数，默认值必须落在实测的安全区间内
	assert.ok(config.typingChunkDelayMs >= 12, `打字间隔 ${config.typingChunkDelayMs}ms 低于实测安全下限`);
	assert.ok(config.typingChunkSize >= 2);
});

test('显式覆盖生效，未覆盖的项仍取默认值', () => {
	const config = Config({ allowInput: false, maxDimension: 800, deniedKeys: ['ctrl+w'] });
	assert.equal(config.allowInput, false);
	assert.equal(config.maxDimension, 800);
	assert.deepEqual(config.deniedKeys, ['ctrl+w']);
	assert.equal(config.maxWaitMs, 10_000);
});

test('前台模式可以被部署方显式开启', () => {
	const config = Config({ allowForegroundInput: true });
	assert.equal(config.allowForegroundInput, true);
	// 与后台模式开关互不牵连
	assert.equal(config.backgroundCaptureEnabled, true);
});

test('后台模式的开关与限额可以被部署方覆盖', () => {
	const config = Config({ backgroundCaptureEnabled: false, windowListLimit: 3 });
	assert.equal(config.backgroundCaptureEnabled, false);
	assert.equal(config.windowListLimit, 3);
	assert.equal(config.allowInput, true, '后台截图开关与输入开关互不影响');
});

test('默认配置通过跨字段校验', () => {
	assertConfig(Config({}));
});

test('拒绝会让输入静默失效的取值', () => {
	assert.throws(
		() => assertConfig(Config({ typingChunkDelayMs: 0 })),
		/typingChunkDelayMs 至少为 1/u,
	);
	assert.throws(
		() => assertConfig(Config({ typingChunkSize: 1 })),
		/typingChunkSize 至少为 2/u,
	);
});

test('关闭输入后允许把打字间隔设为 0（该参数不再有意义）', () => {
	assert.doesNotThrow(() => assertConfig(Config({ allowInput: false, typingChunkDelayMs: 0 })));
});

test('拒绝越界与负值', () => {
	assert.throws(() => assertConfig(Config({ pngLevel: 10 })), /pngLevel 必须在 0–9 之间/u);
	assert.throws(() => assertConfig(Config({ pngLevel: -1 })), /pngLevel 必须在 0–9 之间/u);
	assert.throws(() => assertConfig(Config({ maxWaitMs: 0 })), /maxWaitMs 必须是正数/u);
	assert.throws(() => assertConfig(Config({ maxTextLength: -5 })), /maxTextLength 必须是正数/u);
	assert.throws(() => assertConfig(Config({ maxDimension: -1 })), /maxDimension 不能为负数/u);
	assert.throws(() => assertConfig(Config({ settleMs: -1 })), /settleMs 不能为负数/u);
	// windowListLimit 为 0 会让 window 动作永远列不出东西，属于配置错误而不是"空结果"
	assert.throws(() => assertConfig(Config({ windowListLimit: 0 })), /windowListLimit 必须是正数/u);
});

test('parse 对错误类型直接拒绝', () => {
	assert.throws(() => Config({ allowInput: 'yes' }), /期望一个布尔值/u);
	assert.throws(() => Config({ maxWaitMs: 'soon' }), /期望一个数字/u);
	assert.throws(() => Config({ deniedKeys: 'ctrl+w' }), /期望一个数组/u);
	assert.throws(() => Config({ backgroundCaptureEnabled: 'yes' }), /期望一个布尔值/u);
	assert.throws(() => Config({ allowForegroundInput: 'yes' }), /期望一个布尔值/u);
	assert.throws(() => Config({ windowListLimit: '20' }), /期望一个数字/u);
});
