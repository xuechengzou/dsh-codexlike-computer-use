/**
 * 按键名与组合键解析。
 *
 * 面向模型的写法沿用 computer use 的通行形式：`Return`、`ctrl+c`、
 * `alt+Tab`、`win+s`。解析结果是一组有序的"按下/抬起"步骤，注入层照单执行。
 *
 * 扩展键标志（KEYEVENTF_EXTENDEDKEY）必须精确：方向键、Delete、Home/End、
 * PageUp/PageDown、右 Ctrl/Alt、数字小键盘的除法键等，漏掉这个标志时
 * 目标程序收到的是小键盘对应键或完全无关的键，且不会报错。
 */

import { KEYEVENTF } from './win32.js';

/** 一次按键步骤。 */
export interface ChordStep {
	virtualKey: number;
	extended: boolean;
}

/** 一个已解析的组合键：先按 `down` 顺序按下，再按 `up` 顺序抬起。 */
export interface Chord {
	/** 规范化后的显示名，用于回显给模型。 */
	label: string;
	down: readonly ChordStep[];
	up: readonly ChordStep[];
}

const MODIFIERS = new Map<string, number>([
	['ctrl', 0x11],
	['control', 0x11],
	['alt', 0x12],
	['menu', 0x12],
	['shift', 0x10],
	['win', 0x5b],
	['super', 0x5b],
	['meta', 0x5b],
	['cmd', 0x5b],
	['lwin', 0x5b],
	['rwin', 0x5c],
]);

/** 需要扩展键标志的虚拟键。 */
const EXTENDED_KEYS = new Set<number>([
	0x21, // PageUp
	0x22, // PageDown
	0x23, // End
	0x24, // Home
	0x25, // Left
	0x26, // Up
	0x27, // Right
	0x28, // Down
	0x2c, // PrintScreen
	0x2d, // Insert
	0x2e, // Delete
	0x5b, // LWin
	0x5c, // RWin
	0x5d, // ContextMenu
	0x6f, // NumpadDivide
	0x90, // NumLock
	0xa3, // RightCtrl
	0xa5, // RightAlt
]);

const NAMED_KEYS = new Map<string, number>([
	['return', 0x0d],
	['enter', 0x0d],
	['escape', 0x1b],
	['esc', 0x1b],
	['tab', 0x09],
	['space', 0x20],
	['spacebar', 0x20],
	['backspace', 0x08],
	['back', 0x08],
	['delete', 0x2e],
	['del', 0x2e],
	['insert', 0x2d],
	['ins', 0x2d],
	['home', 0x24],
	['end', 0x23],
	['pageup', 0x21],
	['pgup', 0x21],
	['pagedown', 0x22],
	['pgdn', 0x22],
	['up', 0x26],
	['down', 0x28],
	['left', 0x25],
	['right', 0x27],
	['capslock', 0x14],
	['numlock', 0x90],
	['scrolllock', 0x91],
	['printscreen', 0x2c],
	['prtsc', 0x2c],
	['pause', 0x13],
	['contextmenu', 0x5d],
	['apps', 0x5d],
	['numpad0', 0x60],
	['numpad1', 0x61],
	['numpad2', 0x62],
	['numpad3', 0x63],
	['numpad4', 0x64],
	['numpad5', 0x65],
	['numpad6', 0x66],
	['numpad7', 0x67],
	['numpad8', 0x68],
	['numpad9', 0x69],
	['numpadmultiply', 0x6a],
	['numpadadd', 0x6b],
	['numpadsubtract', 0x6d],
	['numpaddecimal', 0x6e],
	['numpaddivide', 0x6f],
	// 标点别名：这些字符走虚拟键路径时按美式布局解析，不受当前输入法影响
	['semicolon', 0xba],
	['colon', 0xba],
	['equals', 0xbb],
	['plus', 0xbb],
	['comma', 0xbc],
	['minus', 0xbd],
	['hyphen', 0xbd],
	['period', 0xbe],
	['dot', 0xbe],
	['slash', 0xbf],
	['grave', 0xc0],
	['backtick', 0xc0],
	['bracketleft', 0xdb],
	['backslash', 0xdc],
	['bracketright', 0xdd],
	['quote', 0xde],
	['apostrophe', 0xde],
]);

/** 单字符标点到虚拟键的映射（美式 101 键布局）。 */
const PUNCTUATION = new Map<string, number>([
	[';', 0xba],
	[':', 0xba],
	['=', 0xbb],
	['+', 0xbb],
	[',', 0xbc],
	['<', 0xbc],
	['-', 0xbd],
	['_', 0xbd],
	['.', 0xbe],
	['>', 0xbe],
	['/', 0xbf],
	['?', 0xbf],
	['`', 0xc0],
	['~', 0xc0],
	['[', 0xdb],
	['{', 0xdb],
	['\\', 0xdc],
	['|', 0xdc],
	[']', 0xdd],
	['}', 0xdd],
	["'", 0xde],
	['"', 0xde],
]);

/** F1–F24 的虚拟键码。 */
function functionKey(index: number): number | undefined {
	return index >= 1 && index <= 24 ? 0x6f + index : undefined;
}

/**
 * 把组合键写法归一成可用于比对的形式。
 *
 * 直接用**虚拟键码**而不是键名做归一：键名有大量别名（`del`/`delete`、
 * `esc`/`escape`、`control`/`ctrl`），标点更是同一个物理键有多个写法
 * （`+` 与 `=`、`:` 与 `;`）。按名字比对会让 `deniedKeys` 出现"写了却拦不住"
 * 的漏洞——安全相关的配置最不能有这种失效方式。
 *
 * 无法解析的 token 退化为小写名，使明显写错的名单项仍可比较而不抛错。
 *
 * @param spec - 模型或配置给出的组合键写法。
 * @returns 形如 `vk17+vk18|vk46` 的规范串；空写法返回空串。
 */
