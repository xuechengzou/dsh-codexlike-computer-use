/**
 * 快照存储与失效判定的测试。
 *
 * 这是"绝不按旧坐标再点一次"这条承诺的实现处，所以重点不在 happy path，
 * 而在：控件变了要能识别、过期要能说清原因、淘汰与卸载要把 COM 引用放掉。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSnapshotStore } from '../lib/uia/snapshot.js';
import { isNodeFresh } from '../lib/uia/tree.js';

/** 造一个可控的假元素。 */
function fakeElement({ type = 50000, name = 'OK', left = 0, top = 0, right = 10, bottom = 10 } = {}) {
	const state = { type, name, left, top, right, bottom, released: 0 };
	const element = {
		pointer: 0n,
		controlType: () => state.type,
		name: () => state.name,
		automationId: () => '',
		className: () => '',
		isOffscreen: () => false,
		isEnabled: () => true,
		bounds: () => ({ left: state.left, top: state.top, right: state.right, bottom: state.bottom }),
		invoke: () => ({ ok: true }),
		setValue: () => ({ ok: true }),
		toggle: () => ({ ok: true }),
		select: () => ({ ok: true }),
		firstChild: () => null,
		nextSibling: () => null,
		release: () => {
			state.released += 1;
		},
	};
	return { element, state };
}

/** 造一个节点。 */
function fakeNode(element, id = 'e0') {
	return {
		id,
		depth: 0,
		line: 'Button "OK" 0,0 10x10',
		element,
		fingerprint: { controlType: element.controlType(), name: element.name(), bounds: element.bounds() },
	};
}

test('新建快照后可解析，指纹匹配即有效', () => {
	const store = createSnapshotStore();
	const { element } = fakeElement();
	const snapshot = store.create('123', [fakeNode(element)], false);
	assert.equal(snapshot.id, 's1');
	const resolved = store.resolve('s1', 'e0');
	assert.equal(resolved.ok, true);
});

test('控件名字变化 → stale', () => {
	const store = createSnapshotStore();
	const { element, state } = fakeElement();
	store.create('123', [fakeNode(element)], false);
	state.name = 'Cancel';
	const resolved = store.resolve('s1', 'e0');
	assert.deepEqual(resolved, { ok: false, reason: 'stale' });
});

test('控件位置变化 → stale', () => {
	const store = createSnapshotStore();
	const { element, state } = fakeElement();
	store.create('123', [fakeNode(element)], false);
	state.left = 40;
	assert.equal(store.resolve('s1', 'e0').ok, false);
});

test('未知快照与未知节点给出不同原因', () => {
	const store = createSnapshotStore();
	const { element } = fakeElement();
	store.create('123', [fakeNode(element)], false);
	assert.deepEqual(store.resolve('s9', 'e0'), { ok: false, reason: 'unknown-snapshot' });
	assert.deepEqual(store.resolve('s1', 'e7'), { ok: false, reason: 'unknown-node' });
});

test('过期快照在解析时报 expired 并释放元素', () => {
	let clock = 1_000;
	const store = createSnapshotStore({ ttlMs: 100 }, () => clock);
	const { element, state } = fakeElement();
	store.create('123', [fakeNode(element)], false);
	clock += 200;
	assert.deepEqual(store.resolve('s1', 'e0'), { ok: false, reason: 'expired-snapshot' });
	assert.equal(state.released, 1, '过期即释放');
});

test('超过上限时淘汰最旧的一份并释放', () => {
	const store = createSnapshotStore({ maxSnapshots: 2 });
	const first = fakeElement();
	const second = fakeElement();
	const third = fakeElement();
	store.create('1', [fakeNode(first.element)], false);
	store.create('2', [fakeNode(second.element)], false);
	store.create('3', [fakeNode(third.element)], false);
	assert.equal(first.state.released, 1, '最旧的一份应被释放');
	assert.equal(second.state.released, 0);
	assert.equal(third.state.released, 0);
});

test('dispose 释放全部元素', () => {
	const store = createSnapshotStore();
	const a = fakeElement();
	const b = fakeElement();
	store.create('1', [fakeNode(a.element)], false);
	store.create('2', [fakeNode(b.element)], false);
	store.dispose();
	assert.equal(a.state.released, 1);
	assert.equal(b.state.released, 1);
	assert.equal(store.get('s1'), undefined);
});

test('isNodeFresh 对未变化的节点返回 true', () => {
	const { element } = fakeElement();
	assert.equal(isNodeFresh(fakeNode(element)), true);
});
