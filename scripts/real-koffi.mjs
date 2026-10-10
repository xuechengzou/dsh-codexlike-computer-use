/**
 * 真实 koffi 入口路径的解析。
 *
 * **路径绝不能写死在脚本里。** 写死有两个后果，都很糟：
 *   1. 把作者机器的用户名带进版本库（隐私泄漏）；
 *   2. 在别人的机器上必然失效，而症状是"原生调用全部失败"这种看不出所以然的样子。
 *
 * 因此统一从环境变量取；缺失时打印**可执行的获取方式**再退出，而不是让下游拿着
 * undefined 去崩在某个难以定位的地方。
 */

/** 环境变量名。README 里也是用它。 */
export const REAL_KOFFI_ENV = 'DSH_COMPUTER_USE_REAL_KOFFI';

/**
 * 校验并返回真实 koffi 的入口路径；缺失时打印指引并退出。
 *
 * 用法：在脚本顶部（任何 `await import('koffi')` 之前）调用一次即可。
 */
export function requireRealKoffi() {
	const entry = process.env[REAL_KOFFI_ENV];
	if (entry === undefined || entry === '') {
		console.error(`缺少环境变量 ${REAL_KOFFI_ENV}：它应当指向宿主安装里的真实 koffi 入口。`);
		console.error('先取得路径（在宿主安装目录下执行）：');
		console.error('  node -e "console.log(require.resolve(\'koffi\'))"');
		console.error('然后设置它，例如：');
		console.error(`  $env:${REAL_KOFFI_ENV}="C:\\...\\node_modules\\koffi\\index.js"`);
		console.error('（node_modules 里的 koffi 是替身联接 → test/doubles/koffi/，不是真实原生模块；）');
		console.error('（联接由 scripts/link-doubles.mjs 建立，替身真身在 test/doubles/。）');
		process.exit(2);
	}
	return entry;
}
