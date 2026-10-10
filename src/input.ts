/**
 * 鼠标与键盘注入。
 *
 * 这里固化了原型实测出的两条可靠性结论，它们直接决定 computer use 能否用：
 *
 * 1. **打字前必须等焦点就绪。** 合成键盘事件只投递给**持有焦点的控件**。
 *    点击之后焦点是分两步落定的（顶层窗口先成为前台，再派发到子控件），
 *    两步之间注入会让开头若干字符被系统丢弃——实测丢失 1–3 个且随负载抖动，
 *    而且固定 sleep 无法消除（250/600/1000ms 都复现）。`settleKeyboardTarget`
 *    改为等待 `hwndFocus` 稳定，这才是键盘输入真正的投递目标。
 *
 * 2. **逐字符注入必须节流。** 0ms 间隔的突发注入会被丢弃；≥12ms 间隔时
 *    实测 100% 送达。`chunkSize` 把若干字符合并成一次 SendInput（同批事件
 *    顺序有保证），`chunkDelayMs` 在批次之间让出时间。
 *
 * SendInput 的返回值是**系统真正接纳**的事件数。任何缺口都视为失败并抛出，
 * 绝不让"看起来成功了但按键没发出去"静默通过——模型据此误判界面状态。
 */

import { keyEvent, type Chord, type ChordStep } from './keys.js';
import { INPUT_KEYBOARD, KEYEVENTF, MOUSEEVENTF, type InputEvent, type Point, type Win32, type WindowInfo } from './win32.js';

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** 一个鼠标键的按下/抬起标志。 */
export interface MouseButton {
	down: number;
	up: number;
	/** 用于错误与回显的名字。 */
	label: string;
}

/** 受支持的鼠标键。 */
export const MOUSE_BUTTONS: Record<'left' | 'right' | 'middle', MouseButton> = {
	left: { down: MOUSEEVENTF.LEFTDOWN, up: MOUSEEVENTF.LEFTUP, label: '左键' },
	right: { down: MOUSEEVENTF.RIGHTDOWN, up: MOUSEEVENTF.RIGHTUP, label: '右键' },
	middle: { down: MOUSEEVENTF.MIDDLEDOWN, up: MOUSEEVENTF.MIDDLEUP, label: '中键' },
};

/** 把一批事件交给 SendInput，并断言系统全部接纳。 */
function inject(win32: Win32, events: readonly InputEvent[], what: string): void {
	const accepted = win32.sendInput(events);
	if (accepted !== events.length) {
		throw new Error(`注入${what}时系统只接纳 ${accepted}/${events.length} 个事件；目标窗口可能正在切换或无响应，请重试`);
	}
}

/** 键盘注入的就绪状态。 */
export interface KeyboardTarget {
	/** 接收按键的顶层窗口。 */
	foreground: bigint;
	/** 持有键盘焦点的控件；0n 表示无法判定。 */
	focus: bigint;
}

/**
 * 等待键盘输入的目标真正就绪。
 *
 * 判据是**前台窗口与其焦点控件都连续两次采样不变**，而不是"距离上次操作
 * 过了多久"，也不是"顶层窗口是否已成为前台"：
 *
 * - 固定 sleep 不可靠。实测点击后等 250ms / 600ms / 1000ms，开头被丢弃的
 *   字符数在 1–3 之间抖动，说明决定因素是焦点派发的完成时机而非时长。
 * - 只看 `GetForegroundWindow` 也不够。顶层窗口成为前台是一步，Windows 把
 *   焦点派发到具体子控件（WM_SETFOCUS）是另一步；两步之间注入的按键会被
 *   系统丢弃，表现为**首个字符凭空消失**——正是这个缺陷最迷惑人的地方。
 *
 * 因此这里等 `hwndFocus`，它才是键盘输入真正的投递目标。
 *
 * @param win32 - 原生绑定。
 * @param timeoutMs - 等待上限；到点后仍返回最后一次读数，由调用方决定是否告警。
 * @returns 稳定后的目标。
 */
export async function settleKeyboardTarget(win32: Win32, timeoutMs: number): Promise<KeyboardTarget> {
	const read = (): KeyboardTarget => ({ foreground: win32.foregroundWindow(), focus: win32.focusedControl() });
	if (timeoutMs <= 0) return read();

	const deadline = Date.now() + timeoutMs;
	let previous = read();
	while (Date.now() < deadline) {
		await sleep(15);
		const current = read();
		// 焦点句柄尚不可判定时不算就绪，继续等到有明确读数
		if (current.focus !== 0n && current.focus === previous.focus && current.foreground === previous.foreground) {
			return current;
		}
		previous = current;
	}
	return previous;
}

/** 读取当前前台窗口的信息，用于向模型回报"输入发给了谁"。 */
export function foregroundInfo(win32: Win32): WindowInfo | undefined {
	return win32.windowInfo(win32.foregroundWindow());
}

