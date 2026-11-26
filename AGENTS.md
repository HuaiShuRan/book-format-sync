# AGENTS.md

This repository is an Obsidian plugin named `book-library`.

**Read `PROJECT_STATE.md` first.** It contains the current version, confirmed
behavior, architecture, settings schema, test/lint commands, release process,
known limitations, and next steps. Also read `README.md`.

## Non-negotiable behavior

Before changing code, preserve these confirmed rules:

- Chapter numbers are never zero-padded: `第1章`, `第10章`, `第101章`.
- TXT same-line chapters are split into a number-only heading plus body when the
  remainder is long or contains multiple sentence endings (Plan A). A short
  title such as `第38章 不准磕！不准磕！` must stay a title.
- Markdown source contains no `&emsp;`, `&nbsp;`, or literal full-width indent.
  Indentation uses `cssclasses: book-format-sync` plus `.cm-line` / `p` CSS.
- TXT uses two full-width spaces; EPUB uses `text-indent: 2em`.
- The plugin hides only the `cssclasses` property row in the properties panel;
  do not delete the YAML field, rename it, or hide all properties.
- Never silently modify a source file. Back up before overwriting.
- Failed three-format verification must prevent writing.

## Workflow

```powershell
node tools/build.js
node tests/run-tests.js
node tests/plugin-harness.js
node tests/title-apply-harness.js
node tests/menu-harness.js
```

- `main.js` is generated and committed. Rebuild after source edits.
- Update `manifest.json`, `versions.json`, and `CHANGELOG.md` for user-visible
  changes, then follow the release workflow in `PROJECT_STATE.md`.
- Do not add personal book content, vault paths, tokens, or credentials to the
  repository.
