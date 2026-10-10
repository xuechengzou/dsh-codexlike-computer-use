/**
 * 路由图像能力门。
 *
 * 与宿主 `read_image` 同构：先解析**当前会话实际路由到的** provider/model，
 * 再要求该路由显式声明支持 `image` 输入。理由相同——截图只有被调用方模型
 * 真正"看得见"才有意义；若模型不支持图像，应当在做捕获与持久化之前就拒绝，
 * 而不是等适配器在更后面报错、白白消耗一次往返。
 *
 * 解析顺序也是照抄宿主的：会话请求头里的 config 优先，其次 agent 选项。
 */

import type { AgentLike, LlmService } from './contracts.js';

/** 解析出的路由。 */
export interface ResolvedRoute {
	provider: string;
	model: string;
}

/**
 * 读取当前会话路由。
 *
 * @param agent - 调用方 agent；缺失时无法判定能力。
 * @returns 路由，或 undefined 表示无法解析。
 */
export function resolveRoute(agent: AgentLike | undefined): ResolvedRoute | undefined {
	if (agent === undefined) return undefined;
	const routed = agent.session?.requestHeader?.()?.config;
	const provider = routed?.provider ?? agent.options?.provider;
	const model = routed?.model ?? agent.options?.model;
	if (provider === undefined || model === undefined) return undefined;
	return { provider, model };
}

/**
 * 断言当前路由接受图像输入。
 *
 * @param llm - 已挂载的 llm 服务；缺失时按"无法判定"处理，fail closed。
 * @param agent - 调用方 agent。
 * @param what - 失败信息里回显的动作，便于模型自我纠正。
 * @param signal - 调用方取消信号。
 * @throws 当路由无法解析、或未声明 `image` 输入时抛出可读错误。
 */
export async function assertImageCapableRoute(
	llm: LlmService | undefined,
	agent: AgentLike | undefined,
	what: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	const route = resolveRoute(agent);
	if (llm === undefined || route === undefined) {
		throw new Error(`${what}需要能接收图像的模型，但当前模型路由无法解析；请切换到一个支持图像输入的模型后重试`);
	}
	const info = await llm.resolveModelInfo(route.provider, route.model, signal);
	if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
		throw new Error(`${what}需要模型支持图像输入，但 "${route.model}" 没有声明 image 输入能力；请切换到支持视觉的模型`);
	}
}
