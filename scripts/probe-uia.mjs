/**
 * UIA 探针：用**已构建的插件模块**读一棵真实的可访问性树。
 *
 * 为什么留在独立进程里：COM 的 vtable 调用一旦索引错位就是访问违例，会直接
 * 杀掉承载进程。这个脚本是那条链路的急诊台——先在它这里把崩溃跑出来，
 * 再让插件去用。
 *
 * 用法：node scripts/probe-uia.mjs [十进制窗口句柄] [最大节点数]
 * 不传句柄时取当前前台窗口。
 */
import { createRequire } from 'node:module';

// 仓库里的 node_modules/koffi 是测试替身，这里要的是 profile 里的真家伙
const require = createRequire('C:/Users/administor/.dsh/profiles/desktop/package.json');
const koffi = require('koffi');
const { createUia } = await import('../lib/uia/com.js');
const { formatTree } = await import('../lib/uia/tree.js');

const user32 = koffi.load('user32.dll');
const getForegroundWindow = user32.func('void *GetForegroundWindow()');

const handle = process.argv[2] === undefined ? getForegroundWindow() : BigInt(process.argv[2]);
const maxNodes = Number(process.argv[3] ?? 200);

const uia = createUia(koffi);
const root = uia.elementFromHandle(handle);
if (root === null) {
	console.error(`拿不到句柄 ${handle} 的元素`);
	uia.dispose();
	process.exit(1);
}

const started = Date.now();
const result = formatTree(root, { maxNodes, maxDepth: 12 });
const elapsed = Date.now() - started;

console.log(result.text);
console.log(`\n节点 ${result.nodes}${result.truncated ? '（已截断）' : ''}，耗时 ${elapsed}ms`);
uia.dispose();
