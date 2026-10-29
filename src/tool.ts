/**
 * `computer` 工具：一次调用完成一个桌面动作。
 *
 * 采用单一工具 + `action` 判别式，而不是把每个动作用一个工具：computer use
 * 的动作集天然是一个整体（看 → 点 → 打 → 再看），合并后工具列表更短、
 * 审批与提示词也更集中，这正是现行 Codex / Anthropic computer use 的形状。
 *
 * 每个动作都返回**它到底作用在哪个窗口**（`target`）以及当时的光标位置。
 * 这不是装饰：焦点错位是 GUI 自动化最常见的失败，把接收者如实报出来，
 * 模型才有依据判断"我以为点在记事本上，其实点到了别处"。
 *
 * 两种模式由 `target` 是否出现区分，而不是由工具悄悄切换：
 *
 *   - **前台模式**（无 `target`）：抓屏幕、移光标、抢焦点。可靠但打扰用户，
 *     因此**输入动作默认被 `allowForegroundInput` 拦下**——"不碰用户的鼠标
 *     键盘"必须是默认行为，只有部署方显式开启才可用。
 *   - **后台模式**（有 `target`）：`PrintWindow` 抓窗口 + `PostMessage` 投递，
 *     不动光标也不改前台，但**可靠性取决于目标窗口种类**（`reliable` 字段
 *     如实回报），因此必须让模型显式选择，而不是替它决定。
 *
 * 后一条纪律来自实测：普通 Win32 窗口不在前台时不响应模拟鼠标消息，但
 * 落点命中按钮类控件时后台会改发 BM_CLICK 语义点击（实测生效、不改前台）；
 * Chromium/Electron 的渲染子窗口则照常响应投递的鼠标消息。把它们统一说成
 * "成功"会让模型对着一张没变的界面反复重试，那比直接报错更浪费。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import { touchOverlay } from './overlay.js';
import { captureWindowBgra, type WindowCapture } from './capture-window.js';
import { assertImageCapableRoute } from './capability.js';
import type { AgentLike, ApprovalService, AttachmentService, LlmService } from './contracts.js';
import type { ConfigValues } from './config.js';
import {
	captureAndStore,
	formatScreenshot,
	formatWindowScreenshot,
	imageRefFromValue,
	OPTIONAL_IMAGE_SCHEMA,
	storeWindowCapture,
	type ScreenshotValue,
	type WindowSummary,
} from './image.js';
import {
	click,
	describeWindow,
	drag,
	focusedControlInfo,
	foregroundInfo,
	holdChord,
	MOUSE_BUTTONS,
	moveMouse,
	pressChord,
	scroll,
	settleKeyboardTarget,
	typeText,
} from './input.js';
import { backgroundClick, backgroundType, type BackgroundInputResult } from './input-background.js';
import { canonicalChordSpec, parseChord } from './keys.js';
import { clampRegion, desktopBounds, type Bounds, type DesktopBounds } from './screen.js';
import { loadWin32, type ClientArea, type Win32 } from './win32.js';
import {
	describeTarget,
	imagePointToClient,
	resolveTargetWindow,
	type CaptureMapping,
	type TargetWindow,
} from './window-target.js';

/** 工具暴露给模型的全部动作。 */
export const ACTIONS = [
	'window',
	'screenshot',
	'cursor_position',
	'mouse_move',
	'left_click',
	'right_click',
	'middle_click',
	'double_click',
	'triple_click',
	'left_click_drag',
	'scroll',
	'type',
	'key',
	'hold_key',
	'wait',
] as const;

/** 动作名。 */
export type ComputerAction = (typeof ACTIONS)[number];

/**
 * 支持 `target`（后台模式）的动作。
 *
 * 刻意只放实测验证过的四种：后台截图靠 `PrintWindow`，后台点击/打字靠
 * `PostMessage`，其余动作（拖拽、滚轮、组合键、双击）没有对应的可靠投递
 * 手段。给它们加 `target` 会得到一个"看起来是后台、实际没生效"的动作，
 * 所以宁可明确报错。
 */
const BACKGROUND_ACTIONS = new Set<ComputerAction>(['screenshot', 'left_click', 'right_click', 'middle_click', 'type']);

/** 需要模型鼠标键盘能力的动作。 */
const INPUT_ACTIONS = new Set<ComputerAction>([
	'mouse_move',
	'left_click',
	'right_click',
	'middle_click',
	'double_click',
	'triple_click',
	'left_click_drag',
	'scroll',
	'type',
	'key',
	'hold_key',
]);

/** 使用键盘的动作，注入前需要等待焦点稳定。 */
const KEYBOARD_ACTIONS = new Set<ComputerAction>(['type', 'key', 'hold_key']);

/** 一次工具调用收到的原始参数。 */
export interface ComputerArgs {
	action: ComputerAction;
	x?: number;
	y?: number;
	start_x?: number;
	start_y?: number;
	end_x?: number;
	end_y?: number;
	text?: string;
	keys?: string;
	scroll_direction?: 'up' | 'down' | 'left' | 'right';
	scroll_amount?: number;
	duration_ms?: number;
	region?: { x: number; y: number; width: number; height: number };
	/** 后台模式的目标窗口句柄（十进制字符串，见 `window` 动作的回报）。 */
	target?: string;
	/** `window` 动作最多列几个窗口；只会比部署上限更小。 */
	limit?: number;
}

/** 工具执行上下文里本插件用到的部分。 */
export interface RunContext {
	readonly callId: string;
	readonly signal: AbortSignal;
	readonly agent?: AgentLike;
}

/** 后台输入投递结果：`reliable`/`note` 原样透传给模型，绝不合并成"成功"。 */
interface BackgroundDelivery {
	handle: string;
	title: string;
	kind: string;
	/** 这次投递是否**可以信任生效**；false 时模型必须换策略。 */
	reliable: boolean;
	/** 选路说明或不可靠的原因。 */
	note: string;
	/** 实际投递出去的消息条数。 */
	delivered: number;
	/** 坐标的解释方式：`image` = 该窗口最近一次截图的图像像素，`client` = 客户区坐标。 */
	coordinateSource?: 'image' | 'client';
	/** 换算后真正投递的客户区坐标。 */
	point?: { x: number; y: number };
}

/** 工具输出值；`render` 只依赖它，保持可重放。 */
export interface ComputerValue {
	action: string;
	summary: string;
	cursor?: { x: number; y: number };
	target?: { title: string; className: string; processId: number; rect: Bounds };
	image?: ScreenshotValue['image'];
	region?: Bounds;
	desktop?: DesktopBounds;
	scale?: number;
	elapsedMs?: number;
	downscaleRetries?: number;
	/** `window` 动作列出的候选窗口。 */
	windows?: WindowSummary[];
	/** 后台截图抓的是哪个窗口（与 `windows` 的条目同形）。 */
	window?: WindowSummary;
	/** 动作作用的可访问性元素（元素级动作才有）。 */
	element?: { id: string; line: string };
	/** 元素级动作走的 pattern 名称。 */
	pattern?: string;
	/** 这次动作是否改变了前台窗口。 */
	foregroundChanged?: boolean;
	/** 需要模型停下来向用户复述的警告。 */
	warnings?: string[];
	/** 本次观察建立的快照 id。 */
	snapshot?: string;
	/** 可访问性树（缩进文本）。 */
	tree?: string;
	/** 树里实际输出了多少节点。 */
	treeNodes?: number;
	/** 树读取失败的原因（成功时不出现）。 */
	treeError?: string;
	/** 树是否因上限被截断。 */
	treeTruncated?: boolean;
	/** 后台输入动作的投递结果。 */
	background?: BackgroundDelivery;
}

