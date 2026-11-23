# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project uses [Semantic Versioning](https://semver.org/).

## [1.3.9] - 2026-11-23

### Changed

- Plugin styles hide only the `cssclasses` property row in notes carrying `book-format-sync`; the YAML field and all other properties remain unchanged. Reading/live-preview indentation is unaffected.

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
