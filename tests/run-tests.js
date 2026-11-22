'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseChapterTitle, chineseToNumber, splitMarkdownBook, splitTxtBook } = require('../lib/chapters');
const { parseBook, renderBook } = require('../lib/book');
const { readZip } = require('../lib/zip');
const { decodeTextBuffer, splitParagraphs } = require('../lib/text');
const {
  detectTitleIssue,
  buildTitleSuggestions,
  titleLength,
} = require('../lib/titles');
const {
  normalizeVaultRelativePath,
  defaultBookDir,
  migrateSettings,
  findBookProfile,
  validateProfilePaths,
  outputDirsForProfile,
} = require('../lib/paths');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bfs-test-'));
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

function hash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fixtureMarkdown() {
  return `---
作者: 测试作者
状态: 在读
file_txt: "[[txt]"
file_epub: "[[epub]"
---

## 作品简介：

　　这是简介。

　　## 第1章 这是正文里的假标题，不应被识别。

## 第1章 真正的开始。

　　第一段。

## 第02章 全角编号。

　　第二段。

## 第十章 中文数字。

　　第三段。

## 序章 规范未覆盖。

　　序章内容。
`;
}

function fixtureTxt() {
  return `作品简介：

　　这是简介。

第1章 真正的开始。

　　第一段。

第2章 全角编号。

　　第二段。

第十章 中文数字。

　　第三段。

## 第9章 正文里的井号假标题

　　这一行是正文，不是章节。
`;
}

console.log('章节名规范化');
test('阿拉伯数字补零', () => {
  assert.strictEqual(parseChapterTitle('第1章 被遗忘的救世主。').normalizedTitle, '第001章 被遗忘的救世主。');
});
test('全角数字', () => {
  assert.strictEqual(parseChapterTitle('第１２章 测试').normalizedTitle, '第012章 测试');
});
test('中文数字', () => {
  assert.strictEqual(chineseToNumber('一百零二'), 102);
  assert.strictEqual(chineseToNumber('十二'), 12);
  assert.strictEqual(parseChapterTitle('第十章 测试').normalizedTitle, '第010章 测试');
});
test('无标题不编造', () => {
  assert.strictEqual(parseChapterTitle('第7章').normalizedTitle, '第007章');
});
test('冒号分隔规范为空格', () => {
  assert.strictEqual(parseChapterTitle('第3章：标题').normalizedTitle, '第003章 标题');
});
test('规范外标题不匹配', () => {
  assert.strictEqual(parseChapterTitle('序章 开始'), null);
});

console.log('Markdown 识别');
test('不把全角缩进的 ## 当标题', () => {
  const book = splitMarkdownBook(fixtureMarkdown(), {});
  assert.strictEqual(book.chapters.length, 4);
  assert.deepStrictEqual(book.chapters.map((ch) => ch.normalizedTitle), [
    '第001章 真正的开始。',
    '第002章 全角编号。',
    '第010章 中文数字。',
    '序章 规范未覆盖。',
  ]);
  assert.ok(book.preamble.includes('这是正文里的假标题'));
});
test('章节号不连续只警告不补号', () => {
  const book = splitMarkdownBook(fixtureMarkdown(), {});
  assert.ok(book.warnings.some((warning) => warning.includes('缺少') || warning.includes('不连续')));
});

console.log('TXT 识别');
test('TXT 正文井号行不被当作章节', () => {
  const book = splitTxtBook(fixtureTxt(), {});
  assert.strictEqual(book.chapters.length, 3);
});

test('一行一段、无空行时自动按行分段', () => {
  const paragraphs = splitParagraphs('　　第一段。\n　　第二段。\n　　第三段。');
  assert.deepStrictEqual(paragraphs, ['第一段。', '第二段。', '第三段。']);
});

test('TXT 正文中的“第一回/第三节”不当作章节', () => {
  const book = splitTxtBook(`第1章 开始
　　正文一。

第一回 可以解释为一时冲动，第二回要怎么说？这件事她精明着呢。

　　正文二。

第三节 上课还有两分钟的时候，和小姐妹大摇大摆地进了教室。

　　正文三。
`, {});
  assert.strictEqual(book.chapters.length, 1);
  assert.ok(book.chapters[0].body.includes('第一回 可以解释'));
  assert.ok(book.chapters[0].body.includes('第三节 上课'));
});

