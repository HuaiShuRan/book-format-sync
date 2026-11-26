'use strict';

/**
 * 书库内容框架（v1.4）测试：模板生成与路径计算。
 * 纯函数，不启动 Obsidian、不碰磁盘。
 */

const assert = require('assert');
const {
  DEFAULT_CARD_DIR,
  DEFAULT_READING_DIR,
  DEFAULT_SHELF_BASE,
  todayStamp,
  yamlValue,
  coverValue,
  normalizeDir,
  normalizeShelfBase,
  bookCardPath,
  readingNotePath,
  bookCardTemplate,
  readingNoteTemplate,
  shelfBoardTemplate,
} = require('../lib/templates');
const { buildEpub } = require('../lib/epub');
const { readZip } = require('../lib/zip');

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

console.log('路径与规范化');

test('目录规范化：反斜杠、首尾斜杠、空值回退', () => {
  assert.strictEqual(normalizeDir('\\20 笔记\\书目\\'), '20 笔记/书目');
  assert.strictEqual(normalizeDir('/notes/', 'x'), 'notes');
  assert.strictEqual(normalizeDir('', DEFAULT_CARD_DIR), DEFAULT_CARD_DIR);
  assert.strictEqual(normalizeDir(null, 'fallback'), 'fallback');
});

test('书架 Base 路径强制 .base 后缀', () => {
  assert.strictEqual(normalizeShelfBase('20 笔记/书架', DEFAULT_SHELF_BASE), '20 笔记/书架.base');
  assert.strictEqual(normalizeShelfBase('20 笔记/书架.base'), '20 笔记/书架.base');
  assert.strictEqual(normalizeShelfBase('', DEFAULT_SHELF_BASE), DEFAULT_SHELF_BASE);
});

test('书籍卡路径跟随卡片目录', () => {
  assert.strictEqual(bookCardPath('20 笔记/书目', '某书'), '20 笔记/书目/某书.md');
  assert.strictEqual(bookCardPath('自定义/卡片', '某书'), '自定义/卡片/某书.md');
  assert.strictEqual(bookCardPath('', '某书'), `${DEFAULT_CARD_DIR}/某书.md`);
});

test('读书笔记路径跟随笔记目录', () => {
  assert.strictEqual(readingNotePath('20 笔记/读书笔记', '某书'), '20 笔记/读书笔记/某书.md');
  assert.strictEqual(readingNotePath('', '某书'), `${DEFAULT_READING_DIR}/某书.md`);
});

test('非法文件名字符被替换', () => {
  assert.strictEqual(bookCardPath('notes', 'a/b:c*d'), 'notes/a_b_c_d.md');
  assert.strictEqual(bookCardPath('notes', '  '), 'notes/未命名.md');
});

console.log('封面取值');

test('vault 路径转成 wikilink', () => {
  assert.strictEqual(coverValue('90 附件/某书/cover.jpg'), '"[[90 附件/某书/cover.jpg]]"');
  assert.strictEqual(coverValue('[[cover.jpg]]'), '"[[cover.jpg]]"');
  assert.strictEqual(coverValue('![[cover.jpg|300]]'), '"[[cover.jpg]]"');
});

test('http 地址原样保留', () => {
  assert.strictEqual(coverValue('https://example.com/a.png'), '"https://example.com/a.png"');
  assert.strictEqual(coverValue('http://example.com/a.png'), '"http://example.com/a.png"');
});

test('空封面写空值', () => {
  assert.strictEqual(coverValue(''), ' ');
  assert.strictEqual(coverValue(null), ' ');
});

console.log('书籍卡');

test('frontmatter 闭合且含关键字段', () => {
  const text = bookCardTemplate({ name: '某书', date: '2026-11-26' });
  assertFrontmatterClosed(text, '书籍卡');
  assert.ok(text.includes('笔记类型: 书目'));
  assert.ok(text.includes('状态: 想读'));
  assert.ok(text.includes('创建日期: 2026-11-26'));
  assert.ok(text.includes('# 《某书》'));
});

test('封面写入 frontmatter', () => {
  const text = bookCardTemplate({ name: '某书', cover: '90 附件/某书/cover.jpg' });
  assert.ok(text.includes('封面: "[[90 附件/某书/cover.jpg]]"'));
});

test('无封面时字段留空', () => {
  const text = bookCardTemplate({ name: '某书' });
  assert.ok(/^封面: *$/m.test(text), '封面应为空');
});

test('标签合法（无空格、非纯数字）', () => {
  assertValidTags(parseTags(bookCardTemplate({ name: '某书' })), '书籍卡');
});

test('只用标准 callout 类型', () => {
  const text = bookCardTemplate({ name: '某书' });
  assert.ok(/^> \[!info\]/m.test(text));
  assert.ok(/^> \[!quote\]/m.test(text));
});

test('不写 cssclasses（避免继承正文缩进）', () => {
  assert.ok(!bookCardTemplate({ name: '某书' }).includes('cssclasses'));
});

