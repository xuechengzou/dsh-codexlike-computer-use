/**
 * 把本插件安装进一个 DSH profile 的 node_modules，并登记为 bundle。
 *
 * 为什么不用 `dsh plugin add`：本机 profile 的 lockfile 存在既有的 pnpm
 * 供应链策略违规（与插件无关），任何 `pnpm install` 都会失败。本脚本绕开
 * 包管理器，按 profile 里既有本地插件的布局手工落位；等策略问题解决后，
 * 随时可以改用正规安装（本脚本幂等，重复执行只会覆盖同名目录）。
 *
 * **只复制 package.json `files` 声明的可发布文件。** 这一点是必须的：
 * 插件的测试替身真身在 test/doubles/（koffi / dsh-tools / schemastery），由
 * scripts/link-doubles.mjs 在 node_modules 下建联接供测试用；若把源码目录整个
 * 链接进去（`link:` 安装正是这么做的），Node 会从项目真实路径向上解析依赖，
 * 优先撞上这些替身：假 koffi 会让插件操作一个虚构的桌面，假 defineTool 会让
 * 插件 fiberPhase 停在 failed。发布文件集经过 `files` 过滤，天然没有这个问题。
 *
 * 两道防护（都来自一次真实事故：目标位置的旧符号链接指向源码目录，
 * 递归删除顺着它删掉了自己的构建产物，若继续执行还会删掉源码文件）：
 * 1. 目标若是符号链接/联接，先**删链接本身**再建真实目录。
 * 2. 任何递归删除前都断言目标不在项目源码树内。
 *
 * 用法：
 *   node scripts/install-local.mjs [--profile desktop] [--dsh-home <路径>]
 */
import { cp, lstat, mkdir, readFile, readlink, readdir, realpath, rm, unlink, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 解析命令行参数。 */
function parseArgs(argv) {
	const options = { profile: 'desktop', dshHome: join(homedir(), '.dsh') };
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--profile') options.profile = argv[++i];
		else if (argv[i] === '--dsh-home') options.dshHome = argv[++i];
		else throw new Error(`未知参数 ${argv[i]}`);
	}
	return options;
}

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** 项目源码树的真实路径，用于防止误删。 */
const rootReal = await realpath(root);

/**
 * 递归删除前的安全闸：目标解析后不得落在项目源码树内。
 *
 * 之所以需要：`rm(recursive)` 会跟随符号链接改写真实内容。目标一旦是指向
 * 源码目录的链接，删除就会变成"删掉自己的源码"。
 */
async function removeOutsideProject(path) {
	const real = await realpath(path).catch(() => resolve(path));
	if (real === rootReal || real.startsWith(rootReal + sep)) {
		throw new Error(`拒绝删除项目源码树内的路径：${real}`);
	}
	await rm(real, { recursive: true, force: true });
}

const { profile, dshHome } = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const packageName = manifest.name;
const profileRoot = join(dshHome, 'profiles', profile);

if (!(await exists(join(profileRoot, 'package.json')))) {
	throw new Error(`找不到 profile：${profileRoot}`);
}
if (!(await exists(join(root, 'lib', 'index.js')))) {
	throw new Error('lib/ 尚未构建，请先执行 npm run build');
}

const published = manifest.files ?? [];
if (published.length === 0) {
	throw new Error('package.json 未声明 files，拒绝安装（否则会把测试替身一起复制进去，生产里会解析到假 koffi）');
}

/** 安装目标：profile 的 node_modules 下、以包名为目录名的真实目录。 */
const target = join(profileRoot, 'node_modules', packageName);

// ---- 1. 清掉旧安装（可能是指向源码的符号链接） -----------------------------
const previous = await lstat(target).catch(() => undefined);
if (previous?.isSymbolicLink()) {
	const points = await readlink(target).catch(() => '(不可读)');
	// 只删链接本身，绝不递归进去——递归会删到链接指向的源码目录
	await unlink(target);
	console.log(`✓ 已移除旧的符号链接安装 ${target} → ${points}`);
	console.log('  （`link:` 安装会把源码目录整个链接进来，其中 node_modules 的测试替身会污染生产解析）');
} else if (previous !== undefined) {
	await removeOutsideProject(target);
	console.log(`✓ 已清除旧的安装目录 ${target}`);
}

