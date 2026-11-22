'use strict';

const crypto = require('crypto');
const { readZip, writeZip } = require('./zip');
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
} = require('./text');
const { parseChapterTitle, looksChapterish } = require('./chapters');

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
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="style" href="style.css" media-type="text/css"/>
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