test('重复章节号且长标题似正文时按正文处理', () => {
  const book = splitTxtBook(`第1章 开始
　　正文一。

第十章 010

　　正文二。

第十章 传了上去，之后她去开了瓶红酒，一边看电影一边隔十分钟点开一次自己的主页。

　　正文三。
`, {});
  assert.strictEqual(book.chapters.length, 2);
  assert.ok(book.chapters[1].body.includes('传了上去'));
});

console.log('标题缺失检测与本地生成');
const titleRules = { prefix: '第', suffix: '章', numberPad: 3, separator: ' ' };
const titleChapters = [
  {
    number: 1,
    title: '001',
    normalizedTitle: '第001章 001',
    plainBody: '实至名归。金桂奖落幕，唐若遥拿下影后。',
    plainParagraphs: ['实至名归。金桂奖落幕，唐若遥拿下影后。'],
  },
  {
    number: 2,
    title: '缘',
    normalizedTitle: '第002章 缘',
    plainBody: '她站在窗前，很久没有说话。',
    plainParagraphs: ['她站在窗前，很久没有说话。'],
  },
  {
    number: 3,
    title: '开始',
    normalizedTitle: '第003章 开始',
    plainBody: '故事从这一天开始。',
    plainParagraphs: ['故事从这一天开始。'],
  },
  {
    number: 4,
    title: '开始',
    normalizedTitle: '第004章 开始',
    plainBody: '另一个开始。',
    plainParagraphs: ['另一个开始。'],
  },
];
const titleBook = { bookName: '标题测试', chapters: titleChapters };
const titleContentHash = (chapter) => crypto.createHash('sha256').update(chapter.plainBody).digest('hex').slice(0, 16);

test('纯数字/占位/短标题识别', () => {
  assert.strictEqual(detectTitleIssue(titleChapters[0], new Map(), { bookName: '标题测试' }).severity, 'hard');
  assert.strictEqual(detectTitleIssue({ number: 9, title: '未命名' }, new Map(), {}).severity, 'hard');
  assert.strictEqual(detectTitleIssue(titleChapters[1], new Map(), {}).severity, 'soft');
  assert.strictEqual(detectTitleIssue({ number: 9, title: '正常标题' }, new Map(), {}), null);
});

test('重复标题识别为硬缺失', () => {
  const counts = new Map([['开始', 2]]);
  const issue = detectTitleIssue(titleChapters[2], counts, {});
  assert.strictEqual(issue.severity, 'hard');
  assert.ok(issue.reasons.includes('duplicate'));
});

test('本地生成标题并保留数字编号', () => {
  const built = buildTitleSuggestions(titleBook, {
    maxChars: 10,
    rules: titleRules,
    bookName: '标题测试',
    contentHash: titleContentHash,
    cache: {},
  });
  const first = built.suggestions.find((item) => item.index === 0);
  assert.strictEqual(first.title, '实至名归');
  assert.strictEqual(first.normalizedTitle, '第001章 实至名归');
  assert.ok(titleLength(first.title) <= 10);
  assert.ok(built.suggestions.find((item) => item.index === 1).severity === 'soft');
  assert.ok(built.suggestions.find((item) => item.index === 2).severity === 'hard');
});

test('标题缓存命中时复用', () => {
  const first = buildTitleSuggestions(titleBook, {
    maxChars: 10,
    rules: titleRules,
    contentHash: titleContentHash,
    cache: {},
  });
  const cache = {};
  for (const item of first.suggestions) {
    cache[item.index] = {
      contentHash: item.contentHash,
      suggestedTitle: item.title,
      confidence: item.confidence,
      source: item.source,
      excerpt: item.excerpt,
      algorithmVersion: 'local-v1',
    };
  }
  const second = buildTitleSuggestions(titleBook, {
    maxChars: 10,
    rules: titleRules,
    contentHash: titleContentHash,
    cache,
  });
  assert.ok(second.suggestions.find((item) => item.index === 0).reused);
});

