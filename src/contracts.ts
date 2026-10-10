/**
 * 本插件消费的宿主服务窄契约。
 *
 * 刻意不 `import type` 宿主包：这些接口按 cordis Inspect 的 Service 目录
 * 逐字段抄录，只保留本插件真正调用的部分。宿主是结构化类型，
 * 因此窄契约既能通过类型检查，也把"我依赖什么"显式写在一处。
 */

/** 宿主接受并持久化的图像媒体类型。 */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** 附件服务返回的不可变图像引用；纯 JSON，可直接放进工具输出值。 */
export interface ImageAttachmentRef {
	attachmentId: string;
	mediaType: ImageMediaType;
	bytes: number;
	width: number;
	height: number;
	name?: string;
	/** 仅在存储侧对栅格做过缩减时出现，记录归一化前的输入尺寸。 */
	originalDimensions?: { width: number; height: number };
}

/** 部署级图像策略，用于在捕获后先行拒绝不可能被接受的截图。 */
export interface ImageAttachmentLimits {
	maxImageBytes: number;
	maxImagesPerMessage: number;
	maxMessageImageBytes: number;
	maxImagePixels: number;
	maxImageDimension: number;
	mediaTypes: readonly ImageMediaType[];
}

/** `ctx.get('attachments')` 暴露的持久化入口。 */
export interface AttachmentService {
	readonly imageLimits: ImageAttachmentLimits;
	saveImage(input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<ImageAttachmentRef>;
}

/** `llm.resolveModelInfo` 返回的路由能力，只有 `inputModalities` 参与判断。 */
export interface ResolvedModelInfo {
	inputModalities?: readonly string[];
}

/** `ctx.get('llm')` 的路由能力查询。 */
export interface LlmService {
	resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<ResolvedModelInfo>;
}

/** 调用方会话上读取当前路由所需的最小面。 */
export interface SessionLike {
	requestHeader?(): { config?: { provider?: string; model?: string } } | undefined;
}

/** 调用方 agent 上读取当前路由所需的最小面。 */
export interface AgentLike {
	readonly id: string;
	readonly session?: SessionLike;
	readonly options?: { provider?: string; model?: string };
}

/** `ctx.computerUse`：进程内单槽 provider 注册。 */
export interface ComputerUseService {
	register(name: string): () => Promise<void>;
}

/** 审批结果词汇；只有 `allowed-once` 是授权。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** `ctx.get('approval')` 的请求形态。 */
export interface ApprovalService {
	request(request: {
		agent: AgentLike;
		toolName: string;
		callId?: string;
		reason?: string;
		displayReason?: { en: string } & Record<string, string>;
		signal?: AbortSignal;
	}): Promise<ApprovalOutcome>;
}
