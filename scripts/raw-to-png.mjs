/**
 * 把探针导出的 BGRA 原始位图转成 PNG，供人眼核对。
 *
 * 存在的意义：像素统计只能说明"图里有内容"，不能说明"内容就是这个窗口"。
 * 黑图失败的形态很容易被统计误判成成功（例如抓到的是桌面壁纸而不是目标窗口），
 * 唯一的判据是亲眼看一遍。
 *
 * 用法：node scripts/raw-to-png.mjs <input.raw> <width> <height> [output.png]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { bgraToRgb, encodePng } from '../lib/png.js';

const [input, widthArg, heightArg, outputArg] = process.argv.slice(2);
if (input === undefined || widthArg === undefined || heightArg === undefined) {
	console.error('用法: node scripts/raw-to-png.mjs <input.raw> <width> <height> [output.png]');
	process.exit(2);
}

const width = Number(widthArg);
const height = Number(heightArg);
const output = outputArg ?? join(dirname(resolve(input)), `${basename(input, '.raw')}.png`);

const bgra = readFileSync(input);
const expected = width * height * 4;
if (bgra.length !== expected) {
	console.error(`尺寸不符：文件 ${bgra.length} 字节，期望 ${expected}（${width}x${height} BGRA）`);
	process.exit(1);
}

writeFileSync(output, encodePng(bgraToRgb(new Uint8Array(bgra), width, height), width, height, 6));
console.log(`已写出 ${output}（${width}x${height}）`);