console.log('路径配置');
test('vault 相对路径校验与规范化', () => {
  assert.strictEqual(normalizeVaultRelativePath('10 书籍\\某书'), '10 书籍/某书');
  assert.strictEqual(normalizeVaultRelativePath('a/./b'), 'a/b');
  assert.throws(() => normalizeVaultRelativePath('../outside'), /不能包含/);
  assert.throws(() => normalizeVaultRelativePath('a/../../b'), /不能包含/);
  assert.throws(() => normalizeVaultRelativePath('/absolute/path'), /绝对路径/);
  assert.throws(() => normalizeVaultRelativePath('C:\\outside'), /绝对路径/);
});

test('输出目录留空回退默认目录', () => {
  const dirs = outputDirsForProfile(
    { bookName: '某书', mdDir: '自定义/md', txtDir: '', epubDir: '' },
    '10 书籍',
    '某书',
  );
  assert.strictEqual(dirs.md, '自定义/md');
  assert.strictEqual(dirs.txt, defaultBookDir('10 书籍', '某书'));
  assert.strictEqual(dirs.epub, defaultBookDir('10 书籍', '某书'));
});

test('旧设置迁移与书籍条目查找', () => {
  const settings = migrateSettings({ bookRoot: '10 书籍' });
  assert.strictEqual(settings.settingsVersion, 2);
  assert.deepStrictEqual(settings.bookProfiles, []);
  const profiles = [{ id: 'a', bookName: '某书', originalPath: '00 收件箱/某书.txt' }];
  assert.strictEqual(findBookProfile(profiles, { bookName: '某书' }).id, 'a');
  assert.strictEqual(findBookProfile(profiles, { sourcePath: '00 收件箱/某书.txt' }).id, 'a');
});

test('空路径校验通过且非法配置报错', () => {
  const normalized = validateProfilePaths({ bookName: '某书', originalPath: '', mdDir: '', txtDir: '', epubDir: '' });
  assert.strictEqual(normalized.bookName, '某书');
  assert.throws(() => validateProfilePaths({ bookName: '某书', mdDir: '../x' }), /不能包含/);
});

console.log('三格式生成与互转');
const sourceMd = path.join(tempRoot, '测试书.md');
const sourceTxt = path.join(tempRoot, '测试书.txt');
fs.writeFileSync(sourceMd, fixtureMarkdown(), 'utf8');
fs.writeFileSync(sourceTxt, fixtureTxt(), 'utf8');

let mdBook;
test('解析 Markdown 样书', () => {
  const data = fs.readFileSync(sourceMd);
  mdBook = parseBook({ sourcePath: sourceMd, sourceFormat: 'md', data });
  assert.strictEqual(mdBook.stats.chapterCount, 4);
  assert.strictEqual(mdBook.chapters[0].normalizedTitle, '第001章 真正的开始。');
});

test('生成 md/txt/epub 并通过内存校验', () => {
  const rendered = renderBook(mdBook, { bookName: mdBook.bookName });
  assert.ok(rendered.md.length > 100);
  assert.ok(rendered.txt.length > 100);
  assert.ok(rendered.epub.length > 1000);
  assert.strictEqual(rendered.epub.subarray(0, 2).toString(), 'PK');
});

