# book-library 图书馆化实施计划

> 起始版本：`1.3.9`　|　计划版本：`1.4.x` → `1.6.x`　|　编写：2026-11-26
> 目标：把"三格式同步工具"扩展成"个人图书馆插件"——能读、能管书、能一键建卡片与书架。
> 本文只定方案，不含实现。实现按第 5 节顺序推进，每期独立可发布。

---

## 1. 背景

现有插件已解决"同一本书的 md / txt / epub 三格式一致"问题（章节规范化、2em 缩进、互转、覆盖前备份、写前校验、31 个测试）。

用户需求（Book 库 `00 收件箱/obsidian图书馆插件.md`）在此基础上提出六项能力：

1. 在 Obsidian 内阅读 txt / pdf / epub
2. 格式转换与排版自动纠正
3. 内容框架：书籍卡模板、书架看板、读书笔记模板
4. 书籍内容获取（网络 / AI）
5. 与用户交互（设置页、面板）
6. 其它

其中 1、2、5 属于插件本职；3 属于"插件生成一次、之后用户自维护"；4 被判定为不做（见第 2 节）。

---

## 2. 范围

### 2.1 做

| 编号 | 能力 | 归属期 |
|---|---|---|
| S1 | 书库扫描与目录索引（catalog） | v1.4 |
| S2 | 一键新建书籍卡、读书笔记、书架看板 | v1.4 |
| S3 | 书库面板（列表、缺失格式、章节异常、批量规范化） | v1.4 |
| S4 | TXT / MD 阅读视图（字号、行距、章节导航、进度记录） | v1.5 |
| S5 | EPUB 阅读视图（复用现有解析器，沙箱渲染） | v1.5 |
| S6 | 元数据补全（书名/作者/简介/封面，只填空字段） | v1.6 |
| S7 | 批量规范化的差分预览与撤销 | v1.6 |

### 2.2 不做（明确排除，写进 README）

| 编号 | 能力 | 原因 |
|---|---|---|
| N1 | 内置"获取书籍文件"（网络下载 / AI 抓取） | 版权与仓库下架风险；插件为 MIT 公开分发，不能提供侵权工具 |
| N2 | AI 生成摘要 / 标签 / 人物表 | 用户确认本期不接 AI；保留接口位置，不实现 |
| N3 | PDF → 文本转换 | 零依赖下无可行方案，见附录 A |
| N4 | 移动端支持 | 阅读视图与 EPUB 渲染依赖桌面端能力；`isDesktopOnly` 保持不变 |
| N5 | 自动补章节号 / 自动重排章节 | 与既有产品约束冲突（只报告，不自动改） |

> 不为 N1 留任何"隐藏开关"。若将来需要，只能作为用户本地私有分支存在，不进入公开仓库。

---

## 3. 现状盘点（v1.3.9）

| 能力 | 代码位置 | 图书馆化时的复用方式 |
|---|---|---|
| 章节识别与规范化 | `lib/chapters.js` | 阅读视图的章节导航直接复用 |
| 文本分段与缩进 | `lib/text.js` | TXT / MD 阅读视图排版复用 |
| EPUB 解析与生成 | `lib/epub.js` | **阅读视图的核心资产**：解析结果即渲染数据源 |
| 零依赖 ZIP 读写 | `lib/zip.js` | 从 EPUB 提取图片 → `URL.createObjectURL` |
| vault 路径校验 | `lib/paths.js` | 书籍卡生成、输出目录沿用 |
| 标题建议与缓存 | `lib/titles.js` | 面板里的"待补标题"列 |
| 三格式渲染与校验 | `lib/book.js` | 面板"一键规范化"直接调用 |
| 插件生命周期/命令/菜单/设置 | `src/main.js` | 新增命令与面板挂载点 |
| 零依赖打包 | `tools/build.js` | 按 require 图打包，新增模块无需改构建 |
| 测试 | `tests/*.js`（31 项） | 新增 `library-harness.js`、`reader-harness.js` |

**结论**：EPUB 阅读不需要从零做，`lib/epub.js` + `lib/zip.js` 已经覆盖解析层，缺的只是渲染视图。

---

## 4. 关键决策（已与用户确认）

