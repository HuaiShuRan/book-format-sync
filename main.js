'use strict';
// 由 tools/build.js 生成，请勿直接编辑；源码在 src/main.js 与 lib/*.js。
const __nativeRequire = require;
const __modules = {
"lib/book.js": function (module, exports, __require, require) {
'use strict';

const path = require('path');
const {
  decodeTextBuffer,
  markdownToPlain,
  sanitizeFileName,
  splitParagraphs,
  splitPreamble,
  indentParagraphs,
  TXT_INDENT,
  decodeEntities,
} = __require("lib/text.js");
const {
  splitMarkdownBook,
  splitTxtBook,
  parseChapterTitle,
  formatChapterTitle,
  collectWarnings,
  rulesWithDefaults,
} = __require("lib/chapters.js");
const { readEpub, buildEpub } = __require("lib/epub.js");
const { readZip } = __require("lib/zip.js");
const { toBuffer } = __require("lib/text.js");

const FORMATS = ['md', 'txt', 'epub'];
const MD_CSS_CLASS = 'book-format-sync';
const MIME = {
  md: 'text/markdown',
  txt: 'text/plain',
  epub: 'application/epub+zip',
};

function extensionOf(filePath) {
  const ext = path.extname(String(filePath || '')).slice(1).toLowerCase();
  return FORMATS.includes(ext) ? ext : '';
}

function baseNameOf(filePath) {
  return path.basename(String(filePath || ''), path.extname(String(filePath || '')));
}

function yamlValue(value) {
  const text = String(value == null ? '' : value).replace(/\r?\n/g, ' ').trim();
  if (!text) return '""';
  return /^[^\s:#"'{}[\],&*?|<>=!%@`-]/.test(text) && !/: | #/.test(text)
    ? text
    : `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function updateFrontmatterLinks(raw, bookName) {
  if (!raw) return '';
  const name = String(bookName).replace(/"/g, '\\"');
  let result = raw;
  result = result.replace(/^([ \t]*file_txt[ \t]*:)[^\n]*$/m, `$1 "[[${name}.txt]]"`);
  result = result.replace(/^([ \t]*file_epub[ \t]*:)[^\n]*$/m, `$1 "[[${name}.epub]]"`);
  return result.endsWith('\n') ? result : `${result}\n`;
}

function ensureCssClass(raw) {
  if (!raw) return `---\ncssclasses: ${MD_CSS_CLASS}\n---\n`;
  const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      close = index;
      break;
    }
  }
  if (close < 0) return `---\ncssclasses: ${MD_CSS_CLASS}\n---\n`;

  let cssIndex = -1;
  for (let index = 1; index < close; index += 1) {
    if (/^cssclasses\s*:/i.test(lines[index])) {
      cssIndex = index;
      break;
    }
  }
  if (cssIndex < 0) {
    lines.splice(close, 0, `cssclasses: ${MD_CSS_CLASS}`);
    return `${lines.join('\n').replace(/\n*$/, '')}\n`;
  }

  const value = lines[cssIndex].replace(/^[^:]*:/, '').trim();
  if (!value) {
    // YAML block list. Add the class only if it is not already present.
    let cursor = cssIndex + 1;
    let present = false;
    while (cursor < close && /^[ \t]+-/.test(lines[cursor])) {
      if (lines[cursor].replace(/^[ \t]+-\s*/, '').trim() === MD_CSS_CLASS) present = true;
      cursor += 1;
    }
    if (!present) lines.splice(cssIndex + 1, 0, `  - ${MD_CSS_CLASS}`);
  } else if (value.startsWith('[') && value.endsWith(']')) {
    if (!value.includes(MD_CSS_CLASS)) {
      lines[cssIndex] = `cssclasses: [${value.slice(1, -1).trim()}${value.slice(1, -1).trim() ? ', ' : ''}${MD_CSS_CLASS}]`;
    }
  } else if (!value.split(/[\s,]+/).includes(MD_CSS_CLASS)) {
    lines[cssIndex] = `cssclasses: ${value} ${MD_CSS_CLASS}`;
  }
  return `${lines.join('\n').replace(/\n*$/, '')}\n`;
}

function buildFrontmatter(book, bookName) {
  let raw = '';
  if (book.frontmatterRaw) raw = updateFrontmatterLinks(book.frontmatterRaw, bookName);
  else if (book.author) raw = `---\n作者: ${yamlValue(book.author)}\n---\n`;
  return ensureCssClass(raw);
}

function normalizeChapters(chapters, rules, warnings) {
  return chapters.map((chapter) => {
    const number = Number(chapter.number);
    if (chapter.inlineBody || (chapter.title === '' && Number.isSafeInteger(number))) {
      return {
        ...chapter,
        number,
        title: '',
        normalizedTitle: formatChapterTitle(number, '', rules),
        sourceTitle: chapter.sourceTitle || chapter.rawTitle || '',
      };
    }
    const candidates = [chapter.sourceTitle, chapter.rawTitle, chapter.title, chapter.normalizedTitle]
      .filter(Boolean);
    let parsed = null;
    for (const candidate of candidates) {
      parsed = parseChapterTitle(candidate, rules);
      if (parsed) break;
    }
    if (parsed) {
      return {
        ...chapter,
        number: parsed.number,
        title: parsed.title,
        normalizedTitle: parsed.normalizedTitle,
        sourceTitle: chapter.sourceTitle || chapter.rawTitle || parsed.raw,
      };
    }
    const title = String(chapter.title || chapter.rawTitle || '').trim();
    if (title) warnings.push(`规范未覆盖的标题，已原样保留：${title.slice(0, 80)}`);
    return {
      ...chapter,
      number: null,
      title,
      normalizedTitle: title,
      sourceTitle: chapter.sourceTitle || title,
    };
  });
}

/**
 * 解析 md/txt/epub 为统一书籍模型。
 * 章节名会在内存中按规则重算；源文件不会被此函数修改。
 */
function parseBook(input) {
  const sourceFormat = input.sourceFormat || extensionOf(input.fileName || input.sourcePath);
  if (!FORMATS.includes(sourceFormat)) throw new Error(`不支持的格式：${sourceFormat || '未知'}；只处理 md/txt/epub。`);
  const bookName = sanitizeFileName(
    input.bookName || baseNameOf(input.sourcePath || input.fileName || '未命名'),
  );
  const rules = rulesWithDefaults(input.rules);
  const warnings = [];
  let rawText = '';
  let encoding = 'utf-8';
  let parsed;

  if (sourceFormat === 'epub') {
    parsed = readEpub(toBuffer(input.data), { rules, bookName });
    encoding = parsed.encoding || 'epub';
  } else {
    const decoded = decodeTextBuffer(input.data);
    rawText = decoded.text;
    encoding = decoded.encoding;
    if (sourceFormat === 'md') {
      parsed = splitMarkdownBook(rawText, rules);
    } else {
      parsed = splitTxtBook(rawText, rules);
    }
  }

  if (!parsed.chapters || !parsed.chapters.length) {
    throw new Error(`《${bookName}》没有识别到任何章节；规范只识别“第N章”，请先检查文件或调整章节规范设置。`);
  }

  const metadata = parsed.metadata || {};
  const author = String(
    input.author || metadata['作者'] || metadata.author || metadata.Author || parsed.author || '',
  ).trim();

  const prepared = parsed.chapters.map((chapter) => {
    const body = String(chapter.body || '');
    const markdownParagraphs = sourceFormat === 'md' ? splitParagraphs(body) : [];
    const plainParagraphs = splitParagraphs(
      sourceFormat === 'md' ? markdownToPlain(body) : body,
    );
    return {
      ...chapter,
      markdownParagraphs,
      plainParagraphs,
      markdownBody: markdownParagraphs.join('\n\n'),
      plainBody: plainParagraphs.join('\n\n'),
    };
  });
  const chapters = normalizeChapters(prepared, rules, warnings);

  const preWarnings = [...(parsed.warnings || []), ...warnings];
  const allWarnings = collectWarnings(chapters, preWarnings);
  const chars = chapters.reduce((sum, chapter) => sum + String(chapter.plainBody || '').length, 0);

  return {
    bookName,
    title: String(parsed.title || input.title || bookName).trim() || bookName,
    author,
    language: String(parsed.language || input.language || 'zh-CN').trim() || 'zh-CN',
    identifier: parsed.identifier || '',
    sourceFormat,
    sourcePath: input.sourcePath || input.fileName || '',
    encoding,
    frontmatterRaw: parsed.frontmatterRaw || '',
    metadata,
    preamble: String(parsed.preamble || '').trim(),
    chapters,
    warnings: [...new Set(allWarnings)],
    stats: {
      chapterCount: chapters.length,
      chars,
    },
  };
}

function protectMarkdownHeadings(text) {
  return String(text || '').replace(
    /^([ \t]{0,3})(#{1,6})(?=[ \t]|$)/gm,
    (whole, indent, hashes) => `${indent}${'&#35;'.repeat(hashes.length)}`,
  );
}

function renderMarkdownPreamble(preamble) {
  const { headingRaw, rest } = splitPreamble(preamble);
  const paragraphs = splitParagraphs(rest).map(protectMarkdownHeadings);
  const parts = [];
  if (headingRaw) parts.push(headingRaw);
  if (paragraphs.length) parts.push(paragraphs.join('\n\n'));
  return parts.join('\n\n');
}

function renderTxtPreamble(preamble) {
  const { headingText, rest } = splitPreamble(preamble);
  const paragraphs = splitParagraphs(markdownToPlain(rest, { stripHeadings: false }));
  const parts = [];
  if (headingText) parts.push(headingText);
  if (paragraphs.length) parts.push(indentParagraphs(paragraphs, TXT_INDENT));
  return parts.join('\n\n');
}

function chapterMarkdownParagraphs(chapter) {
  if (Array.isArray(chapter.markdownParagraphs) && chapter.markdownParagraphs.length) {
    return chapter.markdownParagraphs;
  }
  return chapterPlainParagraphs(chapter);
}

function chapterPlainParagraphs(chapter) {
  if (Array.isArray(chapter.plainParagraphs)) return chapter.plainParagraphs;
  return splitParagraphs(chapter.plainBody || '');
}

function serializeMarkdown(book, options) {
  const bookName = options.bookName || book.bookName;
  const blocks = [];
  const frontmatter = buildFrontmatter(book, bookName);
  if (frontmatter) blocks.push(frontmatter.trimEnd());
  const preamble = renderMarkdownPreamble(book.preamble);
  if (preamble) blocks.push(preamble);

  for (const chapter of book.chapters) {
    const title = String(chapter.normalizedTitle || chapter.title || '').trim();
    const paragraphs = chapterMarkdownParagraphs(chapter).map(protectMarkdownHeadings);
    const body = paragraphs.join('\n\n');
    blocks.push(`## ${title}${body ? `\n\n${body}` : ''}`);
  }
  return `${blocks.join('\n\n').trimEnd()}\n`;
}

function serializeTxt(book, options) {
  const blocks = [];
  const preamble = renderTxtPreamble(book.preamble);
  if (preamble) blocks.push(preamble);

  for (const chapter of book.chapters) {
    const title = String(chapter.normalizedTitle || chapter.title || '').trim();
    const paragraphs = chapterPlainParagraphs(chapter);
    const body = indentParagraphs(paragraphs, TXT_INDENT);
    blocks.push(`${title}${body ? `\n\n${body}` : ''}`);
  }
  let text = `${blocks.join('\n\n').trimEnd()}\n`;
  if (options.txtLineEnding === 'crlf') text = text.replace(/\n/g, '\r\n');
  if (options.txtBom) text = `\ufeff${text}`;
  return text;
}

function chapterTitles(book) {
  return book.chapters.map((chapter) => String(chapter.normalizedTitle || chapter.title || '').trim());
}

function rawParagraphBlocks(body) {
  return String(body || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((block) => block.replace(/^[\n]+|[\n]+$/g, ''))
    .filter((block) => block.replace(/[\s\u3000\u2000-\u200a]/g, ''));
}

function hasLeadingIndent(value) {
  return /^(?:[ \t\u00a0\u3000\u2000-\u200a]|&(?:emsp|ensp|nbsp|thinsp);|&#(?:8194|8195|160|12288|x2002|x2003|x00a0);)/i
    .test(String(value || ''));
}

function verifyTextParagraphs(blocks, prefix, format, chapterIndex) {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (prefix && !block.startsWith(prefix)) {
      throw new Error(`三格式校验失败：${format} 第 ${chapterIndex + 1} 章第 ${index + 1} 段缺少 2em 首行缩进。`);
    }
    const rest = prefix ? block.slice(prefix.length) : block;
    if (!rest.replace(/[\s\u3000\u2000-\u200a]/g, '')) {
      throw new Error(`三格式校验失败：${format} 第 ${chapterIndex + 1} 章第 ${index + 1} 段为空。`);
    }
    if (hasLeadingIndent(rest)) {
      throw new Error(`三格式校验失败：${format} 第 ${chapterIndex + 1} 章第 ${index + 1} 段存在字面缩进，应只由样式控制。`);
    }
  }
}

function verifyParsedTextIndent(parsedChapters, prefix, format, book) {
  if (parsedChapters.length !== book.chapters.length) {
    throw new Error(`三格式校验失败：${format} 章节数不一致。`);
  }
  for (let index = 0; index < parsedChapters.length; index += 1) {
    const expectedCount = chapterPlainParagraphs(book.chapters[index]).length;
    const blocks = rawParagraphBlocks(parsedChapters[index].body);
    if (blocks.length !== expectedCount) {
      throw new Error(
        `三格式校验失败：${format} 第 ${index + 1} 章有 ${blocks.length} 段，预期 ${expectedCount} 段。`,
      );
    }
    verifyTextParagraphs(blocks, prefix, format, index);
  }
}

function verifyTxtPreambleIndent(parsedPreamble, book) {
  const expected = splitParagraphs(markdownToPlain(splitPreamble(book.preamble).rest, { stripHeadings: false }));
  const blocks = rawParagraphBlocks(splitPreamble(parsedPreamble).rest);
  if (blocks.length !== expected.length) {
    throw new Error(`三格式校验失败：txt 前言有 ${blocks.length} 段，预期 ${expected.length} 段。`);
  }
  verifyTextParagraphs(blocks, TXT_INDENT, 'txt-前言', -1);
}

function verifyMdPreambleIndent(parsedPreamble, book) {
  const expected = splitParagraphs(markdownToPlain(splitPreamble(book.preamble).rest));
  const blocks = rawParagraphBlocks(splitPreamble(parsedPreamble).rest);
  if (blocks.length !== expected.length) {
    throw new Error(`三格式校验失败：md 前言有 ${blocks.length} 段，预期 ${expected.length} 段。`);
  }
  verifyTextParagraphs(blocks, null, 'md-前言', -1);
}

function verifyEpubIndent(buffer, book) {
  const zip = readZip(buffer);
  const css = zip.get('OEBPS/style.css');
  if (!css || !/\.body-paragraph\s*\{[^}]*text-indent\s*:\s*2em\s*;/i.test(css.toString('utf8'))) {
    throw new Error('三格式校验失败：EPUB 缺少 2em 段落缩进样式。');
  }
  const chapterFiles = zip.names
    .filter((name) => /^OEBPS\/chapter-\d+\.xhtml$/.test(name))
    .sort();
  if (chapterFiles.length !== book.chapters.length) {
    throw new Error(`三格式校验失败：EPUB 有 ${chapterFiles.length} 个章节文件，预期 ${book.chapters.length} 个。`);
  }
  const preambleCount = splitParagraphs(markdownToPlain(splitPreamble(book.preamble).rest, { stripHeadings: false })).length;
  for (let index = 0; index < chapterFiles.length; index += 1) {
    const html = zip.get(chapterFiles[index]).toString('utf8');
    const title = String(book.chapters[index].normalizedTitle || book.chapters[index].title || '').trim();
    const headingMatch = /<h2>([\s\S]*?)<\/h2>/.exec(html);
    if (!headingMatch) throw new Error(`三格式校验失败：EPUB 第 ${index + 1} 章缺少章节标题。`);
    const headingText = decodeEntities(headingMatch[1].replace(/<[^>]*>/g, '')).trim();
    if (headingText !== title) {
      throw new Error(`三格式校验失败：EPUB 第 ${index + 1} 章标题为“${headingText}”，预期“${title}”。`);
    }
    const expectedCount = chapterPlainParagraphs(book.chapters[index]).length + (index === 0 ? preambleCount : 0);
    const bodyParagraphs = [...html.matchAll(/<p class="body-paragraph" style="text-indent:2em;">([\s\S]*?)<\/p>/g)];
    if (bodyParagraphs.length !== expectedCount) {
      throw new Error(
        `三格式校验失败：EPUB 第 ${index + 1} 章有 ${bodyParagraphs.length} 个正文段落，预期 ${expectedCount} 个。`,
      );
    }
    for (const match of bodyParagraphs) {
      const inner = match[1];
      if (hasLeadingIndent(inner) || /^\s/.test(inner)) {
        throw new Error(`三格式校验失败：EPUB 第 ${index + 1} 章某段存在多余缩进。`);
      }
      const text = decodeEntities(inner.replace(/<[^>]*>/g, ''));
      if (!text.trim()) throw new Error(`三格式校验失败：EPUB 第 ${index + 1} 章存在空段落。`);
    }
    const allParagraphTags = [...html.matchAll(/<p\b[^>]*>/g)].map((match) => match[0]);
    for (const tag of allParagraphTags) {
      const isBody = tag.includes('class="body-paragraph"') && /text-indent\s*:\s*2em/i.test(tag);
      const isPreambleTitle = tag.includes('class="preamble-title"');
      if (!isBody && !isPreambleTitle) {
        throw new Error(`三格式校验失败：EPUB 第 ${index + 1} 章存在未声明缩进的段落。`);
      }
    }
  }
}

function verifyMarkdownHeadingLines(text, book) {
  const lines = String(text).split(/\r?\n/);
  let offset = 0;
  for (const chapter of book.chapters) {
    const expected = `## ${String(chapter.normalizedTitle || chapter.title || '').trim()}`;
    let found = -1;
    for (let index = offset; index < lines.length; index += 1) {
      if (lines[index] === expected) {
        found = index;
        break;
      }
    }
    if (found < 0) throw new Error(`三格式校验失败：md 章节标题行缺失或被缩进：${expected}`);
    offset = found + 1;
  }
}

function verifyTxtHeadingLines(text, book) {
  const lines = String(text).split(/\r?\n/);
  let offset = 0;
  for (const chapter of book.chapters) {
    const expected = String(chapter.normalizedTitle || chapter.title || '').trim();
    let found = -1;
    for (let index = offset; index < lines.length; index += 1) {
      if (lines[index] === expected) {
        found = index;
        break;
      }
    }
    if (found < 0) throw new Error(`三格式校验失败：txt 章节标题行缺失或被缩进：${expected}`);
    offset = found + 1;
  }
}

function verifyRendered(book, rendered, rules) {
  const expected = chapterTitles(book);
  const mdText = rendered.md.toString('utf8');
  const txtText = rendered.txt.toString('utf8');
  const mdParsed = splitMarkdownBook(mdText, rules);
  const txtParsed = splitTxtBook(txtText, rules);
  const epubParsed = readEpub(rendered.epub, { rules, bookName: book.bookName });
  const actual = {
    md: mdParsed.chapters.map((ch) => ch.normalizedTitle),
    txt: txtParsed.chapters.map((ch) => ch.normalizedTitle),
    epub: epubParsed.chapters.map((ch) => ch.normalizedTitle),
  };

  for (const format of FORMATS) {
    if (actual[format].length !== expected.length) {
      throw new Error(`三格式校验失败：${format} 有 ${actual[format].length} 章，预期 ${expected.length} 章。`);
    }
    for (let i = 0; i < expected.length; i += 1) {
      if (actual[format][i] !== expected[i]) {
        throw new Error(`三格式校验失败：${format} 第 ${i + 1} 章标题为“${actual[format][i]}”，预期“${expected[i]}”。`);
      }
    }
  }

  if (!String(mdParsed.frontmatterRaw || '').includes(MD_CSS_CLASS)) {
    throw new Error(`三格式校验失败：md 缺少 frontmatter cssclasses: ${MD_CSS_CLASS}，阅读视图无法应用 2em 缩进。`);
  }

  verifyParsedTextIndent(mdParsed.chapters, null, 'md', book);
  verifyParsedTextIndent(txtParsed.chapters, TXT_INDENT, 'txt', book);
  verifyMarkdownHeadingLines(mdText, book);
  verifyTxtHeadingLines(txtText, book);
  verifyMdPreambleIndent(mdParsed.preamble, book);
  verifyTxtPreambleIndent(txtParsed.preamble, book);
  verifyEpubIndent(rendered.epub, book);

  return {
    ...actual,
    indentation: {
      md: '2em（frontmatter cssclasses: book-format-sync + 插件 CSS）',
      txt: '2 个全角空格',
      epub: 'CSS text-indent: 2em',
    },
  };
}

/**
 * 生成三格式 Buffer。只生成，不写盘；写盘由插件/CLI 负责。
 */
function renderBook(book, options) {
  const opts = options || {};
  const bookName = opts.bookName || book.bookName;
  const rules = rulesWithDefaults(opts.rules);
  const md = Buffer.from(serializeMarkdown(book, { ...opts, bookName }), 'utf8');
  const txt = Buffer.from(serializeTxt(book, opts), 'utf8');
  const epub = buildEpub(book, { ...opts, bookName });
  const rendered = { md, txt, epub };
  const verification = verifyRendered(book, rendered, rules);
  return {
    ...rendered,
    titles: chapterTitles(book),
    verification,
    sizes: {
      md: md.length,
      txt: txt.length,
      epub: epub.length,
    },
  };
}

module.exports = {
  FORMATS,
  MIME,
  MD_CSS_CLASS,
  extensionOf,
  baseNameOf,
  parseBook,
  renderBook,
  serializeMarkdown,
  serializeTxt,
  chapterTitles,
  verifyRendered,
  normalizeChapters,
  updateFrontmatterLinks,
  yamlValue,
};

},
"lib/chapters.js": function (module, exports, __require, require) {
'use strict';

/**
 * 章节识别与章节名规范化。
 *
 * 只识别“第 <数字> 章”这一类章节名；序章、楔子、番外等规范未覆盖的
 * 标题一律保持原样并记录警告，不猜测编号、不补造标题。
 */

const DEFAULT_RULES = Object.freeze({
  prefix: '第',
  suffix: '章',
  separator: ' ',
});

const CN_DIGITS = {
  '〇': 0, '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
  '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
  '壹': 1, '贰': 2, '叁': 3, '肆': 4, '伍': 5, '陆': 6, '柒': 7,
  '捌': 8, '玖': 9,
};

const CN_UNITS = {
  '十': 10, '拾': 10, '百': 100, '佰': 100, '千': 1000, '仟': 1000,
  '万': 10000, '亿': 100000000,
};

const NUMBER_CHARS = '0-9０-９〇零一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟亿';
const CHAPTERISH_RE = new RegExp(
  `^${escapeRegExp('第')}\\s*[${NUMBER_CHARS}]+\\s*[章节回卷篇]`,
);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rulesWithDefaults(rules) {
  const merged = { ...DEFAULT_RULES, ...(rules || {}) };
  merged.prefix = String(merged.prefix == null ? '第' : merged.prefix);
  merged.suffix = String(merged.suffix == null ? '章' : merged.suffix);
  merged.separator = String(merged.separator == null ? ' ' : merged.separator);
  return merged;
}

function normalizeDigits(value) {
  return String(value).replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/** 中文数字（含“十/百/千/万/亿”）转整数；没有单位时按数字串拼接。 */
function chineseToNumber(text) {
  const raw = String(text).replace(/[〇零]/g, '〇');
  if (!raw) return NaN;
  if (!/[十拾百佰千仟万亿]/.test(raw)) {
    let digits = '';
    for (const ch of raw) {
      if (ch === '〇') digits += '0';
      else if (ch in CN_DIGITS) digits += String(CN_DIGITS[ch]);
      else return NaN;
    }
    return digits ? Number(digits) : NaN;
  }

  let total = 0;
  let section = 0;
  let number = 0;
  for (const ch of raw) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      if (unit >= 10000) {
        section += number;
        total += (section || 1) * unit;
        section = 0;
      } else {
        section += (number || 1) * unit;
      }
      number = 0;
    } else {
      return NaN;
    }
  }
  return total + section + number;
}

function parseNumberToken(token) {
  const normalized = normalizeDigits(token).trim();
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return chineseToNumber(normalized);
}

/**
 * 解析一行“第N章 标题”。
 * @returns {{number:number,title:string,normalizedTitle:string,raw:string}|null}
 */
function parseChapterTitle(rawTitle, rules) {
  const opts = rulesWithDefaults(rules);
  const text = String(rawTitle == null ? '' : rawTitle).trim();
  // Markdown headings can be longer than a prose line; the TXT path still
  // applies its own 160-character guard before calling this parser.
  if (!text || text.length > 512) return null;

  const prefix = escapeRegExp(opts.prefix);
  const suffix = escapeRegExp(opts.suffix);
  const re = new RegExp(
    `^${prefix}\\s*([${NUMBER_CHARS}]+)\\s*${suffix}([\\s\\S]*)$`,
  );
  const match = re.exec(text);
  if (!match) return null;

  const number = parseNumberToken(match[1]);
  if (!Number.isSafeInteger(number) || number < 0 || number > 999999) return null;

  let title = match[2].replace(/^[\s:：、.．\-—–]+/, '').trim();
  title = title.replace(/[\s\u3000]+/g, ' ').trim();
  return {
    number,
    title,
    normalizedTitle: formatChapterTitle(number, title, opts),
    raw: text,
  };
}

/** 按规范生成章节名：“第1章 标题”；章节序号不补零。 */
function formatChapterTitle(number, title, rules) {
  const opts = rulesWithDefaults(rules);
  const value = Math.max(0, Number(number) || 0);
  let result = `${opts.prefix}${value}${opts.suffix}`;
  const cleanTitle = String(title == null ? '' : title)
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
  if (cleanTitle) result += `${opts.separator}${cleanTitle}`;
  return result;
}

/** 判断“第N章”后面的剩余文本是否其实是正文，而不是标题。 */
function isInlineChapterBody(rest) {
  const text = String(rest == null ? '' : rest).trim();
  if (!text) return false;
  if (text.length > 40) return true;
  const sentenceEnds = (text.match(/[。！？!?；;]/g) || []).length;
  return text.length > 20 && sentenceEnds >= 2;
}

/**
 * 解析 TXT 的整行章节行：可能是“第N章 标题”，也可能是“第N章 正文...”。
 * 方案 A：长文本/多句末标点视为正文，标题只保留“第N章”。
 */
function parseChapterLine(rawLine, rules) {
  const opts = rulesWithDefaults(rules);
  const text = String(rawLine == null ? '' : rawLine).trim();
  if (!text || text.length > 10000) return null;
  const re = new RegExp(
    `^${escapeRegExp(opts.prefix)}\\s*([${NUMBER_CHARS}]+)\\s*${escapeRegExp(opts.suffix)}([\\s\\S]*)$`,
  );
  const match = re.exec(text);
  if (!match) return null;
  const number = parseNumberToken(match[1]);
  if (!Number.isSafeInteger(number) || number < 0 || number > 999999) return null;

  const rest = match[2].trim();
  if (!rest) {
    return {
      number,
      title: '',
      normalizedTitle: formatChapterTitle(number, '', opts),
      raw: text,
      body: '',
      inlineBody: false,
    };
  }
  if (isInlineChapterBody(rest)) {
    return {
      number,
      title: '',
      normalizedTitle: formatChapterTitle(number, '', opts),
      raw: text,
      body: rest,
      inlineBody: true,
    };
  }
  const title = rest.replace(/^[\s:：、.．\-—–]+/, '').trim().replace(/[\s\u3000]+/g, ' ');
  return {
    number,
    title,
    normalizedTitle: formatChapterTitle(number, title, opts),
    raw: text,
    body: '',
    inlineBody: false,
  };
}

/** 判断一行是否像章节名，但可能因为格式不符合规范而没被识别。 */
function looksChapterish(text) {
  const value = String(text == null ? '' : text).trim();
  if (!value || value.length > 160) return false;
  return CHAPTERISH_RE.test(value) || /^(序章|楔子|引子|尾声|后记|番外)([\s:：]|$)/.test(value);
}

/**
 * 规范只定义“第N章”。序章、楔子、番外、第N回/节/卷等仍应作为章节边界，
 * 但标题原样保留，不改成“第1章”，也不猜编号。
 * TXT 的“第N回/节”经常出现在正文句子开头，可通过 numberedSections:false 关闭。
 */
function isUncoveredSectionHeading(text, options) {
  const value = String(text == null ? '' : text).trim();
  if (!value || value.length > 80) return false;
  if (/^(序章|序言|楔子|引子|前言|尾声|后记|终章|番外(?:篇)?)(?=$|[\s:：、.．\-—])/.test(value)) {
    return true;
  }
  if (options && options.numberedSections === false) return false;
  return new RegExp(
    `^第\\s*[${NUMBER_CHARS}]+\\s*[回节卷篇](?=$|[\\s:：、.．\\-—])`,
  ).test(value);
}


function matchMarkdownHeading(line) {
  const match = /^([ \t]{0,3})(#{1,6})[ \t]*(.*?)[ \t]*$/.exec(String(line));
  if (!match) return null;
  return { level: match[2].length, text: match[3].trim() };
}

function parseSimpleFrontmatter(raw) {
  const fields = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const match = /^([^\s:#][^:：]*)[ \t]*[:：][ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].trim();
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
    fields[key.toLowerCase()] = value;
  }
  return fields;
}

function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !String(lines[start]).trim()) start += 1;
  while (end > start && !String(lines[end - 1]).trim()) end -= 1;
  return lines.slice(start, end);
}

function collectWarnings(chapters, warnings) {
  const seen = new Set();
  const numbers = new Map();
  for (const chapter of chapters) {
    if (chapter.number == null) continue;
    numbers.set(chapter.number, (numbers.get(chapter.number) || 0) + 1);
  }
  for (const [number, count] of numbers) {
    if (count > 1) warnings.push(`章节号重复：第 ${number} 章出现了 ${count} 次，保持原顺序，未重新编号。`);
  }
  const nums = [...numbers.keys()].sort((a, b) => a - b);
  if (nums.length > 1) {
    const missing = [];
    for (let n = nums[0]; n <= nums[nums.length - 1]; n += 1) {
      if (!numbers.has(n)) missing.push(n);
    }
    if (missing.length) {
      const preview = missing.slice(0, 20).join('、');
      warnings.push(`章节号不连续：缺少 ${missing.length} 个编号（${preview}${missing.length > 20 ? '…' : ''}）；未自动补章或改号。`);
    }
  }
  return [...new Set(warnings)];
}

function makeChapter(parsed, lines) {
  return {
    number: parsed.number,
    title: parsed.title,
    normalizedTitle: parsed.normalizedTitle,
    sourceTitle: parsed.raw,
    inlineBody: Boolean(parsed.inlineBody),
    lines: trimBlankLines(lines),
    body: trimBlankLines(lines).join('\n'),
  };
}

function splitMarkdownBook(text, rules) {
  let source = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  let frontmatterRaw = '';
  const frontmatterMatch = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (frontmatterMatch) {
    frontmatterRaw = frontmatterMatch[0];
    source = source.slice(frontmatterMatch[0].length);
  }

  const lines = source.split(/\r?\n/);
  const preambleLines = [];
  const chapters = [];
  const warnings = [];
  let current = null;

  const finishCurrent = () => {
    if (current) {
      chapters.push(makeChapter(current.parsed, current.lines));
      current = null;
    }
  };

  for (const line of lines) {
    const heading = matchMarkdownHeading(line);
    if (heading) {
      const parsed = parseChapterTitle(heading.text, rules);
      if (parsed) {
        finishCurrent();
        current = { parsed, lines: [] };
        continue;
      }
      if (isUncoveredSectionHeading(heading.text)) {
        finishCurrent();
        current = {
          parsed: {
            number: null,
            title: heading.text,
            normalizedTitle: heading.text,
            raw: heading.text,
            uncovered: true,
          },
          lines: [],
        };
        continue;
      }
      if (looksChapterish(heading.text)) {
        warnings.push(`未按规范识别的标题，已原样保留：${heading.text.slice(0, 80)}`);
      }
    }
    if (current) current.lines.push(line);
    else preambleLines.push(line);
  }
  finishCurrent();

  const metadata = parseSimpleFrontmatter(
    frontmatterRaw.replace(/^---[ \t]*\r?\n/, '').replace(/\r?\n---[ \t]*\s*$/, ''),
  );
  return {
    frontmatterRaw,
    metadata,
    preamble: trimBlankLines(preambleLines).join('\n'),
    chapters,
    warnings: collectWarnings(chapters, warnings),
  };
}

function splitTxtBook(text, rules) {
  const lines = String(text == null ? '' : text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const preambleLines = [];
  const chapters = [];
  const warnings = [];
  const seenNumbers = new Set();
  let current = null;

  const finishCurrent = () => {
    if (current) {
      chapters.push(makeChapter(current.parsed, current.lines));
      current = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    // TXT 可能把章节标题和正文放在同一行；512 字以内交给结构解析，
    // 由 parseChapterLine 判断是短标题还是“第N章 + 正文”。
    const parsed = trimmed.length <= 512 ? parseChapterLine(trimmed, rules) : null;
    let duplicateProse = false;
    if (parsed) {
      duplicateProse = seenNumbers.has(parsed.number)
        && (parsed.inlineBody || (parsed.title.length > 20 && /[，；]/.test(parsed.title)));
      if (!duplicateProse) {
        finishCurrent();
        seenNumbers.add(parsed.number);
        current = { parsed, lines: parsed.body ? [parsed.body] : [] };
        continue;
      }
      warnings.push(`重复章节号且标题似正文，已按正文保留：${trimmed.slice(0, 80)}`);
    }
    if (isUncoveredSectionHeading(trimmed, { numberedSections: false })) {
      finishCurrent();
      current = {
        parsed: {
          number: null,
          title: trimmed,
          normalizedTitle: trimmed,
          raw: trimmed,
          uncovered: true,
        },
        lines: [],
      };
      continue;
    }
    const numberedSection = /^第\s*[0-9０-９〇零一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟亿]+\s*[回节卷篇]/.test(trimmed);
    if (!duplicateProse && !numberedSection && looksChapterish(trimmed) && trimmed.length <= 80) {
      warnings.push(`未按规范识别的标题，已原样保留：${trimmed.slice(0, 80)}`);
    }
    if (current) current.lines.push(line);
    else preambleLines.push(line);
  }
  finishCurrent();

  return {
    frontmatterRaw: '',
    metadata: {},
    preamble: trimBlankLines(preambleLines).join('\n'),
    chapters,
    warnings: collectWarnings(chapters, warnings),
  };
}

module.exports = {
  DEFAULT_RULES,
  rulesWithDefaults,
  parseNumberToken,
  chineseToNumber,
  parseChapterTitle,
  parseChapterLine,
  formatChapterTitle,
  isInlineChapterBody,
  looksChapterish,
  isUncoveredSectionHeading,
  matchMarkdownHeading,
  parseSimpleFrontmatter,
  splitMarkdownBook,
  splitTxtBook,
  trimBlankLines,
  collectWarnings,
};

},
"lib/epub.js": function (module, exports, __require, require) {
'use strict';

const crypto = require('crypto');
const { readZip, writeZip } = __require("lib/zip.js");
const {
  decodeTextBuffer,
  decodeEntities,
  escapeXml,
  markdownToPlain,
  splitParagraphs,
  splitPreamble,
  stripParagraphIndent,
  normalizePlainBody,
  toBuffer,
} = __require("lib/text.js");
const { parseChapterTitle, looksChapterish } = __require("lib/chapters.js");

/**
 * EPUB 解析与生成。
 *
 * 解析：container.xml → OPF(manifest/spine) → 按 spine 顺序读 XHTML；
 *       nav.xhtml / toc.ncx 只用于补全标题，不替代正文。
 * 生成：EPUB 3（nav）+ EPUB 2 兼容 NCX；mimetype 为 ZIP 第一项且 store。
 */

function resolveHref(baseDir, href) {
  const clean = decodeEntities(String(href || '').trim()).replace(/\\/g, '/');
  if (!clean) return '';
  const withoutFragment = clean.split('#')[0];
  const parts = `${baseDir ? `${baseDir}/` : ''}${withoutFragment}`.split('/');
  const stack = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function getAttr(tag, name) {
  const re = new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = re.exec(String(tag));
  if (!match) return '';
  return decodeEntities(match[1] != null ? match[1] : match[2]);
}

function getTagText(xml, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = re.exec(String(xml));
  return match ? stripTags(match[1]).trim() : '';
}

function stripTags(value) {
  return decodeEntities(String(value == null ? '' : value).replace(/<[^>]*>/g, ' '))
    .replace(/[\t\r\n ]+/g, ' ')
    .trim();
}

function cleanHtmlText(value) {
  return decodeEntities(String(value == null ? '' : value))
    .replace(/[\t\r\n ]+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    // 只去 ASCII 空白，保留中文全角缩进（\u3000）。
    .replace(/^[\t\r\n ]+|[\t\r\n ]+$/g, '');
}

function splitXhtml(html) {
  let source = String(html == null ? '' : html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '');
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(source);
  if (body) source = body[1];
  return source;
}

const SKIP_TAGS = new Set(['script', 'style', 'svg', 'rt', 'rp', 'nav', 'template']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'blockquote', 'li', 'ul', 'ol', 'dl', 'dt', 'dd',
  'tr', 'td', 'th', 'table', 'figure', 'figcaption', 'pre', 'address', 'aside', 'header',
  'footer', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * 把一份 XHTML 拆成前言 + 章节。支持一个文件内多个 h1-h6 的情况。
 */
function extractFromXhtml(html, options) {
  const opts = options || {};
  const warnings = [];
  const docTitleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(String(html));
  const docTitle = docTitleMatch ? stripTags(docTitleMatch[1]) : '';
  const source = splitXhtml(html);
  const tokens = source.match(/<[^>]*>|[^<]+/g) || [];
  const preambleBlocks = [];
  const chapters = [];
  let current = null;
  let paragraph = '';
  let heading = null;
  let skipDepth = 0;

  const flushParagraph = () => {
    const text = cleanHtmlText(paragraph);
    paragraph = '';
    if (!text || !text.replace(/[\s\u3000]/g, '')) return;
    if (current) current.lines.push(text);
    else preambleBlocks.push(text);
  };
  const finishCurrent = () => {
    if (!current) return;
    current.body = normalizePlainBody(current.lines.join('\n\n'));
    current.rawTitle = current.rawTitle || current.title;
    chapters.push(current);
    current = null;
  };

  for (const token of tokens) {
    if (token.startsWith('<')) {
      const match = /^<\s*(\/?)\s*([a-zA-Z0-9:_-]+)([^>]*)>$/.exec(token);
      if (!match) continue;
      const closing = Boolean(match[1]);
      const tag = match[2].toLowerCase();
      const attrs = match[3];

      if (skipDepth > 0) {
        if (tag === 'script' || tag === 'style' || SKIP_TAGS.has(tag)) {
          if (closing) skipDepth = Math.max(0, skipDepth - 1);
          else if (!/\/\s*$/.test(attrs)) skipDepth += 1;
        }
        continue;
      }
      if (SKIP_TAGS.has(tag)) {
        if (!closing && !/\/\s*$/.test(attrs)) skipDepth += 1;
        continue;
      }

      if (HEADING_TAGS.has(tag)) {
        if (!closing) {
          flushParagraph();
          heading = { tag, text: '' };
        } else if (heading && heading.tag === tag) {
          const rawTitle = cleanHtmlText(heading.text);
          heading = null;
          if (rawTitle) {
            finishCurrent();
            current = { rawTitle, title: rawTitle, lines: [] };
          }
        }
        continue;
      }
      if (heading) continue;

      if (tag === 'br') {
        flushParagraph();
      } else if (tag === 'img' && !closing) {
        const alt = cleanHtmlText(getAttr(attrs, 'alt'));
        paragraph += alt ? `[图片：${alt}]` : '[图片]';
      } else if (BLOCK_TAGS.has(tag)) {
        if (closing) flushParagraph();
      }
      continue;
    }

    if (skipDepth > 0) continue;
    const text = decodeEntities(token);
    if (heading) heading.text += text;
    else paragraph += text;
  }

  flushParagraph();
  finishCurrent();

  const navTitle = cleanHtmlText(opts.navTitle);
  const fallbackTitle = navTitle || docTitle;
  let preamble = preambleBlocks.join('\n\n').trim();

  // 第一页常见“书名/作者”标题：若后面还有真正的章节标题，把第一个非章节标题移到前言，避免误当章节。
  if (chapters.length > 1 && !looksLikeChapter(chapters[0].rawTitle, opts.rules)) {
    const laterHasChapter = chapters.slice(1).some((ch) => looksLikeChapter(ch.rawTitle, opts.rules));
    if (laterHasChapter) {
      const first = chapters.shift();
      preamble = [preamble, first.rawTitle, first.body].filter(Boolean).join('\n\n');
    }
  }

  if (!chapters.length) {
    const bodyText = [preamble].filter(Boolean).join('\n\n');
    if (fallbackTitle) {
      chapters.push({
        rawTitle: fallbackTitle,
        title: fallbackTitle,
        lines: [],
        body: bodyText,
      });
      preamble = '';
    } else if (bodyText) {
      warnings.push('该 EPUB 页面没有 h1-h6 章节标题，内容已保留在正文前部分；未猜造章节名。');
    }
  }

  return {
    docTitle,
    navTitle,
    preamble,
    chapters,
    warnings,
  };
}

function looksLikeChapter(title, rules) {
  return Boolean(parseChapterTitle(title, rules)) || looksChapterish(title);
}

function parseNavTitles(zip, manifest, opfDir, warnings) {
  const titles = new Map();

  const navItem = Object.values(manifest).find((item) =>
    String(item.properties || '').split(/\s+/).includes('nav'));
  const navPath = navItem ? resolveHref(opfDir, navItem.href) : '';
  if (navPath && zip.has(navPath)) {
    const navHtml = decodeTextBuffer(zip.get(navPath)).text;
    const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = re.exec(navHtml))) {
      const href = getAttr(match[1], 'href');
      const label = stripTags(match[2]);
      if (!href || !label) continue;
      const path = resolveHref(opfDir, href);
      if (path && !titles.has(path)) titles.set(path, label);
    }
  }

  if (!titles.size) {
    const ncxItem = Object.values(manifest).find((item) =>
      /ncx/i.test(item['media-type'] || '') || /\.ncx$/i.test(item.href || ''));
    if (ncxItem) {
      const ncxPath = resolveHref(opfDir, ncxItem.href);
      if (zip.has(ncxPath)) {
        const ncx = decodeTextBuffer(zip.get(ncxPath)).text;
        const blockRe = /<navPoint\b[^>]*>([\s\S]*?)<\/navPoint>/gi;
        let block;
        while ((block = blockRe.exec(ncx))) {
          const label = getTagText(block[1], 'text');
          const src = getAttr(/<content\b[^>]*>/i.exec(block[1])?.[0] || '', 'src');
          const path = resolveHref(opfDir, src);
          if (path && label && !titles.has(path)) titles.set(path, label);
        }
      }
    }
  }

  if (!titles.size) warnings.push('未找到 EPUB 的导航目录（nav/NCX），章节标题仅从正文标题提取。');
  return titles;
}

function parseOpf(opfXml, opfPath) {
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const manifest = {};
  const itemRe = /<item\b[^>]*>/gi;
  let itemMatch;
  while ((itemMatch = itemRe.exec(opfXml))) {
    const tag = itemMatch[0];
    const id = getAttr(tag, 'id');
    if (!id) continue;
    manifest[id] = {
      id,
      href: getAttr(tag, 'href'),
      'media-type': getAttr(tag, 'media-type'),
      properties: getAttr(tag, 'properties'),
    };
  }

  const spine = [];
  const refRe = /<itemref\b[^>]*>/gi;
  let refMatch;
  while ((refMatch = refRe.exec(opfXml))) {
    const idref = getAttr(refMatch[0], 'idref');
    if (idref) spine.push(idref);
  }

  const metadata = {
    title: getTagText(opfXml, 'dc:title'),
    creator: getTagText(opfXml, 'dc:creator'),
    language: getTagText(opfXml, 'dc:language'),
    identifier: getTagText(opfXml, 'dc:identifier'),
  };
  const title = metadata.title || '';
  return { opfDir, manifest, spine, metadata, title };
}

function readEpub(value, options) {
  const opts = options || {};
  const zip = readZip(value);
  const container = zip.get('META-INF/container.xml');
  if (!container) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml。');
  const containerXml = decodeTextBuffer(container).text;
  const rootfileTag = /<rootfile\b[^>]*>/i.exec(containerXml)?.[0] || '';
  const opfPath = getAttr(rootfileTag, 'full-path').replace(/^\/+/, '');
  if (!opfPath || !zip.has(opfPath)) throw new Error('不是有效的 EPUB：container.xml 指向的 OPF 不存在。');

  const opfXml = decodeTextBuffer(zip.get(opfPath)).text;
  const { opfDir, manifest, spine, metadata } = parseOpf(opfXml, opfPath);
  const warnings = [];
  const navTitles = parseNavTitles(zip, manifest, opfDir, warnings);
  const preambleParts = [];
  const chapters = [];

  for (const idref of spine) {
    const item = manifest[idref];
    if (!item || !item.href) continue;
    const mediaType = String(item['media-type'] || '').toLowerCase();
    if (mediaType && !/xhtml|html|xml/.test(mediaType)) continue;
    const path = resolveHref(opfDir, item.href);
    if (!zip.has(path)) {
      warnings.push(`EPUB spine 中的文件不存在：${path}`);
      continue;
    }
    const html = decodeTextBuffer(zip.get(path)).text;
    const parsed = extractFromXhtml(html, {
      navTitle: navTitles.get(path) || '',
      rules: opts.rules,
    });
    warnings.push(...parsed.warnings);
    if (parsed.preamble) preambleParts.push(parsed.preamble);
    for (const chapter of parsed.chapters) {
      chapters.push({
        ...chapter,
        sourcePath: path,
      });
    }
  }

  if (!chapters.length) {
    throw new Error('EPUB 中没有找到可转换的正文内容（spine 为空或所有页面都被跳过）。');
  }

  // 统一按“第N章”规范处理；规范覆盖不到的标题保持原样并警告。
  const normalized = chapters.map((chapter) => {
    const candidates = [chapter.rawTitle, chapter.sourceTitle, chapter.title].filter(Boolean);
    let parsed = null;
    for (const candidate of candidates) {
      parsed = parseChapterTitle(candidate, opts.rules);
      if (parsed) break;
    }
    if (parsed) {
      return {
        ...chapter,
        number: parsed.number,
        title: parsed.title,
        normalizedTitle: parsed.normalizedTitle,
        sourceTitle: chapter.rawTitle,
      };
    }
    const title = String(chapter.rawTitle || chapter.title || '').trim();
    if (title) warnings.push(`规范未覆盖的 EPUB 标题，已原样保留：${title.slice(0, 80)}`);
    return {
      ...chapter,
      number: null,
      title,
      normalizedTitle: title,
      sourceTitle: chapter.rawTitle || title,
    };
  });

  return {
    title: metadata.title || opts.bookName || '',
    author: metadata.creator || '',
    language: metadata.language || 'zh-CN',
    identifier: metadata.identifier || '',
    preamble: preambleParts.join('\n\n').trim(),
    chapters: normalized,
    warnings: [...new Set(warnings)],
    sourceFormat: 'epub',
    encoding: 'epub',
  };
}

function uuidFrom(seed) {
  const hex = crypto.createHash('sha256').update(String(seed)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function paragraphsToHtml(value) {
  const paragraphs = Array.isArray(value) ? value : splitParagraphs(value);
  return paragraphs.map((block) => {
    const lines = block.split(/\n/)
      .map((line) => stripParagraphIndent(line).replace(/^[ \t]+|[ \t]+$/g, ''))
      .map((line) => escapeXml(line))
      .filter(Boolean);
    return `<p class="body-paragraph" style="text-indent:2em;">${lines.join('<br/>')}</p>`;
  }).join('\n');
}

/**
 * 前言片段：不生成 h1-h6，避免被解析器误当成章节。
 * 前言标题单独使用不缩进的 preamble-title，正文段落统一 2em。
 */
function preambleToFragment(preamble) {
  const { headingText, rest } = splitPreamble(preamble);
  const body = paragraphsToHtml(splitParagraphs(markdownToPlain(rest, { stripHeadings: false })));
  return `${headingText ? `<p class="preamble-title"><strong>${escapeXml(headingText)}</strong></p>` : ''}\n${body}`.trim();
}

function xhtmlDocument(title, bodyHtml, language) {
  const lang = language || 'zh-CN';
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(lang)}" lang="${escapeXml(lang)}">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function buildEpub(book, options) {
  const opts = options || {};
  const bookName = String(opts.bookName || book.bookName || book.title || '未命名').trim() || '未命名';
  const language = String(book.language || 'zh-CN').trim() || 'zh-CN';
  const author = String(book.author || '').trim();
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  if (!chapters.length) throw new Error('没有章节，无法生成 EPUB。');

  const id = uuidFrom(`${bookName}\n${book.author || ''}\n${chapters.map((ch) => ch.normalizedTitle || ch.title || '').join('\n')}`);
  const modified = String(opts.modified || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const manifest = [];
  const spine = [];
  const navItems = [];
  const entries = [];
  const cover = opts.cover && opts.cover.data ? opts.cover : null;

  const addItem = (item) => {
    manifest.push(item);
    entries.push({ name: item.zipPath, data: Buffer.from(item.content, 'utf8') });
    if (item.spine) spine.push(item.id);
    if (item.navTitle) navItems.push({ href: item.href, title: item.navTitle });
  };

  const preambleFragment = preambleToFragment(book.preamble);

  chapters.forEach((chapter, index) => {
    const number = index + 1;
    const id = `chapter-${String(number).padStart(4, '0')}`;
    const title = String(chapter.normalizedTitle || chapter.title || '').trim() || `章节 ${number}`;
    const paragraphs = Array.isArray(chapter.plainParagraphs)
      ? chapter.plainParagraphs
      : splitParagraphs(chapter.plainBody || chapter.body || '');
    const bodyHtml = paragraphsToHtml(paragraphs);
    // 前言并入第一章 XHTML、放在 h2 之前，避免额外的“正文前”伪章节。
    const before = index === 0 && preambleFragment ? `${preambleFragment}\n` : '';
    const content = xhtmlDocument(title, `${before}<h2>${escapeXml(title)}</h2>\n${bodyHtml}`, language);
    addItem({
      id,
      href: `${id}.xhtml`,
      zipPath: `OEBPS/${id}.xhtml`,
      mediaType: 'application/xhtml+xml',
      content,
      navTitle: title,
      spine: true,
    });
  });

  const navXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
<head><meta charset="utf-8"/><title>目录</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<nav epub:type="toc" id="toc">
<h1>目录</h1>
<ol>
${navItems.map((item) => `<li><a href="${escapeXml(item.href)}">${escapeXml(item.title)}</a></li>`).join('\n')}
</ol>
</nav>
</body>
</html>`;

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
<meta name="dtb:uid" content="urn:uuid:${id}"/>
<meta name="dtb:depth" content="1"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${escapeXml(bookName)}</text></docTitle>
<navMap>
${navItems.map((item, index) => `<navPoint id="navPoint-${index + 1}" playOrder="${index + 1}">
<navLabel><text>${escapeXml(item.title)}</text></navLabel>
<content src="${escapeXml(item.href)}"/>
</navPoint>`).join('\n')}
</navMap>
</ncx>`;

  const style = `body { font-family: "Noto Serif CJK SC", "Source Han Serif SC", serif; line-height: 1.8; margin: 1.2em; }
h1, h2 { line-height: 1.4; margin: 1.2em 0 0.8em; }
p { margin: 0.6em 0; }
.body-paragraph { text-indent: 2em; }
.preamble-title { text-indent: 0; font-weight: bold; }`;

  // 封面：只写图片本体 + OPF 元数据，不新增 XHTML 页，避免改变章节文件数量与校验。
  const coverExt = cover ? String(cover.ext || 'jpg').replace(/^\./, '').toLowerCase() : '';
  const coverMediaType = cover ? String(cover.mediaType || 'image/jpeg') : '';
  const coverHref = cover ? `cover.${coverExt}` : '';
  const coverXml = cover
    ? `<item id="cover-image" href="${coverHref}" media-type="${escapeXml(coverMediaType)}" properties="cover-image"/>`
    : '';
  const coverMetaXml = cover ? '<meta name="cover" content="cover-image"/>' : '';
  if (cover) entries.push({ name: `OEBPS/${coverHref}`, data: cover.data });

  const manifestXml = manifest.map((item) =>
    `<item id="${escapeXml(item.id)}" href="${escapeXml(item.href)}" media-type="${escapeXml(item.mediaType)}"/>`).join('\n');
  const spineXml = spine.map((id) => `<itemref idref="${escapeXml(id)}"/>`).join('\n');
  const creatorXml = author ? `<dc:creator>${escapeXml(author)}</dc:creator>` : '';
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${escapeXml(language)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">urn:uuid:${id}</dc:identifier>
<dc:title>${escapeXml(bookName)}</dc:title>
<dc:language>${escapeXml(language)}</dc:language>
${creatorXml}
<meta property="dcterms:modified">${modified}</meta>
${coverMetaXml}
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="style" href="style.css" media-type="text/css"/>
${coverXml}
${manifestXml}
</manifest>
<spine toc="ncx">
${spineXml}
</spine>
</package>`;

  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>`;

  const allEntries = [
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'ascii'), store: true },
    { name: 'META-INF/container.xml', data: Buffer.from(container, 'utf8') },
    { name: 'OEBPS/content.opf', data: Buffer.from(opf, 'utf8') },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(navXhtml, 'utf8') },
    { name: 'OEBPS/toc.ncx', data: Buffer.from(ncx, 'utf8') },
    { name: 'OEBPS/style.css', data: Buffer.from(style, 'utf8') },
    ...entries,
  ];

  return writeZip(allEntries);
}

module.exports = {
  readEpub,
  buildEpub,
  extractFromXhtml,
  resolveHref,
  parseOpf,
  uuidFrom,
  xhtmlDocument,
  paragraphsToHtml,
};

},
"lib/paths.js": function (module, exports, __require, require) {
'use strict';

class PathConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathConfigError';
  }
}

/** 校验并规范化 vault 内相对路径；拒绝绝对路径和任何 `..` 段。 */
function normalizeVaultRelativePath(value, field) {
  const label = field || '路径';
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  const text = raw.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(text) || text.startsWith('/') || text.startsWith('//')) {
    throw new PathConfigError(`${label}必须使用 vault 内相对路径，不能是绝对路径：${raw}`);
  }
  const parts = text.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw new PathConfigError(`${label}不能包含 ..：${raw}`);
  }
  if (!parts.length) throw new PathConfigError(`${label}不能是 vault 根目录。`);
  return parts.join('/');
}

function defaultBookDir(bookRoot, bookName) {
  const root = normalizeVaultRelativePath(bookRoot, '书库目录');
  const name = String(bookName == null ? '' : bookName).trim();
  if (!name) throw new PathConfigError('书籍标识不能为空，无法计算默认目录。');
  return normalizeVaultRelativePath(`${root}/${name}`, '默认目录');
}

function resolveOutputDir(value, fallback, field) {
  const label = field || '输出目录';
  const target = String(value == null ? '' : value).trim() || fallback;
  return normalizeVaultRelativePath(target, label);
}

function normalizeBookProfile(profile, index) {
  const record = profile && typeof profile === 'object' ? profile : {};
  return {
    id: String(record.id || `book-${index + 1}`),
    bookName: String(record.bookName || record.name || '').trim(),
    mdDir: String(record.mdDir || (record.outputs && record.outputs.md) || '').trim(),
    txtDir: String(record.txtDir || (record.outputs && record.outputs.txt) || '').trim(),
    epubDir: String(record.epubDir || (record.outputs && record.outputs.epub) || '').trim(),
    cardDir: String(record.cardDir || '').trim(),
  };
}

function migrateSettings(settings) {
  const next = settings && typeof settings === 'object' ? settings : {};
  if (next.settingsVersion == null) next.settingsVersion = 2;
  if (!Array.isArray(next.bookProfiles)) next.bookProfiles = [];
  next.bookProfiles = next.bookProfiles.map((entry, index) => normalizeBookProfile(entry, index));
  return next;
}

function findBookProfile(profiles, options) {
  const list = Array.isArray(profiles) ? profiles : [];
  const bookName = String((options && options.bookName) || '').trim();
  for (const entry of list) {
    if (bookName && entry.bookName === bookName) return entry;
  }
  for (const entry of list) {
    if (bookName && entry.bookName.toLowerCase() === bookName.toLowerCase()) return entry;
  }
  return null;
}

function validateProfilePaths(profile) {
  const entry = normalizeBookProfile(profile, 0);
  if (!entry.bookName) throw new PathConfigError('书籍标识不能为空。');
  for (const [field, value] of [
    ['Markdown 输出目录', entry.mdDir],
    ['TXT 输出目录', entry.txtDir],
    ['EPUB 输出目录', entry.epubDir],
    ['书籍卡片目录', entry.cardDir],
  ]) {
    if (value) normalizeVaultRelativePath(value, field);
  }
  return entry;
}

function outputDirsForProfile(profile, bookRoot, bookName, fallbackDir) {
  const fallback = fallbackDir || defaultBookDir(bookRoot, bookName);
  return {
    md: resolveOutputDir(profile && profile.mdDir, fallback, 'Markdown 输出目录'),
    txt: resolveOutputDir(profile && profile.txtDir, fallback, 'TXT 输出目录'),
    epub: resolveOutputDir(profile && profile.epubDir, fallback, 'EPUB 输出目录'),
  };
}

module.exports = {
  PathConfigError,
  normalizeVaultRelativePath,
  defaultBookDir,
  resolveOutputDir,
  normalizeBookProfile,
  migrateSettings,
  findBookProfile,
  validateProfilePaths,
  outputDirsForProfile,
};

},
"lib/scaffold.js": function (module, exports, __require, require) {
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

const { normalizeDir, normalizeShelfBase } = __require("lib/templates.js");

const INBOX_DIR = '00 收件箱';
const SHARED_ATTACH_DIR = '90 附件';
const DIR_NOTE_FILE = '_目录说明.md';
const RECOMMENDATION_FILE = '书库结构建议.md';

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
    '> 书库目录里已经有内容了，插件**没有改动任何文件**。这份文件只解释推荐结构，是否调整由你自己决定。',
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
    '> 只有「书库目录」为空时，插件才能一键布置目录结构。你现在已有内容，所以这里只给建议。',
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
  posixDirname,
  dirNoteContent,
  scaffoldPlan,
  recommendationMarkdown,
};

},
"lib/templates.js": function (module, exports, __require, require) {
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

const { sanitizeFileName } = __require("lib/text.js");

const DEFAULT_CARD_DIR = '20 笔记/书目';
const DEFAULT_READING_DIR = '20 笔记/读书笔记';
const DEFAULT_SHELF_BASE = '90 书架/书架.base';

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

},
"lib/text.js": function (module, exports, __require, require) {
'use strict';

const { TextDecoder } = require('util');

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', deg: '°',
  times: '×', divide: '÷', laquo: '«', raquo: '»', szlig: 'ß',
};

