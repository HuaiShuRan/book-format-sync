# book-library — 项目状态与交接摘要

> 最后整理：2026-11-26  
> 当前版本：`1.4.1`  
> 仓库：<https://github.com/HuaiShuRan/book-format-sync>  
> 最新 Release：<https://github.com/HuaiShuRan/book-format-sync/releases/tag/v1.3.9>（`v1.4.x` 尚未发布）

这份文件用于换电脑、重新 clone 或交给另一个 AI 时快速接手。先读本文件，再读 `README.md` 和 `AGENTS.md`。

---

## 1. 项目定位

`book-library` 是一个 Obsidian 桌面插件，维护每本书的三种格式：

```text
md + txt + epub
```

核心目标：

- 统一章节标题格式；
- 统一正文首行缩进；
- 从任意一种格式生成另外两种，且不修改源文件；
- 保证三种格式的章节、正文和缩进一致；
- 提供本地章节标题建议、按书输出路径和右键菜单。

运行时只依赖 Obsidian 和 Node 内置模块，不使用 npm 运行时依赖。

---

## 2. 当前已确认、不要回退的行为

这些是经过多轮确认的产品约束。修改代码前必须保留。

### 2.1 章节编号

- **一律不补零**：`第1章`、`第10章`、`第101章`。
- 不再按章节总数或最大章号计算位数。
- 不要重新引入手动“编号位数”输入。
- 章节号与标题之间统一一个半角空格。
- 保留原标题文字和标点；不凭空编造标题。

### 2.2 同章节行正文拆分（方案 A）

TXT 可能出现：

```text
第01章 道可道，非常道。名可名，非常名。……
```

处理规则：

- 章节号后文本较短 → 作为标题；
- 文本较长，或较长且含多个句末标点 → 作为正文，标题只保留 `第1章`；
- 短标题即使包含多个感叹号也仍是标题，例如 `第38章 不准磕！不准磕！`；
- 兼容 `第04章道冲而用之` 这种没有空格的写法。

### 2.3 Markdown 首行缩进

- 正文**不写** `&emsp;`、`&nbsp;` 或两个全角空格。
- `frontmatter` 保留：

```yaml
cssclasses: book-format-sync
```

- 阅读视图：`text-indent: 2em`；
- 实时预览：`.cm-line` 规则；
- 源码模式可能有视觉缩进，但源码字节不变；
- 插件 `styles.css` 仅隐藏属性面板中的 `cssclasses` 行，不删除 YAML，也不隐藏其他属性。
- 属性行隐藏依赖 Obsidian 的 `.metadata-property[data-property-key="cssclasses"]`；如果版本/主题改变 DOM，需要更新选择器。

### 2.4 TXT 与 EPUB

- TXT：正文首行两个全角空格 `\u3000\u3000`；
- EPUB：`<p class="body-paragraph" style="text-indent:2em;">` + CSS；
- 三格式渲染后必须在内存中重新解析并校验，校验不通过不能写盘。

### 2.5 源文件

- 转换/规范化不得静默修改源文件。
- 目标就是源文件时，覆盖前备份到：

```text
.book-format-sync/backups/<时间戳>/<书名>/<文件名>
```

### 2.6 设置页

- 按书路径配置是**手动增删条目**，不自动扫描；
- 不再有“原件路径”输入；
- 输出目录留空回退到 `10 书籍/<书名>/`；
- 路径必须是 vault 内相对路径，拒绝绝对路径和 `..`；
- 输出目录不存在时自动创建；
- 右键输出目录输入框可从 vault 目录选择；
- 不要隐藏全部属性来达到“隐藏 cssclasses”的目的。

---

## 3. 代码结构

```text
src/main.js         插件生命周期、命令、右键菜单、设置页、Modal、路径流程
lib/book.js         统一书籍模型、解析入口、三格式渲染、写盘前校验
lib/chapters.js     章节识别、编号、标题解析、TXT 同段正文拆分
lib/text.js         编码、分段、缩进、Markdown/TXT 文本处理
lib/epub.js         EPUB 解析/生成
lib/zip.js          零依赖 ZIP 读写
lib/titles.js       标题缺失检测、本地标题建议、缓存键
lib/paths.js        vault 相对路径校验、旧设置迁移、按书输出目录
lib/templates.js    书籍卡 / 读书笔记 / 书架看板模板（纯函数，只产出字符串）
styles.css          阅读视图/实时预览缩进、属性行隐藏、插件 UI 样式
tools/build.js      零依赖打包器，生成 main.js
tools/cli.js        命令行转换器
tests/*.js          测试与 harness
main.js             由 tools/build.js 生成的提交产物
manifest.json       插件 manifest，版本必须与版本号一致
versions.json       Obsidian 版本兼容表
CHANGELOG.md        版本变更
.github/workflows/  test.yml + release.yml
```

