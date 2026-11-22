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
const { parseBook, renderBook, FORMATS } = require('../lib/book');
const { formatChapterTitle } = require('../lib/chapters');
const {
  buildTitleSuggestions,
  compactTitle,
  isNumericTitle,
  isPlaceholderTitle,
  isStructuralTitle,
  titleLength,
  TITLE_ALGORITHM_VERSION,
} = require('../lib/titles');
const { formatBytes, sanitizeFileName } = require('../lib/text');
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
} = require('../lib/paths');

const DEFAULT_SETTINGS = Object.freeze({
  bookRoot: '10 书籍',
  folderPerBook: true,
  chapterPrefix: '第',
  chapterSuffix: '章',
  numberPad: 3,
  chapterSeparator: ' ',
  backup: true,
  overwrite: true,
  txtLineEnding: 'lf',
  txtBom: false,
  maxTitleChars: 10,
  bookProfiles: [],
  settingsVersion: 2,
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

    this.addRibbonIcon('library', '书库三格式同步', () => this.openLibrary());

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

    this.addSettingTab(new BookFormatSettingTab(this.app, this));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      this.addBookFileMenu(menu, file);
    }));
    this.registerEvent(this.app.workspace.on('file-open', () => this.updateStatusBar()));
    this.app.workspace.onLayoutReady(() => this.updateStatusBar());
  }

  addBookFileMenu(menu, file) {
    if (!(file instanceof TFile)) return;
    const ext = extOf(file.path);
    if (!ext) return;
    menu.addItem((item) => {
      item.setTitle('书库三格式同步').setIcon('library');
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
    this.settings = migrateSettings(Object.assign({}, DEFAULT_SETTINGS, await this.loadData()));
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
      numberPad: Number(this.settings.numberPad) || 3,
      separator: this.settings.chapterSeparator,
    };
  }

  renderOptions(bookName, numberPad) {
    return {
      bookName,
      rules: {
        ...this.rules,
        numberPad: Number(numberPad) || this.rules.numberPad,
      },
      txtLineEnding: this.settings.txtLineEnding === 'crlf' ? 'crlf' : 'lf',
      txtBom: Boolean(this.settings.txtBom),
    };
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
    const rendered = renderBook(book, this.renderOptions(book.bookName, book.numberPad));
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
        `章节规范：${this.rules.prefix}${'0'.repeat(Math.max(0, parsed.book.numberPad - 1))}1${this.rules.suffix}${this.rules.separator}标题`,
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
      rules: { ...this.rules, numberPad: parsed.book.numberPad || this.rules.numberPad },
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
      item.chapter.normalizedTitle = formatChapterTitle(item.chapter.number, item.title, {
        ...this.rules,
        numberPad: book.numberPad || this.rules.numberPad,
      });
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
    if (!file || !extOf(file.path)) {
      this.statusBar.setText('三格式 —');
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

    if (!this.groups.length) {
      this.contentEl.createEl('p', { text: '没有扫描到书籍。请检查书库目录设置。' });
      return;
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
    containerEl.createEl('h2', { text: '书库三格式同步' });
    containerEl.createEl('p', {
      text: '只处理 txt、md、epub。章节名只识别“第N章”，规范未覆盖的标题保持原样并在报告中提示。',
      cls: 'bfs-muted',
    });

    new Setting(containerEl)
      .setName('书库目录')
      .setDesc('相对 vault 根目录，例如 10 书籍。')
      .addText((text) => text
        .setPlaceholder('10 书籍')
        .setValue(this.plugin.settings.bookRoot)
        .onChange(async (value) => {
          this.plugin.settings.bookRoot = value.trim() || '10 书籍';
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
      text: '提示：右键单击任一“输出目录”输入框，可从 vault 已有目录中选择。',
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
        new Setting(containerEl)
          .setName(name)
          .setDesc(desc)
          .addText((text) => {
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
        '留空回退到 10 书籍/<书名>/；右键输入框可选择目录。',
        'epubDir',
        '90 附件/书名/epub',
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
      .setDesc('自动按全书章节数计算：81 章为“第01章”，340 章为“第001章”，1000 章为“第0001章”。');
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
    new Setting(containerEl)
      .setName('覆盖前备份')
      .setDesc('备份到 .book-format-sync/backups/时间戳/书名/。')
      .addToggle((toggle) => toggle
        .setValue(Boolean(this.plugin.settings.backup))
        .onChange(async (value) => {
          this.plugin.settings.backup = value;
          await this.plugin.saveSettings();
        }));
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

    new Setting(containerEl)
      .setName('扫描书库')
      .setDesc('打开只读面板，查看每本书的 3 格式状态。')
      .addButton((button) => button
        .setButtonText('打开面板')
        .setCta()
        .onClick(() => {
          this.plugin.openLibrary();
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
