/**
 * 运行时状态：用户随时可切换的输入模式。
 *
 * 为什么要独立于 Config：Config 是**部署默认值**，改它要经过 profile 的
 * patch 层并触发插件重载；而"现在要不要真的动鼠标"是工作过程中的临时决定，
 * 必须在一次点击内生效、且不需要重启。因此模式放在这里，界面通过插件自己的
 * HTTP 路由改它，工具执行时读同一份。
 *
 * Config 只提供**初值**（`inputMode` / `allowInput`），重启后回到初值。
 */

import { INPUT_MODES, type InputMode } from './config.js';

/** 一份可观察的状态快照；读取方直接持有引用，不复制。 */
export interface ComputerState {
	/** 当前输入模式。 */
	readonly inputMode: InputMode;
	/** 是否允许模拟输入（与 Config 的 allowInput 取与）。 */
	readonly allowInput: boolean;
}

/** 状态变更的订阅者。 */
export type StateListener = (state: ComputerState) => void;

/** 状态存储：读取、写入、订阅。 */
export interface StateStore {
	/** 读当前状态。 */
	get(): ComputerState;
	/**
	 * 局部更新。
	 *
	 * @param patch - 要改的字段。
	 * @returns 更新后的状态；没有变化时返回同一引用。
	 */
	set(patch: { inputMode?: string; allowInput?: boolean }): ComputerState;
	/** 订阅变更；返回取消订阅函数。 */
	subscribe(listener: StateListener): () => void;
}

/**
 * 把任意值收敛成合法模式。
 *
 * 供配置解析与 HTTP 入参共用：两处都可能收到写错的值，处理方式必须一致。
 *
 * @param value - 候选值。
 * @returns 合法模式；无法识别时返回 undefined。
 */
export function normalizeInputMode(value: unknown): InputMode | undefined {
	if (typeof value !== 'string') return undefined;
	return (INPUT_MODES as readonly string[]).includes(value) ? (value as InputMode) : undefined;
}

/**
 * 依据配置初值建立状态存储。
 *
 * @param initial - 初值：`inputMode` 来自 Config，`allowInput` 同样。
 * @returns 状态存储。
 */
export function createState(initial: { inputMode: string; allowInput: boolean }): StateStore {
	let current: ComputerState = Object.freeze({
		inputMode: normalizeInputMode(initial.inputMode) ?? 'window',
		allowInput: initial.allowInput,
	});
	const listeners = new Set<StateListener>();

	return {
		get: () => current,
		set(patch) {
			const nextMode = patch.inputMode === undefined ? current.inputMode : normalizeInputMode(patch.inputMode);
			const nextAllow = patch.allowInput ?? current.allowInput;
			const next: ComputerState = Object.freeze({
				inputMode: nextMode ?? current.inputMode,
				allowInput: nextAllow,
			});
			if (next.inputMode === current.inputMode && next.allowInput === current.allowInput) return current;
			current = next;
			for (const listener of listeners) {
				try {
					listener(current);
				} catch {
					// 订阅者的异常不应该让"改个模式"失败
				}
			}
			return current;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
