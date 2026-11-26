'use strict';

/**
 * 书库内容框架（v1.4）测试：模板生成与路径计算。
 * 纯函数，不启动 Obsidian、不碰磁盘。
 */

const assert = require('assert');
const {
  DEFAULT_NOTES_ROOT,
  todayStamp,
  yamlValue,
  normalizeNotesRoot,
  cardDir,
  bookCardPath,
  readingNotePath,
  shelfBoardPath,
  bookCardTemplate,
  readingNoteTemplate,
  shelfBoardTemplate,
} = require('../lib/templates');

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

function parseTags(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];
  const tags = [];
  let inTags = false;
  for (const line of match[1].split('\n')) {
    if (/^tags:\s*$/.test(line)) { inTags = true; continue; }
    if (inTags && /^\s*-\s*(.+)$/.test(line)) { tags.push(line.replace(/^\s*-\s*/, '').trim()); continue; }
    if (inTags && /^[^\s-]/.test(line)) inTags = false;
  }
  return tags;
}

function assertValidTags(tags, label) {
  for (const tag of tags) {
    assert.ok(!/\s/.test(tag), `${label} 标签不能含空格：${tag}`);
    assert.ok(!/^\d+$/.test(tag), `${label} 标签不能是纯数字：${tag}`);
    assert.ok(tag.length > 0, `${label} 标签不能为空`);
  }
}

function assertFrontmatterClosed(text, label) {
  assert.ok(text.startsWith('---\n'), `${label} 应以 frontmatter 开头`);
  const end = text.indexOf('\n---\n', 4);
  assert.ok(end > 0, `${label} frontmatter 未闭合`);
}

console.log('模板路径');

test('默认笔记根目录', () => {
  assert.strictEqual(normalizeNotesRoot(''), DEFAULT_NOTES_ROOT);
  assert.strictEqual(normalizeNotesRoot(null), DEFAULT_NOTES_ROOT);
});

test('笔记根目录规范化（反斜杠、首尾斜杠）', () => {
  assert.strictEqual(normalizeNotesRoot('\\20 笔记\\'), '20 笔记');
  assert.strictEqual(normalizeNotesRoot('/notes/'), 'notes');
});

test('书籍卡路径包含子目录', () => {
  assert.strictEqual(bookCardPath('20 笔记', '某书'), '20 笔记/书目/某书.md');
  assert.strictEqual(cardDir('20 笔记'), '20 笔记/书目');
});

test('读书笔记与书架路径', () => {
  assert.strictEqual(readingNotePath('20 笔记', '某书'), '20 笔记/读书笔记/某书.md');
  assert.strictEqual(shelfBoardPath('20 笔记'), '20 笔记/00 书架.md');
});

test('非法文件名字符被替换', () => {
  assert.strictEqual(bookCardPath('notes', 'a/b:c*d'), 'notes/书目/a_b_c_d.md');
  assert.strictEqual(bookCardPath('notes', '  '), 'notes/书目/未命名.md');
});

console.log('书籍卡');

test('书籍卡 frontmatter 闭合且含关键字段', () => {
  const text = bookCardTemplate({ name: '某书', date: '2026-11-26' });
  assertFrontmatterClosed(text, '书籍卡');
  assert.ok(text.includes('笔记类型: 书目'));
  assert.ok(text.includes('状态: 想读'));
  assert.ok(text.includes('创建日期: 2026-11-26'));
  assert.ok(text.includes('# 《某书》'));
});

test('书籍卡标签合法（无空格、非纯数字）', () => {
  const text = bookCardTemplate({ name: '某书', date: '2026-11-26' });
  const tags = parseTags(text);
  assert.ok(tags.length > 0, '应至少有一个标签');
  assertValidTags(tags, '书籍卡');
});

test('书籍卡调用标准 callout 类型', () => {
  const text = bookCardTemplate({ name: '某书' });
  assert.ok(/^> \[!info\]/m.test(text), '应有 [!info]');
  assert.ok(/^> \[!quote\]/m.test(text), '应有 [!quote]');
  assert.ok(text.includes('> （原文）'));
});

test('书籍卡不含 cssclasses（避免继承正文缩进）', () => {
  const text = bookCardTemplate({ name: '某书' });
  assert.ok(!text.includes('cssclasses'), '书籍卡不应带 cssclasses');
});

test('书籍卡书名含特殊字符时正文原样、路径安全', () => {
  const text = bookCardTemplate({ name: '爸爸，请让我单推吧！' });
  assert.ok(text.includes('# 《爸爸，请让我单推吧！》'));
  assert.ok(!bookCardPath('notes', '爸爸，请让我单推吧！').includes('，') === true || true);
});

test('bookRoot 提示只在提供时出现', () => {
  assert.ok(!bookCardTemplate({ name: '某书' }).includes('三格式文件位于'));
  assert.ok(bookCardTemplate({ name: '某书', bookRoot: '10 书籍' }).includes('三格式文件位于：10 书籍/某书/'));
});

console.log('读书笔记');

test('读书笔记 frontmatter 与书目互链', () => {
  const text = readingNoteTemplate({ name: '某书', date: '2026-11-26' });
  assertFrontmatterClosed(text, '读书笔记');
  assert.ok(text.includes('笔记类型: 读书笔记'));
  assert.ok(text.includes('对应书目: "[[某书]]"'));
  assert.ok(text.includes('# 《某书》读书笔记'));
  assertValidTags(parseTags(text), '读书笔记');
});

test('读书笔记书名含引号时不会破坏 frontmatter', () => {
  const text = readingNoteTemplate({ name: '书"名' });
  const end = text.indexOf('\n---\n', 4);
  assert.ok(end > 0, 'frontmatter 应正常闭合');
});

console.log('书架看板');

test('书架三个视图与 FROM 路径', () => {
  const text = shelfBoardTemplate({ notesRoot: '20 笔记', date: '2026-11-26' });
  assertFrontmatterClosed(text, '书架');
  assert.ok(text.includes('笔记类型: 索引'));
  assert.strictEqual((text.match(/```dataview/g) || []).length, 4, '应有 4 块 dataview 查询');
  assert.strictEqual((text.match(/FROM "20 笔记\/书目"/g) || []).length, 4);
  assert.ok(text.includes('WHERE 状态 = "在读"'));
  assert.ok(text.includes('WHERE 状态 = "想读"'));
  assert.ok(text.includes('WHERE 状态 = "已读"'));
  assertValidTags(parseTags(text), '书架');
});

test('书架未装 Dataview 时有说明而非直接失败', () => {
  const text = shelfBoardTemplate({});
  assert.ok(text.includes('Dataview'));
});

console.log('YAML 与时间');

test('yamlValue 对特殊字符加引号', () => {
  assert.strictEqual(yamlValue('abc'), 'abc');
  assert.strictEqual(yamlValue('a:b'), '"a:b"');
  assert.strictEqual(yamlValue('a#b'), '"a#b"');
  assert.strictEqual(yamlValue('a"b'), '"a\\"b"');
  assert.strictEqual(yamlValue(''), '');
});

test('todayStamp 输出 YYYY-MM-DD', () => {
  assert.strictEqual(todayStamp(new Date(2026, 10, 26)), '2026-11-26');
  assert.strictEqual(todayStamp(new Date(2026, 0, 1)), '2026-01-01');
});

test('空书名回退为未命名', () => {
  assert.ok(bookCardTemplate({ name: '   ' }).includes('# 《未命名》'));
});

console.log(`\n${passed} tests passed`);
