// ---------------------------------------------------------------------------
// 打扰性守卫：本脚本会创建窗口，可能打断正在使用电脑的人。
// 必须显式放行才运行——"默认安全"而不是"默认危险"。
// ---------------------------------------------------------------------------
if (process.env.DSH_COMPUTER_USE_ALLOW_DISRUPTIVE !== '1') {
	console.error('本脚本会创建窗口，可能打扰到正在使用电脑的人。');
	console.error('确认此刻可以打扰时：设置 DSH_COMPUTER_USE_ALLOW_DISRUPTIVE=1 再运行。');
	process.exit(2);
}

/**
 * 前台时间线：启动真实辅助脚本，逐拍记录前台归属。
 *
 * 为什么要"时间线"而不是"前后各采一次"：
 * 之前只采前后两点，看到"结束时前台变成了我的窗口"，却无法判断它是在**哪一刻**
 * 变的——是显示时抢的、还是被系统后来顺手推上去的、还是用户自己点的。
 * 没有时间线就只能猜，而这一整轮的教训就是不该用猜的。
 *
 * 为什么用 Node 而不是 PowerShell 来测：
 * 之前两版 PowerShell 诊断都挂死了，根因是它的脚本块不捕获外层变量，
 * 回调里读到的是另一个同名变量，于是计时器永不结束。本脚本在 Node 里轮询，
 * 没有这层作用域陷阱。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireRealKoffi } from './real-koffi.mjs';

requireRealKoffi();

const koffi = await import('koffi');
const api = koffi.default ?? koffi;
const user32 = api.load('user32.dll');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const GetWindowTextW = user32.func('int GetWindowTextW(void *hWnd, _Out_ char16_t *buf, int max)');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROJECT = fileURLToPath(new URL('..', import.meta.url));

const titleOf = (handle) => {
	const buffer = Buffer.alloc(1024);
	const written = GetWindowTextW(handle, buffer, 512);
	return written <= 0 ? '' : buffer.subarray(0, written * 2).toString('utf16le');
};

const workDir = mkdtempSync(join(tmpdir(), 'dsh-fg-timeline-'));

const launch = (extra, out) => spawn('pwsh', [
	'-NoProfile', '-ExecutionPolicy', 'Bypass',
	'-File', join(PROJECT, 'test', 'helpers', 'paint-target.ps1'),
	'-OutPath', out, ...extra,
], { stdio: 'ignore' });

const spawnOpts = { stdio: 'ignore' };
const bottomOut = join(workDir, 'bottom.json');
const coverOut = join(workDir, 'cover.json');

// 场景与 verify-no-activate.mjs 完全一致：先不置顶的底窗，再置顶的遮挡窗
const bottom = spawn('pwsh', [
	'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(PROJECT, 'test', 'helpers', 'paint-target.ps1'),
	'-OutPath', bottomOut, '-Title', 'TL2-BOTTOM', '-Color', 'Magenta', '-Left', '300', '-Top', '240', '-Width', '520', '-Height', '380',
], spawnOpts);
const cover = spawn('pwsh', [
	'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(PROJECT, 'test', 'helpers', 'paint-target.ps1'),
	'-OutPath', coverOut, '-Title', 'TL2-COVER', '-Color', 'Cyan', '-Left', '280', '-Top', '220', '-Width', '600', '-Height', '460', '-TopMost',
], spawnOpts);

const stop = (child) => {
	if (child.pid !== undefined) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
};

try {
	const baseline = GetForegroundWindow();
	console.log(`起始前台: ${baseline} "${titleOf(baseline)}"`);
	console.log('');
	console.log('时刻      前台窗口                                    是否改变');
	console.log('--------  ----------------------------------------  --------');

	// 20 拍 × 400ms = 8 秒。窗口创建与 C# 编译大约要 1~3 秒，够覆盖到显示之后。
	for (let tick = 0; tick < 20; tick += 1) {
		const current = GetForegroundWindow();
		const title = titleOf(current);
		const changed = current === baseline ? '' : '  ← 变了';
		console.log(`+${String(tick * 400).padStart(5)}ms  ${String(current).padEnd(10)} ${title.slice(0, 33).padEnd(33)}${changed}`);
		await sleep(400);
	}

	const final = GetForegroundWindow();
	const bottomInfo = existsSync(bottomOut) ? JSON.parse(readFileSync(bottomOut, 'utf8')) : null;
	const coverInfo = existsSync(coverOut) ? JSON.parse(readFileSync(coverOut, 'utf8')) : null;
	console.log('');
	console.log(`底窗句柄=${bottomInfo?.hwnd ?? '(未就绪)'}  遮挡窗句柄=${coverInfo?.hwnd ?? '(未就绪)'}`);
	console.log(`结束前台=${final} "${titleOf(final)}"`);
	console.log(`前台是否被夺走: ${final === baseline ? '没有 ✓' : '被夺走了 ✗'}`);
	void launch;
} finally {
	stop(bottom);
	stop(cover);
	await sleep(500);
	rmSync(workDir, { recursive: true, force: true });
	for (const path of [bottomOut, coverOut]) if (existsSync(path)) unlinkSync(path);
	console.log('\n已清理（按 PID 精确终止）');
}
