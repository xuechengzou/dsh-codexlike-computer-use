/**
 * 插件配置（schemastery）。默认值面向"开箱可用且不伤及用户桌面"。
 */

import z from '@deepseek-ai/schemastery';

/** 允许的输入模式；顺序即界面上的展示顺序。 */
export const INPUT_MODES = ['window', 'foreground', 'both'] as const;

/** 输入模式。 */
export type InputMode = (typeof INPUT_MODES)[number];

/** 配置 schema；profile 的 cordis.patch.yml 可逐项覆盖。 */
export const Config = z.object({
	/** 总开关。关闭后不再注册工具与提示词段。 */
	enabled: z.boolean().default(true),

	/** 是否允许模拟鼠标键盘。`false` 时插件退化为"只能看，不能动"。 */
	allowInput: z.boolean().default(true),

	/**
	 * 是否允许前台模式的输入（不传 `target` 的输入动作），默认关闭。
	 *
	 * 开启后，不传 `target` 的输入动作会用 SendInput 注入真实事件：会移动用户的
	 * 真实光标、并把焦点从用户正在输入的地方抢走。后台模式（带 `target`）已能
	 * 覆盖大部分场景，因此"不碰用户的鼠标键盘"必须是默认行为而不是一句承诺；
	 * 只有部署方显式打开本项，模型才有前台模式可用。
	 */
	allowForegroundInput: z.boolean().default(false),

	/**
	 * 输入模式：`window`（默认，只走后台投递）、`foreground`（真实鼠标键盘）、
	 * `both`（由模型按次选择）。
	 *
	 * 这是**部署默认值**：设置界面可以把它切成别的值并立即生效，但重启后
	 * 从这里恢复。`window` 之所以是默认，是因为前台模式会真的移动用户的光标。
	 */
	inputMode: z.string().default('window'),

	/** 每个 SendInput 批次承载的 UTF-16 单元数。 */
	typingChunkSize: z.number().default(8),

	/** 批次之间的让出毫秒数。实测 <12ms 会显著提高丢字概率，不建议调低。 */
	typingChunkDelayMs: z.number().default(12),

	/**
	 * 键盘注入前等待前台窗口稳定的上限（毫秒）。
	 * 判定标准是连续两次采样读到同一句柄，因此这是上限而不是固定等待。
	 */
	settleMs: z.number().default(400),

	/** 连击时两次点击之间的间隔，需落在系统的双击判定窗口内。 */
	doubleClickIntervalMs: z.number().default(60),

	/**
	 * 是否在每次键盘注入前先送一对无害的"牺牲"按键。
	 *
	 * 焦点切换后的首批合成输入会被系统间歇性丢弃（实测丢掉开头 1–2 个字符，
	 * 且延长等待无法消除）。牺牲对先用掉这个丢弃额度，真实内容才完整。
	 * 默认开启；仅在目标程序对孤立 Shift 事件敏感时才需要关闭。
	 */
	warmupInjection: z.boolean().default(true),

	/** 拖拽时插入的中间移动步数。 */
	dragSteps: z.number().default(12),

	/** `wait` 动作允许的最长毫秒数。 */
	maxWaitMs: z.number().default(10000),

	/** 单次 `type` 允许注入的最大字符数。 */
	maxTextLength: z.number().default(8000),

	/** 截图长边上限；`0` 表示按原生分辨率抓取（仍受部署图像上限约束）。 */
	maxDimension: z.number().default(1568),

	/** PNG zlib 压缩级别；调低可换更快的捕获速度。 */
	pngLevel: z.number().default(6),

	/**
	 * `window` 动作最多列出几个候选窗口（默认 20）。
	 *
	 * 真实桌面上顶层窗口动辄几十上百个（各种辅助工具、隐藏宿主），全列出来只会
	 * 把上下文塞满噪音，而模型要找的目标几乎总在最近活跃的几个里。模型可以用
	 * `limit` 要得更少，但要不到更多——上限由部署方决定。
	 */
	windowListLimit: z.number().default(20),

	/**
	 * 是否允许后台截图（带 `target` 的 screenshot），默认开启。
	 *
	 * 后台截图走 PrintWindow：不把目标窗口带到前台、也不动光标。关掉它意味着
	 * 带 `target` 的 screenshot 直接报错，模型只能回到前台截图。
	 * 后台**输入**不在此开关下——它已经由 allowInput 与 requireApproval 管束。
	 */
	backgroundCaptureEnabled: z.boolean().default(true),

	/** 可访问性树最多输出多少个节点（默认 400）。 */
	treeNodeLimit: z.number().default(400),

	/** 可访问性树的最大层级（默认 12）。 */
	treeDepthLimit: z.number().default(12),

	/** 拒绝注入的组合键写法，例如 `["ctrl+alt+Delete"]`。大小写与分隔符不敏感。 */
	deniedKeys: z.array(z.string()).default([]),

	/**
	 * 是否让每个输入动作先走宿主审批。
	 *
	 * 默认关闭：宿主的权限预设已经按会话约束了工具可用性，而审批策略为
	 * `never` 的会话会把"需要审批"直接判为拒绝，使工具彻底不可用。需要更
	 * 强约束的部署在 profile 里打开即可（`ask` 策略下会逐次询问）。
	 */
	requireApproval: z.boolean().default(false),
});

