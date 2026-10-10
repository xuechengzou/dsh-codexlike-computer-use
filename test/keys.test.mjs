/**
 * 按键解析测试。
 *
 * 重点在扩展键标志与修饰键顺序：这两处错了都不会报错，只会让目标程序收到
 * 错误按键——例如 "Down" 丢掉扩展标志后会变成数字小键盘的 "2"。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalChordSpec, parseChord } from '../lib/keys.js';

/** 取出按下序列的虚拟键码。 */
const downKeys = (chord) => chord.down.map((step) => step.virtualKey);

test('命名键解析为正确的虚拟键码', () => {
	assert.deepEqual(downKeys(parseChord('Return')), [0x0d]);
	assert.deepEqual(downKeys(parseChord('enter')), [0x0d], '别名应大小写不敏感');
	assert.deepEqual(downKeys(parseChord('Escape')), [0x1b]);
	assert.deepEqual(downKeys(parseChord('Tab')), [0x09]);
	assert.deepEqual(downKeys(parseChord('Space')), [0x20]);
	assert.deepEqual(downKeys(parseChord('F5')), [0x74]);
	assert.deepEqual(downKeys(parseChord('F24')), [0x87]);
});

test('方向与编辑键带扩展标志', () => {
	for (const spec of ['Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Insert']) {
		const chord = parseChord(spec);
		assert.equal(chord.down[0].extended, true, `${spec} 必须带扩展键标志`);
	}
});

test('字母数字与普通符号不带扩展标志', () => {
	for (const spec of ['a', 'Z', '5', 'Return', 'Tab', 'F5', 'ctrl']) {
		const chord = parseChord(spec);
		assert.equal(chord.down[0].extended, false, `${spec} 不应带扩展键标志`);
	}
});

test('组合键按修饰键在前、抬起顺序相反下发', () => {
	const chord = parseChord('ctrl+shift+s');
	assert.deepEqual(downKeys(chord), [0x11, 0x10, 0x53]);
	assert.deepEqual(chord.up.map((step) => step.virtualKey), [0x53, 0x10, 0x11]);
	assert.equal(chord.label, 'ctrl+shift+s');
});

test('空白分隔与 + 分隔等价，且重复修饰键去重', () => {
	assert.deepEqual(downKeys(parseChord('alt Tab')), downKeys(parseChord('alt+Tab')));
	assert.deepEqual(downKeys(parseChord('ctrl+ctrl+c')), [0x11, 0x43]);
});

test('win/cmd/super 归一化为同一个修饰键', () => {
	for (const spec of ['win+s', 'cmd+s', 'super+s', 'meta+s']) {
		assert.deepEqual(downKeys(parseChord(spec)), [0x5b, 0x53], `${spec} 应映射到左 Win`);
	}
});

test('右 Win 被归一化为左 Win，避免不可用的组合', () => {
	const chord = parseChord('rwin+e');
	assert.deepEqual(chord.down.map((step) => step.virtualKey), [0x5b, 0x45]);
});

test('标点走美式布局虚拟键', () => {
	assert.deepEqual(downKeys(parseChord('slash')), [0xbf]);
	assert.deepEqual(downKeys(parseChord('?')), [0xbf]);
	assert.deepEqual(downKeys(parseChord('plus')), [0xbb]);
	assert.deepEqual(downKeys(parseChord('ctrl+plus')), [0x11, 0xbb]);
});

test('数字小键盘键单独命名', () => {
	assert.deepEqual(downKeys(parseChord('Numpad5')), [0x65]);
	assert.equal(parseChord('NumpadDivide').down[0].extended, true, '小键盘除号是扩展键');
});

test('无法识别的写法给出可纠正的错误', () => {
	assert.throws(() => parseChord('ControlAltDelete'), /无法识别按键/u);
	assert.throws(() => parseChord('   '), /不能为空/u);
	// 修饰键必须出现在主键之前
	assert.throws(() => parseChord('s+ctrl'), /不是修饰键/u);
	assert.throws(() => parseChord('a+b'), /不是修饰键/u);
});

test('错误信息里回显原始写法，便于模型自我纠正', () => {
	assert.throws(() => parseChord('ctrl+nope'), /ctrl\+nope/u);
});

test('修饰键可以单独作主键（hold_key 按住 shift 再点击是常见用法）', () => {
	assert.deepEqual(downKeys(parseChord('shift')), [0x10]);
	assert.deepEqual(downKeys(parseChord('control')), [0x11]);
	assert.deepEqual(downKeys(parseChord('Menu')), [0x12], 'Menu 是 Alt 的别名');
	assert.equal(parseChord('win').down[0].extended, true, 'Win 是扩展键');
});

test('拒绝名单的比对按虚拟键码归一，别名与标点写法都拦得住', () => {
	// 键名别名
	assert.equal(canonicalChordSpec('ctrl+alt+Delete'), canonicalChordSpec('Ctrl+Alt+del'));
	assert.equal(canonicalChordSpec('esc'), canonicalChordSpec('Escape'));
	assert.equal(canonicalChordSpec('enter'), canonicalChordSpec('Return'));
	// 同一个物理键的多种标点写法
	assert.equal(canonicalChordSpec('ctrl+plus'), canonicalChordSpec('ctrl+='));
	assert.equal(canonicalChordSpec('ctrl+colon'), canonicalChordSpec('ctrl+;'));
	// 修饰键顺序与重复
	assert.equal(canonicalChordSpec('alt+ctrl+delete'), canonicalChordSpec('ctrl+alt+ctrl+delete'));
	// 不同键不得被误判为同一个
	assert.notEqual(canonicalChordSpec('ctrl+Delete'), canonicalChordSpec('ctrl+Backspace'));
	assert.notEqual(canonicalChordSpec('ctrl+c'), canonicalChordSpec('c'));
	assert.notEqual(canonicalChordSpec('shift+Delete'), canonicalChordSpec('Delete'), '带修饰键与不带是两回事');
});

test('无法解析的名单项退化为名字比对，不抛错', () => {
	assert.equal(canonicalChordSpec('not-a-key'), '|not-a-key');
	assert.equal(canonicalChordSpec('ctrl+not-a-key'), 'vk17|not-a-key');
	assert.equal(canonicalChordSpec('   '), '');
});