| # | 议题 | 结论 | 依据 |
|:--:|---|---|---|
| D1 | 依赖策略 | **继续保持零 npm 依赖** | 打包简单、CI 快、体积小；代价是 PDF 文本提取不可行 |
| D2 | 书籍获取 / AI | **只做元数据补全，不接 AI，不做下载** | 版权与仓库风险；用户选择最保守方案 |
| D3 | 内容框架 | **插件一键生成，生成后与插件脱钩** | 不锁死用户格式，后续可自改 |
| D4 | PDF | **本期不做文本转换**，只做原生打开 + 页码进度 | 见附录 A；这是唯一可切换的决策，见第 12 节 |
| D5 | 移动端 | 保持 `isDesktopOnly: true` | 阅读渲染依赖桌面端 |
| D6 | 不可回退项 | 源文件不静默改、写盘前校验、覆盖前备份 | 交接书 §3.5，继续保留 |

---

## 5. 分期路线

### v1.4 — 书库骨架（不含阅读器）

**目标**：把空 vault 变成可用书库；完全不碰阅读视图，风险最低。

任务：

| # | 文件 | 内容 | 验收 |
|:--:|---|---|---|
| T1 | `lib/library.js` | `scanLibrary(root)` 返回每本书的 `{name, mdDir, txtDir, epubDir, files, chapterCount, issues[]}`；纯只读，不写盘 | 单测覆盖：正常书、缺格式、空目录、路径越界 |
| T2 | `lib/templates.js` | 三个模板函数 `bookCard()` / `readingNote()` / `shelfBoard()`，返回字符串；不依赖 Templater | 快照测试比对生成结果 |
| T3 | `src/main.js` | 新命令：`新建书籍卡`、`新建读书笔记`；书架 Base 自动维护 | 命令注册成功、生成文件内容正确 |
| T4 | `src/panel.js` | `LibraryModal`：表格列出书籍 + 缺失格式 + 章节异常；单行操作（规范化 / 打开三格式） | harness 用 DOM stub 验证渲染与操作回调 |
| T5 | `tests/library-harness.js` | 扫描 + 模板 + 面板三块 | `node tests/library-harness.js` 通过 |

**不包含**：阅读、PDF、元数据。

### v1.5 — 阅读与校对

**目标**：真正能在 Obsidian 里读书。

任务：

| # | 文件 | 内容 | 验收 |
|:--:|---|---|---|
| T6 | `src/reader.js` | `ReadingView`（`ItemView`）：TXT / MD 渲染，字号、行距、章节目录侧栏 | 打开一篇 10 万字 md，滚动流畅 |
| T7 | `src/reader-epub.js` | EPUB 渲染：`lib/epub.js` 解析 → 沙箱 iframe；图片经 `lib/zip.js` → blob URL | 打开一本 5 MB EPUB，图片正常、无外部网络请求 |
| T8 | 进度 | 进度写入 frontmatter `阅读进度: {章节, 位置}`；面板显示进度 | 关闭重开后回到上次位置 |
| T9 | PDF | 用 Obsidian 原生 PDF 视图打开；只记录页码 `pdfPage` | 不做文本提取 |
| T10 | `tests/reader-harness.js` | 渲染函数与进度读写 | 通过 |

**风险点**：大 EPUB 解析在主线程会卡，需分片 + 进度提示（见第 10 节）。

### v1.6 — 格式补强与元数据

| # | 文件 | 内容 | 验收 |
|:--:|---|---|---|
| T11 | `lib/metadata.js` | 从 Open Library / Google Books 查书名元数据，**只填空字段**，不覆盖用户手填 | 有网络/无网络两条路径都有降级 |
| T12 | 封面 | 下载封面到 `99 附件/<书名>/cover.jpg`，写入 frontmatter `封面` | 只写新文件，不覆盖已有封面 |
| T13 | `lib/diff.js` | 规范化前的差分预览（哪些章节标题变、哪些缩进变） | 面板里逐条显示，可勾选应用 |
| T14 | 撤销 | 应用前把原文件备份到 `.book-format-sync/backups/`，面板提供"还原上一版" | 还原后内容字节级一致 |

---

## 6. 数据模型

### 6.1 settings 扩展（`data.json`）