/**
 * 屏幕坐标里的一个矩形。
 *
 * `region`、`desktop`、`target.rect` 全部复用这一种形状：只给模型一种矩形
 * 描述，就没有"这个 rect 是左右上下还是 xywh"的歧义。
 */
const BOUNDS_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		x: { type: 'integer', required: true },
		y: { type: 'integer', required: true },
		width: { type: 'integer', required: true },
		height: { type: 'integer', required: true },
	},
} as const;

const POINT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: { x: { type: 'integer', required: true }, y: { type: 'integer', required: true } },
} as const;

const DESKTOP_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		x: { type: 'integer', required: true },
		y: { type: 'integer', required: true },
		width: { type: 'integer', required: true },
		height: { type: 'integer', required: true },
		monitors: { type: 'integer', required: true },
	},
} as const;

const WINDOW_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		title: { type: 'string', required: true },
		className: { type: 'string', required: true },
		processId: { type: 'integer', required: true },
		rect: BOUNDS_SCHEMA,
	},
} as const;

/**
 * 一个候选/被操作窗口的摘要形状。
 *
 * `handle` 是**字符串**而不是数字：原生句柄是 bigint，直接放进输出值会让
 * JSON 序列化抛错，而输出值必须能无损进会话日志。模型只需要原样回传它，
 * 不需要理解它的含义。
 */
const WINDOW_ENTRY_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		handle: { type: 'string', required: true },
		title: { type: 'string', required: true },
		kind: { type: 'string', required: true },
		width: { type: 'integer', required: true },
		height: { type: 'integer', required: true },
		minimized: { type: 'boolean', required: true },
	},
} as const;

/** 后台输入投递结果；`reliable`/`note` 必须能被模型读到。 */
const BACKGROUND_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		handle: { type: 'string', required: true },
		title: { type: 'string', required: true },
		kind: { type: 'string', required: true },
		reliable: { type: 'boolean', required: true },
		note: { type: 'string', required: true },
		delivered: { type: 'integer', required: true },
		coordinateSource: { type: 'string', enum: ['image', 'client'] },
		point: POINT_SCHEMA,
	},
} as const;

/**
 * 工具的输出契约。
 *
 * 关键：**只有 `action` 与 `summary` 是必填**。上面这些对象 schema 自身都不带
 * `required: true`——在 DSL 里那个注解修饰的是"它作为父对象属性时是否必填"。
 * 一旦带上，就等于要求每个动作都返回图像/区域/目标窗口，于是除 `screenshot`
 * 之外的动作全部校验失败（宿主会以"missing required property"报错）。
 *
 * 同理，**任何新增的值字段都必须在这里同时声明**：`additionalProperties: false`
 * 之下，代码里多返回一个 schema 没写的字段，宿主会直接以
 * "is not a declared property" 拒绝整次调用。
 */
export const OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		action: { type: 'string', required: true },
		summary: { type: 'string', required: true },
		cursor: POINT_SCHEMA,
		target: WINDOW_SCHEMA,
		image: OPTIONAL_IMAGE_SCHEMA,
		region: BOUNDS_SCHEMA,
		desktop: DESKTOP_SCHEMA,
		scale: { type: 'number' },
		elapsedMs: { type: 'integer' },
		downscaleRetries: { type: 'integer' },
		windows: { type: 'array', items: WINDOW_ENTRY_SCHEMA },
		window: WINDOW_ENTRY_SCHEMA,
		background: BACKGROUND_SCHEMA,
		foregroundChanged: { type: 'boolean' },
		warnings: { type: 'array', items: { type: 'string' } },
		snapshot: { type: 'string' },
		pattern: { type: 'string' },
		element: {
			type: 'object',
			additionalProperties: false,
			properties: { id: { type: 'string', required: true }, line: { type: 'string', required: true } },
		},
		tree: { type: 'string' },
		treeNodes: { type: 'integer' },
		treeTruncated: { type: 'boolean' },
		treeError: { type: 'string' },
	},
} as const;

const TOOL_DESCRIPTION = [
	'Control the Windows desktop: capture the screen and drive the mouse and keyboard.',
	'Use this to operate graphical applications when no command-line or file-based path exists.',
	'',
	'Always start with `screenshot` unless you have taken one in the immediately preceding step — the screen is shared with the user and changes without notice.',
	'Screenshots are returned as images. Read coordinates off them directly; every mouse action takes SCREEN pixels.',
	'When an image is scaled, the text envelope states the exact conversion — do not guess it.',
	'Keyboard actions report which window received the input in `target`; if that is not the window you intended, click the intended window first and re-send the text.',
	'Prefer `key` with a chord like "ctrl+c" over `type` for shortcuts, and prefer `type` for literal text.',
	'',
	'FOREGROUND vs BACKGROUND MODE — read this before passing `target`:',
	'- BACKGROUND mode is the ONLY input mode available by default. To use it, pass `target` (a window handle printed by the `window` action, passed back verbatim): the cursor is not moved and no window is brought to front. Reliability depends on the target — Chromium/Electron windows accept posted input; for plain Win32 targets a click that lands on a button-like control is delivered as a semantic BM_CLICK (which works in the background), but simulated mouse messages landing anywhere else do NOT take effect on a window that is not in front — so every background result carries `reliable` and `note`: read them, and do not assume a click worked.',
	'- WITHOUT `target` an input action would run in FOREGROUND mode: it moves the real cursor and takes the focus away from whatever the user is doing. FOREGROUND mode is DISABLED by default — an input action without `target` fails with an error explaining why. It exists only if the deployment explicitly enabled it (`allowForegroundInput: true`); do not assume it is available. It is off by default because it would really move the user\'s cursor and steal the focus out from under their typing.',
	'- Actions that produce no input (screenshot, cursor_position, window, wait) work without `target` in every configuration: a foreground screenshot only reads the screen, it never moves the cursor or changes focus.',
	'Only screenshot, left_click, right_click, middle_click and type accept `target`; other actions reject it rather than silently falling back to the foreground.',
	'Background clicks are posted with the message numbers matching the requested button, so left/right/middle button semantics ARE preserved. What is not preserved is reliability: for plain Win32 targets a click that lands on a button-like control is sent as a semantic BM_CLICK and works, but simulated mouse messages landing elsewhere may be queued yet ignored — always read `background.reliable` and `background.note` on the result instead of assuming the click landed.',
	'Background typing into plain Win32 (GDI) windows is addressed to a specific text-editing child control (Edit / RichEdit / WinForms TextBox class) that the tool tries to locate automatically; when no such control is found the messages fall back to the top-level window and will NOT take effect, which `background.note` states explicitly.',
	'In background mode x/y are the pixels you read off that window\'s most recent `screenshot target=...` image (the tool applies its scale for you); if you click a window you have not screenshotted, x/y are taken as CLIENT-area pixels of that window directly. Either way the result says which interpretation was used.',
	'Use {"action":"window"} to list windows you can target; it does not move the cursor or change focus.',
	'',
	'This drives a live machine. Do not click or type anything that deletes data, sends messages, completes purchases, or changes system settings without the user asking for it.',
].join('\n');