// TXT 的纯文本缩进；Markdown 改由 frontmatter cssclasses + 插件 CSS 控制 2em。
const TXT_INDENT = '\u3000\u3000';

const LEADING_INDENT_RE = /^(?:(?:&(?:emsp|ensp|nbsp|thinsp);)|&#(?:8194|8195|160|12288|x2002|x2003|x00a0);|[\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000])+/i;

function stripParagraphIndent(value) {
  return String(value == null ? '' : value).replace(LEADING_INDENT_RE, '');
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(String(value), 'utf8');
}

/**
 * 读取 txt/epub 内的文本：BOM → UTF-8 → GB18030。
 * 返回 encoding 便于报告，而不是静默猜测。
 */
function decodeTextBuffer(value) {
  const buffer = toBuffer(value);
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const copy = Buffer.from(buffer.subarray(2));
    copy.swap16();
    return { text: copy.toString('utf16le'), encoding: 'utf-16be' };
  }

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch {
    try {
      return { text: new TextDecoder('gb18030').decode(buffer), encoding: 'gb18030' };
    } catch {
      return { text: buffer.toString('utf8'), encoding: 'utf-8-lossy' };
    }
  }
}

function decodeEntities(value) {
  return String(value == null ? '' : value).replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]+));/g,
    (whole, dec, hex, name) => {
      if (dec) {
        const code = Number(dec);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      if (hex) {
        const code = parseInt(hex, 16);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      const lower = String(name).toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)
        ? NAMED_ENTITIES[lower]
        : whole;
    },
  );
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeHtml(value) {
  return escapeXml(value);
}