/** 读取焦点控件的信息；多数情况下它才是按键的真正接收者。 */
export function focusedControlInfo(win32: Win32): WindowInfo | undefined {
	return win32.windowInfo(win32.focusedControl());
}

/** 把窗口信息压成一行可读描述。 */
export function describeWindow(info: WindowInfo | undefined): string {
	if (info === undefined) return '(无法读取前台窗口)';
	const title = info.title.length > 0 ? info.title : '(无标题)';
	return `"${title}" [${info.className}] pid=${info.processId}`;
}

/** 把鼠标移动到绝对屏幕坐标。 */
export function moveMouse(win32: Win32, point: Point): void {
	if (!win32.setCursorPosition(point.x, point.y)) {
		throw new Error(`SetCursorPos(${point.x}, ${point.y}) 失败；坐标可能超出桌面范围`);
	}
}

/**
 * 在当前位置或指定位置点击。
 *
 * @param point - 省略时在原地点击（用于连续操作已定位的目标）。
 * @param count - 连击次数；多次点击之间留出系统识别双击的间隔。
 */
export async function click(
	win32: Win32,
	button: MouseButton,
	count: number,
	point: Point | undefined,
	doubleClickIntervalMs: number,
): Promise<void> {
	if (point !== undefined) moveMouse(win32, point);
	for (let index = 0; index < count; index += 1) {
		// 同一批内下发按下与抬起：保证不被其它事件插入到两者之间
		inject(win32, [
			{ kind: 'mouse', dx: 0, dy: 0, mouseData: 0, flags: button.down },
			{ kind: 'mouse', dx: 0, dy: 0, mouseData: 0, flags: button.up },
		], `${button.label}点击`);
		if (index < count - 1) await sleep(doubleClickIntervalMs);
	}
}

/** 按住左键从一点拖到另一点；中间补插移动步，避免目标程序判定为瞬移。 */
export async function drag(win32: Win32, from: Point, to: Point, steps: number): Promise<void> {
	moveMouse(win32, from);
	await sleep(20);
	inject(win32, [{ kind: 'mouse', dx: 0, dy: 0, mouseData: 0, flags: MOUSEEVENTF.LEFTDOWN }], '拖拽按下');
	await sleep(20);
	for (let step = 1; step <= steps; step += 1) {
		const x = Math.round(from.x + ((to.x - from.x) * step) / steps);
		const y = Math.round(from.y + ((to.y - from.y) * step) / steps);
		moveMouse(win32, { x, y });
		await sleep(8);
	}
	await sleep(20);
	inject(win32, [{ kind: 'mouse', dx: 0, dy: 0, mouseData: 0, flags: MOUSEEVENTF.LEFTUP }], '拖拽抬起');
}

/** 滚轮常量：一格 120。 */
export const WHEEL_DELTA = 120;

/**
 * 滚动。
 *
 * @param vertical - 垂直格数，正数向上（与 Win32 WHEEL 同号）。
 * @param horizontal - 水平格数，正数向右。
 * @param point - 给定时光标先移过去，确保滚动落在目标窗口上。
 */
export function scroll(win32: Win32, vertical: number, horizontal: number, point: Point | undefined): void {
	if (vertical === 0 && horizontal === 0) throw new Error('scroll 需要垂直或水平方向至少一个非零格数');
	if (point !== undefined) moveMouse(win32, point);
	const events: InputEvent[] = [];
	if (vertical !== 0) {
		events.push({ kind: 'mouse', dx: 0, dy: 0, mouseData: (vertical * WHEEL_DELTA) >>> 0, flags: MOUSEEVENTF.WHEEL });
	}
	if (horizontal !== 0) {
		events.push({ kind: 'mouse', dx: 0, dy: 0, mouseData: (horizontal * WHEEL_DELTA) >>> 0, flags: MOUSEEVENTF.HWHEEL });
	}
	inject(win32, events, '滚轮');
}

/** 需要走虚拟键而非 Unicode 注入的控制字符。 */
const CONTROL_CHARACTERS = new Map<string, number>([
	['\n', 0x0d], // Return：多数应用忽略 Unicode 的 \n，必须走 VK
	['\t', 0x09], // Tab
]);
/**
 * 注入文本。
 *
 * 走 `KEYEVENTF_UNICODE` 而不是"字符 → 虚拟键"：注入结果与当前键盘布局、
 * 输入法、大小写锁定无关，因此中文、重音字母、emoji 都能如实送达。
 * 换行与制表符例外——它们必须走虚拟键，否则多数控件不会响应。
 *
 * @param text - 待注入文本。
 * @param chunkSize - 每个 SendInput 承载的 UTF-16 单元数。
 * @param chunkDelayMs - 批次之间的让出时间；`< 1` 会显著提高丢字概率。
 * @param warmup - 是否在首批最前面加一对"牺牲"按键；关闭后仅用于对照实验。
 * @returns 实际注入的字符数（不含被跳过的 `\r`，也不含牺牲事件）。
 */