/** 校验一个必须出现的整数参数。 */
function requireInteger(args: ComputerArgs, field: 'x' | 'y' | 'start_x' | 'start_y' | 'end_x' | 'end_y'): number {
	const value = args[field];
	if (value === undefined || !Number.isInteger(value)) {
		throw new Error(`动作 "${args.action}" 需要整数参数 ${field}`);
	}
	return value;
}

/** 校验一个必须出现的字符串参数。 */
function requireString(args: ComputerArgs, field: 'text' | 'keys'): string {
	const value = args[field];
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`动作 "${args.action}" 需要非空字符串参数 ${field}`);
	}
	return value;
}

/** 规范化组合键写法，用于拒绝名单比对（大小写、顺序、分隔符都不敏感）。 */
export function normalizeChordSpec(spec: string): string {
	const tokens = spec
		.trim()
		.toLowerCase()
		.split(/[+\s]+/u)
		.filter((token) => token.length > 0);
	if (tokens.length === 0) return '';
	const main = tokens[tokens.length - 1]!;
	const modifiers = [...new Set(tokens.slice(0, -1))].sort();
	return [...modifiers, main].join('+');
}

/** 可被取消的等待。 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new Error('computer-use: 等待被取消'));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * 把一个窗口信息转成输出值里的 `target`。
 *
 * Win32 的原生矩形是 `{left, top, right, bottom}`；这里换算成与 `region`、
 * `desktop` 一致的 `{x, y, width, height}`。模型只需要认识一种矩形形状，
 * 少一种换算就少一类算错坐标的机会。
 */
function targetOf(info: ReturnType<typeof foregroundInfo>): ComputerValue['target'] {
	if (info === undefined) return undefined;
	const { left, top, right, bottom } = info.rect;
	return {
		title: info.title,
		className: info.className,
		processId: info.processId,
		rect: { x: left, y: top, width: right - left, height: bottom - top },
	};
}

/** 把后台目标转成输出值里的 `target`：形状与前台模式一致，但描述的是被操作的那个窗口。 */
function targetOfTargetWindow(target: TargetWindow): ComputerValue['target'] {
	return {
		title: target.title,
		className: target.className,
		processId: target.processId,
		// ClientArea 本身就是 {x, y, width, height}，与 region/desktop 同形
		rect: { ...target.frame },
	};
}

/** 后台目标转成窗口摘要：`handle` 转字符串，否则 bigint 会让 JSON 序列化抛错。 */
function summaryOfTarget(target: TargetWindow, width: number, height: number): WindowSummary {
	return {
		handle: target.frameHandle.toString(),
		title: target.title.length > 0 ? target.title : '(untitled)',
		kind: target.kind,
		width,
		height,
		minimized: target.minimized,
	};
}

/**
 * 单行展示用的标题：换行或引号会破坏清单的行结构。
 *
 * 只用于给人/模型读的那份清单，输出值里的 `title` 保持原样——模型可能要按标题
 * 精确匹配窗口，改过的标题会误导它。
 */
function displayTitle(title: string): string {
	return title.replace(/\s+/gu, ' ').replace(/"/gu, "'");
}

/**
 * 系统壳窗口的类名。
 *
 * 这些窗口由 shell 拥有（桌面、任务栏），既不接受后台操作，也没有可读的标题。
 * 判据要求"标题也为空"，因为同名类里也可能有真实应用窗口，标题非空就照列。
 */
const SHELL_WINDOW_CLASSES = new Set(['Progman', 'Shell_TrayWnd', 'WorkerW', 'Shell_SecondaryTrayWnd']);

/**
 * 列出可以走后台模式的顶层窗口。
 *
 * 过滤掉不可见、客户区为空与系统壳窗口：这三类在真实桌面上占绝大多数，
 * 列出来只会把模型要找的目标挤出上下文。句柄一律转成十进制字符串——
 * bigint 放进输出值会直接让 JSON 序列化抛错。
 */
function windowListAction(config: ConfigValues, args: ComputerArgs, win32: Win32): ComputerValue {
	const requested = args.limit ?? config.windowListLimit;
	if (!Number.isInteger(requested) || requested <= 0) {
		throw new Error(`limit 必须是正整数，收到 ${String(args.limit)}`);
	}
	// 部署配置是硬上限：模型可以要得更少，不能要得更多
	const limit = Math.min(requested, config.windowListLimit);

	const entries: WindowSummary[] = [];
	let matched = 0;
	for (const handle of win32.topLevelWindows()) {
		const info = win32.windowInfo(handle);
		if (info === undefined) continue;
		if (info.title.length === 0 && SHELL_WINDOW_CLASSES.has(info.className)) continue;

		// 解析这一步同时完成了"客户区尺寸 > 0"与"Chromium 有渲染表面"的校验：
		// 拿不到可操作目标的窗口，列出来只会让模型白试一次
		const resolved = resolveTargetWindow(win32, handle);
		if (!resolved.ok) continue;
		const target = resolved.target;
		if (!target.visible) continue;

		matched += 1;
		// 超出上限后仍继续数总数，好如实告诉模型"还有多少没列出来"
		if (entries.length >= limit) continue;
		entries.push(summaryOfTarget(target, target.client.width, target.client.height));
	}

	const rows = entries.map((entry) => `- handle=${entry.handle} "${displayTitle(entry.title)}" [${entry.kind}] client ${entry.width}x${entry.height}${entry.minimized ? ' (minimized)' : ''}`);
	const summary = entries.length === 0
		? 'No window currently accepts background operations: every top-level window is hidden, zero-sized, or a system shell window. Take a foreground screenshot (without target) instead.'
		: [
			`${entries.length} of ${matched} window(s) listed that accept background operations. Pass a handle back verbatim as \`target\` (you do not need to interpret it); the \`window\` action itself never moves the cursor or changes focus:`,
			...rows,
			'Pass a handle to computer_observe to capture that window (screenshot, optionally tree:true), and to computer_act as `target` for window-mode input.',
		].join('\n');

	return { action: 'window', summary, windows: entries };
}

/**
 * 解析 `target` 参数为一个可操作的后台目标；没有 `target` 时返回 undefined。
 *
 * 任何一步失败都抛错，**绝不退回前台模式**：模型以为自己操作的是后台窗口、
 * 结果光标被抢走、前台被换掉，是这套工具最不可接受的一种静默失败。
 * 因此这里也在最前面拦下"给不支持的动作传了 target"，而不是把它当多余参数忽略。
 */
function resolveBackgroundTarget(win32: Win32, args: ComputerArgs): TargetWindow | undefined {
	if (args.target === undefined) return undefined;

	if (!BACKGROUND_ACTIONS.has(args.action)) {
		throw new Error(
			`动作 "${args.action}" 不支持 target：后台模式目前只有 ${[...BACKGROUND_ACTIONS].join(' / ')}。本次未执行任何操作；`
			+ '要操作该窗口请去掉 target 走前台模式，或改用支持的动作',
		);
	}

	const raw = args.target;
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		throw new Error('target 需要窗口句柄的字符串形式；请先用 window 动作列出窗口，再原样回传 handle');
	}
	const spec = raw.trim();
	// 只接受十进制（window 动作回报的形式）与 0x 前缀，避免 BigInt 把空串当 0、
	// 把浮点/科学计数法悄悄取整——句柄错一位就会打到另一个窗口上
	if (!/^\d+$/u.test(spec) && !/^0x[0-9a-f]+$/iu.test(spec)) {
		throw new Error(`target "${raw}" 不是合法的窗口句柄；请原样回传 window 动作回报的十进制 handle`);
	}
	const handle = BigInt(spec);

	const resolved = resolveTargetWindow(win32, handle);
	if (!resolved.ok) {
		throw new Error(`无法把窗口 ${spec} 用作后台目标：${resolved.reason}。${resolved.hint}`);
	}
	return resolved.target;
}

