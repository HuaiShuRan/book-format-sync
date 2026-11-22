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
} = require('./text');
const {
  splitMarkdownBook,
  splitTxtBook,
  parseChapterTitle,
  formatChapterTitle,
  numberPadForChapters,
  collectWarnings,
  rulesWithDefaults,
} = require('./chapters');
const { readEpub, buildEpub } = require('./epub');
const { readZip } = require('./zip');
const { toBuffer } = require('./text');

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
  const numberPad = numberPadForChapters(prepared);
  const finalRules = { ...rules, numberPad };
  const chapters = normalizeChapters(prepared, finalRules, warnings);

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
    numberPad,
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
  const rules = rulesWithDefaults({
    ...(opts.rules || {}),
    numberPad: book.numberPad || (opts.rules && opts.rules.numberPad),
  });
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
