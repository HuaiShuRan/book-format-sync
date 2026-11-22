# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project uses [Semantic Versioning](https://semver.org/).

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
