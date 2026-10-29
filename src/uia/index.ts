/**
 * UIA 的加载与树读取入口。
 *
 * 三条刻意为之：
 *
 * 1. **延迟加载**。`koffi` 是原生模块，只在第一次真要读树时才 import：
 *    缺原生模块、或跑在非 Windows 上时，插件其余部分照常工作，报错只落在
 *    这一次调用上。
 * 2. **单例**。每次读树都 CoInitializeEx + CoCreateInstance 太贵（实测几十毫秒），
 *    因此成功后就一直复用；失败**不缓存**，否则一次瞬时失败会让进程里永久
 *    "UIA 不可用"。
 * 3. **句柄校验**。模型给的 handle 是字符串，`BigInt()` 会接受 `"12abc"` 之外的
 *    东西也可能抛错——统一在这里收口，错误信息写清楚。
 */

import { createUia, type KoffiLike, type Uia } from './com.js';
import { DEFAULT_TREE_OPTIONS, formatTree, walkTree, type TreeOptions, type TreeResult, type WalkedNode } from './tree.js';

/** 成功建立的会话；失败不会被记住。 */
let pending: Promise<Uia> | undefined;

/**
 * 取（或建立）UIA 会话。
 *
 * @returns 会话对象。
 * @throws 非 Windows、或系统不提供 UIAutomation 时。
 */
export function loadUia(): Promise<Uia> {
	if (pending === undefined) {
		const created = (async () => {
			if (process.platform !== 'win32') {
				throw new Error(`可访问性树只实现了 Windows 后端（当前平台 ${process.platform}）`);
			}
			const module = await import('koffi');
			const koffi = (module as { default?: unknown }).default ?? module;
			return createUia(koffi as KoffiLike);
		})();
		pending = created;
		// 失败时清掉缓存，下一次调用重新尝试
		void created.catch(() => {
			if (pending === created) pending = undefined;
		});
	}
	return pending;
}

/**
 * 读取一个窗口的可访问性树，并**保留**元素引用。
 *
 * 调用方（快照存储）负责释放；不要在同一批节点上再调 `formatTree`。
 *
 * @param handle - 十进制窗口句柄。
 * @param options - 节点/深度上限。
 * @returns 节点表与截断标记。
 */
export async function readWindowNodes(handle: string, options: Partial<TreeOptions> = {}): Promise<{ nodes: WalkedNode[]; truncated: boolean }> {
	const target = parseHandle(handle);
	const uia = await loadUia();
	const root = uia.elementFromHandle(target);
	if (root === null) {
		throw new Error(`窗口 ${handle} 没有可访问性根元素：它可能已经关闭，或不实现 UIA 提供程序`);
	}
	return walkTree(root, { ...DEFAULT_TREE_OPTIONS, ...options });
}

/**
 * 解析模型给出的窗口句柄。
 *
 * @param handle - 十进制字符串。
 * @returns 句柄值。
 */
function parseHandle(handle: string): bigint {
	let target: bigint;
	try {
		target = BigInt(handle.trim());
	} catch {
		throw new Error(`可访问性树需要一个十进制窗口句柄，收到 ${JSON.stringify(handle)}`);
	}
	if (target <= 0n) throw new Error(`窗口句柄必须为正数，收到 ${handle}`);
	return target;
}

/**
 * 读取一个窗口的可访问性树。
 *
 * @param handle - 十进制窗口句柄（`computer_observe` 的窗口列表里给的那个）。
 * @param options - 节点/深度上限，缺省用内置值。
 * @returns 缩进文本与统计。
 * @throws 句柄非法、窗口没有 UIA 根元素、或 UIA 不可用时。
 */
export async function readWindowTree(handle: string, options: Partial<TreeOptions> = {}): Promise<TreeResult> {
	let target: bigint;
	try {
		target = BigInt(handle.trim());
	} catch {
		throw new Error(`可访问性树需要一个十进制窗口句柄，收到 ${JSON.stringify(handle)}`);
	}
	if (target <= 0n) throw new Error(`窗口句柄必须为正数，收到 ${handle}`);

	const uia = await loadUia();
	const root = uia.elementFromHandle(target);
	if (root === null) {
		throw new Error(`窗口 ${handle} 没有可访问性根元素：它可能已经关闭，或不实现 UIA 提供程序`);
	}
	return formatTree(root, { ...DEFAULT_TREE_OPTIONS, ...options });
}
