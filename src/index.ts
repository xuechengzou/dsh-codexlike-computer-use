/**
 * dsh-computer-use — 给 DSH 提供 Codex 风格的 computer use。
 *
 * 注册一个 `computer` 工具（截图 + 鼠标键盘）和一段系统提示词，并在宿主
 * 挂载了 computer-use 服务时占用它的 provider 槽位。
 *
 * **`computerUse` 不是硬依赖。** 该服务是"可选的 provider 槽位"，并非每个
 * 组合都会挂载它——本机安装里只存在它的服务契约、没有任何实现。若把它写进
 * `inject`，插件的 fiber 会永远停在 `pending`：宿主不报错，工具却从不注册，
 * 表现为"插件看起来装好了，但模型看不到工具"。这类静默失效最难排查。
 *
 * 原生依赖（koffi）只在第一次真正执行动作时加载，因此缺少原生模块或
 * 运行在非 Windows 平台时，插件本身仍能正常加载并在调用时给出可读诊断，
 * 而不是把整个宿主的启动拖垮。
 */

import type { Context } from '@deepseek-ai/cordis';
import { assertConfig, Config, type ConfigValues } from './config.js';
import type { ComputerUseService } from './contracts.js';
import { registerComputerUsePrompt } from './prompt.js';
import { registerStateRoute } from './route.js';
import { createState } from './state.js';
import { registerToolIndicator } from './tool-indicator.js';
import { registerTools } from './tools.js';

export { Config };

/** Cordis 加载器诊断用的插件名。 */
export const name = 'dsh-computer-use';

/**
 * 硬依赖：只包含本插件真正必需的注册表。
 *
 * 刻意不含 `computerUse`——理由见文件头注释。
 */
export const inject = ['tools', 'systemPrompt'];

/** 槽位占用的结果。 */
type SlotReservation = { ok: true; release?: () => Promise<void> } | { ok: false };

/**
 * 尝试占用 computer-use provider 槽位。
 *
 * 三条路径：
 * - **宿主未挂载该服务**（本机即如此）：没有任何提供者需要协调，继续注册工具。
 * - **服务在且槽位空闲**：占用成功，返回卸载时归还用的释放函数。
 * - **服务在但槽位已被别的提供者占用**：放弃注册工具，让那个提供者独占——
 *   两个提供者注册同名 `computer` 工具只会在宿主里炸出重复注册错误。
 *
 * @param ctx - 插件上下文。
 * @returns 是否可以继续注册工具，以及归还槽位用的释放函数。
 */
function reserveComputerUseSlot(ctx: Context): SlotReservation {
	const service = ctx.get('computerUse') as ComputerUseService | undefined;
	if (service === undefined) return { ok: true };
	try {
		return { ok: true, release: service.register(name) };
	} catch (error) {
		ctx.logger?.warn?.(`[computer-use] computer-use provider 槽位已被占用，已跳过工具注册：${String(error)}`);
		return { ok: false };
	}
}

/**
 * 激活插件。
 *
 * @param ctx - 插件上下文。
 * @param config - 经 schema 解析的配置。
 * @returns 卸载时释放 provider 槽位的清理函数。
 */
export function apply(ctx: Context, rawConfig?: ConfigValues): (() => Promise<void>) | undefined {
	/**
	 * 自己补齐默认值，不假定宿主已经做过。
	 *
	 * 宿主的 Loader 只在认得这份 schema 时才替插件解析配置；插件的 schemastery
	 * 来自 profile 的 node_modules，与宿主内那份是两个模块实例，认不出来时
	 * `apply` 收到的就是 `undefined`，随后 `assertConfig` 抛错、整条 fiber 停在
	 * `failed`（实测报错：`Cannot read properties of undefined (reading
	 * 'typingChunkSize')`）。
	 *
	 * Schema 本身是可调用的：`Config({})` 按 schema 补齐默认值。因此这里无论宿主
	 * 传没传、传得全不全，都收敛成一份完整配置。
	 */
	const config = Config(rawConfig ?? {}) as ConfigValues;
	assertConfig(config);
	if (!config.enabled) return undefined;

	const slot = reserveComputerUseSlot(ctx);
	if (!slot.ok) return undefined;

	// 运行时模式：Config 只提供初值，界面可以随时改它，工具执行时读同一份
	const state = createState({ inputMode: config.inputMode, allowInput: config.allowInput });

	registerTools(ctx, config, state);
	registerComputerUsePrompt(ctx);

	// 屏幕边框：工具执行期间亮，执行完淡出
	const disposeIndicator = registerToolIndicator(ctx);

	// 状态路由必须**等 webServer 就位**再注册。
	//
	// 实测踩过：apply 只等 tools / systemPrompt，这两个服务比 webServer 早得多，
	// 于是 apply 时 ctx.get('webServer') 是 undefined，路由被静默跳过——面板拿
	// 状态时得到 404。用 ctx.inject 起一个等依赖就位的子 fiber 才是正确时机。
	let disposeRoute: (() => void) | undefined;
	ctx.inject(['webServer'], (scope: Context) => {
		disposeRoute = registerStateRoute(scope, state);
	});

	return async () => {
		// 工具与提示词段落的处置由 ctx 的生命周期负责；这里只清掉自己注册的路由
		disposeIndicator();
		disposeRoute?.();
		await slot.release?.();
	};
}
