/**
 * 把测试替身联接到 node_modules，让裸模块说明符在测试进程里解析到 test/doubles/*。
 *
 * 为什么要有这一步：
 * 三个替身（koffi、@deepseek-ai/dsh-tools、@deepseek-ai/schemastery）必须进版本库，
 * 否则别人克隆下来跑不了测试；而 `node_modules/` 被 .gitignore 排除（它同时承载真实
 * 依赖），唯一可提交的位置就是 test/doubles/。但 Node 的裸说明符解析只认
 * node_modules/ —— `import koffi from 'koffi'` 不会去找 test/doubles/koffi。
 * 联接是这两者之间唯一的桥：替身的**源码**在 test/doubles/（进库），
 * node_modules/ 里只有一层可随时重建的联接（不进库）。
 *
 * 生产路径干净这件事，本脚本能做的与做不到的：
 * 做到：默认拒绝在"本目录已被 profile 以 link:/符号链接安装"时建联接，并在结束时
 *   提示这条风险；`--remove` 一键拆掉全部联接（改走 scripts/install-local.mjs 的
 *   复制安装，或准备 link: 安装前先执行）。
 * 做不到：只要裸说明符要解析到替身，node_modules/ 下就必须存在这些入口，而
 *   link: 安装会把源码目录整体交给生产解析（Node 从项目真实路径向上找
 *   node_modules）。也就是说"跑过测试的源码目录被 link: 安装"这一条方向上，
 *   风险无法在本仓库内从结构上消除，只能靠守卫 + 文档 + 一条 --remove 命令兜住。
 *   之所以接受这个残留：另一端（不写 node_modules、改用 --import 解析钩子）会让
 *   `node --test test/*.test.mjs` 这种裸命令直接跑不起来，代价更大。
 *
 * 幂等：重复执行只会补齐缺失的联接、跳过已正确的联接。
 * 用法：
 *   node scripts/link-doubles.mjs              # 建立/修复联接
 *   node scripts/link-doubles.mjs --remove     # 拆联接，并把顶替掉的真实包放回原位
 *   node scripts/link-doubles.mjs --force      # 越过 profile 守卫（确定要用 link: 时）
 *
 * 顶替真实包时**不删除**：把它挪到 node_modules/.dsh-computer-use-parked/ 下，
 * `--remove` 会连同联接一起还原。本脚本出现在 npm test 的前置步骤里，不该有破坏性。
 */
import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, symlink, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootReal = await realpath(root);
const nodeModules = join(root, 'node_modules');

/** 替身的唯一真身位置；node_modules 里的联接只是它的投影。 */
const doublesRoot = join(root, 'test', 'doubles');

/** 需要联接的说明符 → test/doubles 下的目录名。 */
const DOUBLES = [
	{ specifier: 'koffi', directory: 'koffi' },
	{ specifier: '@deepseek-ai/dsh-tools', directory: 'dsh-tools' },
	{ specifier: '@deepseek-ai/schemastery', directory: 'schemastery' },
];

const argv = process.argv.slice(2);
const remove = argv.includes('--remove');
const force = argv.includes('--force');
for (const argument of argv) {
	if (!['--remove', '--force'].includes(argument)) throw new Error(`未知参数 ${argument}`);
}

