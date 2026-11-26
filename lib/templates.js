'use strict';

/**
 * 书库内容框架：书籍卡、读书笔记、书架看板。
 *
 * 约束：
 * - 只产出字符串，不读写 vault，方便单测（见 tests/library-harness.js）
 * - 模板只生成一次，生成后与插件脱钩，用户可自由修改
 * - 书籍卡放在「笔记目录/书目/」，不放进书库目录，避免被三格式规范化改写
 */

const { sanitizeFileName } = require('./text');

const DEFAULT_NOTES_ROOT = '20 笔记';
const CARD_SUBDIR = '书目';
const READING_SUBDIR = '读书笔记';
const SHELF_FILE = '00 书架.md';

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

function normalizeNotesRoot(notesRoot) {
  const root = String(notesRoot == null ? '' : notesRoot).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
  return root || DEFAULT_NOTES_ROOT;
}

function cardDir(notesRoot) {
  return `${normalizeNotesRoot(notesRoot)}/${CARD_SUBDIR}`;
}

function readingDir(notesRoot) {
  return `${normalizeNotesRoot(notesRoot)}/${READING_SUBDIR}`;
}

function bookCardPath(notesRoot, bookName) {
  return `${cardDir(notesRoot)}/${sanitizeFileName(bookName)}.md`;
}

function readingNotePath(notesRoot, bookName) {
  return `${readingDir(notesRoot)}/${sanitizeFileName(bookName)}.md`;
}

function shelfBoardPath(notesRoot) {
  return `${normalizeNotesRoot(notesRoot)}/${SHELF_FILE}`;
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
  lines.push('封面: ');
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

/** 书架看板：三个 Dataview 视图。未装 Dataview 时只是普通代码块，不会报错。 */
function shelfBoardTemplate(options) {
  const opts = options || {};
  const notesRoot = normalizeNotesRoot(opts.notesRoot);
  const from = cardDir(notesRoot);
  const date = opts.date || todayStamp();
  const fence = '```';
  const lines = [];

  lines.push('---');
  lines.push('aliases: []');
  lines.push('tags:');
  lines.push('  - 书/书架');
  lines.push('笔记类型: 索引');
  lines.push(`更新日期: ${date}`);
  lines.push('---');
  lines.push('');
  lines.push('# 书架');
  lines.push('');
  lines.push('> [!info] 这页是什么');
  lines.push('> 由「书库三格式同步」插件生成一次，之后归你自己维护。数据来自书籍卡的 frontmatter。');
  lines.push('');
  lines.push('> [!tip] 依赖说明');
  lines.push('> 下面三块查询需要社区插件 **Dataview**。没装的话它们只是普通代码块，不影响笔记本身。');
  lines.push('> 书籍卡目录：`' + from + '`');
  lines.push('');
  lines.push('## 在读');
  lines.push('');
  lines.push(fence + 'dataview');
  lines.push('TABLE 作者, 开始日期, 阅读进度');
  lines.push(`FROM "${from}"`);
  lines.push('WHERE 状态 = "在读"');
  lines.push('SORT 开始日期 DESC');
  lines.push(fence);
  lines.push('');
  lines.push('## 想读');
  lines.push('');
  lines.push(fence + 'dataview');
  lines.push('TABLE 作者, 体裁, 页数');
  lines.push(`FROM "${from}"`);
  lines.push('WHERE 状态 = "想读"');
  lines.push('SORT 页数 ASC');
  lines.push(fence);
  lines.push('');
  lines.push('## 已读');
  lines.push('');
  lines.push(fence + 'dataview');
  lines.push('TABLE 作者, 评分, 读完日期');
  lines.push(`FROM "${from}"`);
  lines.push('WHERE 状态 = "已读"');
  lines.push('SORT 评分 DESC');
  lines.push(fence);
  lines.push('');
  lines.push('## 统计');
  lines.push('');
  lines.push(fence + 'dataview');
  lines.push('TABLE length(rows) AS 本数, sum(rows.页数) AS 总页数');
  lines.push(`FROM "${from}"`);
  lines.push('WHERE 状态 = "已读"');
  lines.push('GROUP BY 体裁');
  lines.push(fence);
  lines.push('');
  lines.push('## 维护约定');
  lines.push('');
  lines.push('> [!warning] 别手工改查询结果');
  lines.push('> 这些表是实时查出来的。要加书就去建书籍卡，要改状态就改卡上的 `状态` 字段。');
  lines.push('');
  lines.push('%% 新增书籍卡：命令面板 →「新建书籍卡」。 %%');
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  DEFAULT_NOTES_ROOT,
  CARD_SUBDIR,
  READING_SUBDIR,
  SHELF_FILE,
  todayStamp,
  yamlValue,
  normalizeNotesRoot,
  cardDir,
  readingDir,
  bookCardPath,
  readingNotePath,
  shelfBoardPath,
  bookCardTemplate,
  readingNoteTemplate,
  shelfBoardTemplate,
};