```json
{
  "settingsVersion": 3,
  "library": {
    "catalogCache": [
      {
        "id": "book-...",
        "name": "某书",
        "mdDir": "10 书籍/某书",
        "txtDir": "99 附件/某书/txt",
        "epubDir": "99 附件/某书/epub",
        "has": { "md": true, "txt": true, "epub": false },
        "chapterCount": 120,
        "issues": ["missing-epub", "chapter-gap:第10章"]
      }
    ],
    "lastScan": 1764139200000,
    "metadataCache": { "某书": { "author": "…", "cover": "…", "fetchedAt": 1764139200000 } }
  }
}
```

约束：

- `catalogCache` 只存**元信息**，绝不存书籍正文
- `settingsVersion` 2 → 3 迁移：缺少 `library` 字段时补默认值，不动既有 `bookProfiles`
- 缓存可在设置页一键清空

### 6.2 frontmatter 约定（书籍卡）

```yaml
aliases: []
tags:
  - 书/小说
笔记类型: 书目
状态: 在读
评分: 
作者: 
译者: 
出版年: 
页数: 
体裁: 小说
内容: 文学
格式: epub
开始日期: 
读完日期: 
阅读进度: 
封面: 
cssclasses: book-format-sync
```

> `cssclasses: book-format-sync` 保留，用于阅读视图的缩进样式；其余字段沿用用户原有书籍模板口径。

---

## 7. 模板规格

三份模板以字符串常量形式内置于 `lib/templates.js`，生成后与插件无关（用户可自由修改）。

### 7.1 书籍卡

```markdown
# 《{{name}}》

> [!info] 一句话
> （填写：这本书讲什么、为什么值得读。）

## 我为什么读它

## 用自己的话概括

## 摘录

> [!quote] 第 X 章
> （原文）
>
> —— 想法：
```

### 7.2 读书笔记

```markdown
# 《{{name}}》读书笔记

> [!abstract] 核心结论
> （填写：三五句话。）

## 逐章笔记

### 第 X 章

- 要点：
- 我的疑问：

## 与其它书的对照

- [[（另一本书）]]
```

### 7.3 书架看板（Bases）

生成 `00 书架.base`（Obsidian 内置 Bases，不依赖社区插件）并在卡片目录变化时自动重写；不生成 `.md` 落地页。

- 卡片视图：`image: 封面` 从书籍卡的 `封面` 属性取图，`imageFit` / `imageAspectRatio` / `cardSize` 控制外形
- 看板视图：`type: kanban` + `groupBy: 状态` + `groupOrder` 固定列顺序（Notion 式看板）
- 表格视图：全部书目的清单
- 全局 `filters: file.inFolder("<笔记目录>/书目")` 限定数据源

```yaml
filters:
  and:
    - file.inFolder("20 笔记/书目")
views:
  - type: cards
    name: 书架
    image: 封面
  - type: kanban
    name: 状态看板
    groupBy:
      property: 状态
      direction: ASC
```

> 版本要求：Obsidian ≥ 1.9（Bases 卡片视图）、≥ 1.14（看板视图）。低于此版本时看板会退化为可编辑的 YAML 文本。

---

## 8. 架构与约束

| 项 | 规定 |
|---|---|
| 新增模块 | `lib/library.js`、`lib/templates.js`、`lib/metadata.js`、`lib/diff.js`、`src/panel.js`、`src/reader.js`、`src/reader-epub.js` |
| 打包 | `tools/build.js` 按 require 图打包，新增文件无需改构建；改完必须 `node tools/build.js` 并提交 `main.js` |
| 网络 | 只用 Obsidian `requestUrl`（避开 CORS），且仅 v1.6 元数据用；失败必须静默降级 |
| 内部 API | 阅读视图优先公开 API；避免依赖 `HyperMD-*` 等内部 class |
| 写盘 | 一律走 `lib/paths.js` 校验；目标即源文件时强制备份 |
| 性能 | 单文件 > 5 MB 时先提示并分片处理；解析放 `setTimeout` 分片，不阻塞 UI |

---

## 9. 测试计划

| 文件 | 覆盖 |
|---|---|
| `tests/run-tests.js`（现有 31 项） | 保持全绿，回归基线 |
| `tests/library-harness.js` | 扫描结果、模板快照、面板渲染与回调 |
| `tests/reader-harness.js` | 渲染函数、进度读写、大文件分片 |
| `tests/metadata-harness.js` | 网络成功 / 失败 / 只填空字段不覆盖 |

