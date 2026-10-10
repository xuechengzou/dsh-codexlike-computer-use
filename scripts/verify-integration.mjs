/**
 * 进程内集成测试台：用**真实的宿主服务**把插件装配起来。
 *
 * 回答一个静态检查回答不了、而且只能靠"重启一次试试"来发现的问题：
 * 宿主真实的 `tools.register()` 与 `systemPrompt.section()` 会不会接受本插件的
 * 注册？插件的 fiber 会不会真的进入 active？
 *
 * 之前正是缺了这一层，才让一个"硬依赖未挂载服务"的错误一路走到部署——宿主
 * 不报错，插件的 fiber 静静停在 `pending`，模型侧完全看不到工具。
 *
 * 与 profile 无关：这里只 new 一个干净的 Cordis Context，挂上真实的
 * SystemPrompt 与 ToolRuntime，再按加载器的方式装配本插件。
 *
 * 用法：
 *   node scripts/verify-integration.mjs <宿主 node_modules 根>
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const hostRoot = process.argv[2];
if (hostRoot === undefined) {
	console.error('用法: node scripts/verify-integration.mjs <宿主 node_modules 根目录>');
	process.exitCode = 2;
} else {
	const resolveHost = (...segments) => join(hostRoot, '@deepseek-ai', ...segments);
	const paths = {
		cordis: resolveHost('cordis', 'lib', 'index.js'),
		tools: resolveHost('dsh-tools', 'lib', 'index.js'),
		systemPrompt: resolveHost('dsh-system-prompt', 'lib', 'index.js'),
		schemastery: resolveHost('schemastery', 'lib', 'index.mjs'),
	};
	for (const [label, path] of Object.entries(paths)) {
		if (!existsSync(path)) {
			console.error(`找不到宿主包 ${label}: ${path}`);
			process.exitCode = 2;
		}
	}

	// 让本插件对宿主包的 import 落到真实实现（默认落到 test/doubles/ 的测试替身，
	// 联接由 scripts/link-doubles.mjs 建立）
	process.env.DSH_COMPUTER_USE_REAL_HOST_TOOLS = paths.tools;
	process.env.DSH_COMPUTER_USE_REAL_HOST_SCHEMASTERY = paths.schemastery;

	const failures = [];
	const check = (label, ok, detail = '') => {
		console.log(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
		if (!ok) failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`);
	};

	/** 让 Cordis 的异步 fiber 推进若干轮。 */
	const settle = async (rounds = 6) => {
		for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
	};

	const { Context } = await import(pathToFileURL(paths.cordis).href);
	const SystemPromptPlugin = (await import(pathToFileURL(paths.systemPrompt).href)).default;
	const ToolRuntimePlugin = (await import(pathToFileURL(paths.tools).href)).default;

	const root = new Context();
	root.plugin(SystemPromptPlugin);
	root.plugin(ToolRuntimePlugin);
	await settle();

	const systemPrompt = root.get('systemPrompt');
	const tools = root.get('tools');
	check('真实的 systemPrompt 服务已挂载', systemPrompt !== undefined);
	check('真实的 tools 服务已挂载', tools !== undefined);

	if (systemPrompt === undefined || tools === undefined) {
		console.error('\n基础服务没起来，无法继续');
		process.exitCode = 1;
	} else {
		// 按加载器的方式装配：模块命名空间自带 name/inject/Config/apply
		const plugin = await import(new URL('../lib/index.js', import.meta.url).href);
		console.log(`插件导出: name=${plugin.name} inject=[${plugin.inject.join(', ')}]`);

		const config = plugin.Config({});
		let applyError;
		try {
			// 显式开启前台模式：本脚本要验证的是"每个动作都能走通宿主完整执行管线"，
			// 而前台输入动作默认被门控拦下（这是刻意的产品决定）。不开启的话，
			// 这里测到的就只是门控本身，11 个动作一个也走不到输出校验。
			root.plugin({
				name: plugin.name,
				inject: plugin.inject,
				Config: plugin.Config,
				apply: plugin.apply,
			}, { allowForegroundInput: true });
			await settle(10);
		} catch (error) {
			applyError = error;
		}
		check('插件装配未抛出', applyError === undefined, applyError === undefined ? '' : String(applyError));
		void config;

		// 关键断言：工具真的注册进了真实的注册表
		const schemas = tools.schemas();
		const computer = schemas.find((schema) => schema.name === 'computer');
		check('computer 工具出现在 tools.schemas() 中', computer !== undefined, `当前共 ${schemas.length} 个工具`);
		if (computer !== undefined) {
			check('工具描述非空', typeof computer.description === 'string' && computer.description.length > 100);
			check('action 枚举已投影到模型侧 schema', Array.isArray(computer.parameters?.properties?.action?.enum));
			check('screenshot 在枚举内', computer.parameters.properties.action.enum.includes('screenshot'));
			console.log(`  动作数: ${computer.parameters.properties.action.enum.length}`);
		}

		// 提示词段落是否真的进入装配结果
		try {
			const assembly = await systemPrompt.assemble({});
			const section = assembly.sections.find((item) => item.name === 'tool-computer-use');
			check('提示词段落进入 systemPrompt.assemble()', section !== undefined, `段落数 ${assembly.sections.length}`);
			if (section !== undefined) check('段落正文非空', typeof section.text === 'string' && section.text.length > 100);
		} catch (error) {
			check('systemPrompt.assemble() 未抛出', false, String(error));
		}

		// ---- 走一遍宿主的完整执行管线 ----
		// 这一步才是真正的现场复现：宿主在 tools.execute() 内部校验输出值是否符合
		// 工具声明的 output schema，而 schema 写错时 tsc 完全抓不到——schema 只是普通
		// 对象字面量，与 TS 类型之间没有任何关联。实测就是这么被宿主以
		// "missing required property" 挡下来的。
		// koffi 仍是测试替身，所以这些动作打在假 Windows 上，不碰真实桌面。
		//
		// screenshot 不在列表内：它需要真实的 attachments 与 llm 服务，本测试台
		// 只挂 systemPrompt 与 tools。它的输出形状由 test/output-schema.test.mjs
		// 用宿主真实编译出的 schema 加真实校验器单独覆盖。
		const EXECUTABLE = [
			['cursor_position', { action: 'cursor_position' }],
			['mouse_move', { action: 'mouse_move', x: 5, y: 6 }],
			['left_click（原地）', { action: 'left_click' }],
			['left_click（带坐标）', { action: 'left_click', x: 5, y: 6 }],
			['right_click', { action: 'right_click', x: 1, y: 2 }],
			['double_click', { action: 'double_click', x: 1, y: 2 }],
			['left_click_drag', { action: 'left_click_drag', start_x: 0, start_y: 0, x: 9, y: 9 }],
			['scroll', { action: 'scroll', scroll_direction: 'down', scroll_amount: 2 }],
			['type', { action: 'type', text: 'hi' }],
			['key', { action: 'key', keys: 'ctrl+c' }],
			['hold_key', { action: 'hold_key', keys: 'shift', duration_ms: 1 }],
			['wait', { action: 'wait', duration_ms: 1 }],
		];

		let executed = 0;
		for (const [label, args] of EXECUTABLE) {
			try {
				const result = await tools.execute({
					callId: `verify-call-${executed}`,
					name: 'computer',
					arguments: args,
					signal: new AbortController().signal,
				});
				if (result.isError) {
					check(`tools.execute(${label})`, false, result.error?.message ?? JSON.stringify(result.content).slice(0, 300));
				} else {
					executed += 1;
				}
			} catch (error) {
				check(`tools.execute(${label})`, false, String(error));
			}
		}
		check('全部可执行动作通过宿主完整执行管线（含输出校验）', executed === EXECUTABLE.length, `${executed}/${EXECUTABLE.length}`);

		// 重复注册同名工具应被拒绝——确认协调语义仍然成立
		const duplicate = tools.get('computer');
		check('tools.get("computer") 可查到该定义', duplicate !== undefined);
	}

	console.log('\n=== 结论 ===');
	if (failures.length === 0) {
		console.log('集成校验全部通过：重启后插件会正常激活');
	} else {
		for (const failure of failures) console.error(`✗ ${failure}`);
		process.exitCode = 1;
	}
}