/** 解析后的配置值。 */
export interface ConfigValues {
	enabled: boolean;
	allowInput: boolean;
	allowForegroundInput: boolean;
	inputMode: string;
	typingChunkSize: number;
	typingChunkDelayMs: number;
	settleMs: number;
	doubleClickIntervalMs: number;
	warmupInjection: boolean;
	dragSteps: number;
	maxWaitMs: number;
	maxTextLength: number;
	maxDimension: number;
	pngLevel: number;
	windowListLimit: number;
	backgroundCaptureEnabled: boolean;
	treeNodeLimit: number;
	treeDepthLimit: number;
	deniedKeys: string[];
	requireApproval: boolean;
}

/**
 * 校验配置里彼此约束的取值。
 *
 * schema 只能表达单字段类型，跨字段的语义约束在这里集中检查，
 * 让配置错误在插件加载时暴露，而不是在模型第一次调用时才炸。
 *
 * @param config - 已解析的配置。
 * @throws 当取值组合非法时。
 */
export function assertConfig(config: ConfigValues): void {
	const positive = (name: keyof ConfigValues, value: number): void => {
		if (!Number.isFinite(value) || value <= 0) throw new Error(`computer-use: 配置 ${String(name)} 必须是正数，收到 ${value}`);
	};
	const nonNegative = (name: keyof ConfigValues, value: number): void => {
		if (!Number.isFinite(value) || value < 0) throw new Error(`computer-use: 配置 ${String(name)} 不能为负数，收到 ${value}`);
	};

	nonNegative('typingChunkSize', config.typingChunkSize);
	nonNegative('typingChunkDelayMs', config.typingChunkDelayMs);
	nonNegative('settleMs', config.settleMs);
	nonNegative('maxDimension', config.maxDimension);
	nonNegative('dragSteps', config.dragSteps);
	nonNegative('doubleClickIntervalMs', config.doubleClickIntervalMs);
	positive('maxWaitMs', config.maxWaitMs);
	positive('maxTextLength', config.maxTextLength);
	positive('windowListLimit', config.windowListLimit);
	positive('treeNodeLimit', config.treeNodeLimit);
	positive('treeDepthLimit', config.treeDepthLimit);

	if (config.pngLevel < 0 || config.pngLevel > 9) {
		throw new Error(`computer-use: pngLevel 必须在 0–9 之间，收到 ${config.pngLevel}`);
	}
	if (config.typingChunkSize < 2) {
		throw new Error(`computer-use: typingChunkSize 至少为 2（一次 SendInput 必须成对下发按下与抬起），收到 ${config.typingChunkSize}`);
	}
	if (config.allowInput && config.typingChunkDelayMs < 1) {
		throw new Error('computer-use: typingChunkDelayMs 至少为 1；0 延迟会让系统丢弃注入的字符');
	}
	if (!(INPUT_MODES as readonly string[]).includes(config.inputMode)) {
		throw new Error(`computer-use: inputMode 只能是 ${INPUT_MODES.join(' / ')}，收到 ${JSON.stringify(config.inputMode)}`);
	}
}