export function canonicalChordSpec(spec: string): string {
	const tokens = spec
		.trim()
		.toLowerCase()
		.split(/[+\s]+/u)
		.filter((token) => token.length > 0);
	if (tokens.length === 0) return '';

	const encode = (token: string): string => {
		const virtualKey = resolveKey(token);
		return virtualKey === undefined ? token : `vk${virtualKey}`;
	};

	const main = encode(tokens[tokens.length - 1]!);
	const modifiers = [...new Set(tokens.slice(0, -1).map(encode))].sort();
	return `${modifiers.join('+')}|${main}`;
}

/** 解析单个键名（不含组合），失败返回 undefined。 */
function resolveKey(token: string): number | undefined {
	const lower = token.toLowerCase();

	const named = NAMED_KEYS.get(lower);
	if (named !== undefined) return named;

	// 修饰键本身也可以作主键：`hold_key` 按住 shift 再点击是常见用法，
	// 若只允许它出现在组合里，"shift" 会被误判为无法识别。
	const modifier = MODIFIERS.get(lower);
	if (modifier !== undefined) return modifier;

	if (lower.length === 1) {
		const code = lower.charCodeAt(0);
		if (code >= 0x61 && code <= 0x7a) return code - 0x20; // a-z → A-Z
		if (code >= 0x30 && code <= 0x39) return code; // 0-9 与虚拟键码同值
		const punctuation = PUNCTUATION.get(lower);
		if (punctuation !== undefined) return punctuation;
	}

	if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return functionKey(Number(lower.slice(1)));

	return undefined;
}

/**
 * 解析一个组合键写法。
 *
 * 末位非修饰键 token 被视为主键，其余必须是修饰键；`ctrl+shift+s` 与
 * `ctrl shift s` 等价。`+` 单独作主键需要写成 `plus`，因为 `+` 同时是分隔符。
 *
 * @param spec - 模型给出的按键写法。
 * @returns 规范化的按下/抬起步骤。
 * @throws 当写法为空白、修饰键缺失或主键无法识别时，抛出可读的模型可纠正错误。
 */
export function parseChord(spec: string): Chord {
	const trimmed = spec.trim();
	if (trimmed.length === 0) throw new Error('keys 不能为空；例如 "Return"、"ctrl+c" 或 "alt+Tab"');

	// 按 '+' 或空白切分；保留以 "+"-结尾的写法（如 "ctrl++"）的兜底
	const tokens = trimmed.split(/[+\s]+/u).filter((token) => token.length > 0);
	if (tokens.length === 0) throw new Error(`无法解析按键 "${spec}"`);

	const main = tokens[tokens.length - 1]!;
	const modifierTokens = tokens.slice(0, -1);

	const virtualKey = resolveKey(main);
	if (virtualKey === undefined) {
		throw new Error(`无法识别按键 "${main}"（来自 "${spec}"）；可用形式如 "Return"、"Escape"、"Tab"、"F5"、"ctrl+c"、"alt+Tab"、"win+s"`);
	}

	const modifierKeys: number[] = [];
	for (const token of modifierTokens) {
		const lower = token.toLowerCase();
		const modifier = MODIFIERS.get(lower);
		if (modifier === undefined) {
			throw new Error(`"${token}" 不是修饰键（可用 ctrl / alt / shift / win），且只能出现在组合键开头，例如 "ctrl+shift+s"`);
		}
		if (!modifierKeys.includes(modifier)) modifierKeys.push(modifier);
	}

	if (modifierKeys.includes(0x5c)) {
		// 右 Win 无法与左 Win 组合；RWin 单独作修饰键时按左 Win 处理更稳
		const index = modifierKeys.indexOf(0x5c);
		modifierKeys[index] = 0x5b;
	}

	const down: ChordStep[] = modifierKeys.map((key) => ({ virtualKey: key, extended: EXTENDED_KEYS.has(key) }));
	down.push({ virtualKey, extended: EXTENDED_KEYS.has(virtualKey) });

	const up: ChordStep[] = [{ virtualKey, extended: EXTENDED_KEYS.has(virtualKey) }];
	for (let index = modifierKeys.length - 1; index >= 0; index -= 1) {
		const key = modifierKeys[index]!;
		up.push({ virtualKey: key, extended: EXTENDED_KEYS.has(key) });
	}

	const label = [...modifierTokens.map((token) => token.toLowerCase()), main].join('+');
	return { label, down, up };
}

/**
 * 把一个步骤转成 INPUT 事件。
 *
 * 除虚拟键外还带上扫描码：多数程序只看虚拟键，但部分输入法、终端与游戏
 * 读扫描码，缺它时那些目标会收不到正确的键。
 *
 * @param step - 已解析的按键步骤。
 * @param release - true 生成抬起事件。
 * @param scanCode - `MapVirtualKey` 得到的扫描码；0 表示该键无扫描码（系统自会补全）。
 */
export function keyEvent(
	step: ChordStep,
	release: boolean,
	scanCode: number,
): { kind: 'key'; virtualKey: number; scanCode: number; flags: number } {
	let flags = release ? KEYEVENTF.KEYUP : 0;
	if (step.extended) flags |= KEYEVENTF.EXTENDEDKEY;
	return { kind: 'key', virtualKey: step.virtualKey, scanCode, flags };
}
