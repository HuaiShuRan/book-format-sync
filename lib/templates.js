'use strict';

/**
 * 书库内容框架：书籍卡、读书笔记、书架看板。
 *
 * 约束：
 * - 只产出字符串，不读写 vault，方便单测（见 tests/library-harness.js）
 * - 模板只生成一次，生成后与插件脱钩，用户可自由修改
 * - 书籍卡放在「笔记目录/书目/」，不放进书库目录，避免被三格式规范化改写
 * - 书架看板用 Obsidian 内置 Bases（.base），卡片视图 + 封面 + 看板视图，
 *   不依赖任何社区插件；`.md` 只是嵌入看板 + 使用说明的落地页
 */

const { sanitizeFileName } = require('./text');

const DEFAULT_NOTES_ROOT = '20 笔记';
const CARD_SUBDIR = '书目';
const READING_SUBDIR = '读书笔记';
const SHELF_FILE = '00 书架.base';
const SHELF_NOTE_FILE = '00 书架.md';

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

/** Bases 数据库文件（书架看板本体）。 */
function shelfBoardPath(notesRoot) {
  return `${normalizeNotesRoot(notesRoot)}/${SHELF_FILE}`;
}

/** 落地页笔记，嵌入上面的 .base 并写使用说明。 */
function shelfNotePath(notesRoot) {
  return `${normalizeNotesRoot(notesRoot)}/${SHELF_NOTE_FILE}`;
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

/**
 * 书架看板本体：Obsidian Bases 文件（.base）。
 *
 * 视图：卡片（带封面）/ 状态看板 / 在读 / 清单。
 * 卡片视图用 `image` 指定封面属性；看板视图按「状态」分列（Notion 风格）。
 */
function shelfBoardTemplate(options) {
  const opts = options || {};
  const from = cardDir(opts.notesRoot);
  const lines = [];

  lines.push('# 书架看板 —— Obsidian Bases 文件，可直接用 Obsidian 打开，也可编辑本文件');
  lines.push('filters:');
  lines.push('  and:');
  lines.push(`    - file.inFolder("${from}")`);
  lines.push('properties:');
  for (const [key, label] of [
    ['封面', '封面'],
    ['状态', '状态'],
    ['评分', '评分'],
    ['作者', '作者'],
    ['体裁', '体裁'],
  ]) {
    lines.push(`  ${key}:`);
    lines.push(`    displayName: ${label}`);
  }
  lines.push('views:');
  // 1. 卡片画廊（封面）
  lines.push('  - type: cards');
  lines.push('    name: 书架');
  lines.push('    image: 封面');
  lines.push('    imageFit: contain');
  lines.push('    imageAspectRatio: 0.72');
  lines.push('    cardSize: 220');
  lines.push('    order:');
  for (const col of ['file.name', '作者', '评分', '状态']) lines.push(`      - ${col}`);
  lines.push('    sort:');
  lines.push('      - property: 评分');
  lines.push('        direction: DESC');
  // 2. 状态看板（Notion 式分列）
  lines.push('  - type: kanban');
  lines.push('    name: 状态看板');
  lines.push('    groupBy:');
  lines.push('      property: 状态');
  lines.push('      direction: ASC');
  lines.push('    groupOrder:');
  for (const status of ['想读', '在读', '已读', '弃读']) lines.push(`      - ${status}`);
  // 3. 在读
  lines.push('  - type: cards');
  lines.push('    name: 在读');
  lines.push('    image: 封面');
  lines.push('    imageFit: contain');
  lines.push('    imageAspectRatio: 0.72');
  lines.push('    cardSize: 220');
  lines.push('    filters:');
  lines.push('      and:');
  lines.push('        - \'状态 == "在读"\'');
  lines.push('    order:');
  for (const col of ['file.name', '作者', '阅读进度']) lines.push(`      - ${col}`);
  // 4. 表格清单
  lines.push('  - type: table');
  lines.push('    name: 清单');
  lines.push('    order:');
  for (const col of ['file.name', '作者', '体裁', '页数', '评分', '状态', '开始日期', '读完日期']) {
    lines.push(`      - ${col}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 落地页：嵌入看板 + 使用说明。 */
function shelfNoteTemplate(options) {
  const opts = options || {};
  const notesRoot = normalizeNotesRoot(opts.notesRoot);
  const date = opts.date || todayStamp();
  const baseName = SHELF_FILE.replace(/\.base$/, '');
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
  lines.push(`![[${baseName}]]`);
  lines.push('');
  lines.push('> [!info] 这页是什么');
  lines.push('> 由「书库三格式同步」生成一次，之后归你自己维护。数据来自书籍卡的属性，实体是同一目录下的 `' + SHELF_FILE + '`。');
  lines.push('');
  lines.push('> [!tip] 怎么加一本书');
  lines.push('> 命令面板 →「新建书籍卡」→ 填书名。想让它出现在卡片上，就在书籍卡的 `封面` 属性里填图片链接，例如 `[[封面.jpg]]` 或 `![[cover.png]]`。');
  lines.push('');
  lines.push('> [!note] 视图说明');
  lines.push('> - **书架**：卡片画廊，有封面就显示封面');
  lines.push('> - **状态看板**：按 `状态` 分列，可拖拽改状态（Notion 看板效果）');
  lines.push('> - **在读** / **清单**：单列表格');
  lines.push(`> 书籍卡目录：\`${cardDir(notesRoot)}\``);
  lines.push('');
  lines.push(`%% 新增书籍卡：命令面板 →「新建书籍卡」。看板本身是 ${SHELF_FILE}，双击即可编辑视图。 %%`);
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  DEFAULT_NOTES_ROOT,
  CARD_SUBDIR,
  READING_SUBDIR,
  SHELF_FILE,
  SHELF_NOTE_FILE,
  todayStamp,
  yamlValue,
  normalizeNotesRoot,
  cardDir,
  readingDir,
  bookCardPath,
  readingNotePath,
  shelfBoardPath,
  shelfNotePath,
  bookCardTemplate,
  readingNoteTemplate,
  shelfBoardTemplate,
  shelfNoteTemplate,
};
