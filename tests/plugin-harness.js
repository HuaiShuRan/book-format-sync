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
    bookProfiles: [],
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

  // 只规范化：只写当前格式，不生成另外两种格式。
  const onlySource = '00 收件箱/只规范化测试.txt';
  files.set(onlySource, Buffer.from(`第1章 001

　　只规范化正文。
`, 'utf8'));
  const onlySourceHash = sha(files.get(onlySource));
  app.workspace.getActiveFile = () => ({ path: onlySource });
  await plugin.normalizeOnlyActiveFile();
  assert.ok(files.has('10 书籍/只规范化测试/只规范化测试.txt'));
  assert.ok(!files.has('10 书籍/只规范化测试/只规范化测试.md'));
  assert.ok(!files.has('10 书籍/只规范化测试/只规范化测试.epub'));
  assert.strictEqual(sha(files.get(onlySource)), onlySourceHash, '只规范化的源文件必须保持不变');

  // 自定义每本书输出路径：默认目录不应再产生重复文件；清空配置后恢复默认。
  const profileSource = '00 收件箱/路径测试.txt';
  files.set(profileSource, Buffer.from(`第1章 001

　　第一段。

第2章 002

　　第二段。
`, 'utf8'));
  const profileSourceHash = sha(files.get(profileSource));
  plugin.settings.bookProfiles = [{
    id: 'profile-test',
    bookName: '路径测试',
    mdDir: '自定义/md',
    txtDir: '自定义/txt',
    epubDir: '自定义/epub',
  }];
  app.workspace.getActiveFile = () => ({ path: profileSource });
  await plugin.convertActiveFile();
  assert.ok(files.has('自定义/md/路径测试.md'));
  assert.ok(files.has('自定义/txt/路径测试.txt'));
  assert.ok(files.has('自定义/epub/路径测试.epub'));
  assert.ok(![...files.keys()].some((key) => key.startsWith('10 书籍/路径测试/')), '默认目录不应产生重复文件');
  assert.strictEqual(sha(files.get(profileSource)), profileSourceHash, '原件必须保持不变');

  plugin.settings.bookProfiles = [];
  await plugin.convertActiveFile();
  assert.ok(files.has('10 书籍/路径测试/路径测试.md'));
  assert.ok(files.has('10 书籍/路径测试/路径测试.txt'));
  assert.ok(files.has('10 书籍/路径测试/路径测试.epub'));
  assert.strictEqual(sha(files.get(profileSource)), profileSourceHash, '清空配置后原件仍不变');

  console.log('plugin harness ok');
  console.log('  source hash unchanged:', before);
  console.log('  groups:', groups.map((g) => g.name));
  console.log('  files:', [...files.keys()].filter((key) => key.startsWith('10 书籍/测试书/')));
  console.log('  backups:', [...files.keys()].filter((key) => key.startsWith('.book-format-sync/backups/')).length);
  console.log('  custom profile files:', [...files.keys()].filter((key) => key.startsWith('自定义/')));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});


