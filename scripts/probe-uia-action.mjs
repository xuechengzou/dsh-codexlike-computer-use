/**
 * 元素级动作探针：在**专门起的靶窗口**上验证 Invoke / SetValue。
 *
 * 为什么必须用靶窗口：元素级动作会真的按下按钮、真的写文本框。拿用户的记事本
 * 或浏览器试，等于让测试去改用户的东西。靶窗口（test/helpers/background-target.ps1）
 * 自带一个按钮与一个文本框，并把点击次数写进 JSON，因此结果可以逐项比对。
 *
 * 用法：node scripts/probe-uia-action.mjs
 * 会启动一个 WinForms 窗口、点它一次、写一次文本，最后关掉它。
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const STATE = join(process.env.TEMP ?? '/tmp', 'dsh-e2e-target.json');

const require = createRequire('C:/Users/administor/.dsh/profiles/desktop/package.json');
const koffi = require('koffi');
const { createUia } = await import('../lib/uia/com.js');

// ---- 1. 起靶窗口 --------------------------------------------------------
// 直接拉起 PowerShell 靶窗口，而不是复用 scripts/start-e2e-target.mjs：
// 后者用 detached 启动并轮询就绪，实测拿不到 JSON（分离进程里的 WinForms 起不来）。
if (existsSync(STATE)) unlinkSync(STATE);
const target = spawn('pwsh', [
	'-NoProfile', '-ExecutionPolicy', 'Bypass',
	'-File', join(PROJECT, 'test', 'helpers', 'background-target.ps1'),
	'-OutPath', STATE, '-Title', 'DSH-E2E-TARGET', '-Left', '200', '-Top', '150',
], { stdio: 'ignore' });

const readState = () => JSON.parse(readFileSync(STATE, 'utf8'));
let initial;
for (let attempt = 0; attempt < 40; attempt += 1) {
	await new Promise((resolve) => setTimeout(resolve, 500));
	if (!existsSync(STATE)) continue;
	try {
		const candidate = readState();
		if (candidate.rect?.width > 0) {
			initial = candidate;
			break;
		}
	} catch {
		// JSON 可能只写了一半
	}
}
if (initial === undefined) {
	console.error('靶窗口没起来，终止');
	target.kill();
	process.exit(1);
}
const hwnd = BigInt(initial.form ?? initial.hwnd);
console.log(`靶窗口 hwnd=${hwnd} 初始点击=${initial.clicks ?? 0}`);

const uia = createUia(koffi);
const root = uia.elementFromHandle(hwnd);
if (root === null) {
	console.error('拿不到靶窗口的可访问性根元素');
	uia.dispose();
	process.exit(1);
}

/** 深度优先找第一个满足条件的元素（不释放返回的那个）。 */
function find(rootElement, predicate) {
	const queue = [rootElement];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current !== rootElement && predicate(current)) return current;
		let child = current.firstChild();
		while (child !== null) {
			queue.push(child);
			child = child.nextSibling();
		}
	}
	return null;
}

// ---- 2. Invoke：点按钮 --------------------------------------------------
const button = find(root, (element) => element.controlType() === 50000 && element.name() === 'CLICK');
if (button === null) {
	console.error('靶窗口里找不到 CLICK 按钮');
	uia.dispose();
	process.exit(1);
}
const invoked = button.invoke();
console.log('Invoke →', JSON.stringify(invoked));
button.release();

await new Promise((resolve) => setTimeout(resolve, 300));
const afterClick = readState();
console.log(`点击后计数 = ${afterClick.clicks ?? 0}（初始 ${initial.clicks ?? 0}）`);

// ---- 3. SetValue：写文本框 ----------------------------------------------
const box = find(root, (element) => element.controlType() === 50004);
if (box === null) {
	console.error('靶窗口里找不到 Edit 控件');
	uia.dispose();
	process.exit(1);
}
const written = box.setValue('ds h-uia 中文');
console.log('SetValue →', JSON.stringify(written));
box.release();

await new Promise((resolve) => setTimeout(resolve, 300));
const afterType = readState();
console.log(`文本框内容 = ${JSON.stringify(afterType.text ?? null)}`);

// ---- 4. 清理 ------------------------------------------------------------
const user32 = koffi.load('user32.dll');
const postMessage = user32.func('bool PostMessageW(void *hwnd, uint32 msg, uintptr wparam, intptr lparam)');
postMessage(hwnd, 0x0010, 0, 0); // WM_CLOSE
uia.dispose();

const ok = (afterClick.clicks ?? 0) === (initial.clicks ?? 0) + 1 && afterType.text === 'ds h-uia 中文';
console.log(ok ? '\n✓ Invoke 与 SetValue 都生效' : '\n✗ 结果与预期不符');
process.exit(ok ? 0 : 1);
