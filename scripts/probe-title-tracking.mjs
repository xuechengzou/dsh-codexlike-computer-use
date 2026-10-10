/**
 * 先验证检测手段本身：`--app` 窗口的原生标题会不会跟随页面 `document.title`？
 *
 * 页面每 400ms 自增一次标题（不需要任何点击）。如果原生标题跟着变，说明
 * "读窗口标题判断点击是否命中"这套检测成立；如果不变，之前那轮对比里
 * 三项全部"未触发"就只是检测失效，不能据此下任何结论。
 */
// ---------------------------------------------------------------------------
// 打扰性守卫：本脚本会创建窗口、抢占前台或移动光标，可能打断正在使用电脑的人。
// 必须显式放行才运行——"默认安全"而不是"默认危险"。
// ---------------------------------------------------------------------------
if (process.env.DSH_COMPUTER_USE_ALLOW_DISRUPTIVE !== '1') {
	console.error('本脚本会创建窗口 / 抢占前台 / 移动光标，可能打扰到正在使用电脑的人。');
	console.error('确认此刻可以打扰时，用以下方式显式放行：');
	console.error('  PowerShell:  $env:DSH_COMPUTER_USE_ALLOW_DISRUPTIVE="1"; node <本脚本>');
	console.error('  或临时:      set DSH_COMPUTER_USE_ALLOW_DISRUPTIVE=1 && node <本脚本>');
	process.exit(2);
}

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireRealKoffi } from './real-koffi.mjs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
requireRealKoffi();

const koffi = await import('koffi');
const api = koffi.default ?? koffi;
const user32 = api.load('user32.dll');
const FindWindowW = user32.func('void *FindWindowW(const char16_t *cls, const char16_t *name)');
const GetWindowTextW = user32.func('int GetWindowTextW(void *hWnd, _Out_ char16_t *buf, int max)');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const titleOf = (handle) => {
	const buffer = Buffer.alloc(1024);
	const written = GetWindowTextW(handle, buffer, 512);
	return written <= 0 ? '' : buffer.subarray(0, written * 2).toString('utf16le');
};

const html = `<!doctype html><meta charset="utf-8"><title>TICKER</title>
<body style="margin:0;font-size:40px">ticker</body>
<script>
let n = 0;
setInterval(() => { n += 1; document.title = 'TICK-' + n; }, 400);
</script>`;

const workDir = mkdtempSync(join(tmpdir(), 'dsh-title-probe-'));
const pagePath = join(workDir, 'tick.html');
writeFileSync(pagePath, html, 'utf8');

const chrome = spawn(CHROME, [
	`--user-data-dir=${join(workDir, 'profile')}`,
	'--no-first-run',
	'--no-default-browser-check',
	'--window-size=800,500',
	'--window-position=300,200',
	`--app=file:///${pagePath.replaceAll('\\', '/')}`,
], { stdio: 'ignore' });

const stop = () => {
	if (chrome.pid !== undefined) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
};

try {
	let top = null;
	for (let attempt = 0; attempt < 80 && top == null; attempt += 1) {
		await sleep(250);
		// 标题会变，所以按前缀找不到；先按启动时的固定标题找，再退回枚举
		top = FindWindowW(null, 'TICKER');
	}
	if (top == null) {
		// 可能已经变成 TICK-n，用 PowerShell 列出候选
		console.log('未按固定标题找到窗口，列出当前可见窗口标题：');
		const list = spawnSync('pwsh', ['-NoProfile', '-Command',
			"Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -ExpandProperty MainWindowTitle",
		], { encoding: 'utf8' });
		console.log((list.stdout ?? '').trim() || '(无)');
		throw new Error('窗口未找到');
	}

	console.log('观察 3 秒内原生窗口标题的变化：');
	const seen = new Set();
	for (let i = 0; i < 12; i += 1) {
		const t = titleOf(top);
		seen.add(t);
		console.log(`  t=${String(i * 250).padStart(4)}ms  title="${t}"`);
		await sleep(250);
	}
	console.log(`\n观察到 ${seen.size} 个不同标题`);
	console.log(seen.size > 1 ? '结论：原生标题跟随 document.title —— 检测手段成立' : '结论：原生标题不变 —— 检测手段失效，之前的"未触发"不能作为证据');
} finally {
	stop();
	await sleep(800);
	rmSync(workDir, { recursive: true, force: true });
	console.log('已清理');
}
