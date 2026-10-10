/**
 * koffi 的最小结构类型。
 *
 * 不复用 koffi 包自带的 `.d.ts`：那是插件自己的运行时依赖，版本可能在
 * 安装时漂移，而这里只需要"能建结构体、能绑函数、能算尺寸"这一小面。
 * 自带声明也让 `tsc` 在 koffi 尚未安装时仍能检查本插件。
 */

/** 一个 koffi 类型描述符（基础类型名、struct、union、pointer）。 */
export type KoffiType = unknown;

/** 已加载的动态库。 */
export interface KoffiLibrary {
	/** 按 C 签名绑定一个导出函数。 */
	func(signature: string): (...args: never[]) => never;
}

/** koffi 顶层导出的最小面。 */
export interface KoffiModule {
	load(path: string): KoffiLibrary;
	struct(name: string, members: Record<string, KoffiType>): KoffiType;
	union(name: string, members: Record<string, KoffiType>): KoffiType;
	sizeof(type: KoffiType): number;
}
