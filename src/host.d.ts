/**
 * 构建期替身声明。
 *
 * 这些包由 DSH 宿主在运行时提供，不随插件发布，因此本地只为
 * `tsc --noEmit` 声明本插件实际用到的最小面。真正的权威契约来自宿主
 * 的 cordis Inspect（Service / Event / Config / Tool 目录）——改这里之前
 * 先核对宿主版本。
 *
 * 注意：这些声明**只在宿主包未安装时**才需要。若日后在本项目里真的
 * `npm install` 了同名 peer 依赖，请删掉本文件，改用宿主的真实类型，
 * 否则两边会做声明合并，报出难以理解的冲突。
 *
 * koffi 不在此列：它是本插件自己的运行时依赖，且真实类型很丰富，
 * 因此 win32.ts 用局部接口 + 动态导入接住它，避免版本间签名冲突。
 */

declare module '@deepseek-ai/schemastery' {
	/**
	 * 宿主的 schema 是**可调用对象**：`Config(value)` 返回补齐默认值后的结果。
	 * 这一点在宿主里实测过，也是插件自己补默认值的依据（见 index.ts）。
	 */
	export interface SchemaLike {
		(value?: unknown): unknown;
		default(value: unknown): SchemaLike;
	}
	export interface SchemaFactory {
		object(members: Record<string, unknown>): SchemaLike;
		number(): SchemaLike;
		integer(): SchemaLike;
		boolean(): SchemaLike;
		string(): SchemaLike;
		array(inner: unknown): SchemaLike;
	}
	const schema: SchemaFactory;
	export default schema;
}

declare module '@deepseek-ai/dsh-tools' {
	/** 注册表接受的工具定义；本插件只依赖这些字段。 */
	export interface ToolDefinition {
		readonly name: string;
		readonly description: string;
		readonly parameters: Record<string, unknown>;
		readonly output: {
			readonly schema: unknown;
			render(args: never, value: never): unknown;
			presentationMeta?(args: never, value: never): unknown;
		};
		readonly timeoutMs?: number;
		isConcurrencySafe?(args: never): boolean;
		execute(args: never, exec: never): Promise<unknown>;
		finalizeContent?(exec: never, result: never): unknown;
		presentCall?(args: never): unknown;
		presentResult?(args: never, result: never): unknown;
	}
	export function defineTool(options: Record<string, unknown>): ToolDefinition;
}

declare module '@deepseek-ai/dsh-attachment' {
	/** 附件服务抛出的带码错误。 */
	export class AttachmentError extends Error {
		readonly code: string;
	}
}

declare module '@deepseek-ai/cordis' {
	export interface Context {
		/** 工具注册表。 */
		readonly tools: {
			register(definition: unknown): () => void;
		};
		/** 提示词注册表。 */
		readonly systemPrompt: {
			section(section: Record<string, unknown>): () => void;
		};
		/**
		 * computer-use provider 槽位。
		 *
		 * 刻意声明为**可选**：它由宿主组合决定是否挂载，而本机安装里只存在
		 * 服务契约、没有实现。声明成必选成员会诱使代码硬依赖它，从而让插件
		 * 永远停在 pending，且宿主不报任何错。
		 */
		readonly computerUse?: {
			register(name: string): () => Promise<void>;
		};
		/** 可选日志器；宿主组合不一定提供。 */
		readonly logger?: {
			warn?(message: string): void;
			info?(message: string): void;
		};
		/** 解析可选服务。 */
		get(name: string): unknown;
		/**
		 * 起一个等依赖就位的子 fiber：服务尚未挂载时回调不会执行，挂载后才跑。
		 * 注册路由这类"必须等 webServer 就位"的动作靠它定时机。
		 */
		inject(deps: string[], callback: (ctx: Context) => void): unknown;
		/** 监听宿主事件（emit 模式）。 */
		on(event: string, listener: (payload: unknown) => void): () => void;
	}
}
