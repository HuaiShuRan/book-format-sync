'use strict';

/**
 * 书库内容框架：书籍卡、读书笔记、书架 Base。
 *
 * 约束：
 * - 只产出字符串，不读写 vault，方便单测（见 tests/library-harness.js）
 * - 模板只生成一次，生成后与插件脱钩，用户可自由修改
 * - 书籍卡放在「卡片目录」，不放进书库目录，避免被三格式规范化改写
 * - 书架用 Obsidian 内置 Bases（.base），卡片视图 + 封面，不依赖社区插件
 */

const { sanitizeFileName } = require('./text');

const DEFAULT_CARD_DIR = '20 笔记/书目';
const DEFAULT_READING_DIR = '20 笔记/读书笔记';
const DEFAULT_SHELF_BASE = '20 笔记/书架.base';

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地时区的 YYYY-MM-DD。 */
function todayStamp(date) {
  const d = date instanceof Date ? date : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** YAML 标量：必要时加双引号，避免 `:`、`#`、引号破坏 frontmatter。 */
function yamlValue(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (/[:#\[\]{}|>&*!%@,`"']/.test(text) || /^[-?\s]/.test(text)) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return text;
}

/** vault 内相对目录：去掉首尾斜杠、统一正斜杠；空值回退默认。 */
function normalizeDir(value, fallback) {
  const raw = String(value == null ? '' : value).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
  return raw || fallback;
}

/** 书架 Base 路径：强制 .base 后缀，空值回退默认。 */
function normalizeShelfBase(value, fallback) {
  const raw = normalizeDir(value, fallback || DEFAULT_SHELF_BASE);
  return /\.base$/i.test(raw) ? raw : `${raw}.base`;
}

function bookCardPath(cardDir, bookName) {
  return `${normalizeDir(cardDir, DEFAULT_CARD_DIR)}/${sanitizeFileName(bookName)}.md`;
}

function readingNotePath(readingDir, bookName) {
  return `${normalizeDir(readingDir, DEFAULT_READING_DIR)}/${sanitizeFileName(bookName)}.md`;
}

/** 封面：vault 内路径写成 wikilink，http(s) 原样保留。 */
function coverValue(cover) {
  const text = String(cover == null ? '' : cover).trim();
  if (!text) return ' ';
  if (/^https?:\/\//i.test(text)) return `"${text.replace(/"/g, '')}"`;
  const cleaned = text.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('|')[0].trim();
  if (!cleaned) return ' ';
  return `"[[${cleaned}]]"`;
}

/** 封面重命名规则：《书名》-作者封面.ext；无作者时《书名》封面.ext。 */
function coverFileName(bookName, author, ext) {
  const name = String(bookName == null ? '' : bookName).trim() || '未命名';
  const who = String(author == null ? '' : author).trim();
  const suffix = String(ext == null ? 'png' : ext).replace(/^\./, '').toLowerCase() || 'png';
  const base = who ? `《${name}》-${who}封面` : `《${name}》封面`;
  return `${sanitizeFileName(base)}.${suffix}`;
}

/** 书籍卡：一本书一篇，承载元数据与摘录。 */
function bookCardTemplate(options) {
  const opts = options || {};
  const name = String(opts.name == null ? '' : opts.name).trim() || '未命名';
  const date = opts.date || todayStamp();
  const bookRoot = String(opts.bookRoot == null ? '' : opts.bookRoot).trim();
  const lines = [];

  lines.push('---');
  lines.push('aliases: []');
  lines.push('tags:');
  lines.push('  - 书/未分类');
  lines.push('笔记类型: 书目');
  lines.push('状态: 想读');
  lines.push('评分: ');
  lines.push(`作者: ${yamlValue(opts.author)}`);
  lines.push('译者: ');
  lines.push('出版年: ');
  lines.push('页数: ');
  lines.push('体裁: ');
  lines.push('内容: ');
  lines.push(`格式: ${yamlValue(opts.format)}`);
  lines.push(`创建日期: ${date}`);
  lines.push('开始日期: ');
  lines.push('读完日期: ');
  lines.push('阅读进度: ');
  lines.push(`封面: ${coverValue(opts.cover)}`);
  lines.push('---');
  lines.push('');
  lines.push(`# 《${name}》`);
  lines.push('');
  lines.push('> [!info] 一句话');
  lines.push('> （填写：这本书讲什么、为什么值得读。）');
  lines.push('');
  lines.push('## 我为什么读它');
  lines.push('');
  lines.push('%% 记下当时的动机。以后回看能判断这本书到底有没有解决你的问题。 %%');
  lines.push('');
  lines.push('## 用自己的话概括');
  lines.push('');
  lines.push('%% 能用自己的话讲清主线才算读进去。抄目录没有意义。 %%');
  lines.push('');
  lines.push('## 摘录');
  lines.push('');
  lines.push('%% 一条摘录 = 引用 + 一句自己的想法。想被别的笔记精确引用时，可给摘录加块 ID：^quote-1 %%');
  lines.push('');
  lines.push('> [!quote] 第 X 章');
  lines.push('> （原文）');
  lines.push('>');
  lines.push('> —— 想法：');
  lines.push('');
  lines.push('## 延伸');
  lines.push('');
  lines.push('- [[（相关概念卡片）]]');
  lines.push('- [[（同主题的另一本书）]]');
  if (bookRoot) {
    lines.push('');
    lines.push('%% 三格式文件位于：' + bookRoot + '/' + name + '/ %%');
  }
  lines.push('');
  return lines.join('\n');
}

/** 读书笔记：只有需要深挖的书才建。 */
function readingNoteTemplate(options) {
  const opts = options || {};
  const name = String(opts.name == null ? '' : opts.name).trim() || '未命名';
  const date = opts.date || todayStamp();
  const lines = [];

  lines.push('---');
  lines.push('aliases: []');
  lines.push('tags:');
  lines.push('  - 书/读书笔记');
  lines.push('笔记类型: 读书笔记');
  lines.push('状态: 在读');
  lines.push(`对应书目: "[[${name.replace(/"/g, '')}]]"`);
  lines.push(`创建日期: ${date}`);
  lines.push('---');
  lines.push('');
  lines.push(`# 《${name}》读书笔记`);
  lines.push('');
  lines.push('> [!abstract] 核心结论');
  lines.push('> （填写：三五句话概括这本书最有价值的部分。）');
  lines.push('');
  lines.push('## 逐章笔记');
  lines.push('');
  lines.push('### 第 X 章 （填写：章节名）');
  lines.push('');
  lines.push('- **要点**：（填写）');
  lines.push('- **我的疑问**：（填写）');
  lines.push('- **可以怎么用**：（填写）');
  lines.push('');
  lines.push('## 与其它书的对照');
  lines.push('');
  lines.push('| 议题 | 本书观点 | 其它书观点（[[书名]]） |');
  lines.push('|---|---|---|');
  lines.push('| （填写） | （填写） | （填写） |');
  lines.push('');
  lines.push('## 可落地的行动');
  lines.push('');
  lines.push('- [ ] （填写：读完准备改变的一件事）');
  lines.push('');
  return lines.join('\n');
}

/**
 * 书架 Base（.base）：数据源 = 设置里的卡片目录。
 * 视图：卡片书架（带封面）+ 表格清单。
 */
function shelfBoardTemplate(options) {
  const opts = options || {};
  const rawDirs = Array.isArray(opts.cardDirs) && opts.cardDirs.length
    ? opts.cardDirs
    : [opts.cardDir];
  const dirs = Array.from(new Set(
    rawDirs.map((dir) => normalizeDir(dir, DEFAULT_CARD_DIR)).filter(Boolean),
  ));
  const from = dirs[0] || DEFAULT_CARD_DIR;
  const sizeRaw = Number(opts.cardSize);
  const cardSize = Number.isFinite(sizeRaw) && sizeRaw >= 80 ? Math.round(sizeRaw) : 220;
  const ratioRaw = Number(opts.cardAspectRatio);
  const aspectRatio = Number.isFinite(ratioRaw) && ratioRaw > 0.2 && ratioRaw < 3 ? ratioRaw : 0.72;
  const lines = [];

  lines.push('# 书架 —— Obsidian Bases 文件；数据来自书籍卡目录，可直接编辑视图');
  lines.push('filters:');
  if (dirs.length > 1) {
    lines.push('  or:');
    for (const dir of dirs) lines.push(`    - file.inFolder("${dir}")`);
  } else {
    lines.push('  and:');
    lines.push(`    - file.inFolder("${from}")`);
  }
  lines.push('properties:');
  for (const key of ['封面', '状态', '评分', '作者', '体裁']) {
    lines.push(`  ${key}:`);
    lines.push(`    displayName: ${key}`);
  }
  lines.push('views:');
  lines.push('  - type: cards');
  lines.push('    name: 书架');
  lines.push('    image: 封面');
  lines.push('    imageFit: contain');
  lines.push(`    imageAspectRatio: ${aspectRatio}`);
  lines.push(`    cardSize: ${cardSize}`);
  lines.push('    order:');
  for (const col of ['file.name', '作者', '评分', '状态']) lines.push(`      - ${col}`);
  lines.push('    sort:');
  lines.push('      - property: 评分');
  lines.push('        direction: DESC');
  lines.push('  - type: table');
  lines.push('    name: 清单');
  lines.push('    order:');
  for (const col of ['file.name', '作者', '体裁', '页数', '评分', '状态', '开始日期', '读完日期']) {
    lines.push(`      - ${col}`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
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
};
