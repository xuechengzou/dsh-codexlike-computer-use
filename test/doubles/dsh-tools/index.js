/**
 * `@deepseek-ai/dsh-tools` 的测试替身。
 *
 * 真身就在 test/doubles/dsh-tools/，随版本库提交；测试时由 scripts/link-doubles.mjs
 * 在 node_modules/@deepseek-ai/dsh-tools 建一层联接。它不是宿主包，生产解析撞上它
 * 会让插件的 fiberPhase 停在 failed（假 `defineTool` 没有宿主的注册语义）。
 *
 * 宿主包不随插件安装，但测试需要驱动真实的 `lib/tool.js`。默认情况下这里的
 * `defineTool` 只把定义原样返回；宿主真正的 `defineTool` 还会把参数 DSL 编译成
 * JSON Schema 并做严格校验——那部分由 `scripts/verify-host-contracts.mjs`
 * 通过环境变量委派给真实宿主包来验证。
 *
 * 替身刻意不做参数校验：本插件自己会逐动作校验参数，测试要验证的正是
 * 这一层的行为，替身若抢先拒绝就看不出插件的真实反应。
 */
import { pathToFileURL } from 'node:url';

/** 真实宿主包入口；未设置时使用下方的透传实现。 */
const realEntry = process.env.DSH_COMPUTER_USE_REAL_HOST_TOOLS;
const real = realEntry === undefined ? null : await import(pathToFileURL(realEntry).href);

/** 是否正在委派给真实的宿主包。 */
export const usingRealHostTools = real !== null;

/** 定义工具。委派模式下走宿主真实实现（含 schema 编译与校验）。 */
export function defineTool(options) {
	return real === null ? options : real.defineTool(options);
}