/**
 * 一个后台目标最近一次成功截图留下的坐标映射。
 *
 * 存在理由是后台点击的坐标语义：模型先 `screenshot target=H`、再 `left_click
 * target=H`，它读到的坐标是**那张图上的像素**，而图可能被降采样过。把当时的
 * 映射留在手边，点击时就能按同一比例换回客户区坐标，不必让模型自己做除法。
 *
 * 记录里同时存下当时的客户区：换算必须用同一份快照。若窗口在截图后被移动，
 * 用当前客户区去减旧原点会把窗口位移算进去，反而点偏——而"同一个客户区偏移"
 * 才是模型看那张图时真正想指的位置。
 *
 * 不做淘汰：一条记录只有几十字节，而"客户区尺寸对不上就当没有"这条判据已经
 * 兜住了句柄被复用、窗口被改尺寸这两种陈旧记录的唯一危险来源。
 */
export interface BackgroundCapture {
	readonly mapping: CaptureMapping;
	readonly client: ClientArea;
}

/** 截图记录的键；与 `window` 动作回报的句柄形式一致。 */
function captureKey(handle: bigint): string {
	return handle.toString();
}

/**
 * 取该目标可用的截图记录。
 *
 * 客户区尺寸变了就当作没有记录：那张图与现在的客户区已经对不上，按图上的坐标
 * 投递必然点偏，宁可退回"按客户区坐标"并如实说明，也不猜。
 */
function usableCapture(captures: Map<string, BackgroundCapture>, target: TargetWindow): { record?: BackgroundCapture; stale: boolean } {
	const record = captures.get(captureKey(target.frameHandle));
	if (record === undefined) return { stale: false };
	if (record.client.width !== target.client.width || record.client.height !== target.client.height) return { stale: true };
	return { record, stale: false };
}

/**
 * 把模型给的坐标换算成投递用的客户区坐标。
 *
 * 两种解释，取哪一种取决于该窗口有没有可用的截图记录，并且每次都在 summary 里
 * 明说——模型无法从别处得知自己给的是图像像素还是客户区像素。
 * 两条路径都走 `imagePointToClient`，保证全局只有一条坐标换算链路。
 */
function toClientPoint(
	coordinates: { x: number; y: number },
	record: BackgroundCapture | undefined,
	target: TargetWindow,
): { point: { x: number; y: number }; source: 'image' | 'client' } {
	if (record === undefined) {
		const client = target.client;
		// 没有截图：按"已经是客户区坐标"处理。原点与客户区取同一份，换算退化为恒等
		const identity: CaptureMapping = { imageWidth: client.width, imageHeight: client.height, originX: client.x, originY: client.y, scale: 1 };
		return { point: imagePointToClient(coordinates, identity, client), source: 'client' };
	}
	return { point: imagePointToClient(coordinates, record.mapping, record.client), source: 'image' };
}

/** 一句话说明本次坐标是按哪种解释换算的。 */
function describeCoordinateSource(source: 'image' | 'client', record: BackgroundCapture | undefined, stale: boolean): string {
	if (source === 'image' && record !== undefined) {
		return `x/y were read as image pixels of this window's last screenshot (scale ${record.mapping.scale.toFixed(5)}) and converted to client-area coordinates`;
	}
	if (stale) {
		return 'x/y were taken as CLIENT-area pixels: the client size changed since this window was last screenshotted, so that image no longer maps onto it';
	}
	return 'x/y were taken as CLIENT-area pixels: this window has no usable screenshot in this session';
}

/**
 * 换算后的点落在客户区之外时的告警。
 *
 * 不拦下这次投递（目标窗口自己会忽略越界坐标），但必须说出来：消息里的坐标是
 * 16 位打包的，越界值会静默回绕，而"点偏了但没有任何报错"正是模型最难自查的失败。
 * 最常见的成因是缩放系数算错了一遍（把已经换算过的坐标又除掉一次 scale）。
 */
function describeOutOfBounds(point: { x: number; y: number }, client: ClientArea): string {
	const inside = point.x >= 0 && point.y >= 0 && point.x < client.width && point.y < client.height;
	if (inside) return '';
	return ` WARNING: client-area (${point.x}, ${point.y}) is outside this window's client area (${client.width}x${client.height}), so the target will most likely ignore it — re-check that the coordinates were read off the right image.`;
}

/**
 * 把后台投递结果拼成一句模型能据此决策的话。
 *
 * `reliable` 与 `note` 来自投递层（实测结论），这里只负责让它显眼：不可靠时
 * 必须点出下一步，否则模型会对着没反应的界面反复重试同一个动作。
 */
function deliveryLine(result: BackgroundInputResult): string {
	if (result.reliable) return `Delivery: reliable, ${result.delivered} message(s) posted. ${result.note}`;
	return `Delivery: UNRELIABLE, ${result.delivered} message(s) posted — ${result.note}. `
		+ 'Do not assume this took effect: switch to foreground mode (omit target) or pick another window.';
}

/** 最小化的窗口没有渲染帧；投递是否被处理未经实测，必须提醒而不是假装知道。 */
const MINIMIZED_INPUT_CAVEAT = ' Note: the target window is minimized, so it is not rendering; background input against minimized windows has not been verified.';

/**
 * 后台点击的按键语义说明。
 *
 * 早先后台投递固定发左键消息，`right_click` / `middle_click` 会静默退化成左键，
 * 因此这里必须带一句醒目的警告。现在 `backgroundClick` 支持按键参数、消息号
 * 按按键分派，语义不再丢失，所以正常情况什么都不补。
 *
 * 保留这个函数而不是删掉，是为了让"按键语义曾经会丢失"这件事在代码里有痕迹：
 * 一旦将来有人去掉按键参数，这里就是该重新加回警告的地方。
 */
function buttonCaveat(button: 'left' | 'right' | 'middle'): string {
	if (button === 'left') return '';
	return '';
}

/**
 * 注册 `computer` 工具。
 *
 * @param ctx - 插件上下文；执行期通过 `ctx.get` 解析可选服务。
 * @param config - 已校验的配置。
 */
