/**
 * 两个面向模型的工具：`computer_observe` 与 `computer_act`。
 *
 * 为什么拆成两件而不是继续用单工具 + `action` 判别式：
 *
 * - **读与写可以分别受约束**。观察永远是安全的（截图、列窗口、读可访问性树），
 *   而动作会改变用户的机器。合成一个工具时，"允不允许看"与"允不允许动"只能
 *   绑在同一个名字上；拆开后策略、提示词与结果外壳都能各按各的风险设计。
 * - **两边的参数天然不同**。观察要 `region` / `limit`，动作要坐标、文本、按键；
 *   合在一起的 schema 里有一半字段对当前动作永远无意义。
 *
 * 两个工具都通过 `runComputerAction` 落到同一套动作实现上——语义只有一份，
 * 不存在"观察路径与动作路径对同一件事给出不同行为"的可能。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { ConfigValues } from './config.js';
import type { StateStore } from './state.js';
import { readWindowNodes } from './uia/index.js';
import { createSnapshotStore } from './uia/snapshot.js';
import { formatWalked, type WalkedNode } from './uia/tree.js';
import {
	OUTPUT_SCHEMA,
	renderComputerValue,
	runComputerAction,
	type ComputerArgs,
	type BackgroundCapture,
	type ComputerValue,
	type RunContext,
} from './tool.js';

/** 动作工具接受的动作；顺序即提示词里的展示顺序。 */
export const ACT_ACTIONS = [
	'click',
	'double_click',
	'right_click',
	'middle_click',
	'move',
	'drag',
	'toggle',
	'select',
	'scroll',
	'type',
	'press',
	'hold',
	'wait',
] as const;

/** 动作工具的动作名。 */
export type ActAction = (typeof ACT_ACTIONS)[number];

/** 会产生输入的动作；`wait` 不在其中，因此观察与等待不受输入模式约束。 */
const INPUT_ACTIONS = new Set<ActAction>([
	'click',
	'double_click',
	'right_click',
	'middle_click',
	'move',
	'drag',
	'scroll',
	'type',
	'press',
	'hold',
]);

/** 动作工具的原始参数。 */
interface ActArgs {
	action: ActAction;
	target?: string;
	x?: number;
	y?: number;
	snapshot?: string;
	element?: string;
	start_x?: number;
	start_y?: number;
	end_x?: number;
	end_y?: number;
	text?: string;
	keys?: string;
	scroll_direction?: 'up' | 'down' | 'left' | 'right';
	scroll_amount?: number;
	duration_ms?: number;
}

/** 观察工具的原始参数。 */
interface ObserveArgs {
	target?: string;
	region?: { x: number; y: number; width: number; height: number };
	limit?: number;
	tree?: boolean;
}

/** 反查用：动作名 → 旧式动作名。 */
const ACTION_ALIASES: Partial<Record<ActAction, ComputerArgs['action']>> = {
	click: 'left_click',
	double_click: 'double_click',
	right_click: 'right_click',
	middle_click: 'middle_click',
	move: 'mouse_move',
	drag: 'left_click_drag',
	scroll: 'scroll',
	type: 'type',
	press: 'key',
	hold: 'hold_key',
	wait: 'wait',
};

const OBSERVE_DESCRIPTION = [
	'Read the Windows desktop or one window: list targets, capture pixels.',
	'This never moves the cursor, never changes focus, and never sends input — it is safe to call at any time.',
	'',
	'- `{"target":"windows"}` lists operable top-level windows (handle, title, class, rect, minimized). Read-only.',
	'- Omit `target` to capture the screen. Add `region` to capture a rectangle and save tokens.',
	'- Pass a handle from the list to capture **that window** by its own rendering (`PrintWindow`), so it does not need to be in front. It must have been on screen at least once and must not be minimized.',
	'',
	'Screenshots come back as images. Read coordinates off the image; the text envelope states any scale conversion — do not guess it.',
'',
'Add `"tree":true` with a window target to also get that window\'s accessibility tree as indented text: control type, name, bounds, and whether it is offscreen or disabled. The tree costs tokens but tells you exactly which control is where, so it is usually cheaper than guessing from pixels alone.',
].join('\n');

