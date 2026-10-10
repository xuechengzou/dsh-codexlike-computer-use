/**
 * 插件装配测试。
 *
 * 覆盖 `apply` 的关键路径：正常激活、被禁用、provider 槽位被抢占，以及
 * **宿主完全没有挂载 computer-use 服务**。
 *
 * 最后一条是真实的部署教训：`computerUse` 只是"可选的 provider 槽位"，本机
 * 安装里只存在它的服务契约、没有实现。曾把它写进 `inject`，结果插件的 fiber
 * 永远停在 `pending`——宿主不报任何错，工具却从不注册，模型侧完全看不到。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, Config, inject, name } from '../lib/index.js';

/**
 * 收集注册动作的假 ctx。
 * @param options.slot - `'present'` 提供空闲槽位；`'taken'` 槽位已被占用；`'absent'` 宿主未挂载该服务。
 */
function makeContext({ slot = 'present' } = {}) {
	const state = { tools: [], sections: [], slotRegistrations: [], releases: 0, warnings: [] };
	const ctx = {
		tools: { register: (definition) => { state.tools.push(definition); return () => {}; } },
		systemPrompt: { section: (section) => { state.sections.push(section); return () => {}; } },
		logger: { warn: (message) => { state.warnings.push(message); } },
		get: (serviceName) => {
			if (serviceName !== 'computerUse' || slot === 'absent') return undefined;
			if (slot === 'taken') {
				return { register: () => { throw new Error('槽位已被占用'); } };
			}
			return {
				register: (providerName) => {
					state.slotRegistrations.push(providerName);
					return async () => { state.releases += 1; };
				},
			};
		},
	};
	return { ctx, state };
}

test('导出宿主要求的四件套', () => {
	assert.equal(typeof apply, 'function');
	assert.equal(typeof name, 'string');
	assert.equal(typeof Config, 'function', 'schemastery 的 schema 是可调用对象');
	assert.equal(typeof Config.parse, 'function', '替身额外提供 parse 别名便于断言');
});

test('inject 不含 computerUse——它不是硬依赖', () => {
	assert.deepEqual(inject, ['tools', 'systemPrompt']);
	assert.ok(!inject.includes('computerUse'), '把未挂载的服务写进 inject 会让 fiber 永远停在 pending');
});

test('激活时占用槽位、注册工具与提示词段落', () => {
	const { ctx, state } = makeContext();
	const dispose = apply(ctx, Config({}));

	assert.deepEqual(state.slotRegistrations, [name], '应以插件名占用槽位');
	assert.equal(state.tools.length, 1);
	assert.equal(state.tools[0].name, 'computer');
	assert.equal(state.sections.length, 1);
	assert.equal(state.sections[0].name, 'tool-computer-use');
	assert.equal(typeof dispose, 'function');
});

test('宿主未挂载 computer-use 服务时照常注册工具', () => {
	const { ctx, state } = makeContext({ slot: 'absent' });
	const dispose = apply(ctx, Config({}));

	assert.deepEqual(state.slotRegistrations, [], '没有服务就没什么可占');
	assert.equal(state.tools.length, 1, '工具必须仍然注册——否则插件形同未安装');
	assert.equal(state.tools[0].name, 'computer');
	assert.equal(state.sections.length, 1);
	assert.equal(typeof dispose, 'function');
	assert.deepEqual(state.warnings, [], '服务缺失是正常组合，不该产生告警噪音');
});

test('提示词段落落在工具说明之后、SDK 之前，并写明安全边界', () => {
	const { ctx, state } = makeContext();
	apply(ctx, Config({}));

	const section = state.sections[0];
	assert.ok(section.order > 2900 && section.order < 5000, `段落顺序 ${section.order} 应位于工具段落与 SDK 之间`);
	assert.match(section.text, /Computer use/u);
	// 模型从工具描述里读不到"这是用户的活机器"，必须由提示词交代
	assert.match(section.text, /user's own machine/u);
	assert.match(section.text, /Never click or type anything that deletes data/u);
});

test('dispose 归还槽位', async () => {
	const { ctx, state } = makeContext();
	const dispose = apply(ctx, Config({}));
	assert.equal(state.releases, 0);
	await dispose();
	assert.equal(state.releases, 1);
});

test('未占用槽位时 dispose 不报错', async () => {
	const { ctx } = makeContext({ slot: 'absent' });
	const dispose = apply(ctx, Config({}));
	await dispose();
});

test('enabled 为 false 时完全不参与装配', () => {
	const { ctx, state } = makeContext();
	const dispose = apply(ctx, Config({ enabled: false }));

	assert.deepEqual(state.slotRegistrations, [], '禁用时不应占槽位');
	assert.deepEqual(state.tools, []);
	assert.deepEqual(state.sections, []);
	assert.equal(dispose, undefined);
});

test('槽位被抢占时放弃注册工具，并留下可排查的告警', () => {
	const { ctx, state } = makeContext({ slot: 'taken' });
	const dispose = apply(ctx, Config({}));

	assert.deepEqual(state.tools, [], '抢不到槽位就不注册工具，避免与其它提供者重名');
	assert.deepEqual(state.sections, []);
	assert.equal(dispose, undefined, '没有占用就不需要归还');
	assert.equal(state.warnings.length, 1);
	assert.match(state.warnings[0], /槽位已被占用/u);
});

test('非法配置在激活期就抛出，而不是等到第一次调用', () => {
	const { ctx } = makeContext();
	assert.throws(() => apply(ctx, Config({ typingChunkDelayMs: 0 })), /至少为 1/u);
});
