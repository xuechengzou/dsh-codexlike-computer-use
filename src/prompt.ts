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
	'You can operate the live Windows desktop through the `computer` tool. The desktop is the user\'s own machine, shared with them, and visible to them while you work.',
	'',
	'Working rules:',
	'- Take a `screenshot` before acting. Anything you learned from an earlier screenshot expires as soon as the user or another program changes the screen.',
	'- Read coordinates off the screenshot; mouse actions take screen pixels. If the screenshot envelope reports a scale, apply the conversion it states instead of estimating.',
	'- After any action that changes focus, check the `target` field in the result. It names the window that actually received the input. If it is not the window you meant, click that window and repeat the action — do not assume the text landed correctly.',
	'- Prefer a command-line or file-based route when one exists: it is faster, reproducible, and does not disturb the user\'s desktop. Use computer use for genuinely graphical targets.',
	'- Batch work: one screenshot can justify several actions, so avoid re-capturing after every keystroke.',
	'',
	'Constraints:',
	'- Never click or type anything that deletes data, sends messages or email, completes purchases, changes account or system security settings, or grants permissions, unless the user explicitly asked for that exact outcome.',
	'- Do not work around a denied or failed action by trying an equivalent destructive action through another route.',
	'- If an action would affect a window you did not intend to touch, stop and report what you see instead of retrying blindly.',
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
