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
