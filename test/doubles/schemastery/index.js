/**
 * `@deepseek-ai/schemastery` 的测试替身。
 *
 * 真身就在 test/doubles/schemastery/，随版本库提交；测试时由 scripts/link-doubles.mjs
 * 在 node_modules/@deepseek-ai/schemastery 建一层联接。
 *
 * 关键保真点：宿主的 schema 是**可调用对象**（`Config(value)` 返回解析结果），
 * 不是带 `.parse()` 的对象。替身照此实现，测试才和生产走同一种调用约定——
 * 否则测试会通过，而宿主加载时以完全不同的方式调用 schema。
 *
 * 覆盖本插件用到的那一小块：`object / number / string / boolean / array`
 * 以及 `.default()`。
 *
 * 设置环境变量 `DSH_COMPUTER_USE_REAL_HOST_SCHEMASTERY` 指向宿主真实包入口时
 * 完全委派给真实实现，用于验证解析语义（尤其是默认值填充）与替身一致。
 */
import { pathToFileURL } from 'node:url';

/** 是否在委派给宿主的真实 schemastery。 */
export const usingRealSchemastery = process.env.DSH_COMPUTER_USE_REAL_HOST_SCHEMASTERY !== undefined;

/**
 * 按节点语义解析一个值。
 * @param node - 内部节点描述。
 * @param value - 待解析值；`undefined` 时回落到默认值。
 */
function resolveNode(node, value) {
	if (value === undefined) {
		if (node.hasDefault) return structuredClone(node.defaultValue);
		return undefined;
	}
	switch (node.kind) {
		case 'object': {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('期望一个对象');
			const out = {};
			for (const [key, member] of Object.entries(node.members)) {
				const parsed = member(value[key]);
				if (parsed !== undefined) out[key] = parsed;
			}
			return out;
		}
		case 'array': {
			if (!Array.isArray(value)) throw new TypeError('期望一个数组');
			return value.map((item) => node.inner(item));
		}
		case 'number': {
			if (typeof value !== 'number' || Number.isNaN(value)) throw new TypeError('期望一个数字');
			return value;
		}
		case 'boolean': {
			if (typeof value !== 'boolean') throw new TypeError('期望一个布尔值');
			return value;
		}
		case 'string': {
			if (typeof value !== 'string') throw new TypeError('期望一个字符串');
			return value;
		}
		default:
			return value;
	}
}

/**
 * 构造一个可调用的 schema 对象，形状对齐宿主真实实现。
 * @param kind - 节点类型。
 * @param extra - 类型专属字段。
 */
function schema(kind, extra = {}) {
	const node = { kind, hasDefault: false, defaultValue: undefined, ...extra };
	const callable = (value) => resolveNode(node, value);
	/** 声明缺省值；返回自身以便链式书写。 */
	callable.default = (value) => {
		node.hasDefault = true;
		node.defaultValue = value;
		return callable;
	};
	// 便捷别名，便于在断言里显式表达"解析一次"
	callable.parse = callable;
	// 标准 schema 协议面；宿主与 UI 都通过它读取 schema
	callable['~standard'] = { validate: (value) => ({ value: resolveNode(node, value) }) };
	return callable;
}

const fakeFactory = {
	object(members) {
		return schema('object', { members });
	},
	number() {
		return schema('number');
	},
	string() {
		return schema('string');
	},
	boolean() {
		return schema('boolean');
	},
	array(inner) {
		return schema('array', { inner });
	},
};

/** 仅在需要时 import 真实包，避免无谓地把它拉进单元测试的模块图。 */
const realEntry = process.env.DSH_COMPUTER_USE_REAL_HOST_SCHEMASTERY;
const realModule = realEntry === undefined ? null : await import(pathToFileURL(realEntry).href);
const factory = realModule === null ? fakeFactory : (realModule.default ?? realModule);

export default factory;
