# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project uses [Semantic Versioning](https://semver.org/).

## [1.7.1] - 2026-11-27

### Changed

- 「布置书库」的判定范围由「书库目录是否为空」改为**整个 vault 是否为空**：只要 vault 里存在任何用户文件夹或文件（`.obsidian`、`.trash`、`.git`、`.book-format-sync` 除外），就只生成建议、不做任何其它改动。
- 建议文件改为写到 **vault 根目录的 `书库结构建议.md`**，不再新建 `00 收件箱`，确保"除了这一份 md 之外不产生任何文件夹或文件"。

## [1.7.0] - 2026-11-27

### Added

- 新命令「布置书库目录结构」与设置项「允许布置书库结构」（**默认关闭**）：一键创建推荐目录（`00 收件箱` / 书库目录 / 卡片目录 / 读书笔记目录 / Base 所在目录 / `90 附件`），并在每个目录写入 `_目录说明.md`，让 Obsidian 能显示空目录。
- 书库目录**已有内容**时不做任何改动，只在 `00 收件箱/书库结构建议.md` 生成一份对照建议（推荐结构、取舍理由、三种迁移走法）。
- 仅在用户主动触发（命令或设置页按钮）时执行，插件加载不会自动运行。

### Changed

- 默认书架 Base 路径由 `20 笔记/书架.base` 改为 `90 书架/书架.base`（已保存的旧值不受影响，仍按你的设置走）。

### Notes

- 幂等：已存在的目录跳过、已存在的文件不覆盖、重复执行无副作用。
- 生成完成后自动重写书架 Base。

## [1.6.0] - 2026-11-26

### Changed

- 合并路径配置：每本书的「路径组」在原有 `mdDir / txtDir / epubDir` 之外新增 `cardDir`。该书的书籍卡优先写入书级 `cardDir`，留空则回退全局「书籍卡片目录」。
- 书架 Base、封面解析、面板里的"打开书籍卡"都按书级 `cardDir` 定位，不再一律使用全局目录。
- 书级路径输入框统一为"可见文件夹按钮 + 右键"两种选择方式，提示文案同步更新。
- 书架 Base 的过滤条件支持多个卡片目录：全局目录 + 各书级 `cardDir` 去重后用 `or` 组合，避免某本书单独设了目录就消失在书架里。

### Notes

- 旧设置无需迁移：`migrateSettings` 会把缺失的 `cardDir` 补成空串，行为等同"使用全局默认"。

## [1.5.0] - 2026-11-26

### Added

- 新设置「书架卡片宽度（px）」「书架封面比例（宽/高）」：卡片视图的尺寸与封面宽高比可调，修改后自动重写 Base。
- 新命令「按规则重命名当前书籍封面文件」：对已有书籍卡补做一次封面重命名，并把新文件名写回 `封面` 属性。

### Changed

- 状态栏只在该书属于「书库目录」内的 md/txt/epub 时显示「三格式 x/3」，其它文件不再占位。

### Removed

- 设置页移除「覆盖前备份」开关，改为**始终备份**到 `.book-format-sync/backups/`。
- 设置页移除「扫描书库 / 打开面板」按钮（面板仍可从功能区图标或命令面板打开）。

## [1.4.2] - 2026-11-26

### Added

- 所有路径类设置都加了「从 vault 目录中选择」按钮：书库目录、书籍卡片目录、读书笔记目录、书架 Base 文件位置；每本书的输出目录也由"仅右键"改为可见按钮 + 右键两种方式。

### Fixed

- 设置页标题、文件右键菜单标题仍显示旧名「书库三格式同步」，统一改为「书库」。
- 新建书籍卡时封面重命名提前于"卡片是否已存在"的判断，可能出现建卡失败却已改动用户图片文件名；改为确认可建卡后再重命名。
- 书库面板里每本书的「新建书籍卡」按钮会直接建卡、无法填封面与作者；改为打开预填书名的建卡弹窗。
- README 里 `cssclasses` 说明与最低 Obsidian 版本（1.5.0 → 1.9.0）未随改名/改版更新。