const ACT_DESCRIPTION = [
	'Drive the Windows desktop mouse and keyboard.',
	'',
	'Which channel is allowed depends on the user\'s current input mode (a switch in the UI, not something you choose):',
	'- WINDOW mode (default): every action needs `target` — the handle of a window from `computer_observe {"target":"windows"}`. Input is delivered to that window without moving the cursor or taking the foreground, and the result says how far to trust it (`reliable`, `note`).',
	'- FOREGROUND mode: `target` is rejected. Actions inject real input at screen coordinates, moving the user\'s cursor and stealing focus.',
	'- BOTH: `target` selects window mode, omitting it selects foreground mode.',
	'',
	'Rules that prevent silent failure:',
	'- Click coordinates are the pixels you read from the most recent capture of the same target. For a window target the tool converts image pixels back to client coordinates itself; do not pre-scale them.',
	'- For text in window mode, the tool types into the window\'s text control; if it cannot find one the result says so — do not assume the text landed.',
	'- After an action, check `target` in the result: it names the window that actually received the input. If it is not the one you meant, stop and re-observe instead of repeating the action.',
	'- `wait` needs no target and is never gated by the input mode.',
	'',
	'This drives the user\'s live machine. Do not click or type anything that deletes data, sends messages, completes purchases, or changes account or system settings unless the user asked for that exact outcome.',
].join('\n');

/**
 * 注册两个工具。
 *
 * @param ctx - 插件上下文。
 * @param config - 已解析配置；作为部署默认值使用。
 * @param state - 运行时状态；决定此刻允许哪条输入通道。
 */