test('书名含特殊字符时正文原样', () => {
  assert.ok(bookCardTemplate({ name: '爸爸，请让我单推吧！' }).includes('# 《爸爸，请让我单推吧！》'));
});

test('bookRoot 提示只在提供时出现', () => {
  assert.ok(!bookCardTemplate({ name: '某书' }).includes('三格式文件位于'));
  assert.ok(bookCardTemplate({ name: '某书', bookRoot: '10 书籍' }).includes('三格式文件位于：10 书籍/某书/'));
});

console.log('读书笔记');

test('frontmatter 与书目互链', () => {
  const text = readingNoteTemplate({ name: '某书', date: '2026-11-26' });
  assertFrontmatterClosed(text, '读书笔记');
  assert.ok(text.includes('笔记类型: 读书笔记'));
  assert.ok(text.includes('对应书目: "[[某书]]"'));
  assert.ok(text.includes('# 《某书》读书笔记'));
  assertValidTags(parseTags(text), '读书笔记');
});

test('书名含引号时不破坏 frontmatter', () => {
  const text = readingNoteTemplate({ name: '书"名' });
  assert.ok(text.indexOf('\n---\n', 4) > 0);
});

console.log('书架 Base');

test('是 YAML 而非 frontmatter 笔记', () => {
  const text = shelfBoardTemplate({ cardDir: '20 笔记/书目' });
  assert.ok(text.startsWith('#'), '应以注释行开头');
  assert.ok(!text.startsWith('---'), '不应带 frontmatter');
  assert.ok(text.includes('filters:'));
  assert.ok(text.includes('views:'));
});

test('数据源跟随卡片目录', () => {
  assert.ok(shelfBoardTemplate({ cardDir: '20 笔记/书目' }).includes('file.inFolder("20 笔记/书目")'));
  assert.ok(shelfBoardTemplate({ cardDir: '自定义/卡片' }).includes('file.inFolder("自定义/卡片")'));
  assert.ok(shelfBoardTemplate({}).includes(DEFAULT_CARD_DIR));
});

test('卡片视图带封面与卡片尺寸', () => {
  const text = shelfBoardTemplate({});
  assert.ok(text.includes('- type: cards'));
  assert.ok(text.includes('image: 封面'));
  assert.ok(text.includes('imageFit: contain'));
  assert.ok(/imageAspectRatio: 0\.\d+/.test(text));
  assert.ok(/cardSize: \d+/.test(text));
});

test('含表格清单视图', () => {
  const text = shelfBoardTemplate({});
  assert.ok(text.includes('- type: table'));
  assert.ok(text.includes('name: 清单'));
  assert.ok(!text.includes('- type: kanban'), '书架形式不需要看板视图');
});

test('不依赖 Dataview', () => {
  assert.strictEqual((shelfBoardTemplate({}).match(/dataview/g) || []).length, 0);
});

console.log('EPUB 封面');

function sampleBook() {
  return {
    bookName: '某书',
    language: 'zh-CN',
    author: '',
    preamble: '',
    chapters: [
      { number: 1, title: '第1章', normalizedTitle: '第1章', plainParagraphs: ['正文一段。'] },
    ],
  };
}

test('无封面时不写 cover 条目', () => {
  const zip = readZip(buildEpub(sampleBook(), { bookName: '某书' }));
  assert.ok(!zip.names.some((name) => name.startsWith('OEBPS/cover.')));
  const opf = zip.get('OEBPS/content.opf').toString('utf8');
  assert.ok(!opf.includes('properties="cover-image"'));
});

test('有封面时写入图片、OPF 条目与 meta cover', () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const zip = readZip(buildEpub(sampleBook(), {
    bookName: '某书',
    cover: { data: jpg, ext: 'jpg', mediaType: 'image/jpeg' },
  }));
  assert.ok(zip.names.includes('OEBPS/cover.jpg'), '应写入封面图片');
  assert.deepStrictEqual(Buffer.from(zip.get('OEBPS/cover.jpg')), jpg, '封面字节应一致');
  const opf = zip.get('OEBPS/content.opf').toString('utf8');
  assert.ok(opf.includes('properties="cover-image"'));
  assert.ok(opf.includes('media-type="image/jpeg"'));
  assert.ok(opf.includes('<meta name="cover" content="cover-image"/>'));
  assert.strictEqual(
    zip.names.filter((name) => /^OEBPS\/chapter-\d+\.xhtml$/.test(name)).length,
    1,
    '封面不应增加章节文件',
  );
});

test('封面用 png 时写入正确扩展名与类型', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const zip = readZip(buildEpub(sampleBook(), {
    bookName: '某书',
    cover: { data: png, ext: 'png', mediaType: 'image/png' },
  }));
  assert.ok(zip.names.includes('OEBPS/cover.png'));
  assert.ok(zip.get('OEBPS/content.opf').toString('utf8').includes('media-type="image/png"'));
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
