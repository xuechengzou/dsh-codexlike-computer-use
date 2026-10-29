/**
 * 状态路由的行为测试：读写、同源校验、错误码。
 *
 * 不需要真起 HTTP 服务器：`registerStateRoute` 拿到的 handler 就是纯函数式的
 * (request, response) → Promise，用两个假对象即可覆盖全部分支。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createState } from '../lib/state.js';
import { registerStateRoute, STATE_PATH } from '../lib/route.js';

/** 假请求：EventEmitter + 头 + 方法。 */
function makeRequest({ method = 'GET', headers = {}, body = '' } = {}) {
	const emitter = new EventEmitter();
	emitter.method = method;
	emitter.headers = headers;
	queueMicrotask(() => {
		if (body.length > 0) emitter.emit('data', { toString: () => body });
		emitter.emit('end');
	});
	return emitter;
}

/** 假响应：收集状态码、头与正文。 */
function makeResponse() {
	const result = { statusCode: 200, headers: {}, body: '' };
	return {
		result,
		get statusCode() {
			return result.statusCode;
		},
		set statusCode(value) {
			result.statusCode = value;
		},
		setHeader(name, value) {
			result.headers[name.toLowerCase()] = value;
		},
		end(body) {
			result.body = body ?? '';
		},
	};
}

/** 用一个假的 webServer 装上路由并返回调用入口。 */
function mount(state) {
	let route;
	const ctx = {
		get: (name) => (name === 'webServer' ? { register: (next) => { route = next; return () => { route = undefined; }; } } : undefined),
	};
	const dispose = registerStateRoute(ctx, state);
	assert.equal(typeof dispose, 'function');
	assert.equal(route.path, STATE_PATH);
	assert.equal(route.kind, 'exact');
	return {
		call: (request) => {
			const response = makeResponse();
			return Promise.resolve(route.handler(request, response)).then(() => response.result);
		},
		dispose,
		hasRoute: () => route !== undefined,
	};
}

test('GET 返回当前模式与允许的模式表', async () => {
	const state = createState({ inputMode: 'window', allowInput: true });
	const { call } = mount(state);
	const response = await call(makeRequest());
	assert.equal(response.statusCode, 200);
	const payload = JSON.parse(response.body);
	assert.equal(payload.inputMode, 'window');
	assert.deepEqual(payload.inputModes, ['window', 'foreground', 'both']);
});

test('POST 改模式并立即反映到状态', async () => {
	const state = createState({ inputMode: 'window', allowInput: true });
	const { call } = mount(state);
	const response = await call(makeRequest({ method: 'POST', body: JSON.stringify({ inputMode: 'foreground' }) }));
	assert.equal(response.statusCode, 200);
	assert.equal(JSON.parse(response.body).inputMode, 'foreground');
	assert.equal(state.get().inputMode, 'foreground');
});

test('POST 非法模式返回 400 且状态不变', async () => {
	const state = createState({ inputMode: 'window', allowInput: true });
	const { call } = mount(state);
	const response = await call(makeRequest({ method: 'POST', body: JSON.stringify({ inputMode: 'telepathy' }) }));
	assert.equal(response.statusCode, 400);
	assert.equal(JSON.parse(response.body).error, 'invalid-input-mode');
	assert.equal(state.get().inputMode, 'window');
});

test('跨站请求被拒绝', async () => {
	const state = createState({ inputMode: 'window', allowInput: true });
	const { call } = mount(state);
	const response = await call(makeRequest({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{}' }));
	assert.equal(response.statusCode, 403);
	assert.equal(JSON.parse(response.body).error, 'cross-site');
});

test('Origin 与 Host 不一致被拒绝（防任意网页改模式）', async () => {
	const state = createState({ inputMode: 'window', allowInput: true });
	const { call } = mount(state);
	const response = await call(makeRequest({
		method: 'POST',
		headers: { origin: 'https://evil.example', host: '127.0.0.1:16990' },
		body: JSON.stringify({ inputMode: 'foreground' }),
	}));
	assert.equal(response.statusCode, 403);
	assert.equal(JSON.parse(response.body).error, 'origin-mismatch');
});

test('同源 Origin 放行', async () => {
	const state = createState({ inputMode: 'window', allowInput: true });
	const { call } = mount(state);
	const response = await call(makeRequest({
		method: 'POST',
		headers: { origin: 'http://127.0.0.1:16990', host: '127.0.0.1:16990' },
		body: JSON.stringify({ inputMode: 'both' }),
	}));
	assert.equal(response.statusCode, 200);
	assert.equal(state.get().inputMode, 'both');
});

test('非 GET/POST 返回 405 并带 Allow 头', async () => {
	const state = createState({ inputMode: 'window', allowInput: true });
	const { call } = mount(state);
	const response = await call(makeRequest({ method: 'DELETE' }));
	assert.equal(response.statusCode, 405);
	assert.equal(response.headers.allow, 'GET, POST');
});

test('非法 JSON 与超大请求体被拒绝', async () => {
	const state = createState({ inputMode: 'window', allowInput: true });
	const { call } = mount(state);

	const bad = await call(makeRequest({ method: 'POST', body: '{oops' }));
	assert.equal(bad.statusCode, 400);
	assert.equal(JSON.parse(bad.body).error, 'invalid-json');

	const huge = await call(makeRequest({ method: 'POST', body: 'x'.repeat(5000) }));
	assert.equal(huge.statusCode, 400);
	assert.equal(JSON.parse(huge.body).error, 'body-too-large');
});

test('卸载时路由被移除', () => {
	const state = createState({ inputMode: 'window', allowInput: true });
	const mounted = mount(state);
	assert.equal(mounted.hasRoute(), true);
	mounted.dispose();
	assert.equal(mounted.hasRoute(), false);
});

test('宿主没有 webServer 时不注册（不抛错）', () => {
	const state = createState({ inputMode: 'window', allowInput: true });
	const dispose = registerStateRoute({ get: () => undefined }, state);
	assert.equal(dispose, undefined);
});
