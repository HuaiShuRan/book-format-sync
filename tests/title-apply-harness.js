'use strict';

/** 用内存 vault 测试标题应用：确认后才写盘、保留编号、缓存接受状态。 */

const assert = require('assert');
const Module = require('module');

class FakePlugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
}
class FakePluginSettingTab {}
class FakeSetting {}
class FakeNotice { constructor(message) { this.message = message; } setMessage(m) { this.message = m; } hide() {} }
class FakeModal { constructor(app) { this.app = app; } open() {} close() {} }
class FakeTFile {}

const originalLoad = Module._load;
Module._load = function fakeLoad(request, parent, isMain) {
  if (request === 'obsidian') {
    return {
      Plugin: FakePlugin,
      PluginSettingTab: FakePluginSettingTab,
      Setting: FakeSetting,
      Notice: FakeNotice,
      Modal: FakeModal,
      FuzzySuggestModal: FakeModal,
      TFile: FakeTFile,
      normalizePath: (value) => String(value).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const BookFormatSyncPlugin = require('../main.js');
Module._load = originalLoad;

const files = new Map();
const dirs = new Set(['']);
const adapter = {
  async exists(p) { return files.has(p) || dirs.has(p); },
  async mkdir(p) {
    let current = '';
    for (const part of p.split('/')) {
      current = current ? `${current}/${part}` : part;
      dirs.add(current);
    }
  },
  async readBinary(p) {
    const buffer = files.get(p);
    if (!buffer) throw new Error(`ENOENT ${p}`);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  },
  async writeBinary(p, data) {
    files.set(p, Buffer.from(data));
    const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (parent) dirs.add(parent);
  },
  async stat(p) {
    if (files.has(p)) return { type: 'file', size: files.get(p).length };
    if (dirs.has(p)) return { type: 'folder', size: 0 };
    throw new Error(`ENOENT ${p}`);
  },
  async list(p) {
    const prefix = p ? `${p}/` : '';
    const result = { files: [], folders: [] };
    for (const d of dirs) {
      if (d === p || !d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (rest && !rest.includes('/')) result.folders.push(d);
    }
    for (const f of files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (rest && !rest.includes('/')) result.files.push(f);
    }
    return result;
  },
  async read(p) {
    const buffer = files.get(p);
    if (!buffer) throw new Error(`ENOENT ${p}`);
    return buffer.toString('utf8');
  },
};

const app = {
  vault: { adapter },
  workspace: {
    getActiveFile: () => null,
    on: () => ({}),
    onLayoutReady: (fn) => fn(),
    openLinkText: () => {},
  },
};

(async () => {
  const source = '10 书籍/标题测试/标题测试.txt';
  files.set(source, Buffer.from(`第1章 001

　　第一段内容。

第2章 002

　　第二段内容。
`, 'utf8'));

  const plugin = new BookFormatSyncPlugin(app, {});
  plugin.settings = {
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
  };
  plugin.askConfirm = async () => true;

  await plugin.generateTitleSuggestions({ path: source });
  const titleCachePath = '.book-format-sync/titles/标题测试.json';
  assert.ok(files.has(titleCachePath));
  const previewCache = JSON.parse(files.get(titleCachePath).toString('utf8'));
  assert.strictEqual(Object.keys(previewCache.chapters).length, 2);

  const parsed = await plugin.parseSource(source);
  const group = await plugin.groupForFile(source);
  const cache = { bookName: parsed.book.bookName, chapters: {} };
  const ok = await plugin.applyGeneratedTitles(
    parsed.book,
    group,
    source,
    [{ index: 0, title: '新标题内容' }],
    cache,
  );
  assert.strictEqual(ok, true);

  const mdPath = '10 书籍/标题测试/标题测试.md';
  const txtPath = '10 书籍/标题测试/标题测试.txt';
  const epubPath = '10 书籍/标题测试/标题测试.epub';
  assert.ok(files.has(mdPath));
  assert.ok(files.has(txtPath));
  assert.ok(files.has(epubPath));
  const md = files.get(mdPath).toString('utf8');
  assert.ok(md.includes('## 第001章 新标题内容'));
  assert.ok(md.includes('## 第002章 002'));
  assert.ok(files.get(txtPath).toString('utf8').includes('第001章 新标题内容'));
  assert.ok(files.has('.book-format-sync/titles/标题测试.json'));
  const cacheJson = JSON.parse(files.get('.book-format-sync/titles/标题测试.json').toString('utf8'));
  assert.strictEqual(cacheJson.chapters['0'].status, 'accepted');
  assert.ok([...files.keys()].some((key) => key.startsWith('.book-format-sync/backups/')));

  console.log('title apply harness ok');
  console.log('  md has:', '## 第001章 新标题内容');
  console.log('  cache:', cacheJson.chapters['0'].status);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});


