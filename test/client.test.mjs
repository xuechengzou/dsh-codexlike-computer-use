/**
 * 浏览器半边的**加载契约**测试。
 *
 * 这里不渲染 React（没有浏览器），只验证最容易静默出错的两层：
 * 1. 脚本是否按宿主的模块表协议注册（`window.__ModuleLoader__.load({id, factory})`）。
 *    —— 写成 ESM 的 `export` 会让脚本直接语法错误，启动期就卡住；这正是它
 *    在真实宿主里崩过一次的原因，所以必须有测试盯着形状。
 * 2. 工厂在缺 React / 缺 slots 时是否安静退出。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const fakeReact = {
	createElement: (...args) => ({ type: 'element', args }),
	useState: (value) => [value, () => {}],
	useEffect: () => {},
	useCallback: (fn) => fn,
};

/** 在导入模块之前装好模块表；脚本在求值期就会调用它。 */
let captured;
globalThis.window = {
	__ModuleLoader__: {
		load: (registration) => {
			captured = registration;
		},
	},
};

await import('../client.js');

test('按模块表协议注册，id 等于包名', () => {
	assert.ok(captured !== undefined, '脚本必须调用 __ModuleLoader__.load');
	assert.equal(captured.id, 'dsh-computer-use');
	assert.equal(typeof captured.factory, 'function');
});

test('工厂返回 { inject, apply }，并声明 slots 依赖', () => {
	const mod = captured.factory((specifier) => (specifier === 'react' ? fakeReact : undefined));
	assert.deepEqual(mod.inject, ['slots']);
	assert.equal(typeof mod.apply, 'function');
});

test('apply 把两处界面注册进正确的插槽', () => {
	const mod = captured.factory((specifier) => (specifier === 'react' ? fakeReact : undefined));
	const registrations = [];
	const injections = [];
	const ctx = {
		slots: {
			inject: (name, factory) => {
				injections.push(name);
				factory();
			},
			register: (options, component) => registrations.push({ options, component }),
		},
	};

	mod.apply(ctx);

	assert.deepEqual(injections, ['settings.section', 'conversation.input.left']);
	assert.equal(registrations.length, 2);
	const [section, chip] = registrations;
	assert.equal(section.options.id, 'computer-use');
	assert.equal(section.options.order, 63);
	assert.equal(chip.options.id, 'computer-use-mode');
	assert.equal(typeof chip.component, 'function');
});

test('没有 React 时安静退出', () => {
	const mod = captured.factory(() => undefined);
	const registrations = [];
	const ctx = { slots: { inject: (name, factory) => factory(), register: (options) => registrations.push(options) } };
	assert.doesNotThrow(() => mod.apply(ctx));
	assert.equal(registrations.length, 0);
});

test('没有 slots 服务时安静退出', () => {
	const mod = captured.factory((specifier) => (specifier === 'react' ? fakeReact : undefined));
	assert.doesNotThrow(() => mod.apply({}));
});