// ---- 2. 落位可发布文件 -----------------------------------------------------
await mkdir(target, { recursive: true });
for (const entry of published) {
	const from = join(root, entry);
	if (!(await exists(from))) {
		console.warn(`跳过不存在的发布项 ${entry}`);
		continue;
	}
	await cp(from, join(target, entry), { recursive: true });
}
await cp(join(root, 'package.json'), join(target, 'package.json'));
console.log(`✓ 已落位 ${[...published, 'package.json'].join(', ')} → ${target}`);

// 兜底自检：发布文件集里混进 node_modules 就中止
const copied = await readdir(target);
if (copied.includes('node_modules')) {
	throw new Error(`安装目录里出现了 node_modules，测试替身会污染生产解析，已中止：${join(target, 'node_modules')}`);
}
if (!(await exists(join(target, manifest.main ?? 'lib/index.js')))) {
	throw new Error(`入口 ${manifest.main} 在安装目录里不存在`);
}
console.log(`✓ 入口 ${manifest.main} 存在，且不含 node_modules`);

// ---- 3. 登记依赖与 bundle -------------------------------------------------
const profileManifestPath = join(profileRoot, 'package.json');
const profileManifest = JSON.parse(await readFile(profileManifestPath, 'utf8'));
const spec = `link:${root.replaceAll('\\', '/')}`;
profileManifest.dependencies ??= {};
profileManifest.dsh ??= {};
profileManifest.dsh.profile ??= {};
profileManifest.dsh.profile.bundles ??= [];

let changed = false;
if (profileManifest.dependencies[packageName] !== spec) {
	profileManifest.dependencies[packageName] = spec;
	changed = true;
}
if (!profileManifest.dsh.profile.bundles.includes(packageName)) {
	profileManifest.dsh.profile.bundles.push(packageName);
	changed = true;
}

if (changed) {
	const backup = `${profileManifestPath}.before-${packageName}-${Date.now()}`;
	await cp(profileManifestPath, backup);
	await writeFile(profileManifestPath, `${JSON.stringify(profileManifest, null, 2)}\n`, 'utf8');
	console.log(`✓ 已更新 profile 的 dependencies 与 dsh.profile.bundles（备份：${backup}）`);
} else {
	console.log('✓ profile 已登记本插件，无需改动');
}

// ---- 4. 校验 koffi 能从安装位置解析到可用实现 ------------------------------
// 绕开了包管理器，插件自己的 koffi 依赖不会被安装，因此必须确认它能从
// profile 解析到一个**真实可用**的 koffi；解析失败会让工具调用直接报错。
const probe = `
const { pathToFileURL } = await import('node:url');
const { createRequire } = await import('node:module');
const require = createRequire(${JSON.stringify(join(target, 'package.json'))});
let resolved;
try { resolved = require.resolve('koffi'); } catch (error) { console.log('RESOLVE_FAIL ' + error.message.split('\\n')[0]); process.exit(0); }
try {
  const mod = await import(pathToFileURL(resolved).href);
  const api = mod.default ?? mod;
  const user32 = api.load('user32.dll');
  const metrics = user32.func('int GetSystemMetrics(int)');
  console.log('OK ' + resolved + '  screen=' + metrics(0) + 'x' + metrics(1));
} catch (error) { console.log('LOAD_FAIL ' + resolved + ' :: ' + String(error.message).split('\\n')[0]); }
`;
const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], { encoding: 'utf8' });
const line = (result.stdout ?? '').trim().split('\n').at(-1) ?? '(无输出)';
if (line.startsWith('OK')) {
	console.log(`✓ koffi 可用：${line.slice(3)}`);
} else {
	console.warn(`⚠ koffi 校验未通过：${line}`);
	console.warn('  插件仍会加载，但第一次调用工具时会返回"需要 koffi 原生模块"的错误。');
	console.warn(`  可把一份可用的 koffi 链接到 ${join(profileRoot, 'node_modules', 'koffi')}`);
}

console.log('\n完成。重启 DSH（或在插件页重新加载该 profile）后生效。');
console.log(`卸载：删除 ${target}，并从 ${profileManifestPath} 移除 dependencies 与 dsh.profile.bundles 中的 ${packageName}。`);
