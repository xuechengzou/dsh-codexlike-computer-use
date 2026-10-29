/**
 * 把 UI Automation 元素树序列化成模型可读的缩进文本，并提供可保留的节点表。
 *
 * 输出契约刻意保守：
 * - **有界**。节点数与深度都有上限，超了标 `truncated`。
 * - **一行一个控件**，缩进即层级。
 * - **屏外与禁用如实标注**，避免模型去点一个 `0x0` 的按钮。
 *
 * 两种用法：
 * - `formatTree`：只取文本，遍历中释放全部元素。
 * - `walkTree`：保留元素引用（供随后的元素级动作使用），**所有权交给调用方**，
 *   由快照存储负责释放。漏释放就是 COM 泄漏，所以这里把两种路径分开写清楚。
 */

import type { UiaBounds, UiaElement } from './com.js';

/** 常见控件类型 id → 名字。 */
const CONTROL_TYPE_NAMES = new Map<number, string>([
	[50000, 'Button'], [50001, 'Calendar'], [50002, 'CheckBox'], [50003, 'ComboBox'],
	[50004, 'Edit'], [50005, 'Hyperlink'], [50006, 'Image'], [50007, 'ListItem'],
	[50008, 'List'], [50009, 'Menu'], [50010, 'MenuBar'], [50011, 'MenuItem'],
	[50012, 'ProgressBar'], [50013, 'RadioButton'], [50014, 'ScrollBar'], [50015, 'Slider'],
	[50016, 'Spinner'], [50017, 'StatusBar'], [50018, 'Tab'], [50019, 'TabItem'],
	[50020, 'Text'], [50021, 'ToolBar'], [50022, 'ToolTip'], [50023, 'Tree'],
	[50024, 'TreeItem'], [50025, 'Custom'], [50026, 'Group'], [50027, 'Thumb'],
	[50028, 'DataGrid'], [50029, 'DataItem'], [50030, 'Document'], [50031, 'SplitButton'],
	[50032, 'Window'], [50033, 'Pane'], [50034, 'Header'], [50035, 'HeaderItem'],
	[50036, 'Table'], [50037, 'TitleBar'], [50038, 'Separator'],
]);

/** 序列化选项。 */
export interface TreeOptions {
	/** 最多输出多少个节点。 */
	maxNodes: number;
	/** 最大层级；根为 0。 */
	maxDepth: number;
}

/** 一个被遍历到的节点。 */
export interface WalkedNode {
	/** 快照内的稳定 id（`e0`、`e1`…）。 */
	id: string;
	/** 层级，根为 0。 */
	depth: number;
	/** 渲染好的一行文本（不含缩进）。 */
	line: string;
	/** 元素引用；`walkTree` 的调用方负责释放。 */
	element: UiaElement;
	/** 建立快照时读到的特征值，用于判定失效。 */
	fingerprint: {
		controlType: number;
		name: string;
		bounds: UiaBounds | undefined;
	};
}

/** `walkTree` 的结果。 */
export interface WalkResult {
	nodes: WalkedNode[];
	truncated: boolean;
}

/** `formatTree` 的结果。 */
export interface TreeResult {
	text: string;
	nodes: number;
	truncated: boolean;
}

/** 默认上限。 */
export const DEFAULT_TREE_OPTIONS: TreeOptions = { maxNodes: 400, maxDepth: 12 };

/**
 * 单行描述。
 *
 * @param element - 元素。
 * @returns 一行文本（不含缩进）。
 */
function describe(element: UiaElement): string {
	const type = CONTROL_TYPE_NAMES.get(element.controlType()) ?? `Type#${element.controlType()}`;
	const name = element.name();
	const parts = [type];
	if (name !== '') parts.push(JSON.stringify(name.slice(0, 200)));

	const bounds = element.bounds();
	if (bounds !== undefined) {
		parts.push(`${bounds.left},${bounds.top} ${bounds.right - bounds.left}x${bounds.bottom - bounds.top}`);
	}

	const flags = [];
	if (element.isOffscreen()) flags.push('offscreen');
	if (!element.isEnabled()) flags.push('disabled');
	if (flags.length > 0) parts.push(`[${flags.join(',')}]`);
	return parts.join(' ');
}

/**
 * 遍历一棵子树并**保留**每个元素引用。
 *
 * @param root - 根元素。
 * @param options - 上限。
 * @returns 节点表；调用方必须释放每个 `element`。
 */
export function walkTree(root: UiaElement, options: TreeOptions = DEFAULT_TREE_OPTIONS): WalkResult {
	const nodes: WalkedNode[] = [];
	let truncated = false;

	/**
	 * 深度优先展开。
	 *
	 * @param element - 当前元素（本函数不释放）。
	 * @param depth - 层级。
	 */
	const visit = (element: UiaElement, depth: number): void => {
		if (nodes.length >= options.maxNodes) {
			truncated = true;
			return;
		}
		const controlType = element.controlType();
		const name = element.name();
		const bounds = element.bounds();
		nodes.push({
			id: `e${nodes.length}`,
			depth,
			line: describe(element),
			element,
			fingerprint: { controlType, name, bounds },
		});

		if (depth >= options.maxDepth) {
			const probe = element.firstChild();
			if (probe !== null) {
				truncated = true;
				probe.release();
			}
			return;
		}

		let child = element.firstChild();
		while (child !== null) {
			const next = child.nextSibling();
			visit(child, depth + 1);
			child = next;
			if (nodes.length >= options.maxNodes) {
				truncated = true;
				break;
			}
		}
	};

	visit(root, 0);
	return { nodes, truncated };
}

/**
 * 序列化一棵子树，遍历后释放全部元素。
 *
 * @param root - 根元素。
 * @param options - 上限。
 * @returns 文本与统计。
 */
export function formatTree(root: UiaElement, options: TreeOptions = DEFAULT_TREE_OPTIONS): TreeResult {
	const walked = walkTree(root, options);
	const lines = walked.nodes.map((node) => `${'  '.repeat(node.depth)}${node.line}`);
	for (const node of walked.nodes) node.element.release();
	return { text: lines.join('\n'), nodes: walked.nodes.length, truncated: walked.truncated };
}

/**
 * 把保留的节点表渲染成文本。
 *
 * @param nodes - walkTree 的结果。
 * @returns 缩进文本。
 */
export function formatWalked(nodes: readonly WalkedNode[]): string {
	return nodes.map((node) => `${'  '.repeat(node.depth)}[${node.id}] ${node.line}`).join('\n');
}

/**
 * 判断一个保留的节点是否仍然指向同一个控件。
 *
 * 只比控件类型、名字与包围盒：这三者在"控件被销毁/界面被重建/列表滚动"时
 * 都会变，而它们是读一次就能拿到的，不需要把整棵树重走一遍。
 *
 * @param node - 快照里的节点。
 * @returns 是否仍然有效。
 */
export function isNodeFresh(node: WalkedNode): boolean {
	const current = node.fingerprint;
	if (node.element.controlType() !== current.controlType) return false;
	if (node.element.name() !== current.name) return false;
	const bounds = node.element.bounds();
	if (current.bounds === undefined) return bounds === undefined;
	if (bounds === undefined) return false;
	return bounds.left === current.bounds.left
		&& bounds.top === current.bounds.top
		&& bounds.right === current.bounds.right
		&& bounds.bottom === current.bounds.bottom;
}