async function exists(path) {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** 路径是否位于 parent 之内（含 parent 本身）。 */
function isInside(child, parent) {
	return child === parent || child.startsWith(parent + sep);
}

/** 该路径是否是链向路径的联接/符号链接；解析失败（断链）也返回 false。 */
async function linksTo(path, target) {
	let real;
	try {
		real = await realpath(path);
	} catch {
		return false;
	}
	let targetReal;
	try {
		targetReal = await realpath(target);
	} catch {
		return false;
	}
	return real === targetReal;
}

/** 读一个目录里的 package.json（不存在或不是目录时返回 undefined）。 */
async function readManifest(path) {
	try {
		return JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
	} catch {
		return undefined;
	}
}

/**
 * 收集本机可能装着本插件的 profile 目录。
 * 优先用 DSH_PROFILE_DIR（DSH 进程里一定有），再退回扫 ~/.dsh/profiles/*。
 */
async function collectProfileRoots() {
	const roots = new Set();
	if (process.env.DSH_PROFILE_DIR !== undefined) roots.add(resolve(process.env.DSH_PROFILE_DIR));
	const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
	const profilesDirectory = join(dshHome, 'profiles');
	const entries = await readdir(profilesDirectory, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (entry.isDirectory()) roots.add(join(profilesDirectory, entry.name));
	}
	return [...roots];
}

/**
 * 守卫：本目录若已被 profile 以 link:/符号链接安装，就不要在 node_modules 里放替身。
 *
 * 这不是洁癖，是一次真实事故：profile 用 link: 把源码目录链进去后，Node 按项目
 * 真实路径解析依赖，先撞上 node_modules 里的假 defineTool，插件的 fiberPhase 直接
 * 变成 failed，宿主不报错、模型侧什么也看不到。宁可让这里的测试装不上替身
 * （跑测试时报模块找不到，错误明确指向本文件），也不让生产解析撞上替身。
 */
async function assertNotLinkInstalled() {
	const packageName = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name;
	const offenders = [];
	for (const profileRoot of await collectProfileRoots()) {
		const entry = join(profileRoot, 'node_modules', packageName);
		if (await linksTo(entry, root)) offenders.push(entry);
	}
	if (offenders.length === 0) return;
	const lines = offenders.map((entry) => `  ${entry} → ${root}`);
	const message = [
		'拒绝建立测试替身联接：本目录已被 profile 以 link:/符号链接安装，',
		'而 link: 会把源码目录整体交给生产解析，node_modules 里的替身会污染它。',
		...lines,
		'改用 `node scripts/install-local.mjs`（只复制 files 声明的可发布文件），',
		'或确实需要 link: 时用 `--force` 越过本守卫。',
	].join('\n');
	throw new Error(message);
}

/** 建联接。Windows 上用 junction：它不需要管理员权限，删除时也只是一个链接。 */
async function createLink(target, linkPath) {
	await mkdir(dirname(linkPath), { recursive: true });
	await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * 被顶替的真实包（或历史遗留的替身副本）的停放处。
 *
 * 为什么是"挪走 + 还原"而不是删除：真实 koffi / 宿主包是包管理器装出来的，
 * 删了要重装才能回来；而本脚本是**跑测试前的自动前置步骤**，不该有破坏性。
 * 挪动在同卷内是一次 rename，不复制、不丢数据；`--remove` 会把它们放回原位。
 */
const parkedRoot = join(nodeModules, '.dsh-computer-use-parked');
const parkedPathFor = (specifier) => join(parkedRoot, ...specifier.split('/'));

/** 描述一个既有入口，用于输出里说清楚顶替了什么。 */
async function describeEntry(entry) {
	const stats = await lstat(entry);
	if (stats.isSymbolicLink()) {
		const points = await realpath(entry).catch(() => '(断链)');
		return `链接 → ${points}`;
	}
	const manifest = await readManifest(entry);
	if (manifest === undefined) return '未知内容';
	return `${manifest.name}@${manifest.version}`;
}

/**
 * 把既有入口挪进停放处。目标路径已被占用时改用带时间戳的名字：
 * 宁可留下多份停放副本，也不删除别人的东西（它们都是可重装/可重建的）。
 */
async function parkEntry(entry, specifier) {
	const described = await describeEntry(entry);
	let parked = parkedPathFor(specifier);
	if (await exists(parked)) parked = `${parked}-${Date.now()}`;
	await mkdir(dirname(parked), { recursive: true });
	await rename(entry, parked);
	return `原为 ${described}，已挪到 ${parked.slice(nodeModules.length + 1)}`;
}

/** 删掉停放处里的空目录（还原后常剩下 @deepseek-ai/ 这类空壳）。只删空的。 */
async function pruneEmptyDirectories(directory) {
	const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		// isDirectory 对符号链接为 false，因此不会递归进被挪走的链接
		if (!entry.isDirectory()) continue;
		const child = join(directory, entry.name);
		await pruneEmptyDirectories(child);
		const remaining = await readdir(child).catch(() => ['(不可读)']);
		if (remaining.length === 0) await rmdir(child).catch(() => {});
	}
}

/** 列出停放处里尚未还原的条目（作用域目录往里看一层），供 --remove 如实汇报。 */
async function listParkedEntries() {
	const entries = await readdir(parkedRoot, { withFileTypes: true }).catch(() => []);
	const out = [];
	for (const entry of entries) {
		if (entry.isDirectory() && entry.name.startsWith('@')) {
			const scoped = await readdir(join(parkedRoot, entry.name), { withFileTypes: true }).catch(() => []);
			for (const inner of scoped) out.push(`${entry.name}/${inner.name}`);
			continue;
		}
		out.push(entry.name);
	}
	return out;
}

if (remove) {
	for (const double of DOUBLES) {
		const entry = join(nodeModules, ...double.specifier.split('/'));
		const target = join(doublesRoot, double.directory);
		const parked = parkedPathFor(double.specifier);

		if (await linksTo(entry, target)) {
			await unlink(entry); // 只删联接本身，绝不递归进去
			console.log(`✓ 已移除替身联接：node_modules/${double.specifier}`);
		} else if (await exists(entry)) {
			console.log(`跳过（不是指向替身的联接，保持原样）: node_modules/${double.specifier}`);
			if (await exists(parked)) console.log(`  停放处还有一份：${parked.slice(nodeModules.length + 1)}`);
			continue;
		} else {
			console.log(`跳过（不存在）: node_modules/${double.specifier}`);
		}

		if (await exists(parked)) {
			await mkdir(dirname(entry), { recursive: true });
			await rename(parked, entry);
			console.log(`  已还原被挪走的原入口：node_modules/${double.specifier}`);
		}
	}

	// 还原后停放处可能只剩空目录（如 @deepseek-ai/）。只清空的，绝不动还有内容的。
	await pruneEmptyDirectories(parkedRoot);

	const leftovers = await listParkedEntries();
	if (leftovers.length > 0) {
		console.log(`\n注意：${parkedRoot.slice(nodeModules.length + 1)} 下仍有 ${leftovers.length} 项未还原：`);
		for (const entry of leftovers) console.log(`  ${entry}`);
		console.log('重新安装依赖（npm/pnpm install）也会重建它们。');
	}
	console.log('\n完成。测试前需要重新执行 node scripts/link-doubles.mjs（npm test 会自动做）。');
	process.exit(0);
}

if (!force) await assertNotLinkInstalled();

console.log(`替身真身：${doublesRoot}`);
console.log(`联接位置：${nodeModules}\n`);

for (const double of DOUBLES) {
	const target = join(doublesRoot, double.directory);
	if (!(await exists(join(target, 'index.js')))) {
		throw new Error(`替身缺失：${join(target, 'index.js')} 不存在（版本库里的 test/doubles/ 不完整）`);
	}

	const entry = join(nodeModules, ...double.specifier.split('/'));
	const label = `node_modules/${double.specifier}`;
	if (await linksTo(entry, target)) {
		console.log(`✓ 已就位  ${label} → test/doubles/${double.directory}`);
		continue;
	}

	if (await exists(entry)) {
		// 已存在但不是我们要的联接：包管理器装出来的真实包（npm 是真实目录，
		// pnpm 是指向 .pnpm 存储的符号链接），或移动替身时遗留的旧副本。
		// 挪进停放处再建联接——node_modules 是包管理器可重建的，而替身不进这里
		// 就跑不了测试（被挪走的真实包可以用 --remove 还原，或 npm install 重装）。
		const how = await parkEntry(entry, double.specifier);
		await createLink(target, entry);
		console.log(`✓ 已替换  ${label} → test/doubles/${double.directory}（${how}）`);
		continue;
	}

	await createLink(target, entry);
	console.log(`✓ 已建立  ${label} → test/doubles/${double.directory}`);
}

// 自检：裸说明符必须真的解析到 test/doubles，而不是碰巧在别处找到了同名包。
// 用 require.resolve 而非 import.meta.resolve：它按 CJS 语义走 exports 字段，
// 与 lib/*.js 里 `import koffi from 'koffi'` 落点一致。
const require = createRequire(join(root, 'package.json'));
const problems = [];
for (const double of DOUBLES) {
	const resolved = require.resolve(double.specifier);
	const expected = join(doublesRoot, double.directory);
	if (!isInside(await realpath(resolved), await realpath(expected))) {
		problems.push(`${double.specifier} → ${resolved}（期望落在 ${expected} 内）`);
		continue;
	}
	console.log(`  自检 ${double.specifier} → ${resolved}`);
}
if (problems.length > 0) {
	throw new Error(`裸说明符没有解析到替身：\n${problems.map((line) => `  ${line}`).join('\n')}`);
}

console.log('\n完成。注意：这些联接只服务于测试；本目录如果要被 link: 安装进 profile，');
console.log('请先 node scripts/link-doubles.mjs --remove（或用 scripts/install-local.mjs 复制安装）。');
