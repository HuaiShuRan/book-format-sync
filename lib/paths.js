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
