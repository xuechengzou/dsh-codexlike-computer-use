/**
 * 把屏幕边框接到**工具执行**上：只有工具真的在跑时亮，跑完立刻淡出。
 *
 * 为什么不用 `agent/status`：那个事件在整个对话回合内都是 `running`，
 * 结果是一发消息边框就亮——用户要的是"调用工具才开始"。
 *
 * `tools/execute` 是 waterfall 事件，宿主这样派发（dsh-tools/lib/index.js:3427）：
 *
 *     waterfall(carrier, 'tools/execute', exec, () => this.dispatchToolBody(exec))
 *
 * 也就是说处理函数收到 `(exec, next)`，`await next()` 前后正好夹住工具执行体。
 * 用 try/finally 保证异常路径也会释放，边框不会卡住。
 */

import type { Context } from '@deepseek-ai/cordis';
import { holdOverlay, releaseOverlay } from './overlay.js';

/** `tools/execute` 处理函数的形状（waterfall）。 */
type ExecuteHandler = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;

/**
 * 注册工具执行指示器。
 *
 * @param ctx - 插件上下文。
 * @returns 卸载函数。
 */
export function registerToolIndicator(ctx: Context): () => void {
	// 没有事件服务时安静退出：指示器是附加效果，不能因为它让插件装配失败
	if (typeof (ctx as { on?: unknown }).on !== 'function') return () => {};

	const handler: ExecuteHandler = async (_payload, next) => {
		holdOverlay();
		try {
			return await next();
		} finally {
			releaseOverlay();
		}
	};

	// on() 的声明只覆盖 emit 事件；waterfall 事件同样走 on 注册，这里放宽类型
	const dispose = (ctx.on as unknown as (
		event: string,
		listener: ExecuteHandler,
	) => () => void)('tools/execute', handler);

	return () => {
		dispose();
	};
}
