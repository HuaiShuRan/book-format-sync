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
  coverFileName,
  bookCardPath,
  readingNotePath,
  bookCardTemplate,
  readingNoteTemplate,
  shelfBoardTemplate,
} = require('../lib/templates');
const { buildEpub } = require('../lib/epub');
const { readZip } = require('../lib/zip');
const { normalizeBookProfile, migrateSettings, validateProfilePaths } = require('../lib/paths');
const { scaffoldPlan, dirNoteContent, recommendationMarkdown, isVaultEmpty } = require('../lib/scaffold');

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
  assert.strictEqual(coverValue('99 附件/某书/cover.jpg'), '"[[99 附件/某书/cover.jpg]]"');
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
  const text = bookCardTemplate({ name: '某书', cover: '99 附件/某书/cover.jpg' });
  assert.ok(text.includes('封面: "[[99 附件/某书/cover.jpg]]"'));
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

test('卡片尺寸与封面比例可配置', () => {
  const text = shelfBoardTemplate({ cardSize: 300, cardAspectRatio: 0.75 });
  assert.ok(text.includes('    cardSize: 300'));
  assert.ok(text.includes('    imageAspectRatio: 0.75'));
});

test('非法尺寸与比例回退默认值', () => {
  const text = shelfBoardTemplate({ cardSize: 'abc', cardAspectRatio: -1 });
  assert.ok(text.includes('    cardSize: 220'));
  assert.ok(text.includes('    imageAspectRatio: 0.72'));
});

test('多个卡片目录时用 or 过滤', () => {
  const text = shelfBoardTemplate({ cardDirs: ['20 笔记/书目', '20 笔记/某书卡'] });
  assert.ok(text.includes('  or:'));
  assert.ok(text.includes('file.inFolder("20 笔记/书目")'));
  assert.ok(text.includes('file.inFolder("20 笔记/某书卡")'));
  assert.ok(!text.includes('  and:'));
});

test('卡片目录去重', () => {
  const text = shelfBoardTemplate({ cardDirs: ['a', 'a', 'b'] });
  assert.strictEqual((text.match(/file\.inFolder\("a"\)/g) || []).length, 1);
  assert.strictEqual((text.match(/file\.inFolder\("b"\)/g) || []).length, 1);
});

console.log('封面命名');

test('有作者时生成《书名》-作者封面.ext', () => {
  assert.strictEqual(coverFileName('道德经', '老子', 'jpg'), '《道德经》-老子封面.jpg');
});

test('无作者时生成《书名》封面.ext', () => {
  assert.strictEqual(coverFileName('道德经', '', 'png'), '《道德经》封面.png');
  assert.strictEqual(coverFileName('道德经', '  ', '.PNG'), '《道德经》封面.png');
});

test('封面文件名中的非法字符被替换', () => {
  assert.strictEqual(coverFileName('a/b', 'c:d', 'png'), '《a_b》-c_d封面.png');
});

console.log('书级路径组');

test('书籍路径组保留 cardDir', () => {
  const entry = normalizeBookProfile({ bookName: '某书', cardDir: '20 笔记/某书卡' }, 0);
  assert.strictEqual(entry.cardDir, '20 笔记/某书卡');
});

test('未配置 cardDir 时为空（回退全局）', () => {
  const migrated = migrateSettings({ bookProfiles: [{ bookName: '某书' }] });
  assert.strictEqual(migrated.bookProfiles[0].cardDir, '');
});

test('cardDir 参与路径校验', () => {
  assert.throws(() => validateProfilePaths({ bookName: '某书', cardDir: 'C:/abs' }), /绝对路径/);
  assert.throws(() => validateProfilePaths({ bookName: '某书', cardDir: '../out' }), /\.\./);
  assert.doesNotThrow(() => validateProfilePaths({ bookName: '某书', cardDir: '20 笔记/某书卡' }));
});

console.log('书库结构（脚手架）');

test('默认配置生成推荐的六类目录', () => {
  const plan = scaffoldPlan({});
  const paths = plan.dirs.map((dir) => dir.path);
  assert.deepStrictEqual(paths, [
    '00 收件箱',
    '10 书籍',
    '20 笔记/书目',
    '20 笔记/读书笔记',
    '90 书架',
    '99 附件',
  ]);
  assert.strictEqual(plan.basePath, '90 书架/书架.base');
});

test('目录清单固定为推荐结构，不受当前设置影响', () => {
  const plan = scaffoldPlan({ bookRoot: '90 附件', shelfBasePath: '20 笔记/书架.base' });
  const paths = plan.dirs.map((dir) => dir.path);
  assert.ok(paths.includes('10 书籍'), '必须包含 10 书籍');
  assert.ok(paths.includes('90 书架'), '必须包含 90 书架');
  assert.strictEqual(plan.settings.bookRoot, '10 书籍');
  assert.strictEqual(plan.settings.cardDir, '20 笔记/书目');
  assert.strictEqual(plan.settings.readingNoteDir, '20 笔记/读书笔记');
  assert.strictEqual(plan.settings.shelfBasePath, '90 书架/书架.base');
});

test('目录清单无重复', () => {
  const plan = scaffoldPlan();
  const paths = plan.dirs.map((dir) => dir.path);
  assert.strictEqual(new Set(paths).size, paths.length, '不应出现重复目录');
  assert.strictEqual(paths.length, 6);
});

test('每个目录都有说明文案', () => {
  const plan = scaffoldPlan({});
  for (const dir of plan.dirs) {
    assert.ok(dir.desc && dir.desc.length > 4, `${dir.path} 缺少说明`);
  }
});

test('目录说明文件可生成且标注可删', () => {
  const text = dirNoteContent('10 书籍', '三格式产物的家。');
  assert.ok(text.includes('# 目录说明：10 书籍'));
  assert.ok(text.includes('三格式产物的家。'));
  assert.ok(text.includes('可以删除'));
});

test('已有内容时的建议文档包含结构、设置对照与三种走法', () => {
  const text = recommendationMarkdown({
    current: {
      bookRoot: '90 附件',
      cardDir: '20 笔记/书目',
      readingNoteDir: '20 笔记/读书笔记',
      shelfBasePath: '20 笔记/书架.base',
    },
    date: '2026-11-27',
  });
  assert.ok(text.startsWith('---\n'));
  assert.ok(text.includes('书库结构建议'));
  assert.ok(text.includes('没有改动任何文件'), '应说明未改动现有文件');
  assert.ok(text.includes('`90 附件`'), '应显示当前值');
  assert.ok(text.includes('`10 书籍`'), '应显示推荐值');
  assert.ok(text.includes('手动搬家'));
  assert.ok(text.includes('零移动'));
  assert.ok(text.includes('渐进'));
  assert.ok(text.includes('更新日期: 2026-11-27'));
});

console.log('vault 空判定');

test('只有系统目录时算空', () => {
  assert.strictEqual(isVaultEmpty([]), true);
  assert.strictEqual(isVaultEmpty(['.obsidian', '.trash', '.git', '.book-format-sync']), true);
});

test('任意用户文件夹或文件都算非空', () => {
  assert.strictEqual(isVaultEmpty(['.obsidian', '20 笔记']), false);
  assert.strictEqual(isVaultEmpty(['说明.md']), false);
  assert.strictEqual(isVaultEmpty(['.obsidian', '00 收件箱']), false);
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
