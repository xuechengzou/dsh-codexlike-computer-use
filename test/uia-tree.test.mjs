/**
 * 可访问性树序列化的单元测试。
 *
 * 用假元素实现 `UiaElement` 接口，因此不需要 COM、也不需要 Windows：
 * 这里验证的是**文本契约**与**释放纪律**——后者尤其重要，遍历一棵树会创建
 * 成百上千个 COM 引用，漏掉一个就是一处泄漏。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTree } from '../lib/uia/tree.js';

/** 计数器：所有假元素共享，用来断言释放次数。 */
function makeFactory() {
	const stats = { released: 0, created: 0 };

	/**
	 * 造一个假元素树。
	 *
	 * @param spec - 元素描述（children 递归）。
	 * @returns 实现 UiaElement 的对象。
	 */
	function make(spec) {
		stats.created += 1;
		let alive = true;
		const element = {
			pointer: 0n,
			controlType: () => spec.type ?? 50000,
			name: () => spec.name ?? '',
			automationId: () => '',
			className: () => '',
			isOffscreen: () => spec.offscreen === true,
			isEnabled: () => spec.enabled !== false,
			bounds: () => spec.bounds,
			children: [],
			firstChild: () => element.children[0] ?? null,
			nextSibling: () => null,
			release: () => {
				if (!alive) throw new Error('重复释放：遍历逻辑把同一个元素释放了两次');
				alive = false;
				stats.released += 1;
			},
		};
		element.children = (spec.children ?? []).map(make);
		element.children.forEach((child, index) => {
			child.nextSibling = () => element.children[index + 1] ?? null;
		});
		return element;
	}

	return { stats, make };
}

test('一行一个控件，缩进表示层级，带类型/名字/几何', () => {
	const { make } = makeFactory();
	const root = make({
		type: 50032,
		name: '记事本',
		bounds: { left: 10, top: 20, right: 810, bottom: 620 },
		children: [
			{ type: 50000, name: '关闭', bounds: { left: 780, top: 0, right: 810, bottom: 30 } },
		],
	});

	const result = formatTree(root, { maxNodes: 100, maxDepth: 10 });
	const lines = result.text.split('\n');
	assert.equal(lines.length, 2);
	assert.equal(lines[0], 'Window "记事本" 10,20 800x600');
	assert.equal(lines[1], '  Button "关闭" 780,0 30x30');
	assert.equal(result.nodes, 2);
	assert.equal(result.truncated, false);
});

test('屏外与禁用如实标注', () => {
	const { make } = makeFactory();
	const root = make({
		type: 50026,
		children: [{ type: 50000, name: '隐藏按钮', offscreen: true }, { type: 50000, name: '禁用按钮', enabled: false }],
	});
	const lines = formatTree(root, { maxNodes: 10, maxDepth: 5 }).text.split('\n');
	assert.match(lines[1], /\[offscreen\]/u);
	assert.match(lines[2], /\[disabled\]/u);
});

test('节点上限触发截断，且不会继续展开', () => {
	const { make, stats } = makeFactory();
	const children = Array.from({ length: 10 }, (_, index) => ({ type: 50000, name: `b${index}` }));
	const root = make({ type: 50032, children });

	const result = formatTree(root, { maxNodes: 4, maxDepth: 10 });
	assert.equal(result.truncated, true);
	assert.equal(result.nodes, 4);
	// 访问到几个就释放几个：根 + 3 个兄弟
	assert.equal(stats.released, 4);
});

test('层级上限触发截断', () => {
	const { make } = makeFactory();
	const deep = { type: 50026, children: [{ type: 50026, children: [{ type: 50026, children: [{ type: 50000, name: '深' }] }] }] };
	const root = make(deep);
	const result = formatTree(root, { maxNodes: 100, maxDepth: 1 });
	assert.equal(result.truncated, true);
	assert.equal(result.nodes, 2);
});

test('每个访问过的元素恰好释放一次', () => {
	const { make, stats } = makeFactory();
	const root = make({
		type: 50032,
		children: [
			{ type: 50026, children: [{ type: 50000, name: 'a' }, { type: 50000, name: 'b' }] },
			{ type: 50000, name: 'c' },
		],
	});
	formatTree(root, { maxNodes: 100, maxDepth: 10 });
	assert.equal(stats.released, stats.created, `创建 ${stats.created} 个，释放 ${stats.released} 个`);
});

test('未知控件类型退化成 Type#id，而不是丢掉信息', () => {
	const { make } = makeFactory();
	const root = make({ type: 99999, name: '未来控件' });
	assert.match(formatTree(root, { maxNodes: 5, maxDepth: 2 }).text, /Type#99999 "未来控件"/u);
});

test('名字过长时截断，避免单行爆掉上下文', () => {
	const { make } = makeFactory();
	const root = make({ type: 50020, name: 'x'.repeat(500) });
	const line = formatTree(root, { maxNodes: 5, maxDepth: 2 }).text;
	assert.ok(line.length < 260, `单行长度 ${line.length} 应被截断`);
});