### 构建

```powershell
node tools/build.js
```

注意：

- `main.js` 是生成产物，必须提交；
- CI 会检查已提交的 `main.js` 是否与源码一致；
- 修改源码后必须重新构建。

---

## 4. 设置数据结构

持久化在 Obsidian 插件 `data.json`：

```json
{
  "bookRoot": "10 书籍",
  "folderPerBook": true,
  "chapterPrefix": "第",
  "chapterSuffix": "章",
  "chapterSeparator": " ",
  "backup": true,
  "overwrite": true,
  "txtLineEnding": "lf",
  "txtBom": false,
  "maxTitleChars": 10,
  "cardDir": "20 笔记/书目",
  "readingNoteDir": "20 笔记/读书笔记",
  "shelfBasePath": "90 书架/书架.base",
  "autoShelf": true,
  "allowScaffold": false,
  "ribbonLibrary": true,
  "ribbonNewCard": true,
  "autoRenameCover": true,
  "bookProfiles": [
    {
      "id": "book-...",
      "bookName": "某书",
      "mdDir": "10 书籍/某书",
      "txtDir": "90 附件/某书/txt",
      "epubDir": "90 附件/某书/epub",
      "cardDir": "20 笔记/某书卡"
    }
  ],
  "settingsVersion": 2
}
```

说明：

- `bookProfiles` 缺失时迁移为 `[]`；
- 旧 `originalPath` 字段会被丢弃；
- 设置中没有手动编号位数；
- 路径字段留空表示使用默认位置。

---

## 5. 命令与右键菜单

命令面板：

```text
扫描书库（只读）
生成章节标题建议（本地）
规范化并生成当前书籍三格式
只规范化当前文件
从当前文件转换生成另外两种格式
规范化书库全部书籍
新建书籍卡
新建读书笔记
按规则重命名当前书籍封面文件
布置书库目录结构
```

功能区（左侧图标，可在设置里逐个开关）：

```text
书库          -> 打开书库面板
新建书籍卡    -> 打开建卡弹窗（书名 / 作者 / 封面）
```

新命令的输出位置（v1.4.1）：

| 命令 / 行为 | 生成位置 |
|---|---|
| 新建书籍卡 | `<书籍卡片目录>/<书名>.md`，默认 `20 笔记/书目` |
| 新建读书笔记 | `<读书笔记目录>/<书名>.md`，默认 `20 笔记/读书笔记` |
| 书架 Base | 自动维护在 `<书架 Base 路径>`，默认 `20 笔记/书架.base` |

书籍卡与读书笔记已存在时只打开、不覆盖。书架 Base 在插件加载、新建书籍卡、修改卡片目录时自动重写；Bases 视图本身实时查询，因此没有手动刷新命令。

封面命名（设置项「封面自动重命名」开启时）：选中图片会在原目录重命名为 `《书名》-作者封面.ext`，无作者时为 `《书名》封面.ext`；重命名走 Obsidian 文件管理器，已有链接会同步更新。

文件列表右键：

```text
书库
├─ 生成章节标题建议
├─ 规范化并生成三格式
├─ 只规范化
└─ 从当前文件生成另外两种
```

“只规范化”的语义：只写当前文件对应的那一种格式，不生成另外两种；目标就是当前文件时强制备份。

---

## 6. 测试

每次改动前后至少运行：

```powershell
node tests/run-tests.js
node tests/plugin-harness.js
node tests/title-apply-harness.js
node tests/menu-harness.js
node tests/library-harness.js
```

当前基线（v1.4.0）：

```text
run-tests: 31 tests passed
plugin-harness: ok
title-apply-harness: ok
menu-harness: ok
library-harness: 18 tests passed
```

测试覆盖重点：

- 章节编号不补零；
- 中文数字/全角数字；
- 同章节行正文拆分；
- 带感叹号的短标题不被误判；
- 重复章节号长标题按正文处理；
- 标题缺失检测与本地标题缓存；
- vault 路径校验、输出目录回退、旧设置迁移；
- 三格式生成、互转、EPUB 结构；
- Markdown 不写实体缩进；
- 阅读/实时预览 CSS 规则存在；
- 属性行隐藏规则存在。

---

## 7. 发布流程

仓库已有 GitHub Actions：

- `.github/workflows/test.yml`：push/PR 时跑四个测试；
- `.github/workflows/release.yml`：推送 `v*` tag 时构建并创建 Release。

发布步骤：

