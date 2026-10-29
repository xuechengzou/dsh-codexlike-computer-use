/**
 * 屏幕指示器的**提前熄灭**信号：回合结束（agent 回到 idle）时立刻淡出，
 * 不再等 `LINGER_MS` 宽限期。
 *
 * 为什么需要它：点亮与续期由 computer use 工具自己调用 `touchOverlay()` 完成
 * （见 `tools.ts` / `tool.ts`），但"这一轮已经结束、后面肯定不会再操作界面了"
 * 只有宿主知道。`agent/status` 的 `idle` 就是那个信号——留着灯不灭会让用户
 * 以为 agent 还在动他的机器。
 *
 * 只监听 `idle`，不监听 `running`：点亮必须由**真实调用**触发，否则又会变成
 * "一发消息就亮"。
 */

import type { Context } from '@deepseek-ai/cordis';
import { forceHideOverlay } from './overlay.js';

/** `agent/status` 的载荷形状（只取本模块用到的字段）。 */
interface AgentStatusPayload {
	status?: string;
}

/**
 * 注册回合结束时的熄灭逻辑。
 *
 * @param ctx - 插件上下文。
 * @returns 卸载函数。
 */
export function registerTurnIndicator(ctx: Context): () => void {
	// 没有事件服务时安静退出：指示器是附加效果，不能因为它让插件装配失败
	if (typeof (ctx as { on?: unknown }).on !== 'function') return () => {};

	const dispose = ctx.on('agent/status', (raw) => {
		const payload = raw as AgentStatusPayload | undefined;
		if (payload?.status === 'idle') forceHideOverlay();
	});

	return () => {
		dispose();
		forceHideOverlay();
	};
}
