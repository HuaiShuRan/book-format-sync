'use strict';

/**
 * 书库目录结构（脚手架）：只计算目录清单与说明文案，不做任何 IO。
 *
 * 结构（方案 A：按类型分层 + 每本书一个目录）：
 *   00 收件箱/            临时落地
 *   <书库目录>/<书名>/     三格式 + 封面（一本书一个目录）
 *   <卡片目录>/            书籍卡（书架 Base 的数据源）
 *   <读书笔记目录>/        读书笔记
 *   <Base 所在目录>/       书架 Base
 *   90 附件/              跨书共享附件
 */

const { normalizeDir, normalizeShelfBase } = require('./templates');

const INBOX_DIR = '00 收件箱';
const SHARED_ATTACH_DIR = '90 附件';
const DIR_NOTE_FILE = '_目录说明.md';
const RECOMMENDATION_FILE = '书库结构建议.md';

/** 判断 vault 是否为空时忽略的系统目录。 */
const SYSTEM_DIRS = new Set(['.obsidian', '.trash', '.git', '.book-format-sync']);

/**
 * vault 顶层名字列表是否算「空」。
 * 只有系统目录（.obsidian 等）时仍算空；出现任何用户文件夹或文件都算有内容。
 */
function isVaultEmpty(names) {
  const list = Array.isArray(names) ? names : [];
  return !list.some((name) => {
    const clean = String(name == null ? '' : name).trim();
    if (!clean) return false;
    return !SYSTEM_DIRS.has(clean.toLowerCase());
  });
}

function posixDirname(value) {
  const text = String(value == null ? '' : value).replace(/\\/g, '/');
  const index = text.lastIndexOf('/');
  return index < 0 ? '' : text.slice(0, index);
}

/** 目录说明文件内容。 */
function dirNoteContent(path, desc) {
  return [
    `# 目录说明：${path}`,
    '',
    desc || '（填写：这个目录放什么）',
    '',
    '> 本文件由「书库」插件生成，用于让 Obsidian 显示空目录；可以删除。',
    '',
  ].join('\n');
}

/**
 * 计算需要创建的目录清单。
 * 返回 { dirs: [{path, desc}], basePath }，已去重、已剔除空路径。
 */
function scaffoldPlan(options) {
  const opts = options || {};
  const bookRoot = normalizeDir(opts.bookRoot, '10 书籍');
  const cardDir = normalizeDir(opts.cardDir, '20 笔记/书目');
  const readingDir = normalizeDir(opts.readingNoteDir, '20 笔记/读书笔记');
  const basePath = normalizeShelfBase(opts.shelfBasePath, '90 书架/书架.base');
  const baseDir = posixDirname(basePath);

  const candidates = [
    { path: INBOX_DIR, desc: '临时落地：还没归类的书、导入的原始文件。' },
    { path: bookRoot, desc: '三格式产物的家。一本书一个目录，含 md / txt / epub 与封面。' },
    { path: cardDir, desc: '书籍卡：一本书一张卡，书架 Base 的数据源。' },
    { path: readingDir, desc: '读书笔记：需要深挖的书才建。' },
    { path: baseDir, desc: '索引与看板：书架 Base 存放在这里。' },
    { path: SHARED_ATTACH_DIR, desc: '跨书共享的附件：图例、插图、模板截图。' },
  ];

  const seen = new Set();
  const dirs = [];
  for (const item of candidates) {
    const path = String(item.path || '').replace(/^\/+|\/+$/g, '');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    dirs.push({ path, desc: item.desc });
  }

  return { dirs, basePath };
}

/** 书库已有内容时生成的建议文档。 */
function recommendationMarkdown(options) {
  const opts = options || {};
  const bookRoot = normalizeDir(opts.bookRoot, '10 书籍');
  const cardDir = normalizeDir(opts.cardDir, '20 笔记/书目');
  const readingDir = normalizeDir(opts.readingNoteDir, '20 笔记/读书笔记');
  const basePath = normalizeShelfBase(opts.shelfBasePath, '90 书架/书架.base');
  const stamp = opts.date || '';

  return [
    '---',
    'aliases: []',
    'tags:',
    '  - 书库/结构建议',
    '笔记类型: 参考手册',
    stamp ? `更新日期: ${stamp}` : '更新日期: ',
    '---',
    '',
    '# 书库结构建议',
    '',
    '> [!info] 为什么有这份文件',
    '> vault 里已经有内容了，插件**没有改动任何文件或文件夹**。这份文件只解释推荐结构，是否调整由你自己决定。',
    '',
    '## 推荐结构',
    '',
    '```text',
    `${INBOX_DIR}/                临时落地：还没归类的书、导入的原始文件`,
    `${bookRoot}/`,
    `└── 《书名》/`,
    '    ├── 《书名》.md',
    '    ├── 《书名》.txt',
    '    ├── 《书名》.epub',
    '    └── 封面.png             封面随书走',
    `${cardDir}/                 书籍卡（书架 Base 的唯一数据源）`,
    `${readingDir}/              读书笔记`,
    `${posixDirname(basePath)}/                 书架 Base`,
    `${SHARED_ATTACH_DIR}/                跨书共享的附件：图例、插图、截图`,
    '```',
    '',
    '## 为什么这样分',
    '',
    '| 决策 | 选择 | 理由 |',
    '|---|---|---|',
    '| 按书建目录还是按格式分层 | 按书 | 一本书的三格式是一个整体，备份、迁移、删除都是"一个目录"的事 |',
    '| 附件集中还是按书分散 | 封面随书、其它共享附件集中 | 封面只服务这一本书；图例、插图跨书复用 |',
    '| 层级深度 | 最多 3 层 | 再深就只能靠记忆找路径 |',
    '| 卡片放哪 | 单个卡片目录 | 书架 Base 只需要一条 `file.inFolder(...)`；卡片散落会让过滤条件随书增加 |',
    '',
    '## 当前设置对照',
    '',
    '| 设置项 | 当前值 |',
    '|---|---|',
    `| 书库目录 | \`${bookRoot}\` |`,
    `| 书籍卡片目录 | \`${cardDir}\` |`,
    `| 读书笔记目录 | \`${readingDir}\` |`,
    `| 书架 Base 文件 | \`${basePath}\` |`,
    '',
    '## 想换成推荐结构时的三种走法',
    '',
    '1. **手动搬家（最干净）**：把旧书移入 `' + bookRoot + '/<书名>/`，再把「书库目录」改成该路径。',
    '2. **零移动**：保留现有目录，用设置里的「每本书路径组」把旧路径登记进去，面板仍能识别。',
    '3. **渐进**：旧书不动，新书按推荐结构走。',
    '',
    '> [!tip] 自动布置',
    '> 只有 **vault 里一个用户文件夹/文件都没有** 时，插件才能一键布置目录结构。你现在已有内容，所以这里只给建议。',
    '',
    '%% 本文件由「书库」插件生成，可自由修改或删除。 %%',
    '',
  ].join('\n');
}

module.exports = {
  INBOX_DIR,
  SHARED_ATTACH_DIR,
  DIR_NOTE_FILE,
  RECOMMENDATION_FILE,
  SYSTEM_DIRS,
  isVaultEmpty,
  posixDirname,
  dirNoteContent,
  scaffoldPlan,
  recommendationMarkdown,
};
