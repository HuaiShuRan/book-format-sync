'use strict';

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
      normalizePath: (value) => String(value).replace(/\\/g, '/'),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const BookFormatSyncPlugin = require('../main.js');
Module._load = originalLoad;

function makeMenu() {
  const menu = { items: [] };
  menu.addItem = (build) => {
    const item = {
      title: '',
      icon: '',
      submenu: null,
      setTitle(value) { this.title = value; return this; },
      setIcon(value) { this.icon = value; return this; },
      setSubmenu() {
        const submenu = makeMenu();
        this.submenu = submenu;
        return submenu;
      },
      onClick(handler) { this.click = handler; return this; },
    };
    build(item);
    menu.items.push(item);
  };
  return menu;
}

const plugin = new BookFormatSyncPlugin({}, {});
const file = new FakeTFile();
file.path = '10 书籍/测试书/测试书.txt';
const menu = makeMenu();
plugin.addBookFileMenu(menu, file);
assert.strictEqual(menu.items.length, 1);
assert.strictEqual(menu.items[0].title, '书库');
assert.strictEqual(menu.items[0].submenu.items.length, 4);
assert.deepStrictEqual(menu.items[0].submenu.items.map((item) => item.title), [
  '生成章节标题建议',
  '规范化并生成三格式',
  '只规范化',
  '从当前文件生成另外两种',
]);

const other = new FakeTFile();
other.path = '10 书籍/测试书/封面.png';
const otherMenu = makeMenu();
plugin.addBookFileMenu(otherMenu, other);
assert.strictEqual(otherMenu.items.length, 0);

console.log('menu harness ok');
console.log('  parent:', menu.items[0].title);
console.log('  children:', menu.items[0].submenu.items.map((item) => item.title));


