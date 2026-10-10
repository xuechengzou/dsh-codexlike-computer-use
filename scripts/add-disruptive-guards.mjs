/**
 * 给"会打扰用户"的脚本统一加上默认拒绝运行的守卫。
 *
 * 背景：这些探针会创建窗口、抢占前台、移动光标，其中一个还会启动并结束浏览器
 * 进程。它们原本是"直接跑就行"，结果在用户正工作时执行过一次，把浏览器关掉了。
 * 这类脚本必须是**显式放行**才跑，而不是显式禁止才不跑。
 *
 * 幂等：已有守卫的文件会被跳过。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 会创建窗口 / 抢前台 / 动光标 / 起浏览器的脚本。 */
const FILES = [
	'scripts/probe-printwindow.mjs',
	'scripts/probe-printwindow-chromium.mjs',
	'scripts/probe-click-methods.mjs',
	'scripts/probe-click-chromium.mjs',
	'scripts/probe-title-tracking.mjs',
	'scripts/verify-cursor.mjs',
];

const MARKER = 'DSH_COMPUTER_USE_ALLOW_DISRUPTIVE';

const GUARD = `// ---------------------------------------------------------------------------
// 打扰性守卫：本脚本会创建窗口、抢占前台或移动光标，可能打断正在使用电脑的人。
// 必须显式放行才运行——"默认安全"而不是"默认危险"。
// ---------------------------------------------------------------------------
if (process.env.${MARKER} !== '1') {
	console.error('本脚本会创建窗口 / 抢占前台 / 移动光标，可能打扰到正在使用电脑的人。');
	console.error('确认此刻可以打扰时，用以下方式显式放行：');
	console.error('  PowerShell:  $env:${MARKER}="1"; node <本脚本>');
	console.error('  或临时:      set ${MARKER}=1 && node <本脚本>');
	process.exit(2);
}

`;

for (const relative of FILES) {
	const path = join(root, relative);
	const source = await readFile(path, 'utf8');
	if (source.includes(MARKER)) {
		console.log(`跳过（已有守卫）: ${relative}`);
		continue;
	}

	// 插到首个 import 之前，确保在任何副作用发生前就判断
	const lines = source.split('\n');
	const firstImport = lines.findIndex((line) => /^\s*import\s/u.test(line) || /^\s*const\s+\w+\s*=\s*await\s+import/u.test(line));
	const at = firstImport === -1 ? 0 : firstImport;
	lines.splice(at, 0, GUARD.trimEnd(), '');
	await writeFile(path, lines.join('\n'), 'utf8');
	console.log(`已加守卫: ${relative}`);
}
