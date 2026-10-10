// ---------------------------------------------------------------------------
// 打扰性守卫：本脚本会使用真实窗口（读取并投递消息），必须先显式放行。
// ---------------------------------------------------------------------------
if (process.env.DSH_COMPUTER_USE_ALLOW_DISRUPTIVE !== '1') {
	console.error('本脚本会向真实窗口投递消息，可能打扰到正在使用电脑的人。');
	console.error('确认此刻可以打扰时：设置 DSH_COMPUTER_USE_ALLOW_DISRUPTIVE=1 再运行。');
	process.exit(2);
}

/**
 * 在真实窗口上验证「GDI 后台打字」修复是否真的生效。
 *
 * 为什么不用运行中的宿主来验证：宿主加载的是 ESM 模块，缓存不会因为文件改动而失效，
 * 改动必须重启 DSH 才生效。所以这里用**插件自己的构建产物** + 真实 koffi，
 * 直接对着真实靶窗口跑一遍——执行的是与工具完全相同的那份实现，
 * 差别只是少了"模型参数解析"这一层（那层由单元测试覆盖）。
 *
 * 判据是地面真相：靶窗口自己写出的 JSON 里，文本框内容到底有没有变。
 * 只看投递条数会自欺——上一版就是"12 条消息已投出、文本依然为空"。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireRealKoffi } from './real-koffi.mjs';

requireRealKoffi();

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(process.env.TEMP ?? '/tmp', 'dsh-gdi-fix-target.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { loadWin32 } = await import(new URL('../lib/win32.js', import.meta.url).href);
const { backgroundType, backgroundClick } = await import(new URL('../lib/input-background.js', import.meta.url).href);
const { resolveTargetWindow } = await import(new URL('../lib/window-target.js', import.meta.url).href);
const { resolveTextTarget } = await import(new URL('../lib/text-target.js', import.meta.url).href).catch(async () => {
	// resolveTextTarget 由 input-background 导出；若被移走则退回这里，避免脚本因导入路径变化而整体失效
	return await import(new URL('../lib/input-background.js', import.meta.url).href);
});

/**
 * 按钮中心在**窗体客户区**里的坐标。
 *
 * `background-target.ps1` 把按钮放在窗体相对 (30,30)、尺寸 180x70，
 * 因此中心是 (30+90, 30+35)。这里写死是因为靶窗口的 JSON 只报了句柄与窗体矩形，
 * 没有报子控件位置——与其再引入一次命中测试去反推，不如直接对齐靶脚本的布局，
 * 并且**用地面真相验证**：如果坐标错了，clicks 计数不会增加，结论就会是"未生效"，
 * 不会被误判成通过。
 */
const buttonCentre = { x: 120, y: 65 };

if (existsSync(OUT)) unlinkSync(OUT);

// 自己起一个靶窗口：不加 -Activate，因此它不会抢走用户的前台焦点
const target = spawn('pwsh', [
	'-NoProfile', '-ExecutionPolicy', 'Bypass',
	'-File', join(PROJECT, 'test', 'helpers', 'background-target.ps1'),
	'-OutPath', OUT, '-Title', 'DSH-GDI-FIX', '-Left', '220', '-Top', '170',
], { stdio: 'ignore' });

const stop = (child) => {
	if (child.pid !== undefined) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
};

try {
	const win32 = await loadWin32();

	let state = null;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		await sleep(500);
		if (!existsSync(OUT)) continue;
		try {
			const parsed = JSON.parse(readFileSync(OUT, 'utf8'));
			// 客户区为 0 说明窗口被最小化或还没显示，那种情况下截图与消息都不会生效
			if (parsed.form && parsed.rect?.width > 0) { state = parsed; break; }
		} catch { /* 半写状态 */ }
	}
	if (state === null) throw new Error('靶窗口未就绪');

	const readState = () => JSON.parse(readFileSync(OUT, 'utf8'));
	const frameHandle = BigInt(state.form);

	const resolved = resolveTargetWindow(win32, frameHandle);
	if (!resolved.ok) throw new Error(`窗口解析失败：${resolved.reason}`);
	const window = resolved.target;
	console.log(`目标「${window.title}」kind=${window.kind} frame=${window.frameHandle} surface=${window.surfaceHandle}`);

	// 这一行就是修复的核心：打字应当指向具体的文本控件，而不是顶层窗口
	const textTarget = resolveTextTarget(win32, window);
	console.log(`文本目标: handle=${textTarget.handle} 策略=${textTarget.strategy} 自评可靠=${textTarget.reliable}`);
	console.log(`  文本框子控件句柄是 ${state.box} —— 两者相同才说明寻址正确`);

	const before = readState().text;
	const result = backgroundType(win32, window, 'GDI-FIX-OK');
	await sleep(800);
	const after = readState().text;

	console.log('');
	console.log(`打字投递：${result.delivered} 条消息，reliable=${result.reliable}`);
	console.log(`地面真相：文本框 ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
	const textLanded = after.length > before.length;
	console.log(`结论：后台打字${textLanded ? '生效 ✓' : '仍未生效 ✗'}`);
	console.log(`note：${result.note}`);

	// ---- 后台点击：落点必须命中按钮，走 BM_CLICK 才会生效 ----
	//
	// 这是另一半核心：投递鼠标消息对不在前台的 GDI 窗口是无效的，
	// 只有对按钮控件发语义点击才有效。判据同样是地面真相——
	// 靶窗口自己写出的 clicks 计数。
	const clicksBefore = readState().clicks;
	const clicked = backgroundClick(win32, window, { x: buttonCentre.x, y: buttonCentre.y }, 'left');
	await sleep(800);
	const clicksAfter = readState().clicks;
	console.log('');
	console.log(`点击投递：${clicked.delivered} 条，reliable=${clicked.reliable}`);
	console.log(`地面真相：按钮点击计数 ${clicksBefore} → ${clicksAfter}`);
	const clickLanded = clicksAfter > clicksBefore;
	console.log(`结论：后台点击${clickLanded ? '生效 ✓' : '仍未生效 ✗'}`);
	console.log(`note：${clicked.note}`);

	process.exitCode = textLanded && clickLanded ? 0 : 1;
} finally {
	stop(target);
	await sleep(400);
	if (existsSync(OUT)) unlinkSync(OUT);
	console.log('已清理（按 PID 精确终止）');
}