# book-library

Obsidian plugin for maintaining a book library where every book has three formats:

```text
md + txt + epub
```

The plugin normalizes chapter headings, enforces a consistent 2em first-line indent for body paragraphs, converts from any one format to the other two, and can suggest Chinese chapter titles for numeric/placeholder headings.

## Project handoff

- [PROJECT_STATE.md](PROJECT_STATE.md) — current status, confirmed behavior, architecture, tests, release process, known limitations, and next steps.
- [AGENTS.md](AGENTS.md) — short onboarding checklist for coding agents working in this repository.

## Features

- **Chapter heading normalization**: `第1章` / `第十章` / `第１２章` → `第1章 …`; chapter numbers are never zero-padded: `第1章`, `第10章`, `第101章`.
- **Same-line TXT chapters**: a line like `第1章 道可道…` is split into a number-only heading plus body when the remainder is long or contains multiple sentence endings; the whole chapter is not treated as a title.
- **Consistent paragraph indentation**:
  - Markdown: frontmatter `cssclasses: book-format-sync`; reading view uses `p`, editor/live preview uses `.cm-line`; no `&emsp;` entities in the source.
  - TXT: two full-width spaces
  - EPUB: `text-indent: 2em`
- **Three-format conversion**: from `md`, `txt`, or `epub`, generate the other formats without modifying the source file.
- **Local chapter title suggestions**: detect empty, numeric, placeholder, duplicated titles; generate suggestions from the first sentence/paragraph locally. No AI, no network, no API key.
- **Clean properties UI**: in notes carrying `cssclasses: book-format-sync`, the plugin hides only the `cssclasses` property row; the YAML field and other properties remain intact.
- **Right-click menu** on `.md`, `.txt`, `.epub` in the file explorer.
- **Safe writes**: validate and re-parse all three outputs before writing; back up existing targets under `.book-format-sync/backups/`.
- **Title suggestion cache** under `.book-format-sync/titles/`; manually edited titles are not overwritten.
- **Book cards** (`新建书籍卡`): pick a title, optional author and cover; the card lands in the configured card folder. The chosen cover image is renamed to `《书名》-作者封面.ext` when that option is enabled, and the picker searches vault images.
- **Shelf Base** (`20 笔记/书架.base` by default): an Obsidian Bases file with a cover gallery plus a table view, regenerated automatically from the configured card folder (Bases views query live, so no manual refresh command).
- **EPUB cover**: when the book card's `封面` property points at a vault image, that image is written into the EPUB (`OEBPS/cover.*` plus OPF `cover-image`). TXT is plain text and cannot embed an image.
- **Configurable ribbon**: the `书库` and `新建书籍卡` ribbon buttons can each be hidden in settings.
- **Library scaffold** (`布置书库目录结构`, off by default): when the book folder is empty, create the recommended structure (`00 收件箱`, book folders per title, card folder, reading-note folder, Base folder, `90 附件`) with a `_目录说明.md` in each new folder. When the book folder already has content, nothing is moved or overwritten — the plugin only writes `00 收件箱/书库结构建议.md` describing the structure and the migration options.

## Requirements

- Obsidian desktop (the plugin uses Node `zlib` and binary file access).
- Obsidian `1.9.0` or later (Bases cards view is used for the shelf).
- No runtime dependencies beyond Obsidian and Node built-ins.

## Installation

### Manual install

1. Create:

   ```text
   <YourVault>/.obsidian/plugins/book-library/
   ```

2. Put these files in that folder:

   ```text
   manifest.json
   main.js
   styles.css
   ```

3. Restart Obsidian or reload the plugin.
4. Enable **书库** in **Settings → Community plugins**.

### From a GitHub Release

Download the release assets and place `manifest.json`, `main.js`, and `styles.css` in `.obsidian/plugins/book-library/`.

## Usage

### Commands

- `书库：扫描书库（只读）`
- `书库：生成章节标题建议（本地）`
- `书库：规范化并生成当前书籍三格式`
- `书库：只规范化当前文件`
- `书库：从当前文件转换生成另外两种格式`
- `书库：规范化书库全部书籍`

### File explorer right-click menu

Right-click a `.md`, `.txt`, or `.epub` file:

```text
书库
├─ 生成章节标题建议
├─ 规范化并生成三格式
├─ 只规范化
└─ 从当前文件生成另外两种
```

Actions apply to the right-clicked file, not the currently open tab. `只规范化` writes only the current format, does not create the other two, and force-backs up the current file when it is also the target.

### Book layout

Default layout:

```text
10 书籍/
└─ <Book Name>/
   ├─ <Book Name>.md
   ├─ <Book Name>.txt
   └─ <Book Name>.epub
```

The book root, folder-per-book behavior, chapter format, and title length can be changed in plugin settings.

### Per-book output paths

Settings include an optional **Per-book paths** group. Entries are added and removed manually; the plugin does not auto-scan the vault for mappings.

Each entry has:

```text
bookName       book identifier (also the output filename stem)
mdDir          Markdown output directory
txtDir         TXT output directory
epubDir        EPUB output directory
```

Paths are vault-relative. Absolute paths and any `..` segment are rejected with an explicit error. Empty output directory fields fall back to `10 书籍/<bookName>/`. Output directories are created automatically. Right-click an output directory input to choose an existing vault folder.

The original file is not configured separately: conversion reads the current file, and batch/right-click normalization reads the same-named md/txt/epub from the default book directory. Removing an entry does not delete generated files. Existing settings without `bookProfiles` migrate to an empty list and keep the default behavior; a legacy `originalPath` field is dropped.


### Title suggestions

The local title generator detects:

- empty titles;
- pure numeric titles such as `001`;
- titles equal to the chapter number;
- placeholder titles such as `未命名`;
- repeated titles;
- short titles (≤2 CJK characters) as soft suggestions.

Titles are generated from the first 1–3 paragraphs, max 800 characters:

1. first narrative sentence;
2. first paragraph snippet;
3. 2–4 character high-frequency fallback.

The default title length is **10 characters** (configurable 4–24). The numeric chapter prefix is retained:

```text
第1章 001 → 第1章 实至名归
```

Suggestions are shown in a preview table. Nothing is written until **应用选中标题** is clicked. Duplicate suggestions fall back to another candidate; if none is usable, the numeric title is kept and marked `needs_review`.

## Development

```powershell
node tools/build.js
node tests/run-tests.js
node tests/plugin-harness.js
node tests/title-apply-harness.js
node tests/menu-harness.js
```

`tools/build.js` bundles `src/main.js` and `lib/*.js` into the root `main.js` loaded by Obsidian. There are no npm dependencies.

## Project structure

```text
book-library/
├─ manifest.json
├─ main.js                 # bundled Obsidian entry
├─ styles.css
├─ src/main.js             # commands, modals, settings
├─ lib/
│  ├─ chapters.js          # chapter parsing and normalization
│  ├─ text.js              # encoding, paragraph splitting, indent rules
│  ├─ zip.js               # ZIP reader/writer (Node zlib)
│  ├─ epub.js              # EPUB parser/generator
│  ├─ book.js              # Book model, three-format rendering/validation
│  └─ titles.js            # title issue detection and local suggestions
├─ tests/
├─ tools/
└─ .github/workflows/
```

## Versioning

- `manifest.json` version is the source of truth.
- Git tags use `v` + version: `v1.3.0`.
- GitHub Releases use the same tag.
- `versions.json` maps plugin version to minimum Obsidian version.
- See [CHANGELOG.md](CHANGELOG.md).

## Limitations

- Only `md`, `txt`, and `epub` are supported.
- EPUB parsing is lightweight and does not support ZIP64, encrypted EPUB, or split ZIP archives.
- Images in EPUB become `[图片]` placeholders in text formats.
- Chapter number gaps/duplicates are reported, not renumbered.
- Title suggestions are local and extractive; they may be plain or truncated, and should be reviewed before applying.
- Markdown 2em indentation depends on the plugin CSS and Obsidian internal `cm-line`/`HyperMD-*` classes; source bytes stay clean, but source mode may show visual indentation and upgrades may require re-checking.
- Per-book path entries are manual; batch scanning still uses the default book root, so a book entirely outside that root must be converted from its configured original file/right-click entry.

## License

MIT. See [LICENSE](LICENSE).

