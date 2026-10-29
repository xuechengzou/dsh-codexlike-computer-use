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
		// 子 fiber：这里没有真实服务图，直接当作依赖已就位执行回调
		inject: (deps, callback) => {
			state.injected ??= [];
			state.injected.push(deps);
			callback(ctx);
			return {};
		},
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
	assert.deepEqual(state.tools.map((tool) => tool.name), ['computer_observe', 'computer_act']);
	assert.equal(state.sections.length, 1);
	assert.equal(state.sections[0].name, 'tool-computer-use');
	assert.equal(typeof dispose, 'function');
});

test('宿主未挂载 computer-use 服务时照常注册工具', () => {
	const { ctx, state } = makeContext({ slot: 'absent' });
	const dispose = apply(ctx, Config({}));

	assert.deepEqual(state.slotRegistrations, [], '没有服务就没什么可占');
	assert.deepEqual(state.tools.map((tool) => tool.name), ['computer_observe', 'computer_act'], '工具必须仍然注册——否则插件形同未安装');
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
	assert.match(section.text, /computer_observe/u, '提示词必须点名两个工具');
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

test('状态路由等 webServer 就位后才注册，而不是在 apply 时取一次', () => {
	// 真实宿主里 webServer 比 tools / systemPrompt 晚挂载；apply 时取一次会拿到
	// undefined，路由被静默跳过，面板读状态直接 404（实测踩过）。
	const routes = [];
	const callbacks = [];
	const ctx = {
		tools: { register: () => () => {} },
		systemPrompt: { section: () => () => {} },
		logger: { warn: () => {} },
		inject: (deps, callback) => {
			callbacks.push({ deps, callback });
			return {};
		},
		get: () => undefined,
	};

	apply(ctx, Config({}));
	assert.equal(callbacks.length, 1, '必须用 ctx.inject 等依赖');
	assert.deepEqual(callbacks[0].deps, ['webServer']);
	assert.deepEqual(routes, [], 'webServer 未就位时不应注册路由');

	// 模拟 webServer 挂载后回调被调用
	const scope = {
		get: (name) => (name === 'webServer'
			? { register: (route) => { routes.push(route); return () => {}; } }
			: undefined),
	};
	callbacks[0].callback(scope);
	assert.equal(routes.length, 1);
	assert.equal(routes[0].path, '/dsh-computer-use/state');
	assert.equal(routes[0].kind, 'exact');
});