let rendered;
test('写出三种格式后逐一重新解析', () => {
  rendered = renderBook(mdBook, { bookName: mdBook.bookName });
  const outDir = path.join(tempRoot, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  for (const ext of ['md', 'txt', 'epub']) fs.writeFileSync(path.join(outDir, `测试书.${ext}`), rendered[ext]);
  const titles = [];
  for (const ext of ['md', 'txt', 'epub']) {
    const file = path.join(outDir, `测试书.${ext}`);
    const book = parseBook({ sourcePath: file, sourceFormat: ext, data: fs.readFileSync(file) });
    titles.push(book.chapters.map((ch) => ch.normalizedTitle));
  }
  assert.deepStrictEqual(titles[0], titles[1]);
  assert.deepStrictEqual(titles[1], titles[2]);
});

test('三格式首行缩进统一且不叠加', () => {
  const md = rendered.md.toString('utf8');
  const txt = rendered.txt.toString('utf8');
  assert.ok(md.includes('## 第001章 真正的开始。'));
  assert.ok(!/^[ \t\u3000]+## 第001章/m.test(md));
  assert.ok(md.includes('cssclasses: book-format-sync'));
  assert.ok(md.includes('\n第一段。'));
  assert.ok(!md.includes('&emsp;'));
  const pluginCss = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(pluginCss.includes('.book-format-sync p'));
  assert.ok(pluginCss.includes('.markdown-source-view.book-format-sync'));
  assert.ok(pluginCss.includes('.cm-line:not(.HyperMD-header)'));
  assert.ok(!md.includes('\n　　'));
  assert.ok(txt.includes('\n第001章 真正的开始。\n'));
  assert.ok(txt.includes('\n　　第一段。'));
  assert.ok(!txt.includes('\n　　　　第一段。'));
  const zip = readZip(rendered.epub);
  const html = zip.get('OEBPS/chapter-0001.xhtml').toString('utf8');
  assert.ok(html.includes('<p class="body-paragraph" style="text-indent:2em;">第一段。</p>'));
  assert.ok(!/body-paragraph[^>]*>\s+第一段/.test(html));
  assert.ok(/\.body-paragraph\s*\{[^}]*text-indent\s*:\s*2em\s*;/i.test(zip.get('OEBPS/style.css').toString('utf8')));
});

test('从 TXT 生成另外两种，源文件哈希不变', () => {
  const before = fs.readFileSync(sourceTxt);
  const book = parseBook({ sourcePath: sourceTxt, sourceFormat: 'txt', data: before });
  const out = renderBook(book, { bookName: book.bookName });
  assert.strictEqual(book.stats.chapterCount, 3);
  assert.deepStrictEqual(book.chapters.map((ch) => ch.normalizedTitle), [
    '第001章 真正的开始。',
    '第002章 全角编号。',
    '第010章 中文数字。',
  ]);
  assert.ok(out.md.toString('utf8').includes('&#35;&#35; 第9章'));
  const after = fs.readFileSync(sourceTxt);
  assert.strictEqual(hash(before), hash(after));
});

test('从 EPUB 反向生成 md/txt 且章节一致', () => {
  const epubPath = path.join(tempRoot, 'out', '测试书.epub');
  const book = parseBook({ sourcePath: epubPath, sourceFormat: 'epub', data: fs.readFileSync(epubPath) });
  const out = renderBook(book, { bookName: book.bookName });
  const mdBook2 = parseBook({ sourcePath: 'x.md', sourceFormat: 'md', data: out.md });
  assert.deepStrictEqual(
    book.chapters.map((ch) => ch.normalizedTitle),
    mdBook2.chapters.map((ch) => ch.normalizedTitle),
  );
});

test('EPUB 结构合法', () => {
  const zip = readZip(rendered.epub);
  assert.ok(zip.names[0] === 'mimetype');
  assert.strictEqual(zip.get('mimetype').toString('ascii'), 'application/epub+zip');
  assert.ok(zip.has('META-INF/container.xml'));
  assert.ok(zip.has('OEBPS/content.opf'));
  assert.ok(zip.has('OEBPS/nav.xhtml'));
  assert.ok(zip.has('OEBPS/toc.ncx'));
  assert.ok(zip.has('OEBPS/chapter-0001.xhtml'));
  const opf = zip.get('OEBPS/content.opf').toString('utf8');
  const nav = zip.get('OEBPS/nav.xhtml').toString('utf8');
  assert.ok(opf.includes('测试书'));
  assert.ok(nav.includes('第001章 真正的开始。'));
});

console.log('编码');
test('GB18030 解码', () => {
  const gbk = Buffer.from([0xb5, 0xda, 0x31, 0xd5, 0xc2, 0x20, 0xb2, 0xe2, 0xca, 0xd4]);
  const decoded = decodeTextBuffer(gbk);
  assert.strictEqual(decoded.encoding, 'gb18030');
  assert.strictEqual(decoded.text, '第1章 测试');
});

test('清理临时目录', () => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

console.log(`\n${passed} tests passed`);