/** 把常见 Markdown 转成可读纯文本；不追求完整 CommonMark，只服务于 txt/epub。 */
function markdownToPlain(value, options) {
  const stripHeadings = !options || options.stripHeadings !== false;
  let text = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
  text = text.replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/, '');
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, '$1');
  text = text.replace(/~~~[^\n]*\n([\s\S]*?)~~~/g, '$1');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (whole, alt) => alt || '');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  if (stripHeadings) text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, '');
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
  text = text.replace(/^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/gm, '');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '$1');
  text = text.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/?(?:p|div|section|article|blockquote|li|ul|ol|h[1-6])\b[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  return text.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 按空行分块；块内单换行保留。
 * 默认剥离每行行首的所有缩进（全角/半角空格、Tab、emsp 实体等），
 * 避免把源文件里已有的缩进带进新文件后与渲染缩进叠加。
 *
 * 自动模式：如果全文几乎没有空行，但绝大多数非空行以句末标点结尾
 * （典型 TXT 是“一行一段”），则按行分段；否则按空行分段。
 */
function splitParagraphs(value, options) {
  const opts = options || {};
  const stripIndent = opts.stripIndent !== false;
  const text = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
  if (!text.replace(/[\s\u3000\u2000-\u200a]/g, '')) return [];

  const allLines = text.split('\n');
  const nonEmptyLines = allLines.filter((line) => line.replace(/[\s\u3000\u2000-\u200a]/g, ''));
  const blankRatio = allLines.length ? (allLines.length - nonEmptyLines.length) / allLines.length : 0;
  const terminatedRatio = nonEmptyLines.length
    ? nonEmptyLines.filter((line) => /[。！？….”』」】）)]$/.test(line.trim())).length / nonEmptyLines.length
    : 0;
  const indentedRatio = nonEmptyLines.length
    ? nonEmptyLines.filter((line) => /^[\t \u3000]/.test(line)).length / nonEmptyLines.length
    : 0;

  const lineMode = opts.lineMode === true ||
    (opts.lineMode !== 'block' &&
      nonEmptyLines.length > 1 &&
      blankRatio < 0.08 &&
      (terminatedRatio >= 0.5 || indentedRatio >= 0.8));

  const cleanLine = (line) => {
    let cleaned = line.replace(/[ \t]+$/g, '');
    if (stripIndent) cleaned = stripParagraphIndent(cleaned);
    return cleaned;
  };
  const isContent = (line) => line.replace(/[\s\u3000\u2000-\u200a]/g, '');

  if (lineMode) {
    return nonEmptyLines.map(cleanLine).filter(isContent);
  }

  return text.split(/\n[ \t]*\n+/)
    .map((block) => {
      const lines = block.split('\n').map(cleanLine);
      while (lines.length && !isContent(lines[0])) lines.shift();
      while (lines.length && !isContent(lines[lines.length - 1])) lines.pop();
      return lines.join('\n');
    })
    .filter(isContent);
}

