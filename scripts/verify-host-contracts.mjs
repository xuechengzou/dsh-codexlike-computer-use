/**
 * 用**宿主真实的** `defineTool` 与 schemastery 校验插件的契约。
 *
 * 单元测试用的是本地替身（真身在 test/doubles/，由 scripts/link-doubles.mjs
 * 联接到 node_modules），因此无法回答两个关键问题：
 *   1. 宿主真实的 schemastery 是否接受本插件的 Config schema，默认值填充是否一致？
 *   2. 宿主真实的 `defineTool` 是否接受本插件的参数 DSL 与输出 schema，
 *      编译出来的 JSON Schema 是否就是模型将看到的样子？
 *
 * 这两处一旦不兼容，插件会在宿主加载期直接失败。本脚本在**不修改任何 profile**
 * 的前提下把它们验证掉：把替身委派给宿主包，跑同一份 `lib/*.js`。
 *
 * 用法：
 *   node scripts/link-doubles.mjs && node scripts/verify-host-contracts.mjs <宿主 node_modules 根>
 * （下面的裸 import 走 node_modules 里的替身联接，先跑 link-doubles 让联接就位。）
 */
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const hostRoot = process.argv[2];
if (hostRoot === undefined) {
	console.error('用法: node scripts/verify-host-contracts.mjs <宿主 node_modules 根目录>');
	process.exitCode = 2;
} else {
	const toolsEntry = join(hostRoot, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
	const schemaEntry = join(hostRoot, '@deepseek-ai', 'schemastery', 'lib', 'index.mjs');
	for (const [label, path] of [['dsh-tools', toolsEntry], ['schemastery', schemaEntry]]) {
		if (!existsSync(path)) {
			console.error(`找不到宿主包 ${label}: ${path}`);
			process.exitCode = 2;
		}
	}

	// 必须在 import 插件模块之前设置：替身在模块求值期读取它们。
	// 这里传**纯文件系统路径**——替身自己会做 pathToFileURL。
	process.env.DSH_COMPUTER_USE_REAL_HOST_TOOLS = toolsEntry;
	process.env.DSH_COMPUTER_USE_REAL_HOST_SCHEMASTERY = schemaEntry;

	const failures = [];
	const { usingRealHostTools } = await import('@deepseek-ai/dsh-tools');
	const { usingRealSchemastery } = await import('@deepseek-ai/schemastery');
	if (!usingRealHostTools || !usingRealSchemastery) {
		failures.push('替身没有成功委派给宿主真实包');
	}

	// ---- 1. Config schema -------------------------------------------------
	console.log('=== Config schema（宿主真实 schemastery）===');
	const { Config, assertConfig } = await import('../lib/config.js');
	console.log(`schema 可调用: ${typeof Config === 'function'}`);
	let resolved;
	try {
		// 宿主的 schema 是可调用对象：`Config(value)` 返回解析结果
		resolved = Config({});
		console.log('默认值:', JSON.stringify(resolved, null, 2));
	} catch (error) {
		failures.push(`Config({}) 抛出: ${error.message}`);
	}

	if (resolved !== undefined) {
		try {
			assertConfig(resolved);
			console.log('✓ 默认配置通过跨字段校验');
		} catch (error) {
			failures.push(`assertConfig(默认值) 抛出: ${error.message}`);
		}

		// 与插件文档承诺的默认值逐项对齐
		const expected = {
			enabled: true,
			allowInput: true,
			typingChunkSize: 8,
			typingChunkDelayMs: 12,
			settleMs: 400,
			doubleClickIntervalMs: 60,
			warmupInjection: true,
			dragSteps: 12,
			maxWaitMs: 10_000,
			maxTextLength: 8_000,
			maxDimension: 1568,
			pngLevel: 6,
			requireApproval: false,
		};
		for (const [key, want] of Object.entries(expected)) {
			if (resolved[key] !== want) failures.push(`默认值 ${key} = ${JSON.stringify(resolved[key])}，期望 ${JSON.stringify(want)}`);
		}
		if (!Array.isArray(resolved.deniedKeys) || resolved.deniedKeys.length !== 0) failures.push('deniedKeys 默认应为空数组');

		// 显式覆盖仍然生效
		const overridden = Config({ allowInput: false, maxDimension: 640, deniedKeys: ['ctrl+w'] });
		if (overridden.allowInput !== false || overridden.maxDimension !== 640) failures.push('显式覆盖未生效');
		if (overridden.typingChunkDelayMs !== 12) failures.push('未被覆盖的项应保持默认值');
		// 宿主真实 schema 对未知键的处理策略要与插件假设一致
		if (!('deniedKeys' in overridden) || overridden.deniedKeys[0] !== 'ctrl+w') failures.push('deniedKeys 覆盖未生效');
		console.log('✓ 默认值与覆盖行为符合预期');
	}

	// ---- 2. Tool definition ----------------------------------------------
	console.log('\n=== Tool definition（宿主真实 defineTool）===');
	const registered = [];
	const fakeCtx = {
		tools: { register: (definition) => { registered.push(definition); return () => {}; } },
		systemPrompt: { section: () => () => {} },
		computerUse: { register: () => async () => {} },
		logger: { warn: () => {} },
		get: () => undefined,
	};

	try {
		const { registerComputerTool } = await import('../lib/tool.js');
		registerComputerTool(fakeCtx, resolved);
	} catch (error) {
		failures.push(`registerComputerTool 抛出: ${error.stack ?? error.message}`);
	}

	if (registered.length !== 1) {
		failures.push(`应注册恰好一个工具，实际 ${registered.length}`);
	} else {
		const tool = registered[0];
		console.log(`name=${tool.name}  timeoutMs=${tool.timeoutMs}`);
		console.log('编译后的 parameters JSON Schema:');
		console.log(JSON.stringify(tool.parameters, null, 2));
		if (tool.parameters?.properties?.action?.enum === undefined) failures.push('action 枚举没有出现在编译结果里');
		if (tool.parameters?.properties?.region?.type !== 'object') failures.push('region 未被编译成对象参数');
		console.log('✓ 宿主真实 defineTool 接受了本插件的参数与输出 schema');
	}

	console.log('\n=== 结论 ===');
	if (failures.length === 0) {
		console.log('宿主契约校验全部通过');
	} else {
		for (const failure of failures) console.error(`✗ ${failure}`);
		process.exitCode = 1;
	}
}
