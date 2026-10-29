/**
 * `koffi` 的模块声明。
 *
 * 为什么需要：仓库在**测试时**把 `node_modules/koffi` 联接到
 * `test/doubles/koffi`（假实现，不带 `.d.ts`），`tsc --noEmit` 因此找不到
 * 声明。这里只声明"能被 import 到"，具体形状由 `src/uia/com.ts` 的
 * `KoffiLike` 窄接口描述——用到哪几个字段就在那里写哪几个。
 */

declare module 'koffi' {
	const koffi: unknown;
	export default koffi;
}