function paragraphsFromText(value) {
  return splitParagraphs(value);
}

function normalizePlainBody(value) {
  return splitParagraphs(value).join('\n\n');
}

/** 拆出前言标题（Markdown 标题或“作品简介：”这类单行标题）与正文。 */
function splitPreamble(value) {
  const lines = String(value == null ? '' : value).replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[0].replace(/[\s\u3000\u2000-\u200a]/g, '')) lines.shift();
  while (lines.length && !lines[lines.length - 1].replace(/[\s\u3000\u2000-\u200a]/g, '')) lines.pop();
  if (!lines.length) return { headingRaw: '', headingText: '', rest: '' };
  const index = lines.findIndex((line) => line.trim());
  if (index < 0) return { headingRaw: '', headingText: '', rest: '' };
  const first = lines[index].trim();
  const markdownHeading = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/.exec(lines[index]);
  const plainHeading = /^(作品简介|内容简介|简介|文案|前言|序言)[ \t]*[:：]?[ \t]*$/.test(first);
  if (!markdownHeading && !plainHeading) {
    // 保留首段原有的缩进，校验环节需要看到它；渲染时再统一剥离并重加。
    return { headingRaw: '', headingText: '', rest: lines.join('\n') };
  }
  const headingRaw = markdownHeading ? lines[index].trim() : first;
  const headingText = markdownHeading ? markdownHeading[2].trim() : first;
  const rest = [...lines.slice(0, index), ...lines.slice(index + 1)].join('\n').replace(/^\n+|\n+$/g, '');
  return { headingRaw, headingText, rest };
}

function indentParagraphs(paragraphs, prefix) {
  return paragraphs.map((paragraph) => `${prefix}${paragraph}`).join('\n\n');
}