1. 修改 `manifest.json` 版本；
2. 更新 `versions.json`；
3. 更新 `CHANGELOG.md`；
4. 运行 `node tools/build.js`；
5. 跑四个测试；
6. 提交；
7. 打 annotate tag：`vX.Y.Z`；
8. 推送 main 和 tag；
9. 等 release workflow 成功；
10. 核对 Release 资产：`main.js`、`manifest.json`、`styles.css`、zip。

当前 Release：

```text
v1.3.9（线上最新）
v1.4.0（本地已就绪，待打 tag 发布）
```
文档-only 改动不需要发 Release；用户可见功能/修复按仓库习惯升 patch/minor 版本。

---

## 8. 安装到 Obsidian

目标目录：

```text
<vault>/.obsidian/plugins/book-library/
```

必须至少包含：

```text
main.js
manifest.json
styles.css
```

开发源码目录中的 `lib/`、`src/` 不参与运行时加载；`main.js` 已打包它们。

安装后：

- 重启 Obsidian 或重新加载插件；
- 确认插件已启用；
- 打开带 `cssclasses: book-format-sync` 的 Markdown 笔记验证缩进；
- 属性面板应只隐藏 `cssclasses` 一行。

---

## 9. 已知限制与待办

### 已知限制

- 批量扫描仍只扫描默认书库根目录；完全在根目录外的书需要从文件/右键单独转换。
- 属性行隐藏依赖 Obsidian 内部 DOM 和 `data-property-key`，主题/版本可能改变。
- 实时预览缩进依赖 `.cm-line` 和内部 `HyperMD-*` class，升级后需回归。
- 源码模式可能出现视觉缩进，这是 CSS 行为，不是源码字符。
- 标题建议对“同章节行正文”的书可能生成与正文首句重复的标题；应用标题前应确认是否要移出首句。
- EPUB 解析不支持 ZIP64/加密/分卷；EPUB 图片在纯文本格式中变成 `[图片]`。
- 章节号缺失/重复只报告，不自动补号或重排。
- 书架看板依赖 Obsidian 内置 Bases（Obsidian ≥ 1.9；卡片视图 1.9、看板视图 1.14），不依赖任何社区插件。
- 书籍卡与读书笔记写在「笔记目录」下，与书库目录（三格式文件）分离，避免被规范化改写。

### 建议下一步

1. 对属性行隐藏做一次实际 Obsidian 重载后的目视验证；若失效，检查 DOM 并更新选择器。
2. 为主题覆盖增加一个可选的更强选择器 fallback，但不要隐藏全部属性。
3. 评估“标题建议 + 正文首句”是否重复；若需要，做显式选项，不默认改动正文。
4. 如果批量管理需求增加，再考虑把 `bookProfiles` 的书纳入扫描/状态面板。
5. 继续保留“源文件不动、写前校验、覆盖前备份”三条安全约束。

---

## 10. 接手检查清单

1. clone 仓库；
2. 读本文件、`README.md`、`AGENTS.md`；
3. `node tools/build.js`；
4. 跑四个测试；
5. 确认 `manifest.json` 版本与最新 Release；
6. 检查 `main.js` 与源码一致；
7. 修改前先确认不会回退第 2 节的约束；
8. 功能改动后重复构建、测试、版本、Release 流程。

---

## 11. 安全与隐私

- 本仓库不包含书籍正文、个人 vault 路径、Token 或账号凭据。
- 不要在公开仓库写入真实书名、个人目录或备份内容。
- 示例统一使用“某书”“<vault>”等占位符。
- `.gitignore` 排除本地书籍、备份、缓存和个人文件。

---

## 12. 版本摘要

| 版本 | 主要内容 |
|---|---|
| 1.3.0 | 初版三格式同步、章节规范化、标题建议、右键菜单 |
| 1.3.1 | Markdown 改用 cssclasses + CSS 2em，移除 `&emsp;` |
| 1.3.2 | 增加 `.cm-line` 实时预览缩进 |
| 1.3.3 | 按书输出路径配置 |
| 1.3.4 | 移除原件路径输入、目录右键选择、通用占位符 |
| 1.3.5 | 增加“只规范化” |
| 1.3.6 | 同章节行正文拆分、自动编号位数（后被 1.3.7 取消） |
| 1.3.7 | 章节序号一律不补零 |
| 1.3.8 | 短感叹号标题不被误判为正文 |
| 1.3.9 | 插件样式仅隐藏属性面板中的 cssclasses 行 |
| 1.4.0 | 书库内容框架：书籍卡/读书笔记/书架看板三命令、面板工具栏、笔记目录设置、`lib/templates.js`、`docs/LIBRARY-PLAN.md` |
