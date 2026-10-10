/**
 * 类型检查包装。
 *
 * 走本地 node_modules 里的 tsc（若装了），否则退回 PATH 上的 tsc。
 * 输出直接透传，方便在 CI 里当门禁用。
 */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localTsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

const command = (await exists(localTsc)) ? process.execPath : 'tsc';
const args = (await exists(localTsc)) ? [localTsc, '--noEmit'] : ['--noEmit'];

const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
child.on('exit', (code) => {
	process.exitCode = code ?? 1;
});
