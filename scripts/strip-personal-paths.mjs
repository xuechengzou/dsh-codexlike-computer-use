/**
 * 把脚本里硬编码的真实 koffi 路径换成环境变量解析。
 *
 * 存在的理由：那些路径含有作者机器的用户名，既泄漏隐私又对别人不可用，
 * 发布前必须清掉。手工改 15 个文件容易漏、也容易改坏，所以用脚本做，
 * 并且**改完立刻验证**——本项目已经因为"补丁看起来成功、实际写坏了文件"栽过一次。
 *
 * 验证项：
 *   1. 目标文件里不再出现 `X:\Users\<某人>\...` 这类带用户名的绝对路径，也不再有 koffi 的字面量；
 *   2. 每个文件都能通过 `node --check`；
 *   3. 每个文件都确实拿到了 `requireRealKoffi` 的导入。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = join(root, 'scripts');

/** 匹配 `process.env.<X> = '<路径>';`，允许跨行、允许各种引号。 */
const ASSIGN_PATTERN = /process\.env\.DSH_COMPUTER_USE_REAL_KOFFI\s*=\s*(?:'[^']*'|"[^"]*")\s*;/gu;
/**
 * 匹配"带用户名的绝对路径"，即 `X:\Users\<某人>\...`。
 *
 * 刻意**不写死具体用户名**：检查脚本自己也会进版本库，写死就等于把要清理的东西
 * 留在了清理工具里。用通用模式还更严格——任何人的用户名都会被抓出来。
 *
 * 用户名那一段排除 `<>%$*` 等占位符字符：`C:\Users\<you>\...` 是文档里该有的
 * 示例，不含任何个人信息，把它当成泄漏只会制造假警报，最后让人不再相信这个检查。
 */
const USER_PATH_PATTERN = /[A-Za-z]:\\+Users\\+[^\\/'"`\s<>%$*]+/gu;
/** 匹配任何指向 koffi 的绝对路径字面量（兜底，防止上面那条漏掉）。 */
const LEAK_PATTERN = /['"][A-Za-z]:[\\/][^'"]*koffi[^'"]*['"]/gu;

const files = (await readdir(scriptsDir)).filter((name) => name.endsWith('.mjs') && name !== 'real-koffi.mjs');
const touched = [];

for (const name of files) {
	const path = join(scriptsDir, name);
	let source = await readFile(path, 'utf8');
	const before = source;

	// 1) 整条赋值语句 → 一次调用
	source = source.replace(ASSIGN_PATTERN, 'requireRealKoffi();');

	// 2) 兜底：仍残留的 koffi 绝对路径字面量一律删掉（连同可能的赋值残留）
	if (LEAK_PATTERN.test(source)) {
		source = source.replace(LEAK_PATTERN, 'requireRealKoffi()');
	}
	LEAK_PATTERN.lastIndex = 0;

	if (source === before) continue;

	// 3) 补导入。
	//    有的脚本用静态 import，有的（如 verify-background-mode.mjs）通篇用
	//    `await import(...)` 动态导入，没有静态 import 可作插入点。因此：
	//    有静态 import 就补一条静态 import；没有就地用动态导入，
	//    这样两种写法都不用特殊照顾。
	if (!source.includes('requireRealKoffi')) throw new Error(`${name}: 替换后没有出现 requireRealKoffi，拒绝写入`);
	if (!/from '\.\/real-koffi\.mjs'/u.test(source) && !/await import\('\.\/real-koffi\.mjs'\)/u.test(source)) {
		const lines = source.split('\n');
		let lastImport = -1;
		for (let index = 0; index < lines.length; index += 1) {
			if (/^\s*import\s/u.test(lines[index])) lastImport = index;
		}
		if (lastImport === -1) {
			source = source.replace(
				'requireRealKoffi();',
				"const { requireRealKoffi } = await import('./real-koffi.mjs');\nrequireRealKoffi();",
			);
		} else {
			lines.splice(lastImport + 1, 0, "import { requireRealKoffi } from './real-koffi.mjs';");
			source = lines.join('\n');
		}
	}

	await writeFile(path, source, 'utf8');
	touched.push(name);
}

console.log(`已处理 ${touched.length} 个文件：`);
for (const name of touched) console.log(`  ${name}`);

// ---- 验证 ----------------------------------------------------------------

console.log('\n=== 验证 ===');
let failures = 0;
for (const name of [...files, 'real-koffi.mjs']) {
	const path = join(scriptsDir, name);
	const source = await readFile(path, 'utf8');

	const userPaths = source.match(USER_PATH_PATTERN) ?? [];
	USER_PATH_PATTERN.lastIndex = 0;
	if (userPaths.length > 0) {
		console.log(`  ✗ ${name}: 仍含带用户名的绝对路径 ${userPaths[0]}`);
		failures += 1;
	}
	// 占位示例（形如 C:\...\node_modules\koffi\index.js）不算泄漏：
	// 它不含任何个人信息，而且正是错误提示里该给用户看的东西。
	// 只有"盘符 + 多级真实目录 + koffi"才算。
	const leaks = (source.match(LEAK_PATTERN) ?? []).filter((hit) => !hit.includes('C:\\\\...'));
	LEAK_PATTERN.lastIndex = 0;
	if (leaks.length > 0) {
		console.log(`  ✗ ${name}: 仍含 koffi 绝对路径字面量 ${leaks[0]}`);
		failures += 1;
	}

	const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
	if (check.status !== 0) {
		console.log(`  ✗ ${name}: 语法检查失败\n${check.stderr}`);
		failures += 1;
	}
}
LEAK_PATTERN.lastIndex = 0;

if (failures === 0) console.log('  全部通过：无用户名残留、无绝对路径字面量、语法均正确');
else console.log(`  ${failures} 项未通过`);
process.exitCode = failures === 0 ? 0 : 1;