## [1.4.1] - 2026-11-26

### Added

- 功能区新增「新建书籍卡」按钮，默认开启。
- 设置页新增「功能区：书库按钮」「功能区：新建书籍卡按钮」两个开关，可分别隐藏对应按钮。
- 设置页新增「封面自动重命名」开关：新建书籍卡时把选中的图片重命名为 `《书名》-作者封面.ext`（无作者时 `《书名》封面.ext`）。
- 新建书籍卡弹窗新增「作者」输入与「选择图片」按钮：可直接从 vault 图片列表中搜索选择封面。
- 新增纯函数 `coverFileName()`（`lib/templates.js`），负责封面命名规则。

### Fixed

- 修复命令面板「新建书籍卡」「新建读书笔记」因模态框签名变更而变成空操作的问题。
- 功能区图标的提示文字由「书库三格式同步」更正为「书库」。

### Removed

- 移除命令「刷新书架 Base」与面板上的刷新按钮：Bases 视图本身实时查询，Base 数据源变化时插件已自动重写，无需手动刷新。

## [1.4.0] - 2026-11-26

### Added

- 书库内容框架：新增 `lib/templates.js`，内置书籍卡、读书笔记、书架看板三份模板。模板只生成一次，生成后与插件脱钩，用户可自由修改。
- 新命令：`新建书籍卡`、`新建读书笔记`、`生成书架看板`。书籍卡写入「笔记目录/书目」，读书笔记写入「笔记目录/读书笔记」。
- 书架看板改用 Obsidian 内置 **Bases**：生成 `笔记目录/00 书架.base`（卡片画廊 + 状态看板 + 在读 + 清单四个视图）与落地页 `笔记目录/00 书架.md`（嵌入看板 + 使用说明）。卡片视图用 `image: 封面` 显示封面，看板视图按 `状态` 分列，不依赖任何社区插件。
- 书库面板新增工具栏（新建书籍卡 / 生成书架看板），并为每本书增加书籍卡入口：未创建时显示「新建书籍卡」，已存在时显示「打开书籍卡」。
- 设置页新增「笔记目录」，默认 `20 笔记`，用于存放上述三类文件。
- 新增 `tests/library-harness.js`（18 项）：模板内容、标签合法性、路径计算与 YAML 转义。
- 新增 `docs/LIBRARY-PLAN.md`：图书馆化分期计划（v1.4 骨架 / v1.5 阅读 / v1.6 元数据）与范围界定。

### Changed

- 插件更名为「书库」，manifest id 改为 `book-library`。安装目录需同步改为 `.obsidian/plugins/book-library/`；首次加载会自动从旧目录 `book-format-sync/data.json` 读取设置完成迁移。
- 设置项重做：`书籍卡片目录`、`读书笔记目录`、`书架 Base 路径`、`自动维护书架 Base`。旧的 `笔记目录` 会自动换算成上述三个路径。
- 书架 Base 改为按设置自动维护：插件加载、新建书籍卡、修改卡片目录时自动重写；原命令「生成书架看板」替换为「刷新书架 Base」，并且不再生成 `.md` 落地页。
- 新建书籍卡弹窗新增「封面」输入：支持 vault 内图片路径（写成 `[[...]]`）与 `http(s)` 图片地址。
- EPUB 生成支持封面：从书籍卡（或书库内同名 md 的）`封面` 属性读取 vault 内图片，写入 `OEBPS/cover.<ext>` 与 OPF 的 `cover-image` 条目及 `<meta name="cover">`；不新增 XHTML 页，因此章节文件数与三格式校验不受影响。远程 `http(s)` 封面不下载。TXT 为纯文本格式，无法内嵌封面。
- **CSS 数据标识保持不变**：frontmatter 仍写 `cssclasses: book-format-sync`，避免已生成的书籍失去 2em 缩进样式。

### Notes

- 明确不做：内置书籍下载、AI 生成内容、PDF → 文本转换、移动端支持。
- 书籍卡不写 `cssclasses: book-format-sync`，避免继承正文首行缩进。
- 新建书籍卡/读书笔记时，若文件已存在则只打开、不覆盖。