export function registerTools(ctx: Context, config: ConfigValues, state: StateStore): void {
	/**
	 * 每个工具实例各自持有后台截图映射。
	 *
	 * 放在注册闭包里而不是模块级：它是**单个插件实例的会话内状态**，
	 * 不同 profile / 不同会话之间不该看到对方的截图。
	 */
	const captures = new Map<string, BackgroundCapture>();

	/** 可访问性树快照；元素动作靠它定位控件并判定失效。 */
	const snapshots = createSnapshotStore();
	const effect = (ctx as { effect?: (fn: () => () => void) => unknown }).effect;
	if (typeof effect === 'function') effect.call(ctx, () => () => snapshots.dispose());

	/** 观察工具。 */
	const observe = defineTool({
		name: 'computer_observe',
		description: OBSERVE_DESCRIPTION,
		timeoutMs: 180_000,

		parameters: {
			target: {
				type: 'string',
				description: 'Either the literal `windows` to list operable windows, or a window handle from that list to capture that window. Omit to capture the screen.',
			},
			region: {
				type: 'object',
				additionalProperties: false,
				description: 'Restrict a screen capture to this rectangle, in screen pixels (screen captures only).',
				properties: {
					x: { type: 'integer', required: true },
					y: { type: 'integer', required: true },
					width: { type: 'integer', required: true },
					height: { type: 'integer', required: true },
				},
			},
			limit: { type: 'integer', description: 'windows only: how many windows to list; capped by the deployment limit.' },
			tree: { type: 'boolean', description: 'Window captures only: also return the accessibility tree as indented text. Bounded by the deployment node/depth limits.' },
		},

		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args: unknown, value: ComputerValue) => renderComputerValue(value),
			presentationMeta: (_args: unknown, value: ComputerValue) => ({ action: value.action, summary: value.summary }),
		},

		isConcurrencySafe: () => false,

		async execute(args: ObserveArgs, exec: RunContext): Promise<ComputerValue> {
			if (args.target === 'windows') {
				if (args.tree === true) throw new Error('tree 只对单个窗口有效：先用 {"target":"windows"} 选一个窗口，再带该句柄调用');
				return await runComputerAction({ action: 'window', limit: args.limit }, exec, ctx, config, captures);
			}
			if (args.target === undefined) {
				if (args.tree === true) throw new Error('tree 需要窗口句柄：屏幕截图没有唯一的可访问性根节点');
				return await runComputerAction({ action: 'screenshot', region: args.region }, exec, ctx, config, captures);
			}

			const value = await runComputerAction({ action: 'screenshot', target: args.target }, exec, ctx, config, captures);
			if (args.tree === true) {
				try {
					const walked = await readWindowNodes(args.target, {
						maxNodes: config.treeNodeLimit,
						maxDepth: config.treeDepthLimit,
					});
					const snapshot = snapshots.create(args.target, walked.nodes, walked.truncated);
					value.snapshot = snapshot.id;
					value.tree = formatWalked(walked.nodes);
					value.treeNodes = walked.nodes.length;
					if (walked.truncated) value.treeTruncated = true;
					value.summary = `${value.summary} Accessibility tree: ${walked.nodes.length} node(s)${walked.truncated ? ' (truncated)' : ''}, snapshot ${snapshot.id}.`;
				} catch (error) {
					// 截图已经成功，不因为树读不到就把它丢掉；原因单独成字段，
					// 由 render 作为独立文本块送出（summary 在截图分支里不会被渲染）
					value.treeError = error instanceof Error ? error.message : String(error);
				}
			}
			return value;
		},

		presentCall(args: ObserveArgs) {
			const title = args.target === 'windows'
				? 'List windows'
				: args.target === undefined
					? 'Capture screen'
					: `Capture window ${args.target}`;
			return { card: 'generic', title, kind: 'read', rawInput: args };
		},
	});

	/** 动作工具。 */
	const act = defineTool({
		name: 'computer_act',
		description: ACT_DESCRIPTION,
		timeoutMs: 180_000,

		parameters: {
			action: {
				type: 'string',
				required: true,
				enum: [...ACT_ACTIONS],
				description: 'The gesture to perform.',
			},
			target: {
				type: 'string',
				description: 'Window handle from `computer_observe {"target":"windows"}`. Required in window mode, rejected in foreground mode.',
			},
			x: { type: 'integer', description: 'Pointer X: image pixels when `target` is given, screen pixels in foreground mode.' },
			y: { type: 'integer', description: 'Pointer Y (see `x`).' },
			start_x: { type: 'integer', description: 'drag only: start X.' },
			start_y: { type: 'integer', description: 'drag only: start Y.' },
			end_x: { type: 'integer', description: 'drag only: end X; alias of `x` when `x` is absent.' },
			end_y: { type: 'integer', description: 'drag only: end Y; alias of `y` when `y` is absent.' },
			text: { type: 'string', description: 'type only: literal text. Unicode is sent as-is, so any language works.' },
			keys: { type: 'string', description: 'press/hold only: a key or chord such as "Return", "Escape", "Tab", "F5", "ctrl+c", "ctrl+shift+s", "alt+Tab".' },
			scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'scroll only: which way.' },
			scroll_amount: { type: 'integer', description: 'scroll only: wheel notches; default 3.' },
			duration_ms: { type: 'integer', description: 'wait: milliseconds to pause. hold: how long to keep the chord down.' },
		},

		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args: unknown, value: ComputerValue) => renderComputerValue(value),
			presentationMeta: (_args: unknown, value: ComputerValue) => ({ action: value.action, summary: value.summary }),
		},

		isConcurrencySafe: () => false,

		async execute(args: ActArgs, exec: RunContext): Promise<ComputerValue> {
			if (args.element !== undefined) {
				if (args.snapshot === undefined) {
					throw new Error('元素级动作需要 snapshot：先用 computer_observe 带 tree:true 观察该窗口，结果里有 snapshot 与 [eN] 节点 id');
				}
				const resolved = snapshots.resolve(args.snapshot, args.element);
				if (!resolved.ok) throw new Error(explainStale(resolved.reason, args.snapshot, args.element));
				return runElementAction(args, resolved.node);
			}

			const current = state.get();
			const allowInput = config.allowInput && current.allowInput;

			if (INPUT_ACTIONS.has(args.action)) {
				if (!allowInput) {
					throw new Error(
						'computer-use: 输入模拟已被关闭（allowInput / 设置界面开关），当前只能观察；'
						+ '需要动手时请让用户在设置里打开输入',
					);
				}
				if (current.inputMode === 'window' && args.target === undefined) {
					throw new Error(
						'computer-use: 当前是窗口模式，所有输入动作都要带 target（窗口句柄）。'
						+ '先调用 computer_observe {"target":"windows"} 列出窗口，把 handle 原样传进来；'
						+ '若确实需要前台模式（会移动用户光标、抢焦点），由用户在设置界面切换模式。本次未执行任何输入',
					);
				}
				if (current.inputMode === 'foreground' && args.target !== undefined) {
					throw new Error(
						'computer-use: 当前是前台模式，不接受 target。去掉 target 并按屏幕坐标操作；'
						+ '要改用窗口模式请让用户在设置界面切换。本次未执行任何输入',
					);
				}
			}

			// 引擎仍然按"有没有 target"分流；模式只决定 target 允许不允许出现，
			// 因此这里把运行时模式折算回引擎认识的两个开关。
			const effective: ConfigValues = {
				...config,
				allowInput,
				allowForegroundInput: current.inputMode !== 'window',
			};

			return await runComputerAction(toLegacyArgs(args), exec, ctx, effective, captures);
		},

		presentCall(args: ActArgs) {
			return { card: 'generic', title: describeAct(args), kind: 'execute', rawInput: args };
		},
	});

	ctx.tools.register(observe);
	ctx.tools.register(act);
}