发布前四条命令全绿（`run-tests`、`plugin-harness`、`title-apply-harness`、`menu-harness`）＋ 新增两条。

---

## 10. 风险

| 风险 | 影响 | 处置 |
|---|---|---|
| 大 EPUB 解析卡主线程 | 打开 30 MB 书冻结数秒 | 分片解析 + 进度条；必要时 Web Worker |
| 阅读视图依赖内部 DOM | Obsidian 升级后样式或行为失效 | 只用公开 API；CSS 加 fallback |
| 网络请求失败 | 元数据补全不可用 | 全流程降级为手动，不阻断其它功能 |
| 面板/阅读器测试难自动化 | 回归成本上升 | 用现有 harness 的 DOM stub 模式，不引入测试框架 |
| 体积膨胀 | 插件加载变慢 | 零依赖原则（D1）+ 禁止进入 N1/N3 |

---

## 11. 发布与本地验证

1. `node tools/build.js`
2. 跑第 9 节全部测试
3. 更新 `manifest.json` / `versions.json` / `CHANGELOG.md`
4. 把 `main.js`、`manifest.json`、`styles.css` 拷到目标库：

```text
D:\小米云盘\note\Book\.obsidian\plugins\book-library\
```

5. 重启 Obsidian，确认"已安装插件"里能看到并启用
6. 打 tag 走 release workflow

> 注意：目录名必须等于 `manifest.json` 的 `id`（`book-library`），否则不加载。

---

## 12. 待决问题

| # | 问题 | 选项 | 默认 |
|:--:|---|---|---|
| Q1 | PDF 是否放弃文本转换 | A 放弃（本期）/ B 用 pdf.js（+1.5~2 MB）/ C 外部 `pdftotext`（不算 npm 依赖） | **A**（见附录 A） |
| Q2 | 书架 Base 视图组合 | A 仅卡片 / B 卡片 + 表格 | B（已按此实现） |
| Q3 | 元数据源优先级 | Open Library / Google Books / 手动 CSV 导入 | Open Library 优先，Google Books 兜底 |
| Q4 | 阅读进度存哪里 | A 书籍卡 frontmatter / B 独立 `library.json` | A（随笔记走，可同步） |

---

## 附录 A：PDF 方案评估（2026-11 调研）

结论：**零依赖前提下，PDF → 文本没有轻量方案**。

| 方案 | 本质 | 体积代价 | 与 D1 冲突 | 备注 |
|---|---|---|---|---|
| pdf.js（`pdfjs-dist`） | 唯一事实标准 | main.js +1.5~2.2 MB | 冲突（等于引入重量级依赖） | MIT/Apache 系许可，成熟 |
| `pdf-parse` / `pdf2json` / `unpdf` | 均为 pdf.js 包装 | 同上 | 冲突 | "零依赖"只是包装层零依赖 |
| `clawpdf`（PDFium WASM） | wasm 二进制 | 额外 .wasm 文件（数 MB） | 部分冲突 | 需从插件目录加载 wasm，桌面限定 |
| 外部 `pdftotext` / Calibre | 系统二进制 | 0 | 不冲突 | 依赖用户装软件，属可选增强 |

参考：
- <https://github.com/openclaw/clawpdf>
- <https://www.npmjs.com/package/unpdf>
- <https://github.com/modesty/pdf2json>
- 打包实测（pdf.js 主模块 + worker 约 2.2 MB）：<https://git.jkaindl.de/jkaindl/image-to-markdown/commit/7d0f39f479ebcdf55b746fea741cae0c6b6aa714>

若将来放行 D1，则优先 `pdfjs-dist`，并把 PDF 文本提取限定为"用户显式触发的单本转换"，不做批量。

---

## 附录 B：代码地图（新增部分）

```text
lib/library.js        书库扫描与目录模型（只读）
lib/templates.js      三份模板字符串与生成函数
lib/metadata.js       元数据补全（v1.6，网络）
lib/diff.js           规范化差分预览（v1.6）
src/panel.js          书库面板（LibraryModal）
src/reader.js         TXT / MD 阅读视图
src/reader-epub.js    EPUB 阅读视图（沙箱 iframe）
tests/library-harness.js
tests/reader-harness.js
tests/metadata-harness.js
```