## [1.3.9] - 2026-11-23

### Changed

- Plugin styles hide only the `cssclasses` property row in notes carrying `book-library`; the YAML field and all other properties remain unchanged. Reading/live-preview indentation is unaffected.

## [1.3.8] - 2026-11-22

### Fixed

- Short chapter titles containing two or more exclamation/question marks (for example `第38章 不准磕！不准磕！`) were misclassified as inline body text, causing TXT verification to expect a title-less heading. Inline-body detection now requires a longer remainder before using punctuation as the signal.

## [1.3.7] - 2026-11-22

### Changed

- Chapter numbers are never zero-padded: `第1章`, `第10章`, `第101章`. The automatic chapter-count width rule and maximum-number fallback were removed.
- Settings now explain the no-padding rule; no manual number-width input was reintroduced.

## [1.3.6] - 2026-11-22

### Fixed

- Same-line TXT chapter bodies such as `第01章 道可道…` are split into an empty title plus body, so the whole chapter is no longer treated as a chapter title.
- Long chapter titles (over 160 characters after normalization) caused the md/txt verification parser to undercount chapters; heading parsing now allows up to 512 characters and normalized TXT headings bypass the 160-character prose guard.

### Changed

- Chapter number width is now automatic from the book's chapter count (and maximum chapter number): 81 chapters → `第01章`, 340 → `第001章`.
- Removed the manual number-padding input from settings.

## [1.3.5] - 2026-11-22

### Added

- `只规范化` command and file-explorer menu item: writes only the current format, does not create the other two, and force-backs up the current file when it is also the target.

## [1.3.4] - 2026-11-22

### Changed

- Removed the per-book original-path input from settings; conversion reads the current file and normalization uses the default book directory.
- Replaced personal-looking path examples with generic placeholders.
- Right-clicking an output-directory input now opens a vault folder picker.

### Removed

- Legacy `originalPath` settings are dropped during migration.

## [1.3.3] - 2026-11-22

### Added

- Per-book path profiles with optional original file and per-format output directories.
- Settings UI to add and remove book path entries.
- Automatic output directory creation and explicit rejection of absolute or `..` paths.
- Migration from settings without `bookProfiles` to the default behavior.

## [1.3.2] - 2026-11-22

### Added

- Editor/live-preview paragraph indentation via `.markdown-source-view... .cm-line` CSS.
- Exclusions for headings, code blocks, lists, quotes, tables, horizontal rules, and frontmatter.

## [1.3.1] - 2026-11-22

### Fixed

- Markdown output no longer writes `&emsp;` entities into body text, which appeared literally in the live editor.
- Markdown 2em indentation now uses frontmatter `cssclasses: book-format-sync` and plugin CSS in reading view.

## [1.3.0] - 2026-11-22

### Added

- Local chapter title suggestions for empty, numeric, placeholder, and duplicate headings.
- Title preview modal with per-chapter selection and editing.
- Sidecar title cache under `.book-format-sync/titles/`.
- Configurable title length (4–24, default 10).
- File explorer right-click menu entry for title suggestions.

### Changed

- Title generation keeps the original numeric chapter prefix.
- Duplicate title candidates fall back to another candidate or `needs_review`.

## [1.2.1] - 2026-11-22

### Fixed

- Paragraph indentation for TXT books with one paragraph per line and almost no blank lines.
- False chapter detection for prose lines beginning with “第一回/第三节” or a duplicate chapter number.

## [1.2.0] - 2026-11-22

### Added

- File explorer right-click menu for md/txt/epub files.

## [1.1.0] - 2026-11-22

### Added

- Consistent first-line indent for Markdown (2em), TXT (two full-width spaces), and EPUB (`text-indent: 2em`).
- Pre-write validation of chapter titles and paragraph indentation.

## [1.0.0] - 2026-11-22

### Added

- Initial three-format library synchronization.
- Chapter heading normalization.
- Local-only md/txt/epub parsing, conversion, validation, and backup.
