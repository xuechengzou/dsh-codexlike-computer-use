/**
 * 从 src 生成可发布的 lib。
 *
 * 用 `bundle: false` 而不是打包：`@deepseek-ai/*` 由宿主在运行时提供，
 * koffi 是原生的、必须留在 node_modules 里由 Node 自己解析。把任何一方
 * 打进产物都会让插件只在"构建时那份宿主"上可用。也正因为不打包，每个
 * 模块都得作为独立入口编译，否则只有 import 图里被引用到的才会产出。
 *
 * 先在同级暂存目录完成构建，成功后再整体替换 lib，避免构建失败留下半个
 * 可安装产物。
 *
 * 本文件同时是 package.json 的 `prepare` 脚本，这一点决定了 esbuild 必须动态导入：
 * - 从 git 安装依赖时，包管理器会先装好 devDependencies 再跑 prepare，esbuild 一定
 *   在场。此时**任何构建失败都必须让安装失败**——package.json 的 main 是
 *   lib/index.js，静默产出一个没有 lib/ 的包等于交付一个装得上、加载不了的插件。
 * - 本地安装则可能因为 --omit=dev、离线、只装生产依赖等原因没有 esbuild。这种
 *   "依赖缺失"不该把整个安装搞崩：跳过构建并打出醒目提示，lib/ 随后用
 *   `npm run build` 补上即可。
 * 所以只有 prepare 生命周期（或显式 --allow-missing-deps）才容忍**依赖缺失**；
 * 依赖在场而构建报错，一律硬失败，不做任何降级。
 */
import { access, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** npm/pnpm 在生命周期脚本里会设置 npm_lifecycle_event；直接 `node scripts/build.mjs` 时为空。 */
const missingDependenciesTolerated =
	process.env.npm_lifecycle_event === 'prepare' || process.argv.includes('--allow-missing-deps');

let build;
try {
	({ build } = await import('esbuild'));
} catch (error) {
	if (!missingDependenciesTolerated) throw error;
	console.warn('[dsh-computer-use] 未找到 esbuild，跳过构建（只在 prepare 阶段容忍缺少开发依赖）。');
	console.warn('  此时 lib/ 没有生成，而 package.json 的 main 指向 lib/index.js——这个包此刻不可用。');
	console.warn('  装上开发依赖后执行 `npm run build` 即可补齐。');
	console.warn('  正常情况下走不到这里：包管理器准备 git 依赖时会带上开发依赖（npm 传的是 --include=dev），');
	console.warn('  esbuild 在场，构建失败会让安装直接失败，而不是静默交付一个没有 lib/ 的包。');
	process.exit(0);
}
const sourceDirectory = join(root, 'src');
const outputDirectory = join(root, 'lib');

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * 递归枚举可编译入口。
 *
 * 早期只读 src 顶层，`src/uia/com.ts` 这类子目录模块会被静默漏掉——构建成功、
 * 产物缺失，直到宿主里 `import './uia/com.js'` 才炸。遍历必须跟着目录走下去。
 *
 * @param directory - 目录绝对路径。
 * @param prefix - 相对 src 的前缀（用于 outbase 保持目录结构）。
 * @returns 相对路径清单。
 */
async function listSources(directory, prefix = '') {
	const found = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) found.push(...await listSources(join(directory, entry.name), relative));
		else found.push(relative);
	}
	return found.sort();
}

/** 动态枚举入口：避免硬编码清单与 src 漂移。声明文件不是可编译入口。 */
const entries = (await listSources(sourceDirectory))
	.filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
if (entries.length === 0) throw new Error('src 下没有可编译的 TypeScript 入口');

// 暂存目录必须和 lib 同卷：跨卷 rename 会以 EXDEV 失败，
// 而系统临时目录常常在另一个盘上。
const stagingRoot = join(root, '.build-staging');
await mkdir(stagingRoot, { recursive: true });
const staging = await mkdtemp(join(stagingRoot, `${randomUUID()}-`));

try {
	await build({
		entryPoints: entries.map((file) => join(sourceDirectory, file)),
		outdir: staging,
		outbase: sourceDirectory,
		bundle: false,
		format: 'esm',
		platform: 'node',
		target: 'node20',
		sourcemap: false,
		logLevel: 'info',
	});

	const produced = (await listSources(staging)).filter((file) => file.endsWith('.js'));
	const expected = entries.map((file) => file.replace(/\.ts$/u, '.js'));
	const missing = expected.filter((file) => !produced.includes(file));
	if (missing.length > 0) throw new Error(`构建产物缺少 ${missing.join(', ')}`);

	if (await exists(outputDirectory)) await rm(outputDirectory, { recursive: true, force: true });
	await rename(staging, outputDirectory);
	console.log(`[dsh-computer-use] 已生成 ${expected.length} 个 ESM 模块到 lib/`);
} catch (error) {
	await rm(staging, { recursive: true, force: true });
	throw error;
} finally {
	// 暂存根目录通常已空；清掉它避免在项目里留下脚手架痕迹
	await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
}
