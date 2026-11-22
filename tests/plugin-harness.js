'use strict';

/** 用内存 vault 验证插件的路径解析、写入、三格式落盘，不启动 Obsidian。 */

const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const path = require('path');

class FakePlugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this.settings = {};
  }
}
class FakePluginSettingTab {}
class FakeSetting {}
class FakeNotice {
  constructor(message) { this.message = message; }
  setMessage(message) { this.message = message; }
  hide() {}
}
class FakeModal {
  constructor(app) { this.app = app; }
  open() {}
  close() {}
}
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
  async exists(filePath) {
    return files.has(filePath) || dirs.has(filePath);
  },
  async mkdir(folder) {
    const parts = folder.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      dirs.add(current);
    }
  },
  async readBinary(filePath) {
    const buffer = files.get(filePath);
    if (!buffer) throw new Error(`ENOENT ${filePath}`);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  },
  async writeBinary(filePath, data) {
    files.set(filePath, Buffer.from(data));
    const parent = path.posix.dirname(filePath);
    if (parent && parent !== '.') dirs.add(parent);
  },
  async stat(filePath) {
    if (files.has(filePath)) return { type: 'file', size: files.get(filePath).length };
    if (dirs.has(filePath)) return { type: 'folder', size: 0 };
    throw new Error(`ENOENT ${filePath}`);
  },
  async list(folder) {
    const prefix = folder ? `${folder}/` : '';
    const result = { files: [], folders: [] };
    for (const key of dirs) {
      if (key === folder || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest && !rest.includes('/')) result.folders.push(key);
    }
    for (const key of files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest && !rest.includes('/')) result.files.push(key);
    }
    return result;
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

function sha(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const fixture = `---
作者: 测试
---
## 作品简介：

　　简介。

## 第1章 开始。

　　正文一。

## 第2章 继续。

　　正文二。
`;

files.set('10 书籍/测试书.md', Buffer.from(fixture, 'utf8'));

(async () => {
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
  };

  const dest = await plugin.destinationFor('10 书籍/测试书.md');
  assert.strictEqual(dest.bookName, '测试书');
  assert.strictEqual(dest.destDir, '10 书籍/测试书');
  assert.deepStrictEqual(dest.targets, {
    md: '10 书籍/测试书/测试书.md',
    txt: '10 书籍/测试书/测试书.txt',
    epub: '10 书籍/测试书/测试书.epub',
  });

  const before = sha(files.get('10 书籍/测试书.md'));
  const parsed = await plugin.parseSource('10 书籍/测试书.md');
  assert.strictEqual(parsed.book.stats.chapterCount, 2);
  const result = await plugin.materialize(parsed.book, dest.destDir, {
    sourcePath: '10 书籍/测试书.md',
    overwrite: true,
    skipSourceFormat: false,
  });
  assert.strictEqual(result.results.length, 3);
  assert.ok(files.has('10 书籍/测试书/测试书.md'));
  assert.ok(files.has('10 书籍/测试书/测试书.txt'));
  assert.ok(files.has('10 书籍/测试书/测试书.epub'));
  assert.strictEqual(sha(files.get('10 书籍/测试书.md')), before, '源文件必须保持不变');
  assert.ok(files.get('10 书籍/测试书/测试书.txt').toString('utf8').includes('第001章 开始。'));

  const groups = await plugin.scanLibrary();
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].name, '测试书');
  assert.strictEqual(groups[0].hasFolder, true);
  assert.ok(Object.values(groups[0].files).every(Boolean));

  const group = await plugin.groupForFile('10 书籍/测试书/测试书.md');
  assert.strictEqual(group.dir, '10 书籍/测试书');
  assert.strictEqual(group.files.epub.size > 0, true);

  // 在目标位置的源文件：转换只补齐另外两种，不覆盖源 Markdown。
  const mdPath = '10 书籍/测试书/测试书.md';
  const sourceHashBeforeConvert = sha(files.get(mdPath));
  app.workspace.getActiveFile = () => ({ path: mdPath });
  plugin.askConfirm = async () => true;
  await plugin.convertActiveFile();
  assert.strictEqual(sha(files.get(mdPath)), sourceHashBeforeConvert, '转换不得覆盖源文件');
  assert.ok(files.has('10 书籍/测试书/测试书.txt'));
  assert.ok(files.has('10 书籍/测试书/测试书.epub'));
  assert.ok([...files.keys()].some((key) => key.startsWith('.book-format-sync/backups/')), '覆盖前应备份');

  console.log('plugin harness ok');
  console.log('  source hash unchanged:', before);
  console.log('  groups:', groups.map((g) => g.name));
  console.log('  files:', [...files.keys()].filter((key) => key.startsWith('10 书籍/测试书/')));
  console.log('  backups:', [...files.keys()].filter((key) => key.startsWith('.book-format-sync/backups/')).length);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