/**
 * 把快照校验失败翻译成模型能照做的动作。
 *
 * @param reason - 失败原因。
 * @param snapshotId - 快照 id。
 * @param nodeId - 节点 id。
 * @returns 错误文本。
 */
function explainStale(reason: string, snapshotId: string, nodeId: string): string {
	switch (reason) {
		case 'unknown-snapshot':
			return `快照 ${snapshotId} 不存在（可能已过期或被新的观察淘汰）。重新调用 computer_observe 再动作`;
		case 'expired-snapshot':
			return `快照 ${snapshotId} 已过期。重新调用 computer_observe 再动作`;
		case 'unknown-node':
			return `快照 ${snapshotId} 里没有节点 ${nodeId}。用结果里的 [eN] id`;
		case 'stale':
			return `节点 ${nodeId} 指向的控件已经变了（类型/名称/位置与观察时不一致）。不要按旧快照继续动作，重新调用 computer_observe`;
		default:
			return `快照校验失败：${reason}`;
	}
}

/**
 * 执行一次元素级动作（走 UIA pattern，不碰光标）。
 *
 * @param args - 动作参数。
 * @param node - 已校验有效的快照节点。
 * @returns 工具输出值。
 */
function runElementAction(args: ActArgs, node: WalkedNode): ComputerValue {
	const base = {
		action: `element_${args.action}`,
		element: { id: node.id, line: node.line },
	};

	switch (args.action) {
		case 'click': {
			const outcome = node.element.invoke();
			if (!outcome.ok) throw patternError('Invoke', node, outcome);
			return { ...base, pattern: 'Invoke', summary: `Invoked ${node.line}.` };
		}
		case 'type': {
			const text = args.text ?? '';
			if (text === '') throw new Error('元素级 type 需要 text');
			const outcome = node.element.setValue(text);
			if (!outcome.ok) throw patternError('Value.SetValue', node, outcome);
			return { ...base, pattern: 'Value', summary: `Set text of ${node.line} to ${JSON.stringify(text)}.` };
		}
		case 'toggle': {
			const outcome = node.element.toggle();
			if (!outcome.ok) throw patternError('Toggle', node, outcome);
			return { ...base, pattern: 'Toggle', summary: `Toggled ${node.line}.` };
		}
		case 'select': {
			const outcome = node.element.select();
			if (!outcome.ok) throw patternError('SelectionItem.Select', node, outcome);
			return { ...base, pattern: 'SelectionItem', summary: `Selected ${node.line}.` };
		}
		default:
			throw new Error(`元素级动作只支持 click / type / toggle / select，收到 ${args.action}`);
	}
}

