/**
 * 验证 SetCursorPos 是否真正生效：同进程内"移动 → 立即读回"，排除工具调用往返
 * 延迟与用户手动移动鼠标的干扰。结束时还原原位置。
 *
 * 用途：`mouse_move` 返回成功后，若怀疑"报成功但没真的移动"，用这个脚本定性。
 * 它绕开工具层直接驱动原生绑定，把"API 没生效"与"鼠标被用户动过"区分开。
 *
 * 用法：
 *   node scripts/verify-cursor.mjs [lib/win32.js 的路径]
 * 默认取 desktop profile 里的安装副本，即宿主正在用的那份代码。
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

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LIB = process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-computer-use', 'lib', 'win32.js');

// Windows 绝对路径必须先转成 file:// URL，ESM 加载器不接受裸盘符
const { loadWin32 } = await import(pathToFileURL(LIB).href);
const win32 = await loadWin32();
console.log(`原生绑定来自: ${LIB}`);

const original = win32.cursorPosition();
console.log(`起始位置: (${original.x}, ${original.y})`);

// 取几个互不相同的目标点，逐一同进程内验证
const targets = [
	{ x: 1111, y: 222 },
	{ x: 333, y: 777 },
	{ x: 900, y: 500 },
];

let allOk = true;
for (const target of targets) {
	const before = win32.cursorPosition();
	const ok = win32.setCursorPosition(target.x, target.y);
	const after = win32.cursorPosition();
	const matched = after.x === target.x && after.y === target.y;
	allOk &&= ok && matched;
	console.log(
		`目标 (${target.x}, ${target.y})  返回=${ok}  `
		+ `读回 (${after.x}, ${after.y})  ${matched ? '一致' : '不一致'}   `
		+ `(移动前在 (${before.x}, ${before.y}))`,
	);
}

win32.setCursorPosition(original.x, original.y);
const restored = win32.cursorPosition();
console.log(`还原到 (${original.x}, ${original.y})，读回 (${restored.x}, ${restored.y})`);
console.log(allOk ? '\n结论：SetCursorPos 真实生效' : '\n结论：SetCursorPos 未生效（读回与目标不符）');