export async function typeText(
	win32: Win32,
	text: string,
	chunkSize: number,
	chunkDelayMs: number,
	warmup = true,
): Promise<number> {
	// 归一化换行：\r\n 与单独 \r 都收敛成一个 Return，避免产生双换行
	const normalized = text.replace(/\r\n?/gu, '\n');
	const units: InputEvent[] = warmup ? sacrificialEvents(win32) : [];
	for (const character of normalized) {
		const control = CONTROL_CHARACTERS.get(character);
		if (control !== undefined) {
			const scanCode = win32.virtualKeyToScanCode(control);
			units.push(keyEvent({ virtualKey: control, extended: false }, false, scanCode));
			units.push(keyEvent({ virtualKey: control, extended: false }, true, scanCode));
			continue;
		}
		for (let index = 0; index < character.length; index += 1) {
			const code = character.charCodeAt(index);
			units.push({ kind: 'key', virtualKey: 0, scanCode: code, flags: KEYEVENTF.UNICODE });
			units.push({ kind: 'key', virtualKey: 0, scanCode: code, flags: KEYEVENTF.UNICODE | KEYEVENTF.KEYUP });
		}
	}

	const stride = Math.max(2, chunkSize);
	for (let offset = 0; offset < units.length; offset += stride) {
		const chunk = units.slice(offset, offset + stride);
		// 保证一次 SendInput 内不切断按下/抬起配对，避免出现悬挂的修饰键
		if (chunk.length % 2 !== 0 && offset + stride >= units.length) {
			// 末尾落单只可能来自异常构造，直接丢弃而不是送出半个事件
			chunk.pop();
		}
		inject(win32, chunk, '文本');
		if (offset + stride < units.length) await sleep(chunkDelayMs);
	}
	return normalized.length;
}

/** VK_SHIFT；用作牺牲事件，因为它单独按下/抬起不产生字符、也不留下残留状态。 */
const SACRIFICIAL_KEY = 0x10;

/**
 * 构造一对"牺牲"按键事件，吸收焦点切换后的首次输入丢弃。
 *
 * 点击造成焦点切换后，紧随其后的首批合成输入会被系统间歇性丢弃——实测会丢掉
 * 开头 1–2 个字符，且**延长等待无法消除**（600ms、1000ms 都复现），因为这不是
 * "目标还没准备好"，而是系统对焦点切换期间合成输入的抑制。既然抑制何时结束
 * 不可预知，就让一个本身无意义的事件去承受它。
 *
 * 用 Shift 的理由：单独按下再抬起既不产生字符（TextBox、终端、编辑器都如此），
 * 也不改变目标的净状态。即使被完整送达也只是空操作。
 *
 * 关键在于**放在同一批次的最前面**：抑制是按事件生效的，把它排在真实内容之前，
 * 被吃掉的就是它；若拆成独立批次，抑制结束的时机不同，真实内容仍可能受损。
 */
function sacrificialEvents(win32: Win32): InputEvent[] {
	const scanCode = win32.virtualKeyToScanCode(SACRIFICIAL_KEY);
	const step: ChordStep = { virtualKey: SACRIFICIAL_KEY, extended: false };
	return [keyEvent(step, false, scanCode), keyEvent(step, true, scanCode)];
}

/** 把一组按键步骤转成 INPUT 事件，并逐个补上扫描码。 */
function chordEvents(win32: Win32, steps: readonly ChordStep[], release: boolean): InputEvent[] {
	return steps.map((step) => keyEvent(step, release, win32.virtualKeyToScanCode(step.virtualKey)));
}

/** 按下并抬起一个组合键。 */
export function pressChord(win32: Win32, chord: Chord, warmup = true): void {
	const events: InputEvent[] = [
		...(warmup ? sacrificialEvents(win32) : []),
		...chordEvents(win32, chord.down, false),
		...chordEvents(win32, chord.up, true),
	];
	inject(win32, events, `按键 ${chord.label}`);
}

/** 按住组合键（不含抬起）指定时长后抬起。 */
export async function holdChord(win32: Win32, chord: Chord, durationMs: number, warmup = true): Promise<void> {
	const down: InputEvent[] = [...(warmup ? sacrificialEvents(win32) : []), ...chordEvents(win32, chord.down, false)];
	inject(win32, down, `按住 ${chord.label}`);
	try {
		await sleep(durationMs);
	} finally {
		// 即使等待被取消也要抬起，否则修饰键会卡在按下状态并污染后续所有输入
		inject(win32, chordEvents(win32, chord.up, true), `松开 ${chord.label}`);
	}
}