function sanitizeFileName(name) {
  return String(name == null ? '' : name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim() || '未命名';
}

function formatBytes(size) {
  const bytes = Number(size) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

module.exports = {
  TXT_INDENT,
  toBuffer,
  decodeTextBuffer,
  decodeEntities,
  escapeXml,
  escapeHtml,
  markdownToPlain,
  stripParagraphIndent,
  splitParagraphs,
  paragraphsFromText,
  normalizePlainBody,
  splitPreamble,
  indentParagraphs,
  sanitizeFileName,
  formatBytes,
};

},
"lib/titles.js": function (module, exports, __require, require) {
'use strict';

/**
 * 章节标题缺失检测与本地标题建议生成。
 * 只做“建议”，不直接写盘；所有结果由调用方预览确认后再应用。
 */

const { splitParagraphs } = __require("lib/text.js");
const { formatChapterTitle } = __require("lib/chapters.js");

const TITLE_ALGORITHM_VERSION = 'local-v1';
const DEFAULT_MAX_TITLE_CHARS = 10;

const STRUCTURAL_TITLES = new Set([
  '序', '序章', '序言', '楔子', '引子', '前言', '尾声', '后记', '终章',
  '番外', '番外篇', '上', '下', '完', '上部', '下部',
]);

const PLACEHOLDER_TITLES = new Set([
  '未命名', '无题', '无标题', '正文', '章节', '新章', '本章', '新章节',
  'untitled', 'chapter', 'section', 'newchapter',
]);

const STOPWORDS = new Set([
  '我们', '你们', '他们', '她们', '自己', '一个', '没有', '什么', '这个', '那个',
  '这样', '那样', '已经', '还是', '就是', '不是', '可以', '因为', '所以', '但是',
  '如果', '然后', '现在', '时候', '知道', '觉得', '看着', '说道', '起来', '出来',
  '进来', '过去', '下来', '上去', '这里', '那里', '心里', '脸上', '眼里', '声音',
]);

function compactTitle(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/[\s\u3000]+/g, '')
    .replace(/^[（(\[【《“"「『]+/, '')
    .replace(/[）)\]】》”"」』]+$/, '')
    .replace(/[.、,，:：;；\-—_]+$/g, '');
}

function titleChars(value) {
  return Array.from(String(value == null ? '' : value).replace(/\s/g, ''));
}

function titleLength(value) {
  return titleChars(value).length;
}

function isStructuralTitle(title) {
  return STRUCTURAL_TITLES.has(compactTitle(title));
}

function isNumericTitle(title) {
  const value = compactTitle(title);
  return /^[0-9０-９]+$/.test(value) || /^[0-9０-９]+(?:[.\-_][0-9０-９]+)*$/.test(value);
}

function isPlaceholderTitle(title) {
  const value = compactTitle(title).toLowerCase();
  return PLACEHOLDER_TITLES.has(value) || /^第?[0-9０-９]+[章节]?$/.test(value);
}

function equalsChapterNumber(title, number) {
  if (number == null) return false;
  const value = compactTitle(title);
  const raw = String(number);
  const padded = raw.padStart(3, '0');
  return value === raw || value === padded || value === `第${raw}章` || value === `第${padded}章`;
}

function isLowInformationTitle(title) {
  const chars = titleChars(compactTitle(title));
  if (!chars.length) return false;
  const cjk = chars.filter((ch) => /[\u3400-\u9fff]/.test(ch)).length;
  const ascii = chars.filter((ch) => /[A-Za-z]/.test(ch)).length;
  if (cjk > 0) return cjk <= 2;
  return ascii > 0 && chars.length <= 3;
}

/**
 * 判断一章标题是否缺失/低识别度。
 * severity: hard（默认勾选）/ soft（只提示，默认不勾选）
 */
function detectTitleIssue(chapter, duplicateCounts, options) {
  const opts = options || {};
  const title = String(chapter && chapter.title != null ? chapter.title : '').trim();
  const compact = compactTitle(title);
  if (isStructuralTitle(compact)) return null;

  const reasons = [];
  if (!compact) reasons.push('empty');
  if (isNumericTitle(compact)) reasons.push('numeric');
  if (equalsChapterNumber(compact, chapter.number)) reasons.push('equals-number');
  if (isPlaceholderTitle(compact)) reasons.push('placeholder');
  if (chapter.number != null && duplicateCounts && duplicateCounts.get(compact) > 1) {
    reasons.push('duplicate');
  }
  if (reasons.length) return { severity: 'hard', reasons };

  const softReasons = [];
  if (isLowInformationTitle(compact)) softReasons.push('short');
  const bookName = opts.bookName ? compactTitle(opts.bookName) : '';
  if (bookName && compact === bookName) softReasons.push('same-as-book');
  if (softReasons.length) return { severity: 'soft', reasons: softReasons };
  return null;
}

function cleanCandidate(value, maxChars) {
  const max = Math.max(4, Math.min(24, Number(maxChars) || DEFAULT_MAX_TITLE_CHARS));
  let text = String(value == null ? '' : value)
    .replace(/<[^>]*>/g, '')
    .replace(/[#*_>`~]/g, '')
    .replace(/^[\s“”"「」『』【】\[\]（）()]+/, '')
    .replace(/[\s“”"「」『』【】\[\]（）()]+$/, '')
    .replace(/^[\-—–]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';

  let chars = titleChars(text);
  if (chars.length > max) {
    const cut = chars.slice(0, max).join('');
    const punctuation = ['，', '。', '、', '；', '：', '！', '？'];
    let last = -1;
    for (const mark of punctuation) last = Math.max(last, cut.lastIndexOf(mark));
    text = last >= 4 ? cut.slice(0, last) : cut;
  }
  text = text
    .replace(/[。！？!?，,、；;：:…]+$/u, '')
    .replace(/^[\s:：、.．\-—–]+/, '')
    .trim();
  if (titleLength(text) < 4) return '';
  if (isNumericTitle(text) || isPlaceholderTitle(text)) return '';
  return text;
}

function isDialogue(value) {
  return /^[\s“"「『]/.test(String(value == null ? '' : value));
}

function extractCandidates(chapter, maxChars) {
  const paragraphs = Array.isArray(chapter.plainParagraphs) && chapter.plainParagraphs.length
    ? chapter.plainParagraphs
    : splitParagraphs(chapter.plainBody || chapter.body || '');
  const source = paragraphs.slice(0, 3).join('\n').slice(0, 800);
  const candidates = [];
  const seen = new Set();

  const push = (raw, confidence, sourceType) => {
    const title = cleanCandidate(raw, maxChars);
    if (!title || seen.has(title)) return;
    seen.add(title);
    candidates.push({
      title,
      confidence,
      source: sourceType,
      excerpt: String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    });
  };

  const sentences = source
    .split(/[。！？!?；;\n]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const narrative = sentences.filter((sentence) => !isDialogue(sentence));
  for (const sentence of [...narrative, ...sentences]) push(sentence, 'high', 'sentence');

  for (const paragraph of paragraphs.slice(0, 3)) {
    push(paragraph.slice(0, 80), 'medium', 'paragraph');
  }

  // 极简中文 n-gram 兜底：仅在前两步失败时使用，标题质量标记为 low。
  const body = paragraphs.slice(0, 3).join('').slice(0, 500);
  const counts = new Map();
  const chars = titleChars(body).filter((ch) => /[\u3400-\u9fff]/.test(ch));
  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index + size <= chars.length; index += 1) {
      const gram = chars.slice(index, index + size).join('');
      if (STOPWORDS.has(gram) || /^[一二三四五六七八九十百千万]+$/.test(gram)) continue;
      counts.set(gram, (counts.get(gram) || 0) + 1);
    }
  }
  const keywords = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 8)
    .map(([word]) => word);
  for (const keyword of keywords) push(keyword, 'low', 'keyword');

  return candidates;
}

/**
 * 为整本书生成标题建议；不修改 book。
 * cache 是 { [chapterIndex]: { contentHash, suggestedTitle, ... } }。
 */
function buildTitleSuggestions(book, options) {
  const opts = options || {};
  const maxChars = Math.max(4, Math.min(24, Number(opts.maxChars) || DEFAULT_MAX_TITLE_CHARS));
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  const duplicateCounts = new Map();
  for (const chapter of chapters) {
    const compact = compactTitle(chapter.title || '');
    if (!compact) continue;
    duplicateCounts.set(compact, (duplicateCounts.get(compact) || 0) + 1);
  }

  const usedTitles = new Set();
  for (const chapter of chapters) {
    const compact = compactTitle(chapter.title || '');
    if (compact) usedTitles.add(compact);
  }

  const suggestions = [];
  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index];
    const issue = detectTitleIssue(chapter, duplicateCounts, { bookName: book.bookName });
    if (!issue) continue;
    const cacheEntry = opts.cache && opts.cache[index];
    const cacheHit = cacheEntry
      && cacheEntry.contentHash === opts.contentHash(chapter)
      && cacheEntry.suggestedTitle
      && cacheEntry.algorithmVersion === TITLE_ALGORITHM_VERSION;
    const cacheCandidates = cacheHit
      ? [{
        title: cacheEntry.suggestedTitle,
        confidence: cacheEntry.confidence || 'medium',
        source: cacheEntry.source || 'cache',
        excerpt: cacheEntry.excerpt || '',
      }]
      : [];
    const candidates = cacheCandidates.length
      ? cacheCandidates
      : extractCandidates(chapter, maxChars);

    let chosen = null;
    for (const candidate of candidates) {
      if (usedTitles.has(compactTitle(candidate.title))) continue;
      chosen = candidate;
      break;
    }
    const title = chosen ? chosen.title : '';
    const number = chapter.number;
    const normalizedTitle = title && number != null
      ? formatChapterTitle(number, title, opts.rules)
      : (title || String(chapter.normalizedTitle || chapter.title || ''));
    usedTitles.add(compactTitle(title));
    suggestions.push({
      index,
      number,
      currentTitle: String(chapter.normalizedTitle || chapter.title || '').trim(),
      title,
      normalizedTitle,
      severity: issue.severity,
      reasons: issue.reasons,
      confidence: chosen ? chosen.confidence : 'none',
      source: chosen ? chosen.source : 'none',
      excerpt: chosen ? chosen.excerpt : '',
      contentHash: opts.contentHash(chapter),
      needsReview: !title,
      reused: cacheCandidates.length > 0,
    });
  }
  return { suggestions, duplicateCounts, maxChars };
}

module.exports = {
  TITLE_ALGORITHM_VERSION,
  DEFAULT_MAX_TITLE_CHARS,
  compactTitle,
  titleLength,
  isNumericTitle,
  isPlaceholderTitle,
  isStructuralTitle,
  isLowInformationTitle,
  detectTitleIssue,
  cleanCandidate,
  extractCandidates,
  buildTitleSuggestions,
};

},
"lib/zip.js": function (module, exports, __require, require) {
'use strict';

/**
 * 极小 ZIP 读写器：只依赖 Node 内置 zlib。
 * - 写：EPUB 需要的 store/deflate、mimetype 首项且不压缩。
 * - 读：中央目录 + 本地文件头，支持 store/deflate（EPUB 常见）。
 * 不支持 ZIP64 / 加密 / 分卷；遇到时明确报错。
 */

const zlib = require('zlib');

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
const DOS_TIME = 0;
const DOS_DATE = 0x5021; // 2020-01-01

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(String(value), 'utf8');
}

function writeZip(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('ZIP 至少需要一个文件。');
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = String(entry.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name) throw new Error('ZIP 条目缺少文件名。');
    const nameBuffer = Buffer.from(name, 'utf8');
    if (nameBuffer.length > 0xffff) throw new Error(`ZIP 文件名过长：${name}`);
    const data = toBuffer(entry.data);
    const method = entry.store ? 0 : 8;
    const stored = method === 0 ? data : zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    if (stored.length > 0xffffffff || data.length > 0xffffffff || offset > 0xffffffff) {
      throw new Error('文件超过 4GB，当前 ZIP 写入器不支持 ZIP64。');
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + stored.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  if (entries.length > 0xffff) throw new Error('条目过多，当前 ZIP 写入器不支持 ZIP64。');
  if (centralOffset > 0xffffffff || centralSize > 0xffffffff) {
    throw new Error('ZIP 目录超过 4GB，当前写入器不支持 ZIP64。');
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) !== EOCD_SIG) continue;
    const commentLength = buffer.readUInt16LE(i + 20);
    if (i + 22 + commentLength === buffer.length) return i;
  }
  return -1;
}

function readZip(value) {
  const buffer = toBuffer(value);
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('不是有效的 ZIP/EPUB：未找到中央目录结尾。');
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0) throw new Error('不支持分卷 ZIP。');
  if (count === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error('该 EPUB 使用 ZIP64，当前解析器暂不支持；请先用 Calibre 另存为普通 EPUB。');
  }
  if (centralOffset + centralSize > buffer.length) throw new Error('ZIP 中央目录越界，文件可能损坏。');

  const entries = new Map();
  let pointer = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== CENTRAL_SIG) {
      throw new Error(`ZIP 中央目录第 ${i + 1} 项损坏。`);
    }
    const flags = buffer.readUInt16LE(pointer + 8);
    const method = buffer.readUInt16LE(pointer + 10);
    const crc = buffer.readUInt32LE(pointer + 16);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const nameStart = pointer + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) throw new Error('ZIP 条目文件名越界。');
    const name = buffer.subarray(nameStart, nameEnd).toString('utf8').replace(/\\/g, '/');
    pointer = nameEnd + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    if (flags & 0x1) throw new Error(`不支持加密 ZIP 条目：${name}`);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`ZIP 条目本地头损坏：${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`ZIP 条目数据越界：${name}`);
    const stored = buffer.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) data = Buffer.from(stored);
    else if (method === 8) data = zlib.inflateRawSync(stored);
    else throw new Error(`不支持的 ZIP 压缩方式 ${method}：${name}`);
    if (data.length !== uncompressedSize) throw new Error(`ZIP 条目解压长度不符：${name}`);
    if (crc32(data) !== crc) throw new Error(`ZIP 条目 CRC 校验失败：${name}`);
    entries.set(name, data);
  }

  return {
    entries,
    names: [...entries.keys()],
    get(name) { return entries.get(String(name).replace(/^\/+/, '')); },
    has(name) { return entries.has(String(name).replace(/^\/+/, '')); },
  };
}

module.exports = { crc32, writeZip, readZip };

},
"src/main.js": function (module, exports, __require, require) {
'use strict';

const crypto = require('crypto');
const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  Modal,
  FuzzySuggestModal,
  TFile,
  normalizePath,
} = require('obsidian');
const { parseBook, renderBook, FORMATS } = __require("lib/book.js");
const { formatChapterTitle } = __require("lib/chapters.js");
const {
  buildTitleSuggestions,
  compactTitle,
  isNumericTitle,
  isPlaceholderTitle,
  isStructuralTitle,
  titleLength,
  TITLE_ALGORITHM_VERSION,
} = __require("lib/titles.js");
const { formatBytes, sanitizeFileName } = __require("lib/text.js");
const {
  PathConfigError,
  normalizeVaultRelativePath,
  defaultBookDir,
  resolveOutputDir,
  normalizeBookProfile,
  migrateSettings,
  findBookProfile,
  validateProfilePaths,
  outputDirsForProfile,
} = __require("lib/paths.js");
const {
  DEFAULT_CARD_DIR,
  DEFAULT_READING_DIR,
  DEFAULT_SHELF_BASE,
  bookCardPath,
  readingNotePath,
  bookCardTemplate,
  readingNoteTemplate,
  shelfBoardTemplate,
  normalizeShelfBase,
  coverFileName,
  todayStamp,
} = __require("lib/templates.js");
const {
  INBOX_DIR,
  DIR_NOTE_FILE,
  RECOMMENDATION_FILE,
  dirNoteContent,
  scaffoldPlan,
  recommendationMarkdown,
} = __require("lib/scaffold.js");

const DEFAULT_SETTINGS = Object.freeze({
  bookRoot: '10 书籍',
  folderPerBook: true,
  chapterPrefix: '第',
  chapterSuffix: '章',
  chapterSeparator: ' ',
  backup: true,
  overwrite: true,
  txtLineEnding: 'lf',
  txtBom: false,
  maxTitleChars: 10,
  bookProfiles: [],
  cardDir: '20 笔记/书目',
  readingNoteDir: '20 笔记/读书笔记',
  shelfBasePath: DEFAULT_SHELF_BASE,
  autoShelf: true,
  ribbonLibrary: true,
  ribbonNewCard: true,
  autoRenameCover: true,
  cardSize: 220,
  cardAspectRatio: 0.72,
  allowScaffold: false,
  settingsVersion: 2,
});

/** 封面图片类型：EPUB cover 条目用。 */
const IMAGE_MIME = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
});

function posixDirname(value) {
  const text = String(value || '').replace(/\\/g, '/');
  const index = text.lastIndexOf('/');
  return index < 0 ? '' : text.slice(0, index);
}

function posixBasename(value) {
  const text = String(value || '').replace(/\\/g, '/');
  const index = text.lastIndexOf('/');
  return index < 0 ? text : text.slice(index + 1);
}

function extOf(value) {
  const name = posixBasename(value);
  const index = name.lastIndexOf('.');
  const ext = index >= 0 ? name.slice(index + 1).toLowerCase() : '';
  return FORMATS.includes(ext) ? ext : '';
}

function stemOf(value) {
  const name = posixBasename(value);
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(0, index) : name;
}

function posixJoin(...parts) {
  return parts
    .filter((part) => part != null && String(part).length)
    .map((part) => String(part).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

function timestamp() {
  const date = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function statusLabel(info) {
  return info ? `${info.ext} ${formatBytes(info.size)}` : '缺失';
}

class BookFormatSyncPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass('mod-clickable');
    this.registerDomEvent(this.statusBar, 'click', () => this.openLibrary());

    this.libraryRibbon = null;
    this.newCardRibbon = null;
    this.applyRibbonVisibility();

    this.addCommand({
      id: 'scan-library',
      name: '扫描书库（只读）',
      callback: () => this.openLibrary(),
    });
    this.addCommand({
      id: 'normalize-active-book',
      name: '规范化并生成当前书籍三格式',
      callback: () => this.normalizeActiveBook(),
    });
    this.addCommand({
      id: 'normalize-active-file',
      name: '只规范化当前文件',
      callback: () => this.normalizeOnlyActiveFile(),
    });
    this.addCommand({
      id: 'generate-title-suggestions',
      name: '生成章节标题建议（本地）',
      callback: () => this.generateTitleSuggestions(),
    });
    this.addCommand({
      id: 'convert-active-file',
      name: '从当前文件转换生成另外两种格式',
      callback: () => this.convertActiveFile(),
    });
    this.addCommand({
      id: 'normalize-all-books',
      name: '规范化书库全部书籍',
      callback: () => this.normalizeAllBooks(),
    });
    this.addCommand({
      id: 'new-book-card',
      name: '新建书籍卡',
      callback: () => this.newBookCardFlow(),
    });
    this.addCommand({
      id: 'new-reading-note',
      name: '新建读书笔记',
      callback: () => this.newReadingNoteFlow(),
    });
    this.addCommand({
      id: 'rename-cover-file',
      name: '按规则重命名当前书籍封面文件',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.renameActiveCover(file);
        return true;
      },
    });

    this.addCommand({
      id: 'scaffold-library',
      name: '布置书库目录结构',
      callback: () => { void this.scaffoldLibrary(); },
    });

    this.addSettingTab(new BookFormatSettingTab(this.app, this));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      this.addBookFileMenu(menu, file);
    }));
    this.registerEvent(this.app.workspace.on('file-open', () => this.updateStatusBar()));
    this.app.workspace.onLayoutReady(() => { this.updateStatusBar(); void this.refreshShelfBase(); });
  }

  /** 按设置创建/移除功能区按钮。 */
  applyRibbonVisibility() {
    const wantLibrary = this.settings.ribbonLibrary !== false;
    if (wantLibrary && !this.libraryRibbon) {
      this.libraryRibbon = this.addRibbonIcon('library', '书库', () => this.openLibrary());
    } else if (!wantLibrary && this.libraryRibbon) {
      this.libraryRibbon.remove();
      this.libraryRibbon = null;
    }

    const wantCard = this.settings.ribbonNewCard !== false;
    if (wantCard && !this.newCardRibbon) {
      this.newCardRibbon = this.addRibbonIcon('book-plus', '新建书籍卡', () => this.newBookCardFlow());
    } else if (!wantCard && this.newCardRibbon) {
      this.newCardRibbon.remove();
      this.newCardRibbon = null;
    }
  }

  newBookCardFlow() {
    new BookNameModal(this.app, (payload) => {
      void this.createBookCard(payload.name, payload.author, payload.cover);
    }).open();
  }

  newReadingNoteFlow() {
    new BookNameModal(this.app, (payload) => {
      void this.createReadingNote(payload.name);
    }, { heading: '新建读书笔记', showAuthor: false, showCover: false }).open();
  }

  /**
   * 把选中的图片重命名为《书名》-作者封面.ext（设置里可关闭）。
   * 只用 vault 内图片；远程地址原样返回。
   */
  async applyCoverNaming(bookName, author, cover) {
    try {
      const linkText = String(cover || '').replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('|')[0].trim();
      if (!linkText || /^https?:\/\//i.test(linkText)) return cover;
      const target = this.app.metadataCache.getFirstLinkpathDest(linkText, '');
      if (!target) return cover;
      const ext = (target.extension || 'png').toLowerCase();
      const wantedPath = posixJoin(posixDirname(target.path), coverFileName(bookName, author, ext));
      if (target.path === wantedPath) return target.path;
      if (await this.exists(wantedPath)) {
        new Notice(`已有同名封面，沿用原文件：${target.path}`, 6000);
        return target.path;
      }
      await this.app.fileManager.renameFile(target, wantedPath);
      new Notice(`封面已重命名为：${posixBasename(wantedPath)}`, 5000);
      return wantedPath;
    } catch (error) {
      return cover;
    }
  }

  addBookFileMenu(menu, file) {
    if (!(file instanceof TFile)) return;
    const ext = extOf(file.path);
    if (!ext) return;
    menu.addItem((item) => {
      item.setTitle('书库').setIcon('library');
      const submenu = item.setSubmenu();
      submenu.addItem((sub) => sub
        .setTitle('生成章节标题建议')
        .setIcon('list-plus')
        .onClick(() => {
          void this.generateTitleSuggestions(file);
        }));
      submenu.addItem((sub) => sub
        .setTitle('规范化并生成三格式')
        .setIcon('refresh-cw')
        .onClick(() => {
          void this.normalizeActiveBook(file);
        }));
      submenu.addItem((sub) => sub
        .setTitle('只规范化')
        .setIcon('file-check')
        .onClick(() => {
          void this.normalizeOnlyActiveFile(file);
        }));
      submenu.addItem((sub) => sub
        .setTitle('从当前文件生成另外两种')
        .setIcon('copy')
        .onClick(() => {
          void this.convertActiveFile(file);
        }));
    });
  }

  onunload() {
    if (this.statusBar) this.statusBar.remove();
  }

  async loadSettings() {
    let data = await this.loadData();
    // 旧插件（book-format-sync）改名前的设置迁移，只读旧 data.json，不做任何写入。
    if (!data) {
      const legacy = '.obsidian/plugins/book-format-sync/data.json';
      try {
        if (await this.exists(legacy)) data = JSON.parse(await this.adapter.read(legacy));
      } catch (error) {
        // 迁移失败不阻断加载，走默认设置
      }
    }
    this.settings = migrateSettings(Object.assign({}, DEFAULT_SETTINGS, data || {}));
    // notesRoot 是旧字段：迁移成卡片目录/笔记目录
    if (this.settings.notesRoot && !(data && data.cardDir)) {
      const root = String(this.settings.notesRoot).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || '20 笔记';
      this.settings.cardDir = `${root}/书目`;
      this.settings.readingNoteDir = `${root}/读书笔记`;
      this.settings.shelfBasePath = `${root}/书架.base`;
    }
    delete this.settings.notesRoot;
    // 设置页已移除“覆盖前备份”开关，统一始终备份
    this.settings.backup = true;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.updateStatusBar();
  }

  get adapter() {
    return this.app.vault.adapter;
  }

  get rootPath() {
    return normalizePath(String(this.settings.bookRoot || '10 书籍').replace(/^\/+|\/+$/g, '')) || '10 书籍';
  }

  get rules() {
    return {
      prefix: this.settings.chapterPrefix,
      suffix: this.settings.chapterSuffix,
      separator: this.settings.chapterSeparator,
    };
  }

  renderOptions(bookName, cover) {
    return {
      bookName,
      rules: this.rules,
      txtLineEnding: this.settings.txtLineEnding === 'crlf' ? 'crlf' : 'lf',
      txtBom: Boolean(this.settings.txtBom),
      cover: cover || null,
    };
  }

  /**
   * 解析书籍封面：优先书籍卡 frontmatter 的「封面」，其次书库内同名 md。
   * 只处理 vault 内图片；http(s) 远程封面不下载，避免联网与体积不可控。
   */
  async resolveCoverForBook(bookName) {
    const name = String(bookName || '').trim();
    if (!name) return null;
    const candidates = [];
    try {
      candidates.push(this.cardPathFor(name));
      candidates.push(posixJoin(this.rootPath, name, `${name}.md`));
      candidates.push(posixJoin(this.rootPath, `${name}.md`));
    } catch (error) {
      return null;
    }
    for (const mdPath of candidates) {
      if (!(await this.exists(mdPath))) continue;
      try {
        const text = await this.adapter.read(mdPath);
        const match = text.match(/^封面\s*:\s*(.+)$/m);
        if (!match) continue;
        const raw = match[1].trim().replace(/^["']|["']$/g, '').trim();
        if (!raw || /^https?:\/\//i.test(raw)) continue;
        const linkText = raw.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('|')[0].trim();
        if (!linkText) continue;
        const dest = this.app.metadataCache.getFirstLinkpathDest(linkText, mdPath);
        const target = dest && dest.path ? dest.path : linkText;
        if (!(await this.exists(target))) continue;
        const data = await this.readBuffer(target);
        const ext = (extOf(target) || 'jpg').toLowerCase();
        const mediaType = IMAGE_MIME[ext] || `image/${ext}`;
        return { data, ext, mediaType };
      } catch (error) {
        // 单个候选失败不影响其它候选
      }
    }
    return null;
  }

  async exists(filePath) {
    if (!filePath) return false;
    try {
      return await this.adapter.exists(filePath);
    } catch {
      return false;
    }
  }

  async ensureFolder(folder) {
    if (!folder) return;
    const parts = String(folder).replace(/\\/g, '/').split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.exists(current))) await this.adapter.mkdir(current);
    }
  }

  async readBuffer(filePath) {
    const data = await this.adapter.readBinary(filePath);
    return Buffer.from(data);
  }

  async writeBuffer(filePath, buffer) {
    await this.ensureFolder(posixDirname(filePath));
    await this.adapter.writeBinary(filePath, toArrayBuffer(buffer));
  }

  async backupFile(filePath, bookName, backupRoot) {
    if (!(await this.exists(filePath))) return '';
    const target = posixJoin(
      backupRoot,
      bookName,
      posixBasename(filePath),
    );
    const buffer = await this.readBuffer(filePath);
    await this.writeBuffer(target, buffer);
    return target;
  }

  async fileInfo(filePath, ext) {
    if (!(await this.exists(filePath))) return null;
    let size = 0;
    try {
      const stat = await this.adapter.stat(filePath);
      size = stat ? stat.size : 0;
    } catch {
      size = 0;
    }
    return { path: filePath, ext, size };
  }

  defaultOutputDirForBook(bookName) {
    const dir = this.settings.folderPerBook
      ? defaultBookDir(this.rootPath, bookName)
      : normalizeVaultRelativePath(this.rootPath, '默认输出目录');
    return dir;
  }

  profileFor(bookName, sourcePath) {
    return findBookProfile(this.settings.bookProfiles || [], { bookName, sourcePath });
  }

  outputDirsForBook(bookName, sourcePath) {
    const profile = this.profileFor(bookName, sourcePath);
    const fallback = this.defaultOutputDirForBook(bookName);
    if (!profile) {
      return { profile: null, md: fallback, txt: fallback, epub: fallback, defaultDir: fallback };
    }
    const entry = validateProfilePaths(profile);
    const dirs = outputDirsForProfile(entry, this.rootPath, bookName, fallback);
    return { profile: entry, ...dirs, defaultDir: fallback };
  }

  async resolveOriginalPath(profile, bookName, preferredPath) {
    if (preferredPath && extOf(preferredPath) && await this.exists(preferredPath)) {
      return preferredPath;
    }
    const fallback = this.defaultOutputDirForBook(bookName);
    for (const dir of [fallback, this.rootPath]) {
      for (const ext of ['md', 'txt', 'epub']) {
        const candidate = posixJoin(dir, `${bookName}.${ext}`);
        if (await this.exists(candidate)) return candidate;
      }
    }
    throw new PathConfigError(`未找到《${bookName}》的原件；请把文件放到 ${fallback}/，或从当前文件执行转换。`);
  }

  async validateProfileEntry(entry) {
    const normalized = validateProfilePaths(entry);
    const duplicate = (this.settings.bookProfiles || []).find(
      (item) => item.id !== normalized.id && item.bookName === normalized.bookName,
    );
    if (duplicate) throw new PathConfigError(`书籍标识重复：${normalized.bookName}`);
    return normalized;
  }

  async destinationFor(filePath) {
    const root = this.rootPath;
    const ext = extOf(filePath);
    if (!ext) throw new Error('只处理 txt、md、epub 三种格式。');
    const parent = posixDirname(filePath);
    const stem = stemOf(filePath);
    let bookName = stem;
    let defaultDir;
    let inFolderGroup = false;

    if (this.settings.folderPerBook) {
      if (parent === root) {
        defaultDir = posixJoin(root, stem);
      } else if (parent.startsWith(`${root}/`)) {
        const relative = parent.slice(root.length + 1);
        const first = relative.split('/')[0];
        if (parent === posixJoin(root, first)) {
          bookName = first;
          defaultDir = posixJoin(root, bookName);
          inFolderGroup = true;
        } else {
          defaultDir = posixJoin(root, stem);
        }
      } else {
        defaultDir = posixJoin(root, stem);
      }
    } else {
      defaultDir = root;
    }

    const profile = this.profileFor(bookName, filePath);
    if (profile) bookName = profile.bookName;
    const outputs = this.outputDirsForBook(bookName, filePath);
    return {
      bookName,
      destDir: defaultDir,
      outputDirs: outputs,
      sourcePath: filePath,
      ext,
      inFolderGroup,
      targets: Object.fromEntries(FORMATS.map((format) => [
        format,
        posixJoin(outputs[format], `${bookName}.${format}`),
      ])),
    };
  }

  async groupForName(bookName) {
    const root = this.rootPath;
    const folderDir = posixJoin(root, bookName);
    const folderFiles = {};
    for (const ext of FORMATS) {
      folderFiles[ext] = await this.fileInfo(posixJoin(folderDir, `${bookName}.${ext}`), ext);
    }
    const legacy = {};
    for (const ext of FORMATS) {
      legacy[ext] = await this.fileInfo(posixJoin(root, `${bookName}.${ext}`), ext);
    }
    const hasFolder = Object.values(folderFiles).some(Boolean);
    if (!hasFolder && !Object.values(legacy).some(Boolean)) return null;
    return {
      name: bookName,
      dir: this.settings.folderPerBook ? folderDir : root,
      files: hasFolder ? folderFiles : legacy,
      legacy: hasFolder ? legacy : {},
      hasFolder,
    };
  }

  async groupForFile(filePath) {
    const dest = await this.destinationFor(filePath);
    const files = {};
    for (const ext of FORMATS) {
      files[ext] = await this.fileInfo(dest.targets[ext], ext);
    }
    if (Object.values(files).some(Boolean)) {
      return {
        name: dest.bookName,
        dir: dest.outputDirs.md,
        files,
        legacy: {},
        hasFolder: true,
      };
    }
    return this.groupForName(dest.bookName);
  }

  pickSource(group, preferredPath) {
    if (preferredPath && extOf(preferredPath) && group.files[extOf(preferredPath)]) {
      return group.files[extOf(preferredPath)].path;
    }
    for (const ext of ['md', 'txt', 'epub']) {
      if (group.files[ext]) return group.files[ext].path;
    }
    return '';
  }

  async parseSource(sourcePath) {
    const format = extOf(sourcePath);
    if (!format) throw new Error(`不支持的格式：${sourcePath}`);
    const data = await this.readBuffer(sourcePath);
    const book = parseBook({
      sourcePath,
      sourceFormat: format,
      data,
      rules: this.rules,
    });
    return { book, data, format };
  }

  async materialize(book, destinations, options) {
    const opts = options || {};
    const dirs = typeof destinations === 'string'
      ? { md: destinations, txt: destinations, epub: destinations }
      : destinations;
    if (!dirs || !dirs.md || !dirs.txt || !dirs.epub) {
      throw new PathConfigError('输出目录配置不完整，无法生成三格式。');
    }
    const cover = await this.resolveCoverForBook(book.bookName);
    const rendered = renderBook(book, this.renderOptions(book.bookName, cover));
    const backupRoot = posixJoin('.book-format-sync', 'backups', timestamp());
    const results = [];
    const backedUp = new Set();
    const requested = Array.isArray(opts.formats) && opts.formats.length ? opts.formats : FORMATS;
    const formats = requested.filter((ext) => FORMATS.includes(ext));
    if (!formats.length) throw new PathConfigError('没有可写入的格式。');

    for (const ext of formats) {
      const outputDir = normalizeVaultRelativePath(dirs[ext], `${ext} 输出目录`);
      await this.ensureFolder(outputDir);
      const target = posixJoin(outputDir, `${book.bookName}.${ext}`);
      const sourceIsTarget = opts.sourcePath && opts.sourcePath === target;
      if (sourceIsTarget && opts.skipSourceFormat) {
        results.push({ ext, target, status: 'source-kept' });
        continue;
      }
      const existed = await this.exists(target);
      if (existed && opts.overwrite === false) {
        results.push({ ext, target, status: 'exists-skipped' });
        continue;
      }
      if (existed && (this.settings.backup || opts.forceBackup) && !backedUp.has(target)) {
        await this.backupFile(target, book.bookName, backupRoot);
        backedUp.add(target);
      }
      await this.writeBuffer(target, rendered[ext]);
      results.push({ ext, target, status: existed ? 'overwritten' : 'created' });
    }

    return { rendered, results, destDir: dirs.md, destinations: dirs };
  }

  async normalizeActiveBook(targetFile) {
    const file = targetFile || this.app.workspace.getActiveFile();
    if (!file || !extOf(file.path)) {
      new Notice('请先打开或右键选择一本 txt、md 或 epub 书籍。');
      return;
    }
    let group;
    let dest;
    try {
      group = await this.groupForFile(file.path);
      if (!group) {
        // 文件不在书库内（例如收件箱里的 txt）：按书名建立临时组。
        dest = await this.destinationFor(file.path);
        group = {
          name: dest.bookName,
          dir: dest.outputDirs.md,
          files: { [dest.ext]: { path: file.path, ext: dest.ext, size: 0 } },
          legacy: {},
          hasFolder: false,
        };
      }
    } catch (error) {
      new Notice(`路径配置错误：${error.message}`, 9000);
      return;
    }
    let sourcePath;
    let parsed;
    try {
      const preferred = this.pickSource(group, file.path);
      const profile = this.profileFor(group.name, preferred);
      sourcePath = await this.resolveOriginalPath(profile, group.name, preferred);
      parsed = await this.parseSource(sourcePath);
    } catch (error) {
      new Notice(`读取失败：${error.message}`, 9000);
      return;
    }
    let outputs;
    try {
      outputs = this.outputDirsForBook(parsed.book.bookName, sourcePath);
    } catch (error) {
      new Notice(`路径配置错误：${error.message}`, 9000);
      return;
    }
    const warnings = parsed.book.warnings;
    const ok = await this.askConfirm(
      '规范化并生成三格式',
      [
        `书籍：${parsed.book.bookName}`,
        `源文件：${sourcePath}`,
        `章节：${parsed.book.stats.chapterCount} 章，${parsed.book.stats.chars.toLocaleString()} 字`,
        `md 输出：${outputs.md}`,
        `txt 输出：${outputs.txt}`,
        `epub 输出：${outputs.epub}`,
        `章节规范：${this.rules.prefix}${parsed.book.chapters.length ? parsed.book.chapters[0].number : 1}${this.rules.suffix}${this.rules.separator}标题（不补零）`,
        warnings.length ? `注意：有 ${warnings.length} 条警告，将在完成后列出。` : '未发现章节号异常。',
        '',
        '会生成 md、txt、epub 三个同名文件；已存在的旧文件先备份到 .book-format-sync/backups。',
      ],
    );
    if (!ok) return;
    try {
      const result = await this.materialize(parsed.book, outputs, {
        sourcePath,
        overwrite: true,
        skipSourceFormat: false,
      });
      new ReportModal(this.app, '规范化完成', parsed.book, result, sourcePath).open();
    } catch (error) {
      new Notice(`生成失败：${error.message}`, 10000);
    }
  }

  async normalizeOnlyActiveFile(targetFile) {
    const file = targetFile || this.app.workspace.getActiveFile();
    if (!file || !extOf(file.path)) {
      new Notice('请先打开或右键选择一本 txt、md 或 epub 书籍。');
      return;
    }
    const ext = extOf(file.path);
    let dest;
    try {
      dest = await this.destinationFor(file.path);
    } catch (error) {
      new Notice(`路径配置错误：${error.message}`, 9000);
      return;
    }
    const target = dest.targets[ext];
    const sourceIsTarget = target === file.path;
    const targetExists = await this.exists(target);
    let parsed;
    try {
      parsed = await this.parseSource(file.path);
    } catch (error) {
      new Notice(`解析失败：${error.message}`, 9000);
      return;
    }

    const lines = [
      `源文件：${file.path}`,
      `只写入格式：${ext}`,
      `目标文件：${target}`,
      `章节：${parsed.book.stats.chapterCount} 章`,
      '只规范化当前文件，不生成另外两种格式，不改动其它已有格式。',
    ];
    if (sourceIsTarget) {
      lines.push('目标就是当前文件：会覆盖当前文件，覆盖前强制备份到 .book-format-sync/backups。');
    } else if (targetExists) {
      lines.push('目标已存在：会覆盖目标，覆盖前按设置备份；当前文件保持不变。');
    } else {
      lines.push('目标不存在：会新建当前格式的规范化副本；当前文件保持不变。');
    }
    if (!(await this.askConfirm('只规范化当前格式', lines))) return;

    try {
      const result = await this.materialize(parsed.book, dest.outputDirs, {
        sourcePath: file.path,
        overwrite: true,
        forceBackup: sourceIsTarget,
        formats: [ext],
      });
      new ReportModal(this.app, '只规范化完成', parsed.book, result, file.path).open();
    } catch (error) {
      new Notice(`只规范化失败：${error.message}`, 10000);
    }
  }

  async convertActiveFile(targetFile) {
    const file = targetFile || this.app.workspace.getActiveFile();
    if (!file || !extOf(file.path)) {
      new Notice('请先打开或右键选择一个 txt、md 或 epub 文件。');
      return;
    }
    let dest;
    try {
      dest = await this.destinationFor(file.path);
    } catch (error) {
      new Notice(`路径配置错误：${error.message}`, 9000);
      return;
    }
    const sourceIsTarget = Object.values(dest.targets).includes(file.path);
    let parsed;
    try {
      parsed = await this.parseSource(file.path);
    } catch (error) {
      new Notice(`解析失败：${error.message}`, 9000);
      return;
    }
    const existing = [];
    for (const ext of FORMATS) {
      if (await this.exists(dest.targets[ext])) existing.push(ext);
    }
    const lines = [
      `源文件：${file.path}`,
      `书籍名：${parsed.book.bookName}`,
      `章节：${parsed.book.stats.chapterCount} 章`,
      `md 输出：${dest.outputDirs.md}`,
      `txt 输出：${dest.outputDirs.txt}`,
      `epub 输出：${dest.outputDirs.epub}`,
    ];
    if (sourceIsTarget) {
      lines.push('源文件本身就在目标位置：为保持原文件不变，只生成另外两种格式，不覆盖源文件。');
      lines.push('如果源文件章节名还不规范，请再执行“规范化并生成当前书籍三格式”（该命令会先备份）。');
    } else {
      lines.push('源文件不在目标位置：会复制一份规范化后的同格式文件到配置的输出目录，原文件保持不变。');
    }
    if (existing.length) lines.push(`已存在：${existing.join('、')}；确认后按设置覆盖（默认先备份）。`);
    if (!(await this.askConfirm('从当前文件生成三格式', lines))) return;

    const beforeHash = sha256(parsed.data);
    try {
      const result = await this.materialize(parsed.book, dest.outputDirs, {
        sourcePath: file.path,
        overwrite: this.settings.overwrite !== false,
        skipSourceFormat: sourceIsTarget,
      });
      if (sourceIsTarget) {
        const afterHash = sha256(await this.readBuffer(file.path));
        if (beforeHash !== afterHash) throw new Error('内部校验失败：源文件被意外修改。');
      }
      new ReportModal(
        this.app,
        '转换完成',
        parsed.book,
        { ...result, sourceKept: sourceIsTarget, beforeHash },
        file.path,
      ).open();
    } catch (error) {
      new Notice(`转换失败：${error.message}`, 10000);
    }
  }

  titleCachePath(bookName) {
    return posixJoin('.book-format-sync', 'titles', `${sanitizeFileName(bookName)}.json`);
  }

  async loadTitleCache(bookName) {
    const empty = {
      version: 1,
      algorithmVersion: TITLE_ALGORITHM_VERSION,
      bookName,
      chapters: {},
    };
    try {
      const cachePath = this.titleCachePath(bookName);
      if (!(await this.exists(cachePath))) return empty;
      const text = await this.adapter.read(cachePath);
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || !data.chapters || typeof data.chapters !== 'object') {
        return empty;
      }
      return { ...empty, ...data, bookName, chapters: { ...data.chapters } };
    } catch {
      return empty;
    }
  }

  async saveTitleCache(cache) {
    const cachePath = this.titleCachePath(cache.bookName);
    const data = {
      ...cache,
      version: 1,
      algorithmVersion: TITLE_ALGORITHM_VERSION,
      updatedAt: new Date().toISOString(),
    };
    await this.writeBuffer(cachePath, Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8'));
  }

  chapterHash(chapter) {
    return sha256(Buffer.from(String(chapter.plainBody || ''), 'utf8')).slice(0, 16);
  }

  async generateTitleSuggestions(targetFile) {
    const file = targetFile || this.app.workspace.getActiveFile();
    if (!file || !extOf(file.path)) {
      new Notice('请先打开或右键选择一本 txt、md 或 epub 书籍。');
      return;
    }
    let group;
    try {
      group = await this.groupForFile(file.path);
      if (!group) {
        const dest = await this.destinationFor(file.path);
        group = {
          name: dest.bookName,
          dir: dest.outputDirs.md,
          files: { [dest.ext]: { path: file.path, ext: dest.ext, size: 0 } },
          legacy: {},
          hasFolder: false,
        };
      }
    } catch (error) {
      new Notice(`路径配置错误：${error.message}`, 9000);
      return;
    }
    const sourcePath = this.pickSource(group, file.path);
    let parsed;
    try {
      parsed = await this.parseSource(sourcePath);
    } catch (error) {
      new Notice(`解析失败：${error.message}`, 9000);
      return;
    }

    const maxChars = Math.max(4, Math.min(24, Number(this.settings.maxTitleChars) || 10));
    const cache = await this.loadTitleCache(parsed.book.bookName);
    const built = buildTitleSuggestions(parsed.book, {
      maxChars,
      rules: this.rules,
      bookName: parsed.book.bookName,
      contentHash: (chapter) => this.chapterHash(chapter),
      cache: cache.chapters,
    });

    if (!built.suggestions.length) {
      new Notice('没有发现需要生成标题的章节（没有空标题、纯数字编号、占位标题或重复标题）。', 7000);
      return;
    }

    const nextCache = {
      ...cache,
      algorithmVersion: TITLE_ALGORITHM_VERSION,
      bookName: parsed.book.bookName,
      chapters: { ...cache.chapters },
    };
    for (const suggestion of built.suggestions) {
      nextCache.chapters[suggestion.index] = {
        contentHash: suggestion.contentHash,
        suggestedTitle: suggestion.title,
        normalizedTitle: suggestion.normalizedTitle,
        originalTitle: suggestion.currentTitle,
        confidence: suggestion.confidence,
        source: suggestion.source,
        excerpt: suggestion.excerpt,
        algorithmVersion: TITLE_ALGORITHM_VERSION,
        status: suggestion.needsReview ? 'needs_review' : 'suggested',
        updatedAt: new Date().toISOString(),
      };
    }
    try {
      await this.saveTitleCache(nextCache);
    } catch (error) {
      new Notice(`标题缓存写入失败（不影响预览）：${error.message}`, 6000);
    }

    new TitlePreviewModal(
      this.app,
      this,
      parsed.book,
      built.suggestions,
      sourcePath,
      group,
      nextCache,
      maxChars,
    ).open();
  }

  async applyGeneratedTitles(book, group, sourcePath, selections, cache) {
    const maxChars = Math.max(4, Math.min(24, Number(this.settings.maxTitleChars) || 10));
    const prepared = [];

    for (const selection of selections) {
      const chapter = book.chapters[selection.index];
      if (!chapter || chapter.number == null) continue;
      let title = String(selection.title || '').trim().replace(/\s+/g, ' ');
      title = title.replace(/^第\s*[0-9０-９〇零一二三四五六七八九十百千万两]+\s*章[\s:：]*/u, '').trim();
      if (!title) continue;
      if (titleLength(title) > maxChars) {
        new Notice(`标题超过 ${maxChars} 字上限：${title}`, 8000);
        return false;
      }
      if (isNumericTitle(title) || isPlaceholderTitle(title)) {
        new Notice(`标题仍是编号或占位词，不能写入：${title}`, 8000);
        return false;
      }
      prepared.push({ index: selection.index, chapter, title });
    }

    if (!prepared.length) {
      new Notice('没有选中可写入的标题。');
      return false;
    }

    const counts = new Map();
    for (const chapter of book.chapters) {
      const key = compactTitle(chapter.title || '');
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const item of prepared) {
      const oldKey = compactTitle(item.chapter.title || '');
      if (oldKey) counts.set(oldKey, Math.max(0, (counts.get(oldKey) || 0) - 1));
    }
    for (const item of prepared) {
      const key = compactTitle(item.title);
      if (isStructuralTitle(key) || (counts.get(key) || 0) > 0) {
        new Notice(`生成标题重复：${item.title}，请换一个或保留数字编号。`, 9000);
        return false;
      }
      counts.set(key, 1);
    }

    for (const item of prepared) {
      item.chapter.title = item.title;
      item.chapter.normalizedTitle = formatChapterTitle(item.chapter.number, item.title, this.rules);
    }

    try {
      const outputs = this.outputDirsForBook(book.bookName, sourcePath);
      const result = await this.materialize(book, outputs, {
        sourcePath,
        overwrite: true,
        skipSourceFormat: false,
      });
      const nextCache = {
        ...(cache || {}),
        bookName: book.bookName,
        algorithmVersion: TITLE_ALGORITHM_VERSION,
        chapters: { ...((cache && cache.chapters) || {}) },
      };
      for (const item of prepared) {
        nextCache.chapters[item.index] = {
          ...(nextCache.chapters[item.index] || {}),
          status: 'accepted',
          acceptedTitle: item.title,
          acceptedAt: new Date().toISOString(),
          algorithmVersion: TITLE_ALGORITHM_VERSION,
        };
      }
      try {
        await this.saveTitleCache(nextCache);
      } catch (error) {
        new Notice(`标题已写入，但缓存保存失败：${error.message}`, 7000);
      }
      new ReportModal(this.app, '标题生成完成', book, result, sourcePath).open();
      return true;
    } catch (error) {
      new Notice(`标题写入失败：${error.message}`, 10000);
      return false;
    }
  }

  async scanLibrary() {
    const root = this.rootPath;
    if (!(await this.exists(root))) {
      new Notice(`书库目录不存在：${root}`, 8000);
      return [];
    }
    const listing = await this.adapter.list(root);
    const groups = [];
    const seen = new Set();
    const folderNames = new Set();

    for (const folder of listing.folders || []) {
      const name = posixBasename(folder);
      if (name.startsWith('.')) continue;
      folderNames.add(name);
      let child;
      try {
        child = await this.adapter.list(folder);
      } catch (error) {
        new Notice(`无法读取目录 ${folder}：${error.message}`, 6000);
        continue;
      }
      const files = {};
      for (const file of child.files || []) {
        const ext = extOf(file);
        if (ext && stemOf(file) === name) {
          files[ext] = await this.fileInfo(file, ext);
        }
      }
      if (!Object.values(files).some(Boolean)) continue;
      const legacy = {};
      for (const ext of FORMATS) {
        legacy[ext] = await this.fileInfo(posixJoin(root, `${name}.${ext}`), ext);
      }
      groups.push({ name, dir: folder, files, legacy, hasFolder: true });
      seen.add(name);
    }

    for (const file of listing.files || []) {
      const ext = extOf(file);
      if (!ext) continue;
      const name = stemOf(file);
      if (seen.has(name) || folderNames.has(name)) continue;
      const files = {};
      for (const format of FORMATS) {
        files[format] = await this.fileInfo(posixJoin(root, `${name}.${format}`), format);
      }
      if (!Object.values(files).some(Boolean)) continue;
      groups.push({
        name,
        dir: this.settings.folderPerBook ? posixJoin(root, name) : root,
        files,
        legacy: {},
        hasFolder: false,
      });
      seen.add(name);
    }

    groups.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return groups;
  }

  async normalizeAllBooks() {
    const groups = await this.scanLibrary();
    if (!groups.length) {
      new Notice('没有扫描到书籍。');
      return;
    }
    const incomplete = groups.filter((group) => Object.values(group.files).filter(Boolean).length < 3);
    if (!(await this.askConfirm(
      '规范化全部书籍',
      [
        `共 ${groups.length} 本书，其中 ${incomplete.length} 本尚未齐全。`,
        '将逐本读取现有格式、统一章节名并生成 md/txt/epub。',
        '已存在的目标文件会先备份到 .book-format-sync/backups。',
        '源文件若就在目标位置，会被规范化版本替换（原字节在备份中）。',
      ],
    ))) return;

    const notice = new Notice('正在规范化书库…', 0);
    const reports = [];
    let okCount = 0;
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      notice.setMessage(`正在处理 ${index + 1}/${groups.length}：${group.name}`);
      try {
        const preferred = this.pickSource(group);
        const profile = this.profileFor(group.name, preferred);
        const sourcePath = await this.resolveOriginalPath(profile, group.name, preferred);
        const parsed = await this.parseSource(sourcePath);
        const outputs = this.outputDirsForBook(parsed.book.bookName, sourcePath);
        const result = await this.materialize(parsed.book, outputs, {
          sourcePath,
          overwrite: true,
          skipSourceFormat: false,
        });
        reports.push({ name: group.name, source: sourcePath, status: 'ok', warnings: parsed.book.warnings, result });
        okCount += 1;
      } catch (error) {
        reports.push({ name: group.name, status: 'error', error: error.message });
      }
    }
    notice.hide();
    new BatchReportModal(this.app, '批量规范化完成', okCount, groups.length, reports).open();
  }

  async updateStatusBar() {
    if (!this.statusBar) return;
    const file = this.app.workspace.getActiveFile();
    const ext = file ? extOf(file.path) : '';
    const inBookRoot = Boolean(file) && (file.path === this.rootPath || file.path.startsWith(`${this.rootPath}/`));
    if (!file || !ext || !inBookRoot) {
      // 非书籍文件不占用状态栏
      this.statusBar.setText('');
      this.statusBar.title = '';
      return;
    }
    const group = await this.groupForFile(file.path).catch(() => null);
    if (!group) {
      this.statusBar.setText('三格式 0/3');
      return;
    }
    const count = Object.values(group.files).filter(Boolean).length;
    this.statusBar.setText(`三格式 ${count}/3`);
    this.statusBar.title = group.files
      ? Object.entries(group.files).map(([ext, info]) => `${ext}: ${statusLabel(info)}`).join('\n')
      : '';
  }

  openLibrary() {
    new LibraryModal(this.app, this).open();
  }

  /** 对当前书籍卡执行一次封面重命名（命令入口）。 */
  async renameActiveCover(file) {
    try {
      const text = await this.adapter.read(file.path);
      const coverMatch = text.match(/^封面\s*:\s*(.+)$/m);
      if (!coverMatch) {
        new Notice('当前笔记没有「封面」属性。');
        return false;
      }
      const raw = coverMatch[1].trim().replace(/^["']|["']$/g, '');
      const linkText = raw.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('|')[0].trim();
      if (!linkText || /^https?:\/\//i.test(linkText)) {
        new Notice('封面不是 vault 内图片，跳过。');
        return false;
      }
      const titleMatch = text.match(/^#\s*《(.+?)》/m);
      const bookName = titleMatch
        ? titleMatch[1].trim()
        : file.basename.replace(/^《|》$/g, '');
      const authorMatch = text.match(/^作者\s*:\s*(.+)$/m);
      const author = authorMatch ? authorMatch[1].trim().replace(/^["']|["']$/g, '') : '';
      const renamed = await this.applyCoverNaming(bookName, author, linkText);
      if (!renamed || renamed === linkText) {
        return false;
      }
      const next = text.replace(coverMatch[0], `封面: "[[${renamed}]]"`);
      await this.adapter.write(file.path, next);
      return true;
    } catch (error) {
      new Notice(`重命名封面失败：${error.message}`, 8000);
      return false;
    }
  }

  /** 目录是否不存在或为空。 */
  async isFolderEmpty(folderPath) {
    const path = String(folderPath || '').replace(/^\/+|\/+$/g, '');
    if (!path) return true;
    if (!(await this.exists(path))) return true;
    try {
      const listing = await this.adapter.list(path);
      return (listing.files || []).length === 0 && (listing.folders || []).length === 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * 布置书库目录结构。
   * - 默认关闭，需在设置里开启「允许布置书库结构」
   * - 只在用户主动触发时执行，加载时绝不自动运行
   * - 书库目录为空：创建推荐结构 + 目录说明文件，再重写书架 Base
   * - 书库目录已有内容：不改动任何文件，只生成一份结构建议
   */
  async scaffoldLibrary() {
    if (this.settings.allowScaffold !== true) {
      new Notice('请先在「设置 → 书库」开启「允许布置书库结构」。', 8000);
      return false;
    }

    const plan = scaffoldPlan({
      bookRoot: this.settings.bookRoot,
      cardDir: this.settings.cardDir,
      readingNoteDir: this.settings.readingNoteDir,
      shelfBasePath: this.settings.shelfBasePath,
    });
    const empty = await this.isFolderEmpty(this.rootPath);

    if (!empty) {
      const target = posixJoin(INBOX_DIR, RECOMMENDATION_FILE);
      if (await this.exists(target)) {
        new Notice(`书库已有内容，未做任何改动；建议文件已存在：${target}`, 7000);
        await this.app.workspace.openLinkText(target, '', false);
        return false;
      }
      const ok = await this.askConfirm('书库已有内容', [
        '不会移动、不会删除、不会覆盖任何现有文件。',
        `只会在「${INBOX_DIR}」生成一份结构建议，供你对照调整。`,
        '确定生成吗？',
      ]);
      if (!ok) return false;
      await this.ensureFolder(INBOX_DIR);
      await this.adapter.write(target, recommendationMarkdown({
        bookRoot: this.settings.bookRoot,
        cardDir: this.settings.cardDir,
        readingNoteDir: this.settings.readingNoteDir,
        shelfBasePath: this.settings.shelfBasePath,
        date: todayStamp(),
      }));
      new Notice(`已生成结构建议：${target}`, 6000);
      await this.app.workspace.openLinkText(target, '', false);
      return true;
    }

    const preview = plan.dirs.map((dir) => `· ${dir.path}`).join('\n');
    const ok = await this.askConfirm('布置书库目录结构', [
      '将创建以下目录（已存在的会跳过）：',
      preview,
      '每个目录会放一份「_目录说明.md」，已存在的文件不会被覆盖。',
      '确定继续吗？',
    ]);
    if (!ok) return false;

    let created = 0;
    for (const dir of plan.dirs) {
      if (!(await this.exists(dir.path))) {
        await this.ensureFolder(dir.path);
        created += 1;
      }
      const notePath = posixJoin(dir.path, DIR_NOTE_FILE);
      if (!(await this.exists(notePath))) {
        await this.adapter.write(notePath, dirNoteContent(dir.path, dir.desc));
      }
    }

    await this.refreshShelfBase(true);
    new Notice(`已布置 ${created} 个目录，并更新书架 Base。`, 7000);
    return true;
  }

  get cardDir() {
    return normalizeVaultRelativePath(this.settings.cardDir || DEFAULT_CARD_DIR, '书籍卡片目录');
  }

  get readingNoteDir() {
    return normalizeVaultRelativePath(this.settings.readingNoteDir || DEFAULT_READING_DIR, '读书笔记目录');
  }

  get shelfBasePath() {
    const configured = this.settings.shelfBasePath || DEFAULT_SHELF_BASE;
    return normalizeVaultRelativePath(normalizeShelfBase(configured, DEFAULT_SHELF_BASE), '书架 Base 路径');
  }

  /** 所有用到的卡片目录：全局 + 书级 cardDir（去重，非法路径忽略）。 */
  allCardDirs() {
    const dirs = new Set();
    try {
      dirs.add(this.cardDir);
    } catch (error) {
      dirs.add(DEFAULT_CARD_DIR);
    }
    for (const profile of this.settings.bookProfiles || []) {
      const raw = String((profile && profile.cardDir) || '').trim();
      if (!raw) continue;
      try {
        dirs.add(normalizeVaultRelativePath(raw, '书籍卡片目录'));
      } catch (error) {
        // 非法路径不进 Base 过滤
      }
    }
    return Array.from(dirs);
  }

  /** 某本书的卡片路径：书级 cardDir 优先，否则用全局卡片目录。 */
  cardPathFor(bookName) {
    const name = String(bookName || '').trim();
    const profile = this.profileFor(name, '');
    const dir = profile && profile.cardDir
      ? normalizeVaultRelativePath(profile.cardDir, '书籍卡片目录')
      : this.cardDir;
    return bookCardPath(dir, name);
  }

  /** 新建书籍卡：已存在则不覆盖，直接打开。 */
  async createBookCard(bookName, author, cover) {
    const name = String(bookName || '').trim();
    if (!name) {
      new Notice('书籍名不能为空。');
      return false;
    }
    const authorText = String(author || '').trim();
    let rel;
    try {
      rel = this.cardPathFor(name);
    } catch (error) {
      new Notice(error.message, 8000);
      return false;
    }
    if (await this.exists(rel)) {
      new Notice(`书籍卡已存在，未覆盖：${rel}`, 8000);
      await this.app.workspace.openLinkText(rel, '', false);
      return false;
    }
    // 确认要新建之后再重命名封面，避免建卡失败却改了用户的图片文件名。
    let coverRef = String(cover || '').trim();
    if (coverRef && this.settings.autoRenameCover !== false) {
      coverRef = await this.applyCoverNaming(name, authorText, coverRef);
    }
    const content = bookCardTemplate({ name, author: authorText, cover: coverRef, bookRoot: this.rootPath, date: todayStamp() });
    await this.ensureFolder(posixDirname(rel));
    await this.adapter.write(rel, content);
    new Notice(`已创建书籍卡：${rel}`, 6000);
    await this.app.workspace.openLinkText(rel, '', false);
    await this.refreshShelfBase();
    return true;
  }

  /** 新建读书笔记：已存在则不覆盖，直接打开。 */
  async createReadingNote(bookName) {
    const name = String(bookName || '').trim();
    if (!name) {
      new Notice('书籍名不能为空。');
      return false;
    }
    let rel;
    try {
      rel = readingNotePath(this.readingNoteDir, name);
    } catch (error) {
      new Notice(error.message, 8000);
      return false;
    }
    if (await this.exists(rel)) {
      new Notice(`读书笔记已存在，未覆盖：${rel}`, 8000);
      await this.app.workspace.openLinkText(rel, '', false);
      return false;
    }
    const content = readingNoteTemplate({ name, date: todayStamp() });
    await this.ensureFolder(posixDirname(rel));
    await this.adapter.write(rel, content);
    new Notice(`已创建读书笔记：${rel}`, 6000);
    await this.app.workspace.openLinkText(rel, '', false);
    return true;
  }

  /**
   * 生成/更新书架 Base（.base）。
   * 数据源是设置里的书籍卡片目录，所以卡片目录一变，Base 内容跟着变。
   * manual=false 时受 autoShelf 开关控制，失败不提示。
   */
  async refreshShelfBase(manual) {
    let target;
    try {
      target = this.shelfBasePath;
    } catch (error) {
      if (manual) new Notice(error.message, 8000);
      return false;
    }
    if (!manual && this.settings.autoShelf === false) return false;
    const content = shelfBoardTemplate({ cardDirs: this.allCardDirs(), cardSize: this.settings.cardSize, cardAspectRatio: this.settings.cardAspectRatio });
    let existing = null;
    if (await this.exists(target)) {
      try {
        existing = await this.adapter.read(target);
      } catch (error) {
        existing = null;
      }
    }
    if (existing === content) return false;
    await this.ensureFolder(posixDirname(target));
    await this.adapter.write(target, content);
    if (manual) {
      new Notice(`已更新书架 Base：${target}`, 6000);
      await this.app.workspace.openLinkText(target, '', false);
    }
    return true;
  }

  pickOutputFolder(onChoose) {
    const folders = (this.app.vault.getAllLoadedFiles ? this.app.vault.getAllLoadedFiles() : [])
      .filter((item) => item && item.path && item.path !== '/' && item.children)
      .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
    if (!folders.length) {
      new Notice('vault 中没有可选目录。');
      return;
    }
    new FolderPickerModal(this.app, folders, onChoose).open();
  }

  askConfirm(title, lines) {
    return new Promise((resolve) => {
      new ConfirmModal(this.app, title, lines, resolve).open();
    });
  }
}

class FolderPickerModal extends FuzzySuggestModal {
  constructor(app, folders, onChoose) {
    super(app);
    this.folders = folders;
    this.onChoose = onChoose;
    this.setPlaceholder('选择 vault 内的输出目录…');
  }

  getItems() {
    return this.folders;
  }

  getItemText(folder) {
    return folder.path;
  }

  onChooseItem(folder) {
    this.onChoose(folder.path);
  }
}

class ConfirmModal extends Modal {
  constructor(app, title, lines, resolve) {
    super(app);
    this.title = title;
    this.lines = lines;
    this.resolve = resolve;
    this.finished = false;
  }

  onOpen() {
    this.titleEl.setText(this.title);
    this.contentEl.addClass('bfs-confirm');
    for (const line of this.lines) {
      if (line === '') {
        this.contentEl.createEl('div', { cls: 'bfs-gap' });
      } else {
        this.contentEl.createEl('p', { text: line, cls: 'bfs-line' });
      }
    }
    const buttons = this.contentEl.createDiv({ cls: 'bfs-actions' });
    const cancel = buttons.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.finish(false));
    const ok = buttons.createEl('button', { text: '继续', cls: 'mod-cta' });
    ok.addEventListener('click', () => this.finish(true));
  }

  finish(value) {
    if (this.finished) return;
    this.finished = true;
    this.close();
    this.resolve(value);
  }

  onClose() {
    if (!this.finished) {
      this.finished = true;
      this.resolve(false);
    }
    this.contentEl.empty();
  }
}

class ReportModal extends Modal {
  constructor(app, title, book, result, sourcePath) {
    super(app);
    this.title = title;
    this.book = book;
    this.result = result;
    this.sourcePath = sourcePath;
  }

  onOpen() {
    this.titleEl.setText(this.title);
    this.contentEl.addClass('bfs-report');
    this.contentEl.createEl('h3', { text: this.book.bookName });
    this.contentEl.createEl('p', {
      text: `章节 ${this.book.stats.chapterCount} 章 · ${this.book.stats.chars.toLocaleString()} 字`,
    });
    this.contentEl.createEl('p', { text: `源文件：${this.sourcePath}` });
    if (this.result.sourceKept) {
      this.contentEl.createEl('p', { text: '源文件未修改（只补齐另外两种格式）。', cls: 'bfs-note' });
    }

    const table = this.contentEl.createEl('table', { cls: 'bfs-table' });
    const head = table.createEl('tr');
    for (const text of ['格式', '结果', '文件']) head.createEl('th', { text });
    for (const item of this.result.results) {
      const row = table.createEl('tr');
      row.createEl('td', { text: item.ext });
      row.createEl('td', { text: {
        created: '新建',
        overwritten: '覆盖（已备份）',
        'source-kept': '保留源文件',
        'exists-skipped': '已存在，跳过',
      }[item.status] || item.status });
      row.createEl('td', { text: item.target });
    }

    if (this.book.warnings.length) {
      this.contentEl.createEl('h4', { text: '警告（未自行编造，保持原样）' });
      const list = this.contentEl.createEl('ul', { cls: 'bfs-warnings' });
      for (const warning of this.book.warnings) list.createEl('li', { text: warning });
    }
    const actions = this.contentEl.createDiv({ cls: 'bfs-actions' });
    const close = actions.createEl('button', { text: '关闭', cls: 'mod-cta' });
    close.addEventListener('click', () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class TitlePreviewModal extends Modal {
  constructor(app, plugin, book, suggestions, sourcePath, group, cache, maxChars) {
    super(app);
    this.plugin = plugin;
    this.book = book;
    this.suggestions = suggestions;
    this.sourcePath = sourcePath;
    this.group = group;
    this.cache = cache;
    this.maxChars = maxChars;
    this.rows = [];
  }

  onOpen() {
    this.titleEl.setText('生成章节标题建议');
    this.modalEl.addClass('bfs-title-modal');
    const hard = this.suggestions.filter((item) => item.severity === 'hard').length;
    const soft = this.suggestions.length - hard;
    this.contentEl.createEl('p', {
      text: `${this.book.bookName} · 共 ${this.suggestions.length} 章待处理：硬缺失 ${hard}，短标题 ${soft}。默认只勾选硬缺失，确认后才会写盘。`,
      cls: 'bfs-title-summary',
    });
    this.contentEl.createEl('p', {
      text: `生成标题最多 ${this.maxChars} 字；保留原数字编号；可逐章修改，取消勾选则保留原编号。`,
      cls: 'bfs-muted',
    });

    const list = this.contentEl.createDiv({ cls: 'bfs-title-list' });
    for (const suggestion of this.suggestions) {
      const row = list.createDiv({ cls: 'bfs-title-row' });
      const checkbox = row.createEl('input', { type: 'checkbox', cls: 'bfs-title-check' });
      checkbox.checked = suggestion.severity === 'hard' && !suggestion.needsReview && Boolean(suggestion.title);

      const main = row.createDiv({ cls: 'bfs-title-main' });
      const old = main.createDiv({ cls: 'bfs-title-old' });
      old.createEl('span', { text: suggestion.currentTitle || '（空标题）' });
      if (suggestion.severity === 'hard') {
        old.createEl('span', {
          text: suggestion.reasons.includes('duplicate') ? '重复' : '硬缺失',
          cls: 'bfs-title-badge bfs-title-badge-hard',
        });
      } else {
        old.createEl('span', { text: '短标题', cls: 'bfs-title-badge bfs-title-badge-soft' });
      }
      if (suggestion.reused) old.createEl('span', { text: '缓存', cls: 'bfs-title-badge bfs-title-badge-cache' });

      const input = main.createEl('input', {
        type: 'text',
        cls: 'bfs-title-input',
        attr: {
          placeholder: '输入或修改生成标题',
          maxlength: String(this.maxChars),
        },
      });
      input.value = suggestion.title || '';
      input.disabled = suggestion.number == null;

      const meta = row.createDiv({ cls: 'bfs-title-meta' });
      meta.createEl('div', {
        text: suggestion.needsReview
          ? '没有可用候选，保留编号'
          : `置信度：${suggestion.confidence}${suggestion.excerpt ? ` · 取材：${suggestion.excerpt}` : ''}`,
        cls: suggestion.needsReview ? 'bfs-warn-text' : 'bfs-muted',
      });

      this.rows.push({ suggestion, checkbox, input });
    }

    const actions = this.contentEl.createDiv({ cls: 'bfs-actions' });
    const selectHard = actions.createEl('button', { text: '全选硬缺失' });
    selectHard.addEventListener('click', () => {
      for (const row of this.rows) {
        const item = row.suggestion;
        row.checkbox.checked = item.severity === 'hard' && !item.needsReview;
      }
    });
    const selectNone = actions.createEl('button', { text: '全不选' });
    selectNone.addEventListener('click', () => {
      for (const row of this.rows) row.checkbox.checked = false;
    });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    const apply = actions.createEl('button', { text: '应用选中标题', cls: 'mod-cta' });
    apply.addEventListener('click', async () => {
      const selections = [];
      for (const row of this.rows) {
        if (!row.checkbox.checked) continue;
        const title = row.input.value.trim();
        if (!title) continue;
        selections.push({ index: row.suggestion.index, title });
      }
      if (!selections.length) {
        new Notice('请至少勾选一章并填写标题。');
        return;
      }
      apply.disabled = true;
      try {
        const ok = await this.plugin.applyGeneratedTitles(
          this.book,
          this.group,
          this.sourcePath,
          selections,
          this.cache,
        );
        if (ok) this.close();
      } finally {
        apply.disabled = false;
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class BatchReportModal extends Modal {
  constructor(app, title, okCount, total, reports) {
    super(app);
    this.title = title;
    this.okCount = okCount;
    this.total = total;
    this.reports = reports;
  }

  onOpen() {
    this.titleEl.setText(this.title);
    this.contentEl.createEl('p', { text: `成功 ${this.okCount}/${this.total} 本。` });
    for (const report of this.reports) {
      const section = this.contentEl.createDiv({ cls: 'bfs-batch-item' });
      section.createEl('strong', { text: report.name });
      if (report.status === 'ok') {
        section.createEl('div', { text: `源：${report.source}` });
        if (report.warnings.length) {
          section.createEl('div', { text: `警告 ${report.warnings.length} 条：${report.warnings.join('；')}`, cls: 'bfs-warn-text' });
        }
      } else {
        section.createEl('div', { text: `失败：${report.error}`, cls: 'bfs-error-text' });
      }
    }
    const actions = this.contentEl.createDiv({ cls: 'bfs-actions' });
    const close = actions.createEl('button', { text: '关闭', cls: 'mod-cta' });
    close.addEventListener('click', () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ImagePickerModal extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder('搜索 vault 内的图片…');
  }

  getItems() {
    return this.app.vault.getFiles()
      .filter((file) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.path))
      .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  }

  getItemText(file) {
    return file.path;
  }

  onChooseItem(file) {
    if (typeof this.onChoose === 'function') this.onChoose(file);
  }
}

class BookNameModal extends Modal {
  constructor(app, onSubmit, options) {
    super(app);
    this.onSubmit = typeof onSubmit === 'function' ? onSubmit : () => {};
    const opts = options || {};
    this.heading = opts.heading || '新建书籍卡';
    this.showAuthor = opts.showAuthor !== false;
    this.showCover = opts.showCover !== false;
    this.name = String(opts.initialName || '');
    this.author = '';
    this.cover = '';
    this.submitted = false;
  }

  onOpen() {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl('p', {
      text: '书名应与书库中的书籍目录名一致。',
      cls: 'bfs-muted',
    });

    this.contentEl.createEl('label', { text: '书名', cls: 'bfs-field-label' });
    const nameInput = this.contentEl.createEl('input', { type: 'text', cls: 'bfs-name-input' });
    nameInput.placeholder = '例如：道德经-老子';
    nameInput.value = this.name;
    nameInput.addEventListener('input', () => { this.name = nameInput.value; });

    let authorInput = null;
    if (this.showAuthor) {
      this.contentEl.createEl('label', { text: '作者（可选）', cls: 'bfs-field-label' });
      authorInput = this.contentEl.createEl('input', { type: 'text', cls: 'bfs-name-input' });
      authorInput.placeholder = '例如：老子';
      authorInput.addEventListener('input', () => { this.author = authorInput.value; });
    }

    let coverInput = null;
    if (this.showCover) {
      this.contentEl.createEl('label', { text: '封面（可选）', cls: 'bfs-field-label' });
      const coverRow = this.contentEl.createDiv({ cls: 'bfs-cover-row' });
      coverInput = coverRow.createEl('input', { type: 'text', cls: 'bfs-name-input' });
      coverInput.placeholder = '90 附件/某书/cover.jpg 或 https://…';
      coverInput.addEventListener('input', () => { this.cover = coverInput.value; });
      const pick = coverRow.createEl('button', { text: '选择图片' });
      pick.addEventListener('click', () => {
        new ImagePickerModal(this.app, (file) => {
          this.cover = file.path;
          coverInput.value = file.path;
          coverInput.focus();
        }).open();
      });
    }

    const onKey = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.submit();
      }
    };
    nameInput.addEventListener('keydown', onKey);
    if (authorInput) authorInput.addEventListener('keydown', onKey);
    if (coverInput) coverInput.addEventListener('keydown', onKey);

    const actions = this.contentEl.createDiv({ cls: 'bfs-actions' });
    const ok = actions.createEl('button', { text: '创建', cls: 'mod-cta' });
    ok.addEventListener('click', () => this.submit());
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    window.setTimeout(() => nameInput.focus(), 0);
  }

  submit() {
    if (this.submitted) return;
    this.submitted = true;
    const name = String(this.name || '').trim();
    const author = String(this.author || '').trim();
    const cover = String(this.cover || '').trim();
    this.close();
    if (!name) {
      new Notice('书籍名不能为空。');
      return;
    }
    this.onSubmit({ name, author, cover });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class LibraryModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.loading = true;
    this.groups = [];
  }

  onOpen() {
    this.titleEl.setText('书库三格式');
    this.modalEl.addClass('bfs-library-modal');
    this.render();
  }

  async render() {
    this.contentEl.empty();
    this.contentEl.createEl('p', {
      text: `书库目录：${this.plugin.rootPath}`,
      cls: 'bfs-muted',
    });
    if (this.loading) {
      this.contentEl.createEl('p', { text: '正在扫描…' });
    }
    try {
      this.groups = await this.plugin.scanLibrary();
    } catch (error) {
      this.groups = [];
      new Notice(`扫描失败：${error.message}`, 8000);
    }
    this.loading = false;
    this.contentEl.empty();
    this.contentEl.createEl('p', {
      text: `书库目录：${this.plugin.rootPath} · 共 ${this.groups.length} 本`,
      cls: 'bfs-muted',
    });

    const toolbar = this.contentEl.createDiv({ cls: 'bfs-actions bfs-toolbar' });
    const newCard = toolbar.createEl('button', { text: '新建书籍卡' });
    newCard.addEventListener('click', () => {
      new BookNameModal(this.app, async (payload) => {
        await this.plugin.createBookCard(payload.name, payload.author, payload.cover);
        this.render();
      }).open();
    });
    // 书架 Base 是实时查询，无需手动刷新；目录变更时会自动重写。

    if (!this.groups.length) {
      this.contentEl.createEl('p', { text: '没有扫描到书籍。请检查书库目录设置。' });
      return;
    }

    const cardPaths = new Map();
    const hasCard = new Map();
    for (const group of this.groups) {
      cardPaths.set(group.name, this.plugin.cardPathFor(group.name));
      hasCard.set(group.name, await this.plugin.exists(cardPaths.get(group.name)));
    }

    for (const group of this.groups) {
      const card = this.contentEl.createDiv({ cls: 'bfs-book' });
      const titleRow = card.createDiv({ cls: 'bfs-book-head' });
      titleRow.createEl('strong', { text: group.name });
      const chips = titleRow.createDiv({ cls: 'bfs-chips' });
      for (const ext of FORMATS) {
        chips.createEl('span', {
          text: ext,
          cls: group.files[ext] ? 'bfs-chip bfs-ok' : 'bfs-chip bfs-missing',
        });
      }

      const counts = Object.values(group.files).filter(Boolean).length;
      card.createEl('div', {
        text: group.files.epub
          ? `epub ${formatBytes(group.files.epub.size)} · ${counts}/3`
          : `${counts}/3 格式`,
        cls: 'bfs-muted',
      });
      if (Object.values(group.legacy || {}).some(Boolean)) {
        card.createEl('div', {
          text: '书库根目录还有同名旧文件；插件以文件夹内版本为准，旧文件不会被改动。',
          cls: 'bfs-warn-text',
        });
      }

      const actions = card.createDiv({ cls: 'bfs-actions' });
      const cardPath = cardPaths.get(group.name);
      if (hasCard.get(group.name)) {
        const openCard = actions.createEl('button', { text: '打开书籍卡' });
        openCard.addEventListener('click', () => {
          this.close();
          this.app.workspace.openLinkText(cardPath, '', false);
        });
      } else {
        const makeCard = actions.createEl('button', { text: '新建书籍卡' });
        makeCard.addEventListener('click', () => {
          new BookNameModal(this.app, async (payload) => {
            await this.plugin.createBookCard(payload.name, payload.author, payload.cover);
            this.render();
          }, { initialName: group.name }).open();
        });
      }
      const normalize = actions.createEl('button', { text: '规范化三格式', cls: 'mod-cta' });
      normalize.addEventListener('click', async () => {
        normalize.disabled = true;
        try {
          await this.plugin.normalizeGroup(group);
        } finally {
          normalize.disabled = false;
          this.render();
        }
      });
      if (group.files.md) {
        const open = actions.createEl('button', { text: '打开 Markdown' });
        open.addEventListener('click', () => {
          this.close();
          this.app.workspace.openLinkText(group.files.md.path, '', false);
        });
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class BookFormatSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: '书库' });
    containerEl.createEl('p', {
      text: '管理每本书的 txt、md、epub 三格式，并按书籍卡片目录维护 Bases 书架。右侧文件夹按钮可从 vault 现有目录中选择。',
      cls: 'bfs-muted',
    });

    const addPathSetting = ({ name, desc, placeholder, value, apply }) => {
      const setting = new Setting(containerEl).setName(name).setDesc(desc);
      let textControl = null;
      setting.addText((text) => {
        textControl = text;
        text.setPlaceholder(placeholder)
          .setValue(value)
          .onChange(async (changed) => {
            await apply(changed, false);
          });
      });
      setting.addExtraButton((button) => button
        .setIcon('folder')
        .setTooltip('从 vault 目录中选择')
        .onClick(() => {
          this.plugin.pickOutputFolder((folderPath) => {
            if (textControl) textControl.setValue(folderPath);
            void apply(folderPath, true);
          });
        }));
    };

    addPathSetting({
      name: '书库目录',
      desc: '三格式文件所在目录，相对 vault 根目录。',
      placeholder: '10 书籍',
      value: this.plugin.settings.bookRoot,
      apply: async (changed) => {
        this.plugin.settings.bookRoot = String(changed || '').trim() || '10 书籍';
        await this.plugin.saveSettings();
      },
    });

    addPathSetting({
      name: '书籍卡片目录',
      desc: '一本书一个 .md 卡片；书架 Base 的数据源就是这里。',
      placeholder: DEFAULT_CARD_DIR,
      value: this.plugin.settings.cardDir || DEFAULT_CARD_DIR,
      apply: async (changed) => {
        this.plugin.settings.cardDir = String(changed || '').trim() || DEFAULT_CARD_DIR;
        await this.plugin.saveSettings();
        await this.plugin.refreshShelfBase();
      },
    });

    addPathSetting({
      name: '读书笔记目录',
      desc: '「新建读书笔记」的写入位置。',
      placeholder: DEFAULT_READING_DIR,
      value: this.plugin.settings.readingNoteDir || DEFAULT_READING_DIR,
      apply: async (changed) => {
        this.plugin.settings.readingNoteDir = String(changed || '').trim() || DEFAULT_READING_DIR;
        await this.plugin.saveSettings();
      },
    });

    addPathSetting({
      name: '书架 Base 文件',
      desc: 'Base 文件位置。选目录后自动拼成 <目录>/书架.base。',
      placeholder: DEFAULT_SHELF_BASE,
      value: this.plugin.settings.shelfBasePath || DEFAULT_SHELF_BASE,
      apply: async (changed, fromPicker) => {
        const raw = String(changed || '').trim();
        const next = fromPicker && raw ? `${raw.replace(/\/+$/, '')}/书架.base` : raw;
        this.plugin.settings.shelfBasePath = next || DEFAULT_SHELF_BASE;
        await this.plugin.saveSettings();
        await this.plugin.refreshShelfBase();
      },
    });

    containerEl.createEl('h3', { text: '书库结构' });

    new Setting(containerEl)
      .setName('允许布置书库结构')
      .setDesc('默认关闭。开启后可用命令「布置书库目录结构」或下方按钮一键创建推荐目录。')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.allowScaffold === true)
        .onChange(async (value) => {
          this.plugin.settings.allowScaffold = Boolean(value);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('布置书库')
      .setDesc('书库目录为空时创建推荐结构；已有内容时只生成一份结构建议，不改动任何文件。')
      .addButton((button) => button
        .setButtonText('布置书库')
        .onClick(() => {
          void this.plugin.scaffoldLibrary();
        }));

    new Setting(containerEl)
      .setName('自动维护书架 Base')
      .setDesc('开启后：插件加载、新建书籍卡、修改卡片目录时自动重写 Base，无需手动命令。')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoShelf !== false)
        .onChange(async (value) => {
          this.plugin.settings.autoShelf = Boolean(value);
          await this.plugin.saveSettings();
          if (value) await this.plugin.refreshShelfBase();
        }));

    new Setting(containerEl)
      .setName('书架卡片宽度（px）')
      .setDesc('卡片视图里每张卡片的宽度，默认 220。')
      .addText((text) => text
        .setPlaceholder('220')
        .setValue(String(this.plugin.settings.cardSize || 220))
        .onChange(async (value) => {
          const size = Number(value);
          this.plugin.settings.cardSize = Number.isFinite(size) && size >= 80 ? Math.round(size) : 220;
          await this.plugin.saveSettings();
          await this.plugin.refreshShelfBase();
        }));

    new Setting(containerEl)
      .setName('书架封面比例（宽/高）')
      .setDesc('封面图宽高比，默认 0.72（竖版书封）。0.75 约等于 3:4。')
      .addText((text) => text
        .setPlaceholder('0.72')
        .setValue(String(this.plugin.settings.cardAspectRatio || 0.72))
        .onChange(async (value) => {
          const ratio = Number(value);
          this.plugin.settings.cardAspectRatio = Number.isFinite(ratio) && ratio > 0.2 && ratio < 3 ? ratio : 0.72;
          await this.plugin.saveSettings();
          await this.plugin.refreshShelfBase();
        }));

    new Setting(containerEl)
      .setName('功能区：书库按钮')
      .setDesc('在左侧功能区显示「书库」按钮（打开书库面板）。')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.ribbonLibrary !== false)
        .onChange(async (value) => {
          this.plugin.settings.ribbonLibrary = Boolean(value);
          await this.plugin.saveSettings();
          this.plugin.applyRibbonVisibility();
        }));

    new Setting(containerEl)
      .setName('功能区：新建书籍卡按钮')
      .setDesc('在左侧功能区显示「新建书籍卡」按钮。')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.ribbonNewCard !== false)
        .onChange(async (value) => {
          this.plugin.settings.ribbonNewCard = Boolean(value);
          await this.plugin.saveSettings();
          this.plugin.applyRibbonVisibility();
        }));

    new Setting(containerEl)
      .setName('封面自动重命名')
      .setDesc('新建书籍卡时，把选中的图片重命名为《书名》-作者封面.ext（无作者时用《书名》封面.ext）。')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoRenameCover !== false)
        .onChange(async (value) => {
          this.plugin.settings.autoRenameCover = Boolean(value);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('每本书一个同名文件夹')
      .setDesc('开启：10 书籍/书名/书名.md；关闭：10 书籍/书名.md。')
      .addToggle((toggle) => toggle
        .setValue(Boolean(this.plugin.settings.folderPerBook))
        .onChange(async (value) => {
          this.plugin.settings.folderPerBook = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: '按书路径配置（可选）' });
    containerEl.createEl('p', {
      text: '手动添加书籍条目；路径留空时回退到默认目录 10 书籍/<书名>/。路径必须是 vault 内相对路径，输出目录不存在会自动创建。',
      cls: 'bfs-muted',
    });
    containerEl.createEl('p', {
      text: '提示：每个路径输入框右侧有文件夹按钮，可从 vault 已有目录中选择；右键输入框同样可用。',
      cls: 'bfs-muted',
    });
    const profiles = this.plugin.settings.bookProfiles || [];
    if (!profiles.length) {
      containerEl.createEl('p', { text: '尚未配置书籍条目；所有书继续使用默认目录。', cls: 'bfs-muted' });
    }

    for (const entry of profiles) {
      const header = new Setting(containerEl)
        .setName(`书籍：${entry.bookName || '未命名'}`)
        .setHeading()
        .addExtraButton((button) => button
          .setIcon('trash')
          .setTooltip('删除此书籍路径条目')
          .onClick(async () => {
            const ok = await this.plugin.askConfirm('删除书籍路径条目', [
              `确定删除「${entry.bookName || '未命名'}」的路径配置吗？`,
              '已生成的书籍文件不会被删除。',
            ]);
            if (!ok) return;
            this.plugin.settings.bookProfiles = profiles.filter((item) => item.id !== entry.id);
            await this.plugin.saveSettings();
            this.display();
          }));
      header.settingEl.addClass('bfs-profile-header');

      const addPathField = (name, desc, key, placeholder, pickFolder = false) => {
        const setting = new Setting(containerEl).setName(name).setDesc(desc);
        let textControl = null;
        setting.addText((text) => {
          textControl = text;
          text.setPlaceholder(placeholder)
            .setValue(entry[key] || '')
            .onChange(async (value) => {
              entry[key] = value;
              await this.plugin.saveSettings();
            });
          if (pickFolder) {
            text.inputEl.addEventListener('contextmenu', (event) => {
              event.preventDefault();
              this.plugin.pickOutputFolder((folderPath) => {
                text.setValue(folderPath);
                entry[key] = folderPath;
                void this.plugin.saveSettings();
              });
            });
          }
          text.inputEl.addEventListener('blur', async () => {
            try {
              await this.plugin.validateProfileEntry(entry);
            } catch (error) {
              new Notice(`路径配置错误：${error.message}`, 9000);
            }
          });
        });
        if (pickFolder) {
          setting.addExtraButton((button) => button
            .setIcon('folder')
            .setTooltip('从 vault 目录中选择')
            .onClick(() => {
              this.plugin.pickOutputFolder((folderPath) => {
                if (textControl) textControl.setValue(folderPath);
                entry[key] = folderPath;
                void this.plugin.saveSettings();
              });
            }));
        }
      };

      addPathField('书籍标识', '用于匹配书名和生成文件名，例如：书名。', 'bookName', '书名');
      addPathField(
        'Markdown 输出目录',
        '留空回退到 10 书籍/<书名>/；右键输入框可选择目录。',
        'mdDir',
        '10 书籍/书名',
        true,
      );
      addPathField(
        'TXT 输出目录',
        '留空回退到 10 书籍/<书名>/；右键输入框可选择目录。',
        'txtDir',
        '90 附件/书名/txt',
        true,
      );
      addPathField(
        'EPUB 输出目录',
        '留空回退到 10 书籍/<书名>/；右侧按钮或右键可选择目录。',
        'epubDir',
        '90 附件/书名/epub',
        true,
      );
      addPathField(
        '卡片目录',
        '该书的书籍卡存放目录；留空使用全局「书籍卡片目录」。',
        'cardDir',
        '默认 20 笔记/书目',
        true,
      );
    }

    new Setting(containerEl)
      .setName('添加书籍路径条目')
      .setDesc('新增一条按书配置；留空的路径继续使用默认目录。')
      .addButton((button) => button
        .setButtonText('添加条目')
        .setCta()
        .onClick(async () => {
          const id = `book-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          this.plugin.settings.bookProfiles.push({
            id,
            bookName: '新书',
            mdDir: '',
            txtDir: '',
            epubDir: '',
            cardDir: '',
          });
          await this.plugin.saveSettings();
          this.display();
        }));

    containerEl.createEl('h3', { text: '章节名规范' });
    new Setting(containerEl)
      .setName('前缀')
      .setDesc('默认“第”。')
      .addText((text) => text
        .setValue(this.plugin.settings.chapterPrefix)
        .onChange(async (value) => {
          this.plugin.settings.chapterPrefix = value;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('后缀')
      .setDesc('默认“章”。')
      .addText((text) => text
        .setValue(this.plugin.settings.chapterSuffix)
        .onChange(async (value) => {
          this.plugin.settings.chapterSuffix = value;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('章节编号位数')
      .setDesc('章节序号不补零，按数字本身输出：第1章、第10章、第101章；不再按章节数分档。');
    new Setting(containerEl)
      .setName('编号与标题分隔符')
      .setDesc('默认一个半角空格。')
      .addText((text) => text
        .setValue(this.plugin.settings.chapterSeparator)
        .onChange(async (value) => {
          this.plugin.settings.chapterSeparator = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('生成标题长度上限')
      .setDesc('本地生成的章节标题最多多少个字符，默认 10，范围 4–24。')
      .addSlider((slider) => slider
        .setLimits(4, 24, 1)
        .setValue(Number(this.plugin.settings.maxTitleChars) || 10)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxTitleChars = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: '写入与备份' });
    containerEl.createEl('p', {
      text: '覆盖前会自动备份到 .book-format-sync/backups/时间戳/书名/。',
      cls: 'bfs-muted',
    });
    new Setting(containerEl)
      .setName('转换时允许覆盖已有目标')
      .setDesc('关闭时只新建缺失文件；开启时覆盖并先备份。')
      .addToggle((toggle) => toggle
        .setValue(Boolean(this.plugin.settings.overwrite))
        .onChange(async (value) => {
          this.plugin.settings.overwrite = value;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('TXT 换行')
      .setDesc('LF 或 Windows CRLF。')
      .addDropdown((drop) => drop
        .addOption('lf', 'LF')
        .addOption('crlf', 'CRLF')
        .setValue(this.plugin.settings.txtLineEnding)
        .onChange(async (value) => {
          this.plugin.settings.txtLineEnding = value;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('TXT 添加 UTF-8 BOM')
      .setDesc('部分旧阅读器需要；一般保持关闭。')
      .addToggle((toggle) => toggle
        .setValue(Boolean(this.plugin.settings.txtBom))
        .onChange(async (value) => {
          this.plugin.settings.txtBom = value;
          await this.plugin.saveSettings();
        }));


  }
}

// 供 LibraryModal 调用：按现有格式重新规范化一本书。
BookFormatSyncPlugin.prototype.normalizeGroup = async function normalizeGroup(group) {
  let sourcePath;
  let parsed;
  try {
    const preferred = this.pickSource(group);
    const profile = this.profileFor(group.name, preferred);
    sourcePath = await this.resolveOriginalPath(profile, group.name, preferred);
    parsed = await this.parseSource(sourcePath);
  } catch (error) {
    new Notice(`读取失败：${error.message}`, 9000);
    return;
  }
  let outputs;
  try {
    outputs = this.outputDirsForBook(parsed.book.bookName, sourcePath);
  } catch (error) {
    new Notice(`路径配置错误：${error.message}`, 9000);
    return;
  }
  const ok = await this.askConfirm(
    '规范化并生成三格式',
    [
      `书籍：${parsed.book.bookName}`,
      `源文件：${sourcePath}`,
      `章节：${parsed.book.stats.chapterCount} 章`,
      `md 输出：${outputs.md}`,
      `txt 输出：${outputs.txt}`,
      `epub 输出：${outputs.epub}`,
      parsed.book.warnings.length ? `警告：${parsed.book.warnings.length} 条` : '未发现章节号异常。',
    ],
  );
  if (!ok) return;
  try {
    const result = await this.materialize(parsed.book, outputs, {
      sourcePath,
      overwrite: true,
      skipSourceFormat: false,
    });
    new ReportModal(this.app, '规范化完成', parsed.book, result, sourcePath).open();
  } catch (error) {
    new Notice(`生成失败：${error.message}`, 10000);
  }
};

module.exports = BookFormatSyncPlugin;

}
};
const __cache = Object.create(null);
function __require(id) {
  if (__cache[id]) return __cache[id].exports;
  const factory = __modules[id];
  if (!factory) throw new Error('模块不存在：' + id);
  const module = { exports: {} };
  __cache[id] = module;
  factory(module, module.exports, __require, __nativeRequire);
  return module.exports;
}
const __entry = __require("src/main.js");
module.exports = __entry;
