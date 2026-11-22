'use strict';

/**
 * 章节标题缺失检测与本地标题建议生成。
 * 只做“建议”，不直接写盘；所有结果由调用方预览确认后再应用。
 */

const { splitParagraphs } = require('./text');
const { formatChapterTitle } = require('./chapters');

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
