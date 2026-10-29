/**
 * computer use 的系统提示词段落。
 *
 * 顺序取 3000：宿主 `SECTION_ORDERS` 里各工具段落在 1000–2900，`TOOLS_SDK`
 * 在 5000，3000 正好落在"工具说明之后、SDK 之前"，且宿主没有为 computer use
 * 预留名字，因此这里用裸数值而不是 `getSectionOrder`。
 *
 * 内容只写模型从工具描述里读不出来的部分：桌面是**用户的活机器**、
 * 截图会过期、输入接收者要核对。重复工具描述里的内容只会浪费上下文。
 */

import type { Context } from '@deepseek-ai/cordis';

/** 段落注册顺序。 */
export const SECTION_ORDER = 3000;

/** 段落正文。 */
export const SECTION_TEXT = [
	'# Computer use',
	'',
	'You can operate the live Windows desktop through two tools. The desktop is the user\'s own machine, shared with them, and visible to them while you work.',
	'',
	'- `computer_observe` reads: list target windows, capture the screen, capture one window. It never sends input.',
	'- `computer_act` acts: click, type, press, scroll, drag, move, wait. It can only act through the channel the user\'s current input mode allows.',
	'',
	'Working rules:',
	'- Look before you act: call `computer_observe` and read the result instead of assuming what is on screen. Anything learned from an earlier capture expires as soon as the user or another program changes the screen.',
	'- In window mode every action needs `target`. The result reports whether the delivery should be trusted (`reliable`, `note`); when it should not, do not repeat the same call — report the limitation or switch approach.',
	'- Coordinates are the pixels of the most recent capture of that target. The tool converts them; do not pre-scale.',
	'- After an action, check `target` in the result: it names the window that actually received the input. If it is not the one you meant, stop and re-observe rather than repeating the action.',
	'- Prefer a command-line or file-based route when one exists: it is faster, reproducible, and does not disturb the user\'s desktop. Use computer use for genuinely graphical targets.',
	'',
	'Constraints:',
	'- Never click or type anything that deletes data, sends messages or email, completes purchases, changes account or system security settings, or grants permissions, unless the user explicitly asked for that exact outcome.',
	'- Do not work around a denied or failed action by trying an equivalent destructive action through another route.',
	'- If the input mode forbids the channel you need, tell the user which mode you need and let them switch it. Do not treat a mode error as a retryable failure.',
].join('\n');

/**
 * 注册提示词段落。
 *
 * @param ctx - 插件上下文。
 */
export function registerComputerUsePrompt(ctx: Context): void {
	ctx.systemPrompt.section({
		name: 'tool-computer-use',
		order: SECTION_ORDER,
		text: SECTION_TEXT,
	});
}
