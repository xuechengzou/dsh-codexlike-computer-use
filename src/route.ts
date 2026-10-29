/**
 * 状态路由：让界面（以及任何本机客户端）读写当前的输入模式。
 *
 * 为什么不用宿主的 Remote 体系：那是宿主自己的服务契约，第三方插件要接进去
 * 需要生成 typert schema；而这里只是"读一个枚举、写一个枚举"，一条同源 HTTP
 * 路由就够，且不依赖宿主版本。
 *
 * 安全边界：
 * - 只注册 `exact` 路由，路径写死。
 * - 写操作必须是 `POST`，且 `Origin`（若存在）必须与本机 host 一致；
 *   `Sec-Fetch-Site: cross-site` 一律拒绝——这是防"任意网页改你输入模式"。
 * - 请求体上限 4KB，解析失败即 400，不做猜测。
 */

import type { Context } from '@deepseek-ai/cordis';
import { INPUT_MODES } from './config.js';
import type { StateStore } from './state.js';

/** 路由路径；界面与文档共用这一处。 */
export const STATE_PATH = '/dsh-computer-use/state';

/** 请求体上限：只需要一个小 JSON。 */
const MAX_BODY_BYTES = 4096;

/** 宿主 `webServer` 服务里本模块用到的窄契约。 */
interface WebServerLike {
	register(route: {
		kind: 'exact' | 'prefix';
		path: string;
		handler: (request: RouteRequest, response: RouteResponse) => void | Promise<void>;
	}): () => void;
}

/** Node 请求的最小面。 */
interface RouteRequest {
	readonly method?: string;
	readonly headers: Record<string, string | string[] | undefined>;
	on(event: 'data', listener: (chunk: { toString(encoding: 'utf8'): string }) => void): void;
	on(event: 'end', listener: () => void): void;
	on(event: 'error', listener: (error: Error) => void): void;
}

/** Node 响应的最小面。 */
interface RouteResponse {
	statusCode: number;
	setHeader(name: string, value: string): void;
	end(body?: string): void;
}

/** 读取结果：要么是完整文本，要么是明确的失败原因。 */
type BodyResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * 读取请求体，超过上限立刻中止。
 *
 * @param request - 请求对象。
 * @returns 读取结果。
 */
function readBody(request: RouteRequest): Promise<BodyResult> {
	return new Promise((resolve) => {
		const chunks: string[] = [];
		let size = 0;
		let settled = false;
		const finish = (result: BodyResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		request.on('data', (chunk) => {
			size += chunk.toString('utf8').length;
			if (size > MAX_BODY_BYTES) {
				finish({ ok: false, reason: 'body-too-large' });
				return;
			}
			chunks.push(chunk.toString('utf8'));
		});
		request.on('end', () => finish({ ok: true, text: chunks.join('') }));
		request.on('error', (error) => finish({ ok: false, reason: String(error.message) }));
	});
}

/**
 * 判断请求是否来自本机页面。
 *
 * @param request - 请求对象。
 * @returns 允许与否，以及拒绝原因。
 */
function sameOrigin(request: RouteRequest): { ok: true } | { ok: false; reason: string } {
	const site = request.headers['sec-fetch-site'];
	if (typeof site === 'string' && site === 'cross-site') return { ok: false, reason: 'cross-site' };

	const origin = request.headers.origin;
	if (origin === undefined) return { ok: true };
	if (typeof origin !== 'string') return { ok: false, reason: 'origin-header-invalid' };

	const host = request.headers.host;
	if (typeof host !== 'string') return { ok: false, reason: 'host-header-missing' };
	try {
		if (new URL(origin).host !== host) return { ok: false, reason: 'origin-mismatch' };
	} catch {
		return { ok: false, reason: 'origin-unparseable' };
	}
	return { ok: true };
}

/**
 * 注册状态路由。
 *
 * @param ctx - 插件上下文。
 * @param state - 运行时状态。
 * @returns 卸载函数；宿主没有 web 服务器时返回 `undefined`（插件照常工作）。
 */
export function registerStateRoute(ctx: Context, state: StateStore): (() => void) | undefined {
	const server = ctx.get('webServer') as WebServerLike | undefined;
	if (server === undefined || typeof server.register !== 'function') return undefined;

	return server.register({
		kind: 'exact',
		path: STATE_PATH,
		handler: async (request, response) => {
			const send = (status: number, payload: unknown): void => {
				response.statusCode = status;
				response.setHeader('content-type', 'application/json; charset=utf-8');
				response.setHeader('cache-control', 'no-store');
				response.end(JSON.stringify(payload));
			};

			const origin = sameOrigin(request);
			if (!origin.ok) {
				send(403, { error: origin.reason });
				return;
			}

			if (request.method === 'GET') {
				const current = state.get();
				send(200, {
					inputMode: current.inputMode,
					allowInput: current.allowInput,
					inputModes: [...INPUT_MODES],
					path: STATE_PATH,
				});
				return;
			}

			if (request.method !== 'POST') {
				response.setHeader('allow', 'GET, POST');
				send(405, { error: 'method-not-allowed' });
				return;
			}

			const body = await readBody(request);
			if (!body.ok) {
				send(400, { error: body.reason });
				return;
			}

			let parsed: unknown;
			try {
				parsed = body.text.length === 0 ? {} : JSON.parse(body.text);
			} catch {
				send(400, { error: 'invalid-json' });
				return;
			}
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				send(400, { error: 'expected-object' });
				return;
			}

			const patch = parsed as { inputMode?: unknown; allowInput?: unknown };
			if (patch.inputMode !== undefined && !(INPUT_MODES as readonly unknown[]).includes(patch.inputMode)) {
				send(400, { error: 'invalid-input-mode', allowed: [...INPUT_MODES] });
				return;
			}
			if (patch.allowInput !== undefined && typeof patch.allowInput !== 'boolean') {
				send(400, { error: 'invalid-allow-input' });
				return;
			}

			const next = state.set({
				...(patch.inputMode === undefined ? {} : { inputMode: patch.inputMode as string }),
				...(patch.allowInput === undefined ? {} : { allowInput: patch.allowInput as boolean }),
			});
			send(200, { inputMode: next.inputMode, allowInput: next.allowInput, inputModes: [...INPUT_MODES], path: STATE_PATH });
		},
	});
}