export function registerComputerTool(ctx: Context, config: ConfigValues): void {
	/**
	 * 每个后台目标最近一次成功截图留下的坐标映射，供随后的后台点击换算坐标。
	 *
	 * 放在注册闭包里而不是模块级：它是**单个工具实例的会话内状态**，
	 * 不同插件实例（不同 profile / 会话）之间不该互相看到对方的截图。
	 */
	const captures = new Map<string, BackgroundCapture>();

	const tool = defineTool({
		name: 'computer',
		description: TOOL_DESCRIPTION,
		timeoutMs: 180_000,

		parameters: {
			action: {
				type: 'string',
				required: true,
				enum: [...ACTIONS],
				description: 'Desktop action to perform.',
			},
			x: { type: 'integer', description: 'Target X. Screen pixels in foreground mode; see the `target` parameter for background mode. Required by mouse_move and left_click_drag (with start_x/start_y); optional for foreground clicks, which then act at the current cursor.' },
			y: { type: 'integer', description: 'Target Y (see x).' },
			start_x: { type: 'integer', description: 'Drag start X (left_click_drag only).' },
			start_y: { type: 'integer', description: 'Drag start Y (left_click_drag only).' },
			end_x: { type: 'integer', description: 'Drag end X (left_click_drag only); alias of x when x is absent.' },
			end_y: { type: 'integer', description: 'Drag end Y (left_click_drag only); alias of y when y is absent.' },
			text: { type: 'string', description: 'Literal text to inject (type only). Unicode is sent directly, so any language works.' },
			keys: { type: 'string', description: 'Key or chord such as "Return", "Escape", "Tab", "F5", "ctrl+c", "ctrl+shift+s", "alt+Tab" (key and hold_key only).' },
			scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Which way to scroll (scroll only).' },
			scroll_amount: { type: 'integer', description: 'Wheel notches to scroll; default 3 (scroll only).' },
			duration_ms: { type: 'integer', description: 'wait: milliseconds to pause. hold_key: how long to hold the chord down.' },
			target: {
				type: 'string',
				description: 'A window handle printed by the `window` action (pass it back verbatim). Present = BACKGROUND mode for screenshot, left_click, right_click, middle_click and type: the real cursor is not moved and no window is brought to front — but delivery is reliable for Chromium/Electron targets, and for plain Win32 targets only when a click lands on a button-like control (sent as a semantic BM_CLICK); so check the reported `reliable`/`note`. Omitted = FOREGROUND mode, which moves the real cursor and steals focus from the user; it is disabled by default and input actions without `target` fail unless the deployment enabled `allowForegroundInput`. Other actions reject `target`.',
			},
			limit: { type: 'integer', description: 'window only: how many windows to list, capped by the deployment limit (`windowListLimit`, default 20).' },
			region: {
				type: 'object',
				additionalProperties: false,
				description: 'Restrict the capture to this screen rectangle (screenshot only). Cheaper and more legible than capturing everything.',
				properties: {
					x: { type: 'integer', required: true },
					y: { type: 'integer', required: true },
					width: { type: 'integer', required: true },
					height: { type: 'integer', required: true },
				},
			},
		},

		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args: unknown, value: ComputerValue) => renderComputerValue(value),
			presentationMeta: (_args: unknown, value: ComputerValue) => ({ action: value.action, summary: value.summary }),
		},

		isConcurrencySafe: () => false,

		async execute(args: ComputerArgs, exec: RunContext): Promise<ComputerValue> {
			return await runComputerAction(args, exec, ctx, config, captures);
		},

		presentCall(args: ComputerArgs) {
			const kind = args.action === 'window' || args.action === 'screenshot' || args.action === 'cursor_position' ? 'read' : 'execute';
			return { card: 'generic', title: describeCall(args), kind, rawInput: args };
		},
	});

	ctx.tools.register(tool);
}

/**
 * 执行一次桌面动作，并补上两条**事后诊断**。
 *
 * 为什么单独包一层：
 * - `foregroundChanged`：前台模式最难察觉的副作用就是"焦点被抢走了"。只有对比
 *   动作前后的前台窗口句柄才说得清，而每个动作分支都自己比较一遍必然漏。
 * - **自指警告**：目标窗口属于 DSH 自己时（用户就是在跟宿主界面交互），动作可能
 *   改到发起这次调用的界面本身。策略允许这么做，但必须让模型看见并停下来复述，
 *   否则它会在自己的审批按钮上连点。
 *
 * 诊断失败绝不影响动作结果：读不到前台窗口时只是不报告，不抛错。
 *
 * @param args - 动作参数。
 * @param exec - 宿主执行上下文。
 * @param ctx - 插件上下文。
 * @param config - 已解析配置。
 * @param captures - 后台截图映射。
 * @returns 动作结果（带诊断字段）。
 */
export async function runComputerAction(
	args: ComputerArgs,
	exec: RunContext,
	ctx: Context,
	config: ConfigValues,
	captures: Map<string, BackgroundCapture>,
): Promise<ComputerValue> {
	touchOverlay();

	const win32 = await loadWin32();
	const before = foregroundInfo(win32);

	const value = await executeComputerAction(args, exec, ctx, config, captures);

	const after = foregroundInfo(win32);
	value.foregroundChanged = after?.handle !== before?.handle;
	// 结构化字段模型看不到（render 只输出 summary 与内容块），
	// 所以"前台被抢走"这件事必须同时写进摘要，否则等于没报告。
	if (value.foregroundChanged === true) {
		value.summary = `${value.summary} Note: the foreground window changed — focus was taken from whatever the user was doing.`;
	}

	if (INPUT_ACTIONS.has(args.action)) {
		let targetHandle: bigint | undefined;
		if (args.target !== undefined) {
			try {
				targetHandle = BigInt(args.target);
			} catch {
				targetHandle = undefined;
			}
		} else {
			targetHandle = before?.handle;
		}
		const targetPid = targetHandle === undefined ? undefined : win32.windowInfo(targetHandle)?.processId;
		if (targetPid !== undefined && targetPid === process.pid) {
			value.warnings = ['目标窗口属于 DSH 自身：这次动作可能改变了宿主界面（例如点到了自己的按钮或输入框）。'];
			value.summary = `⚠ ${value.warnings[0]} ${value.summary}`;
		}
	}

	return value;
}

/**
 * 执行一次桌面动作。
 *
 * 从 `computer` 工具的执行体提出来：**同一份动作语义**现在供
 * `computer_observe` / `computer_act` 以及一份为测试保留的旧注册路径共用。
 * 复制体一旦分叉，"窗口模式不动光标"这类承诺就会在两条路径里给出不同结果。
 *
 * @param args - 旧式动作参数（新工具负责把自己那套参数映射成它）。
 * @param exec - 宿主的工具执行上下文。
 * @param ctx - 插件上下文，用于解析可选服务。
 * @param config - 已解析配置。
 * @param captures - 后台目标的截图映射；由调用方的工具实例持有。
 */
