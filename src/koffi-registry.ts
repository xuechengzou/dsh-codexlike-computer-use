/**
 * koffi 类型注册的幂等包装。
 *
 * koffi 的类型表是**进程全局**的，而插件在宿主里可能被 HMR 重新加载：新模块
 * 实例再次注册同名 struct/union 会抛 `Duplicate type name 'POINT'`。实测的后果
 * 不是一条警告，而是之后每个工具调用都失败——因为 `loadWin32()` 在注册阶段就
 * 炸了。
 *
 * 由于本插件的函数原型一律用**类型名**书写（`int GetCursorPos(_Out_ POINT *p)`），
 * 冲突时把名字本身当作类型标识返回即可，语义不变。
 */

/**
 * 注册一个 koffi 类型；同名已注册时返回类型名。
 *
 * @param name - koffi 类型名。
 * @param register - 首次注册的工厂。
 * @returns 类型标识：首次是 koffi 返回的对象，重复时是类型名字符串。
 */
export function defineType<T>(name: string, register: () => T): T | string {
	try {
		return register();
	} catch (error) {
		if (String(error).includes('Duplicate type name')) return name;
		throw error;
	}
}
