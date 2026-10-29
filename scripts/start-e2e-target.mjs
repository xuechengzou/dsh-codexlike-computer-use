// ---------------------------------------------------------------------------
// 打扰性守卫：本脚本会创建窗口，可能打扰到正在使用电脑的人。
// ---------------------------------------------------------------------------
if (process.env.DSH_COMPUTER_USE_ALLOW_DISRUPTIVE !== '1') {
	console.error('本脚本会创建窗口，可能打扰到正在使用电脑的人。');
	console.error('确认此刻可以打扰时：设置 DSH_COMPUTER_USE_ALLOW_DISRUPTIVE=1 再运行。');
	process.exit(2);
}

/**
 * 为端到端验证起一个靶窗口，并等它就绪后打印状态。
 *
 * 为什么不用 Start-Process：`-WindowStyle Hidden` 会把 STARTUPINFO 的 SW_HIDE
 * 传染给 WinForms 窗体的首次显示，结果靶窗口被最小化成 (-32000,-32000,0,0)，
 * 而最小化的窗口渲染被系统挂起，后台截图必然拿不到内容——测出来会像是功能坏了。
 * 用 spawn 不带任何窗口样式，是这里唯一可靠的启动方式（探针一直这么用）。
 *
 * 窗口**不加 -Activate**，因此它不会抢走用户的前台焦点。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(process.env.TEMP ?? '/tmp', 'dsh-e2e-target.json');

if (existsSync(OUT)) unlinkSync(OUT);

const child = spawn('pwsh', [
	'-NoProfile', '-ExecutionPolicy', 'Bypass',
	'-File', join(PROJECT, 'test', 'helpers', 'background-target.ps1'),
	'-OutPath', OUT, '-Title', 'DSH-E2E-TARGET', '-Left', '200', '-Top', '150',
], { stdio: 'ignore', detached: true });
child.unref();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (let attempt = 0; attempt < 60; attempt += 1) {
	await sleep(500);
	if (!existsSync(OUT)) continue;
	try {
		const state = JSON.parse(readFileSync(OUT, 'utf8'));
		// 客户区尺寸为 0 说明窗口被最小化或还没显示——不能当成"就绪"，
		// 否则后面的后台截图会拿到空白帧，把启动问题误判成功能问题。
		// 靶脚本报的是各控件的句柄（form/button/box），没有单独的 hwnd 字段；
		// 表单句柄就是这扇窗口的句柄，readiness 必须认它。
		const form = state.form ?? state.hwnd;
		if (form && state.rect?.width > 0 && state.rect?.height > 0) {
			console.log(`靶窗口就绪: form=${form} button=${state.button} box=${state.box}`);
			console.log(`客户区 ${state.rect.width}x${state.rect.height} @ (${state.rect.left},${state.rect.top})`);
			console.log(`pid=${child.pid}（未加 -Activate，不会抢前台）`);
			process.exit(0);
		}
	} catch {
		// JSON 可能只写了一半
	}
}
console.error('靶窗口未在 30 秒内就绪');
process.exit(1);