/**
 * 把 pattern 失败翻译成可执行的建议。
 *
 * @param pattern - pattern 名称。
 * @param node - 目标节点。
 * @param outcome - 失败结果。
 * @returns 错误。
 */
function patternError(pattern: string, node: WalkedNode, outcome: { reason: string; hresult?: number }): Error {
	if (outcome.reason === 'unsupported') {
		return new Error(`控件 ${node.id} 不支持 ${pattern}（它没有暴露该 pattern）。改用坐标点击，或换一个控件`);
	}
	const code = outcome.hresult === undefined ? '' : `（HRESULT 0x${(outcome.hresult >>> 0).toString(16)}）`;
	return new Error(`${pattern} 在 ${node.id} 上执行失败${code}`);
}

/**
 * 把动作工具的参数映射成引擎认识的旧式动作。
 *
 * @param args - 动作工具参数。
 * @returns 引擎参数。
 */
function toLegacyArgs(args: ActArgs): ComputerArgs {
	const mapped = ACTION_ALIASES[args.action];
	if (mapped === undefined) throw new Error(`动作 ${args.action} 只支持元素级调用（需要 snapshot + element）`);
	const legacy: ComputerArgs = { action: mapped };
	if (args.target !== undefined) legacy.target = args.target;
	if (args.x !== undefined) legacy.x = args.x;
	if (args.y !== undefined) legacy.y = args.y;
	if (args.start_x !== undefined) legacy.start_x = args.start_x;
	if (args.start_y !== undefined) legacy.start_y = args.start_y;
	if (args.end_x !== undefined) legacy.end_x = args.end_x;
	if (args.end_y !== undefined) legacy.end_y = args.end_y;
	if (args.text !== undefined) legacy.text = args.text;
	if (args.keys !== undefined) legacy.keys = args.keys;
	if (args.scroll_direction !== undefined) legacy.scroll_direction = args.scroll_direction;
	if (args.scroll_amount !== undefined) legacy.scroll_amount = args.scroll_amount;
	if (args.duration_ms !== undefined) legacy.duration_ms = args.duration_ms;
	return legacy;
}

/**
 * 工具卡片标题。
 *
 * @param args - 动作工具参数。
 * @returns 一行标题。
 */
function describeAct(args: ActArgs): string {
	switch (args.action) {
		case 'type': {
			const preview = (args.text ?? '').replace(/\s+/gu, ' ').slice(0, 40);
			return `Type "${preview}${(args.text ?? '').length > 40 ? '…' : ''}"`;
		}
		case 'press':
		case 'hold':
			return `${args.action === 'press' ? 'Press' : 'Hold'} ${args.keys ?? ''}`.trim();
		case 'scroll':
			return `Scroll ${args.scroll_direction ?? 'down'} ${args.scroll_amount ?? 3}`;
		case 'drag':
			return `Drag ${args.start_x},${args.start_y} → ${args.x ?? args.end_x},${args.y ?? args.end_y}`;
		case 'wait':
			return `Wait ${args.duration_ms ?? 1000}ms`;
		case 'move':
			return `Move pointer to ${args.x},${args.y}`;
		default:
			return args.x === undefined ? args.action : `${args.action} at ${args.x},${args.y}`;
	}
}
