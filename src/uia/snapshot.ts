/**
 * 快照存储：把一次 `computer_observe` 的树节点留在内存里，供随后的元素级动作使用。
 *
 * 为什么要保留 COM 元素而不是只留路径：路径重走一次要几十到几百毫秒，而动作
 * 前只需要读 3 个属性就能判断"还是不是同一个控件"。代价是要管生命周期，
 * 因此这里明确三条纪律：
 *
 * 1. **上限与 TTL**。最多留 3 份快照、5 分钟过期；淘汰时释放全部元素。
 * 2. **失效不猜**。动作前用 `isNodeFresh` 校验；不新鲜就报错让模型重新观察，
 *    绝不"按旧坐标再点一次"。
 * 3. **卸载即释放**。插件卸载时必须 `dispose()`，否则这些引用活到进程结束。
 */

import { isNodeFresh, type WalkedNode } from './tree.js';

/** 一份快照。 */
export interface Snapshot {
	/** 快照 id，形如 `s1`。 */
	readonly id: string;
	/** 目标窗口句柄（十进制字符串）。 */
	readonly target: string;
	/** 建立时间（毫秒）。 */
	readonly createdAt: number;
	/** 节点表，按遍历顺序。 */
	readonly nodes: Map<string, WalkedNode>;
	/** 树是否被截断。 */
	readonly truncated: boolean;
}

/** 存储上限。 */
export interface SnapshotLimits {
	/** 最多保留几份快照。 */
	maxSnapshots: number;
	/** 过期毫秒数。 */
	ttlMs: number;
}

/** 默认上限。 */
export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = { maxSnapshots: 3, ttlMs: 5 * 60_000 };

/** 快照存储。 */
export interface SnapshotStore {
	/**
	 * 登记一份新快照，并接管节点元素的所有权。
	 *
	 * @param target - 目标窗口句柄。
	 * @param nodes - 遍历结果。
	 * @param truncated - 树是否被截断。
	 * @returns 新快照。
	 */
	create(target: string, nodes: WalkedNode[], truncated: boolean): Snapshot;
	/** 取一份未过期的快照。 */
	get(id: string): Snapshot | undefined;
	/**
	 * 取一个节点，并确认它仍然有效。
	 *
	 * @param snapshotId - 快照 id。
	 * @param nodeId - 节点 id（`e12`）。
	 * @returns 校验结果：节点、或明确的失败原因。
	 */
	resolve(snapshotId: string, nodeId: string): { ok: true; snapshot: Snapshot; node: WalkedNode }
		| { ok: false; reason: 'unknown-snapshot' | 'expired-snapshot' | 'unknown-node' | 'stale' };
	/** 释放全部元素。 */
	dispose(): void;
}

/**
 * 建立快照存储。
 *
 * @param limits - 上限覆盖。
 * @param now - 时间源（测试注入）。
 * @returns 存储对象。
 */
export function createSnapshotStore(limits: Partial<SnapshotLimits> = {}, now: () => number = Date.now): SnapshotStore {
	const resolved: SnapshotLimits = { ...DEFAULT_SNAPSHOT_LIMITS, ...limits };
	const snapshots = new Map<string, Snapshot>();
	let counter = 0;

	/** 释放一份快照的全部元素。 */
	const release = (snapshot: Snapshot): void => {
		for (const node of snapshot.nodes.values()) node.element.release();
	};

	/** 淘汰过期与超量的快照。 */
	const evict = (): void => {
		const current = now();
		for (const [id, snapshot] of snapshots) {
			if (current - snapshot.createdAt > resolved.ttlMs) {
				release(snapshot);
				snapshots.delete(id);
			}
		}
		while (snapshots.size > resolved.maxSnapshots) {
			const oldest = snapshots.keys().next();
			if (oldest.done === true) break;
			const snapshot = snapshots.get(oldest.value)!;
			release(snapshot);
			snapshots.delete(oldest.value);
		}
	};

	return {
		create(target, nodes, truncated) {
			evict();
			counter += 1;
			const snapshot: Snapshot = {
				id: `s${counter}`,
				target,
				createdAt: now(),
				nodes: new Map(nodes.map((node) => [node.id, node])),
				truncated,
			};
			snapshots.set(snapshot.id, snapshot);
			evict();
			return snapshot;
		},
		get(id) {
			const snapshot = snapshots.get(id);
			if (snapshot === undefined) return undefined;
			if (now() - snapshot.createdAt > resolved.ttlMs) {
				release(snapshot);
				snapshots.delete(id);
				return undefined;
			}
			return snapshot;
		},
		resolve(snapshotId, nodeId) {
			const snapshot = snapshots.get(snapshotId);
			if (snapshot === undefined) return { ok: false, reason: 'unknown-snapshot' };
			if (now() - snapshot.createdAt > resolved.ttlMs) {
				release(snapshot);
				snapshots.delete(snapshotId);
				return { ok: false, reason: 'expired-snapshot' };
			}
			const node = snapshot.nodes.get(nodeId);
			if (node === undefined) return { ok: false, reason: 'unknown-node' };
			if (!isNodeFresh(node)) return { ok: false, reason: 'stale' };
			return { ok: true, snapshot, node };
		},
		dispose() {
			for (const snapshot of snapshots.values()) release(snapshot);
			snapshots.clear();
		},
	};
}
