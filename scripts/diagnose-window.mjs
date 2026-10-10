/**
 * 诊断：某个窗口为什么没有出现在 `window` 动作的清单里。
 *
 * 存在的理由：`window` 动作只列出"能接受后台操作"的窗口，但**不说明被漏掉的那些
 * 是为什么被漏掉的**。用户看到自己明明开着的窗口不在清单里，只能靠猜。
 * 这个脚本把插件自己的判定过程摊开：是按标题找不到、解析失败（附原因）、
 * 还是解析成功了却被别的规则筛掉。
 *
 * 只读：不创建窗口、不投递消息、不动光标、不改前台。
 *
 * 用法：node scripts/diagnose-window.mjs <标题子串>
 */
import { fileURLToPath } from 'node:url';
import { requireRealKoffi } from './real-koffi.mjs';

requireRealKoffi();

const needle = process.argv[2] ?? '';
if (needle === '') {
	console.error('用法: node scripts/diagnose-window.mjs <标题子串>');
	process.exit(2);
}

const { loadWin32 } = await import(new URL('../lib/win32.js', import.meta.url).href);
const { resolveTargetWindow, classifyWindow, describeTarget } = await import(new URL('../lib/window-target.js', import.meta.url).href);

const win32 = await loadWin32();
const handles = win32.topLevelWindows();
console.log(`顶层窗口共 ${handles.length} 个，按标题子串 "${needle}" 过滤：\n`);

let matched = 0;
for (const handle of handles) {
	const info = win32.windowInfo(handle);
	if (info === undefined) continue;
	if (!info.title.includes(needle)) continue;
	matched += 1;

	const width = info.rect.right - info.rect.left;
	const height = info.rect.bottom - info.rect.top;
	console.log(`句柄 ${handle}  「${info.title}」`);
	console.log(`  类名 ${info.className}  →  判定为 ${classifyWindow(info.className)}`);
	console.log(`  窗口矩形 ${width}x${height}  可见=${win32.isWindowVisible(handle)}  最小化=${win32.isMinimized(handle)}`);
	console.log(`  子窗口 ${win32.childWindows(handle).length} 个`);

	// 把每个后代的类名与客户区都列出来——渲染子窗口是否够大、是否可见，一眼可见
	for (const child of win32.childWindows(handle)) {
		const childInfo = win32.windowInfo(child);
		const client = win32.clientArea(child);
		console.log(`    子: ${child}  ${String(client?.width ?? 0).padStart(5)}x${String(client?.height ?? 0).padEnd(5)} 可见=${win32.isWindowVisible(child)}  ${childInfo?.className ?? '?'}`);
	}

	const resolved = resolveTargetWindow(win32, handle);
	if (resolved.ok) {
		console.log(`  → 解析成功：${describeTarget(resolved.target)}`);
		console.log(`     surface=${resolved.target.surfaceHandle}  kind=${resolved.target.kind}`);
		console.log(`  → 它**应当**出现在 window 清单里。若没有，问题在工具的筛选规则而不是这里。`);
	} else {
		console.log(`  → 解析失败，这就是它没出现在清单里的原因：`);
		console.log(`     reason: ${resolved.reason}`);
		console.log(`     hint:   ${resolved.hint}`);
	}
	console.log('');
}

if (matched === 0) console.log(`没有标题包含 "${needle}" 的顶层窗口。`);