async function executeComputerAction(
	args: ComputerArgs,
	exec: RunContext,
	ctx: Context,
	config: ConfigValues,
	captures: Map<string, BackgroundCapture>,
): Promise<ComputerValue> {			const win32: Win32 = await loadWin32();

			if (INPUT_ACTIONS.has(args.action) && !config.allowInput) {
				throw new Error('computer-use 的输入模拟已被配置关闭（allowInput: false）；当前只能执行 window、screenshot、cursor_position 和 wait');
			}

			// 有 target 就是后台模式。放在动作分派之前解析：给不支持的动作传 target
			// 会立刻得到一句可纠正的错误，而不是被后面的流程当多余参数忽略掉
			const target = resolveBackgroundTarget(win32, args);

			if (args.action === 'wait') {
				const requested = args.duration_ms ?? 1000;
				if (!Number.isInteger(requested) || requested < 0) throw new Error('wait 需要非负整数 duration_ms');
				if (requested > config.maxWaitMs) throw new Error(`wait 最多等待 ${config.maxWaitMs}ms，请求 ${requested}ms`);
				await delay(requested, exec.signal);
				return {
					action: 'wait',
					summary: `Waited ${requested}ms.`,
					cursor: win32.cursorPosition(),
					target: targetOf(foregroundInfo(win32)),
				};
			}

			if (args.action === 'cursor_position') {
				const cursor = win32.cursorPosition();
				return {
					action: 'cursor_position',
					summary: `Cursor is at (${cursor.x}, ${cursor.y}).`,
					cursor,
					target: targetOf(foregroundInfo(win32)),
				};
			}

			if (args.action === 'window') {
				// 只读的窗口枚举：不产生输入，因此不受 allowInput / requireApproval 约束
				return windowListAction(config, args, win32);
			}

			if (INPUT_ACTIONS.has(args.action)) {
				// 前台输入门控必须在任何 SendInput/光标操作之前拦下：
				// 只报错却不拦，等于门控名存实亡。后台模式（有 target）不受此限。
				if (target === undefined && !config.allowForegroundInput) {
					throw new Error(
						`"${args.action}" 没有 target，会走前台模式，而前台模式默认关闭（它用 SendInput 注入真实事件，`
						+ '会移动用户的光标、抢走用户正在输入的焦点）。两条出路：'
						+ '1) 先调 {action:"window"} 列出可操作窗口，把回报的 handle 原样作为 target 传入，走后台模式（不动光标、不抢前台）；'
						+ '2) 确需前台模式时，由部署方在配置里把 allowForegroundInput 设为 true。本次未执行任何输入',
					);
				}
				await authorizeInput(ctx, config, args, exec);
			}

			if (args.action === 'screenshot') {
				return target === undefined
					? await screenshotAction(ctx, config, args, exec, win32)
					: await windowScreenshotAction(ctx, config, args, exec, win32, target, captures);
			}

			if (target !== undefined) {
				// 后台输入不等待焦点落定、也不碰前台：消息直接进目标窗口的消息队列
				return await backgroundInputAction(config, args, win32, target, captures);
			}

			if (KEYBOARD_ACTIONS.has(args.action)) {
				// 键盘输入只投递给持有焦点的控件；等它稳定，否则开头若干字符会被丢弃
				await settleKeyboardTarget(win32, config.settleMs);
			}

			return await inputAction(config, args, win32);
}

/**
 * 把输出值渲染成模型可见的内容块。
 *
 * 与执行体同理：渲染只有一份，观察工具与动作工具的结果外壳不会各说各话。
 *
 * @param value - 工具输出值。
 * @returns 内容块数组。
 */
export function renderComputerValue(value: ComputerValue): Array<Record<string, unknown>> {
		const blocks: Array<Record<string, unknown>> = [];
				if (value.image !== undefined && value.region !== undefined && value.desktop !== undefined && value.scale !== undefined) {
					const shell: ScreenshotValue = {
						image: value.image,
						region: value.region,
						desktop: value.desktop,
						scale: value.scale,
						cursor: value.cursor ?? { x: 0, y: 0 },
						elapsedMs: value.elapsedMs ?? 0,
						downscaleRetries: value.downscaleRetries ?? 0,
					};
					blocks.push({
						type: 'text',
						// 后台截图报的是客户区坐标，外壳必须换一份，否则模型会按屏幕坐标去点
						text: value.window === undefined
							? formatScreenshot(shell)
							: formatWindowScreenshot({ ...shell, window: value.window }),
					});
					// 快照 id 与可访问性树必须**和截图一起**给模型：
					// 少了 id，元素级动作无从引用；少了树，模型只能靠像素猜控件。
					if (value.snapshot !== undefined) {
						blocks.push({ type: 'text', text: `snapshot=${value.snapshot}: pass it as "snapshot" together with an [eN] id from the tree below when calling computer_act with "element".` });
					}
					if (value.tree !== undefined) blocks.push({ type: 'text', text: value.tree });
					// 树读不到时必须让模型看见原因：截图分支不渲染 summary，
					// 把失败写进 summary 等于静默失败。
					if (value.treeError !== undefined) blocks.push({ type: 'text', text: `Accessibility tree unavailable: ${value.treeError}` });
					blocks.push({ type: 'image', attachment: imageRefFromValue(value.image) });
					return blocks;
				}
				blocks.push({ type: 'text', text: value.summary });
				return blocks;
}

/** 生成工具卡片标题。 */
function describeCall(args: ComputerArgs): string {
	switch (args.action) {
		case 'window':
			return `List windows${args.limit === undefined ? '' : ` (limit ${args.limit})`}`;
		case 'screenshot':
			if (args.target !== undefined) return `Screenshot window ${args.target}`;
			return args.region === undefined
				? 'Screenshot'
				: `Screenshot ${args.region.width}x${args.region.height} at ${args.region.x},${args.region.y}`;
		case 'mouse_move':
			return `Move mouse to ${args.x},${args.y}`;
		case 'type': {
			const preview = (args.text ?? '').replace(/\s+/gu, ' ').slice(0, 40);
			return `Type "${preview}${(args.text ?? '').length > 40 ? '…' : ''}"`;
		}
		case 'key':
		case 'hold_key':
			return `${args.action === 'key' ? 'Press' : 'Hold'} ${args.keys}`;
		case 'scroll':
			return `Scroll ${args.scroll_direction ?? 'down'} ${args.scroll_amount ?? 3}`;
		case 'left_click_drag':
			return `Drag ${args.start_x},${args.start_y} → ${args.x},${args.y}`;
		case 'wait':
			return `Wait ${args.duration_ms ?? 1000}ms`;
		default:
			return `${args.action}${args.x === undefined ? '' : ` at ${args.x},${args.y}`}`;
	}
}

/**
 * 让输入动作先经过宿主审批（仅在配置开启时）。
 *
 * `ctx.approval` 会先套用会话策略再询问应答方，因此策略为 `never` 的会话
 * 直接得到 `rejected`/`unavailable`——这正是"fail closed"该有的样子。
 */
async function authorizeInput(ctx: Context, config: ConfigValues, args: ComputerArgs, exec: RunContext): Promise<void> {
	if (!config.requireApproval) return;
	const approval = ctx.get('approval') as ApprovalService | undefined;
	if (approval === undefined) {
		throw new Error('computer-use: 配置要求审批，但宿主没有可用的审批服务，已拒绝本次输入');
	}
	const outcome = await approval.request({
		agent: exec.agent as never,
		toolName: 'computer',
		callId: exec.callId,
		reason: `Computer use will perform "${args.action}" on the live desktop.`,
		signal: exec.signal,
	});
	if (outcome !== 'allowed-once') {
		throw new Error(`computer-use: "${args.action}" 未获批准（${outcome}）`);
	}
}

