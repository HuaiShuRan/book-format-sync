'use strict';

/**
 * 命令行工具（不依赖 Obsidian），用于测试和演示：
 *   node tools/cli.js <源文件> <输出目录> [--book-name=书名]
 * 源文件只读；输出目录中生成同名的 md/txt/epub。
 */

const fs = require('fs');
const path = require('path');
const { parseBook, renderBook, extensionOf, baseNameOf } = require('../lib/book');

function parseArgs(argv) {
  const positional = [];
  let bookName = '';
  for (const arg of argv) {
    if (arg.startsWith('--book-name=')) bookName = arg.slice('--book-name='.length);
    else if (arg === '--help' || arg === '-h') positional.push('--help');
    else positional.push(arg);
  }
  return { positional, bookName };
}

function main() {
  const { positional, bookName } = parseArgs(process.argv.slice(2));
  if (positional[0] === '--help' || positional.length < 2) {
    console.error('用法：node tools/cli.js <源文件.md|txt|epub> <输出目录> [--book-name=书名]');
    process.exit(2);
  }
  const source = path.resolve(positional[0]);
  const outDir = path.resolve(positional[1]);
  const format = extensionOf(source);
  if (!format) throw new Error('只支持 md、txt、epub。');
  const before = fs.readFileSync(source);
  const book = parseBook({
    sourcePath: source,
    sourceFormat: format,
    data: before,
    bookName: bookName || baseNameOf(source),
  });
  const rendered = renderBook(book, { bookName: book.bookName });
  fs.mkdirSync(outDir, { recursive: true });
  const outputs = {};
  for (const ext of ['md', 'txt', 'epub']) {
    const target = path.join(outDir, `${book.bookName}.${ext}`);
    fs.writeFileSync(target, rendered[ext]);
    outputs[ext] = target;
  }
  const after = fs.readFileSync(source);
  if (!before.equals(after)) throw new Error('源文件被修改，测试失败。');
  console.log(JSON.stringify({
    book: book.bookName,
    source,
    sourceFormat: format,
    sourceHash: require('crypto').createHash('sha256').update(before).digest('hex'),
    chapters: book.stats.chapterCount,
    chars: book.stats.chars,
    warnings: book.warnings,
    outputs,
    sizes: rendered.sizes,
    titles: [rendered.titles[0], rendered.titles[rendered.titles.length - 1]],
  }, null, 2));
}

main();
