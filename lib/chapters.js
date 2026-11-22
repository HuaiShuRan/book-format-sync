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
  numberPad: 3,
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
  merged.numberPad = Math.max(1, Math.min(8, Number(merged.numberPad) || 3));
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

/** 按规范生成章节名：“第001章 标题”；无标题时不会凭空补“无标题”。 */
function formatChapterTitle(number, title, rules) {
  const opts = rulesWithDefaults(rules);
  const padded = String(Math.max(0, Number(number) || 0)).padStart(opts.numberPad, '0');
  let result = `${opts.prefix}${padded}${opts.suffix}`;
  const cleanTitle = String(title == null ? '' : title)
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
  if (cleanTitle) result += `${opts.separator}${cleanTitle}`;
  return result;
}

/** 章节序号宽度：按章节总数（并兼顾最大章号）计算，如 81 章 → 2 位。 */
function numberPadForChapters(chapters) {
  const list = Array.isArray(chapters) ? chapters : [];
  const count = list.length;
  let maxNumber = 0;
  for (const chapter of list) {
    const number = Number(chapter && chapter.number);
    if (Number.isSafeInteger(number) && number > maxNumber) maxNumber = number;
  }
  const width = String(Math.max(count, maxNumber, 1)).length;
  return Math.max(1, Math.min(8, width));
}

/** 判断“第N章”后面的剩余文本是否其实是正文，而不是标题。 */
function isInlineChapterBody(rest) {
  const text = String(rest == null ? '' : rest).trim();
  if (!text) return false;
  if (text.length > 40) return true;
  const sentenceEnds = (text.match(/[。！？!?；;]/g) || []).length;
  return sentenceEnds >= 2;
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
 * 但标题原样保留，不改成“第001章”，也不猜编号。
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
  numberPadForChapters,
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