/** 执行 screenshot。 */
async function screenshotAction(
	ctx: Context,
	config: ConfigValues,
	args: ComputerArgs,
	exec: RunContext,
	win32: Win32,
): Promise<ComputerValue> {
	await assertImageCapableRoute(ctx.get('llm') as LlmService | undefined, exec.agent, '截图（screenshot）', exec.signal);

	const attachments = ctx.get('attachments') as AttachmentService | undefined;
	if (attachments === undefined) {
		throw new Error('截图需要宿主的附件服务，但当前没有挂载；无法把图像交给模型');
	}

	let region: ComputerArgs['region'];
	if (args.region !== undefined) {
		const desktop = desktopBounds(win32);
		region = clampRegion(args.region, desktop);
	}

	const stored = await captureAndStore(win32, attachments, { region }, config.maxDimension, config.pngLevel);
	const { value } = stored;
	const scaleNote = value.scale === 1 ? '' : ` scaled to ${(value.scale * 100).toFixed(1)}%`;
	return {
		action: 'screenshot',
		summary: `Captured ${value.region.width}x${value.region.height} at ${value.region.x},${value.region.y}${scaleNote} in ${value.elapsedMs}ms.`,
		cursor: value.cursor,
		target: targetOf(foregroundInfo(win32)),
		image: value.image,
		region: value.region,
		desktop: value.desktop,
		scale: value.scale,
		elapsedMs: value.elapsedMs,
		downscaleRetries: value.downscaleRetries,
	};
}

/**
 * 执行带 `target` 的 screenshot：`PrintWindow` 抓目标窗口，不动光标、不抢前台。
 *
 * 这里有三处刻意为之：
 *
 * 1. 最小化等"必然失败"由 `captureWindowBgra` 抛错，这里只补上"这是后台截图"
 *    的上下文，不吞掉原因——模型据此知道该先还原窗口。
 * 2. 空白帧**不算成功**。PrintWindow 经常返回成功却给一张纯色图，把它当截图
 *    交出去，模型会在一张白图上凭空找按钮。
 * 3. 成功后留下坐标映射，供随后同一目标的 `left_click` 把图上的像素换回客户区坐标。
 */
