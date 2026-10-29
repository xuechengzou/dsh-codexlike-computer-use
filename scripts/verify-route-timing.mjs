/**
 * 用**真实 cordis** 验证"等 webServer 就位再注册路由"这条时序修复。
 *
 * 为什么需要它：这条 bug 只在真实宿主的装配顺序里出现（webServer 比
 * tools/systemPrompt 晚挂载），单元测试里手写的假 ctx 抓不到。而每次验证都要
 * 用户重启一次 App，代价太高。这里拿宿主自带的 cordis 起一个最小上下文：
 * 先提供 tools / systemPrompt，插件装配；**之后**再提供 webServer，
 * 断言路由此时才出现。
 *
 * 用法：node scripts/verify-route-timing.mjs <宿主 node_modules 根>
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const hostRoot = process.argv[2];
if (hostRoot === undefined) {
	console.error('用法: node scripts/verify-route-timing.mjs <宿主 node_modules 根>');
	process.exit(2);
}

const contextEntry = join(hostRoot, '@deepseek-ai', 'cordis', 'lib', 'index.js');
const toolsEntry = join(hostRoot, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
const schemaEntry = join(hostRoot, '@deepseek-ai', 'schemastery', 'lib', 'index.mjs');

// 让仓库里的替身把调用委派给宿主真实实现（必须在 import 插件之前设置）
process.env.DSH_COMPUTER_USE_REAL_HOST_TOOLS = toolsEntry;
process.env.DSH_COMPUTER_USE_REAL_HOST_SCHEMASTERY = schemaEntry;

const { Context } = await import(pathToFileURL(contextEntry).href);

const tools = [];
const sections = [];
const routes = [];

const ctx = new Context();
ctx.provide('tools');
ctx.set('tools', { register: (definition) => { tools.push(definition); return () => {}; } });
ctx.provide('systemPrompt');
ctx.set('systemPrompt', { section: (section) => { sections.push(section); return () => {}; } });

const plugin = await import(pathToFileURL(join('..', 'lib', 'index.js')).href);
const fiber = ctx.plugin({ ...plugin, name: 'dsh-computer-use' }, {});

/** 让 cordis 的微任务/装配轮转一圈。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

await settle();
const toolsBefore = tools.length;
const routesBefore = routes.length;
console.log(`装配后：工具 ${toolsBefore} 个，提示词段 ${sections.length} 个，路由 ${routesBefore} 条`);

const failures = [];
if (toolsBefore !== 2) failures.push(`应注册 2 个工具，实际 ${toolsBefore}`);
if (sections.length !== 1) failures.push(`应注册 1 个提示词段落，实际 ${sections.length}`);
if (routesBefore !== 0) failures.push(`webServer 未就位时不应有路由，实际 ${routesBefore}`);

// 现在才提供 webServer —— 模拟宿主晚挂载
ctx.provide('webServer');
ctx.set('webServer', {
	register: (route) => {
		routes.push(route);
		return () => {};
	},
});
await settle();

console.log(`提供 webServer 后：路由 ${routes.length} 条`);
if (routes.length !== 1) failures.push(`webServer 就位后应注册 1 条路由，实际 ${routes.length}`);
else if (routes[0].path !== '/dsh-computer-use/state') failures.push(`路由路径不对：${routes[0].path}`);

await fiber?.dispose?.();
await ctx.dispose?.();

if (failures.length === 0) {
	console.log('✓ 时序正确：路由在 webServer 就位后才注册');
} else {
	for (const failure of failures) console.error('✗', failure);
	process.exitCode = 1;
}
