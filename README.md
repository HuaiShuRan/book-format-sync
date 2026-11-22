# book-format-sync

Obsidian plugin for maintaining a book library where every book has three formats:

```text
md + txt + epub
```

The plugin normalizes chapter headings, enforces a consistent 2em first-line indent for body paragraphs, converts from any one format to the other two, and can suggest Chinese chapter titles for numeric/placeholder headings.

## Features

- **Chapter heading normalization**: `第1章` / `第十章` / `第１２章` → `第001章 …`; numbers are padded to 3 digits.
- **Consistent paragraph indentation**:
  - Markdown: frontmatter `cssclasses: book-format-sync`; reading view uses `p`, editor/live preview uses `.cm-line`; no `&emsp;` entities in the source.
  - TXT: two full-width spaces
  - EPUB: `text-indent: 2em`
- **Three-format conversion**: from `md`, `txt`, or `epub`, generate the other formats without modifying the source file.
- **Local chapter title suggestions**: detect empty, numeric, placeholder, duplicated titles; generate suggestions from the first sentence/paragraph locally. No AI, no network, no API key.
- **Right-click menu** on `.md`, `.txt`, `.epub` in the file explorer.
- **Safe writes**: validate and re-parse all three outputs before writing; back up existing targets under `.book-format-sync/backups/`.
- **Title suggestion cache** under `.book-format-sync/titles/`; manually edited titles are not overwritten.

## Requirements

- Obsidian desktop (the plugin uses Node `zlib` and binary file access).
- Obsidian `1.5.0` or later.
- No runtime dependencies beyond Obsidian and Node built-ins.

## Installation

### Manual install

1. Create:

   ```text
   <YourVault>/.obsidian/plugins/book-format-sync/
   ```

2. Put these files in that folder:

   ```text
   manifest.json
   main.js
   styles.css
   ```

3. Restart Obsidian or reload the plugin.
4. Enable **书库三格式同步** in **Settings → Community plugins**.

### From a GitHub Release

Download the release assets and place `manifest.json`, `main.js`, and `styles.css` in `.obsidian/plugins/book-format-sync/`.

## Usage

### Commands

- `书库三格式同步：扫描书库（只读）`
- `书库三格式同步：生成章节标题建议（本地）`
- `书库三格式同步：规范化并生成当前书籍三格式`
- `书库三格式同步：从当前文件转换生成另外两种格式`
- `书库三格式同步：规范化书库全部书籍`

### File explorer right-click menu

Right-click a `.md`, `.txt`, or `.epub` file:

```text
书库三格式同步
├─ 生成章节标题建议
├─ 规范化并生成三格式
└─ 从当前文件生成另外两种
```

Actions apply to the right-clicked file, not the currently open tab.

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
第001章 001 → 第001章 实至名归
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
book-format-sync/
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

## License

MIT. See [LICENSE](LICENSE).