async function windowScreenshotAction(
	ctx: Context,
	config: ConfigValues,
	args: ComputerArgs,
	exec: RunContext,
	win32: Win32,
	target: TargetWindow,
	captures: Map<string, BackgroundCapture>,
): Promise<ComputerValue> {
	if (!config.backgroundCaptureEnabled) {
		throw new Error('后台截图已被配置关闭（backgroundCaptureEnabled: false）；要么去掉 target 用前台截图，要么让部署方打开该配置');
	}

	if (args.region !== undefined) {
		// region 是**屏幕**矩形，而后台截图固定抓整个客户区：同时给会得到一个
		// 与请求不符的结果，宁可报错说清
		throw new Error('target 与 region 不能同时使用：后台截图固定抓目标窗口的整个客户区；需要局部截图时请去掉 target 走前台模式');
	}

	await assertImageCapableRoute(ctx.get('llm') as LlmService | undefined, exec.agent, '截图（screenshot）', exec.signal);

	const attachments = ctx.get('attachments') as AttachmentService | undefined;
	if (attachments === undefined) {
		throw new Error('截图需要宿主的附件服务，但当前没有挂载；无法把图像交给模型');
	}

	const started = Date.now();
	let capture: WindowCapture;
	try {
		capture = captureWindowBgra(win32, target);
	} catch (error) {
		throw new Error(
			`后台截图失败：${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}

	if (capture.blank) {
		// blank 的三种成因都写出来：模型必须能据此选择"先让窗口显示一次"还是"换前台模式"
		throw new Error(
			`后台截图得到的是一张空白帧，不能当作窗口内容：${describeTarget(target)}。`
			+ '常见成因是窗口被完全遮挡且从未真正呈现过（Chromium 对没有帧的窗口只会交出纯色图）、'
			+ '渲染进程此刻没有可给的帧、或该窗口不响应 PrintWindow。'
			+ `请先让「${target.title}」显示一次再试，或改用不带 target 的前台截图`,
		);
	}

	const stored = await storeWindowCapture(win32, attachments, target, capture, config.maxDimension, config.pngLevel, started);
	const { value } = stored;

	// 记录这次截图的坐标映射：后台点击要按同一个比例把图上的像素换回客户区坐标
	captures.set(captureKey(target.frameHandle), {
		mapping: {
			imageWidth: value.image.width,
			imageHeight: value.image.height,
			originX: target.client.x,
			originY: target.client.y,
			scale: value.scale,
		},
		client: { ...target.client },
	});

	const scaleNote = value.scale === 1 ? '' : ` scaled to ${(value.scale * 100).toFixed(1)}%`;
	return {
		action: 'screenshot',
		summary: `Captured the client area of window "${target.title}" (target ${target.frameHandle}, ${target.kind}) ${capture.width}x${capture.height}${scaleNote} in ${value.elapsedMs}ms in background mode: cursor untouched, foreground unchanged.`,
		cursor: value.cursor,
		target: targetOfTargetWindow(target),
		image: value.image,
		region: value.region,
		desktop: value.desktop,
		scale: value.scale,
		elapsedMs: value.elapsedMs,
		downscaleRetries: value.downscaleRetries,
		window: summaryOfTarget(target, capture.width, capture.height),
	};
}

/** 执行鼠标与键盘动作。 */
async function inputAction(config: ConfigValues, args: ComputerArgs, win32: Win32): Promise<ComputerValue> {
	switch (args.action) {
		case 'mouse_move': {
			const point = { x: requireInteger(args, 'x'), y: requireInteger(args, 'y') };
			moveMouse(win32, point);
			return { action: args.action, summary: `Moved the cursor to (${point.x}, ${point.y}).`, cursor: win32.cursorPosition(), target: targetOf(foregroundInfo(win32)) };
		}

		case 'left_click':
		case 'right_click':
		case 'middle_click':
		case 'double_click':
		case 'triple_click': {
			const buttonName = args.action.startsWith('right') ? 'right' : args.action.startsWith('middle') ? 'middle' : 'left';
			const count = args.action === 'double_click' ? 2 : args.action === 'triple_click' ? 3 : 1;
			const point = args.x === undefined || args.y === undefined
				? undefined
				: { x: requireInteger(args, 'x'), y: requireInteger(args, 'y') };
			await click(win32, MOUSE_BUTTONS[buttonName], count, point, config.doubleClickIntervalMs);
			// 点击会改变焦点；等它落定再回报接收者，读数才有意义
			await settleKeyboardTarget(win32, config.settleMs);
			const cursor = win32.cursorPosition();
			return {
				action: args.action,
				summary: `${count > 1 ? `${count}× ` : ''}${MOUSE_BUTTONS[buttonName].label}点击于 (${cursor.x}, ${cursor.y})。`,
				cursor,
				target: targetOf(foregroundInfo(win32)),
			};
		}

		case 'left_click_drag': {
			const from = { x: requireInteger(args, 'start_x'), y: requireInteger(args, 'start_y') };
			const to = {
				x: args.x ?? args.end_x,
				y: args.y ?? args.end_y,
			};
			if (to.x === undefined || to.y === undefined || !Number.isInteger(to.x) || !Number.isInteger(to.y)) {
				throw new Error('left_click_drag 需要终点坐标：给出 x/y，或 end_x/end_y');
			}
			await drag(win32, from, { x: to.x, y: to.y }, Math.max(2, config.dragSteps));
			return {
				action: args.action,
				summary: `Dragged from (${from.x}, ${from.y}) to (${to.x}, ${to.y}).`,
				cursor: win32.cursorPosition(),
				target: targetOf(foregroundInfo(win32)),
			};
		}

		case 'scroll': {
			const direction = args.scroll_direction;
			if (direction === undefined) throw new Error('scroll 需要 scroll_direction（up/down/left/right）');
			const amount = args.scroll_amount ?? 3;
			if (!Number.isInteger(amount) || amount <= 0) throw new Error(`scroll_amount 必须是正整数，收到 ${amount}`);
			// Win32 约定：垂直正数为向上，水平正数为向右
			const vertical = direction === 'up' ? amount : direction === 'down' ? -amount : 0;
			const horizontal = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
			const point = args.x === undefined || args.y === undefined
				? undefined
				: { x: requireInteger(args, 'x'), y: requireInteger(args, 'y') };
			scroll(win32, vertical, horizontal, point);
			const cursor = win32.cursorPosition();
			return { action: args.action, summary: `Scrolled ${direction} by ${amount}.`, cursor, target: targetOf(foregroundInfo(win32)) };
		}

		case 'type': {
			const text = requireString(args, 'text');
			if (text.length > config.maxTextLength) {
				throw new Error(`type 一次最多注入 ${config.maxTextLength} 个字符，收到 ${text.length}；请分段发送`);
			}
			// 焦点控件才是按键的真正接收者，优先回报它
			const receiver = focusedControlInfo(win32) ?? foregroundInfo(win32);
			const written = await typeText(win32, text, config.typingChunkSize, config.typingChunkDelayMs, config.warmupInjection);
			return {
				action: args.action,
				summary: `Typed ${written} character(s) into ${describeWindow(receiver)}.`,
				cursor: win32.cursorPosition(),
				target: targetOf(receiver),
			};
		}

		case 'key':
		case 'hold_key': {
			const spec = requireString(args, 'keys');
			assertKeyAllowed(config, spec);
			const chord = parseChord(spec);
			const receiver = focusedControlInfo(win32) ?? foregroundInfo(win32);
			if (args.action === 'key') {
				pressChord(win32, chord, config.warmupInjection);
			} else {
				const duration = args.duration_ms ?? 500;
				if (!Number.isInteger(duration) || duration < 0) throw new Error('hold_key 需要非负整数 duration_ms');
				if (duration > config.maxWaitMs) throw new Error(`hold_key 最多按住 ${config.maxWaitMs}ms，请求 ${duration}ms`);
				await holdChord(win32, chord, duration, config.warmupInjection);
			}
			return {
				action: args.action,
				summary: `${args.action === 'key' ? 'Pressed' : 'Held'} ${chord.label} (${describeWindow(receiver)}).`,
				cursor: win32.cursorPosition(),
				target: targetOf(receiver),
			};
		}

		default:
			throw new Error(`未知动作 "${args.action}"`);
	}
}

/** 按配置的拒绝名单拦下组合键。 */
function assertKeyAllowed(config: ConfigValues, spec: string): void {
	if (config.deniedKeys.length === 0) return;
	const canonical = canonicalChordSpec(spec);
	for (const denied of config.deniedKeys) {
		if (canonicalChordSpec(denied) === canonical) {
			throw new Error(`按键 "${spec}" 已被部署配置禁止（deniedKeys）`);
		}
	}
}

/**
 * 执行带 `target` 的点击与打字：`PostMessage` 投递，不动光标、不抢前台。
 *
 * 两条纪律都体现在返回值里：
 *
 * 1. `reliable` 与 `note` **原样透传**（投递层给的是实测结论），不可靠时在
 *    summary 里显式提醒改用前台模式或换目标。假装成功比报错更浪费模型的时间。
 * 2. 坐标按哪种方式解释、最终投到客户区哪个点，都写进 summary 与 `background`
 *    字段——同一句话里既给出结论也给出依据，模型才能自己判断是否要重新截图。
 */
async function backgroundInputAction(
	config: ConfigValues,
	args: ComputerArgs,
	win32: Win32,
	target: TargetWindow,
	captures: Map<string, BackgroundCapture>,
): Promise<ComputerValue> {
	const handle = target.frameHandle.toString();
	const minimizedCaveat = target.minimized ? MINIMIZED_INPUT_CAVEAT : '';

	if (args.action === 'type') {
		const text = requireString(args, 'text');
		if (text.length > config.maxTextLength) {
			throw new Error(`type 一次最多注入 ${config.maxTextLength} 个字符，收到 ${text.length}；请分段发送`);
		}
		const result = backgroundType(win32, target, text);
		return {
			action: 'type',
			summary: `Typed ${result.delivered} UTF-16 code unit(s) into window "${target.title}" (target ${handle}, ${target.kind}) in background mode: cursor untouched, foreground unchanged. `
				+ deliveryLine(result) + minimizedCaveat,
			cursor: win32.cursorPosition(),
			target: targetOfTargetWindow(target),
			background: {
				handle,
				title: target.title,
				kind: target.kind,
				reliable: result.reliable,
				note: result.note,
				delivered: result.delivered,
			},
		};
	}

	const buttonName = args.action.startsWith('right') ? 'right' : args.action.startsWith('middle') ? 'middle' : 'left';
	if (args.x === undefined || args.y === undefined) {
		// 后台点击没有"在光标处点击"这种语义：坐标要靠消息里的 lParam 携带
		throw new Error(`后台模式的 "${args.action}" 需要 x/y：消息投递必须携带客户区坐标，没有"在光标处点击"这种语义`);
	}
	const coordinates = { x: requireInteger(args, 'x'), y: requireInteger(args, 'y') };

	const { record, stale } = usableCapture(captures, target);
	const converted = toClientPoint(coordinates, record, target);
	const result = backgroundClick(win32, target, converted.point, buttonName);

	return {
		action: args.action,
		summary: `Background ${buttonName} click delivered to window "${target.title}" (target ${handle}, ${target.kind}) at client-area (${converted.point.x}, ${converted.point.y}): cursor untouched, foreground unchanged. `
			+ `${describeCoordinateSource(converted.source, record, stale)}. `
			+ deliveryLine(result) + buttonCaveat(buttonName) + minimizedCaveat
			+ describeOutOfBounds(converted.point, target.client),
		cursor: win32.cursorPosition(),
		target: targetOfTargetWindow(target),
		background: {
			handle,
			title: target.title,
			kind: target.kind,
			reliable: result.reliable,
			note: result.note,
			delivered: result.delivered,
			coordinateSource: converted.source,
			point: converted.point,
		},
	};
}

