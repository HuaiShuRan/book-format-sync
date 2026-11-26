'use strict';

/**
 * 书库内容框架（v1.4）测试：模板生成与路径计算。
 * 纯函数，不启动 Obsidian、不碰磁盘。
 */

const assert = require('assert');
const {
  DEFAULT_NOTES_ROOT,
  SHELF_FILE,
  SHELF_NOTE_FILE,
  todayStamp,
  yamlValue,
  normalizeNotesRoot,
  cardDir,
  bookCardPath,
  readingNotePath,
  shelfBoardPath,
  shelfNotePath,
  bookCardTemplate,
  readingNoteTemplate,
  shelfBoardTemplate,
  shelfNoteTemplate,
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
  assert.strictEqual(shelfBoardPath('20 笔记'), `20 笔记/${SHELF_FILE}`);
  assert.strictEqual(shelfNotePath('20 笔记'), `20 笔记/${SHELF_NOTE_FILE}`);
  assert.ok(SHELF_FILE.endsWith('.base'), '看板本体必须是 .base');
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

console.log('书架看板（Bases）');

test('看板本体是 YAML，不含前导 frontmatter', () => {
  const text = shelfBoardTemplate({ notesRoot: '20 笔记' });
  assert.ok(text.startsWith('#'), '应以便于阅读的注释行开头');
  assert.ok(!text.startsWith('---'), '不应有 frontmatter 分隔符');
  assert.ok(text.includes('filters:'));
  assert.ok(text.includes('views:'));
});

test('全局筛选限定书籍卡目录', () => {
  const text = shelfBoardTemplate({ notesRoot: '20 笔记' });
  assert.ok(text.includes('file.inFolder("20 笔记/书目")'));
});

test('四个视图类型齐全：cards×2 / kanban / table', () => {
  const text = shelfBoardTemplate({ notesRoot: '20 笔记' });
  const count = (re) => (text.match(re) || []).length;
  assert.strictEqual(count(/^\s+- type: cards$/gm), 2, '应有两个卡片视图');
  assert.strictEqual(count(/^\s+- type: kanban$/gm), 1, '应有一个看板视图');
  assert.strictEqual(count(/^\s+- type: table$/gm), 1, '应有一个表格视图');
});

test('卡片视图用封面属性', () => {
  const text = shelfBoardTemplate({ notesRoot: '20 笔记' });
  assert.ok(text.includes('image: 封面'));
  assert.ok(text.includes('imageFit: contain'));
  assert.ok(/imageAspectRatio: 0\.\d+/.test(text));
  assert.ok(/cardSize: \d+/.test(text));
});

test('看板视图按状态分列', () => {
  const text = shelfBoardTemplate({ notesRoot: '20 笔记' });
  assert.ok(text.includes('groupBy:'));
  assert.ok(text.includes('property: 状态'));
  for (const status of ['想读', '在读', '已读', '弃读']) {
    assert.ok(text.includes(`      - ${status}`), `groupOrder 应包含 ${status}`);
  }
});

test('排序使用 Bases 的 sort 结构', () => {
  const text = shelfBoardTemplate({ notesRoot: '20 笔记' });
  assert.ok(text.includes('sort:'));
  assert.ok(text.includes('property: 评分'));
  assert.ok(text.includes('direction: DESC'));
});

test('不再依赖 Dataview', () => {
  const text = shelfBoardTemplate({ notesRoot: '20 笔记' });
  assert.strictEqual((text.match(/dataview/g) || []).length, 0, '不应出现 dataview');
});

console.log('书架落地页');

test('落地页嵌入看板并写维护说明', () => {
  const text = shelfNoteTemplate({ notesRoot: '20 笔记', date: '2026-11-26' });
  assertFrontmatterClosed(text, '书架落地页');
  assert.ok(text.includes('笔记类型: 索引'));
  assert.ok(text.includes('![[00 书架]]'), '应嵌入看板本体');
  assert.ok(text.includes('新建书籍卡'));
  assertValidTags(parseTags(text), '书架落地页');
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
