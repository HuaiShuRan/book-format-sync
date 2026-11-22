'use strict';

/**
 * 无第三方依赖的 CommonJS 打包器：把 src/main.js 与 lib/*.js 合成
 * Obsidian 直接加载的 main.js。保留 require('obsidian') 等宿主模块。
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const entry = 'src/main.js';
const libDir = path.join(root, 'lib');
const modules = new Map();

for (const name of fs.readdirSync(libDir).filter((file) => file.endsWith('.js')).sort()) {
  modules.set(`lib/${name}`, fs.readFileSync(path.join(libDir, name), 'utf8'));
}
modules.set(entry, fs.readFileSync(path.join(root, entry), 'utf8'));

function resolveRelative(fromKey, spec) {
  const fromDir = path.posix.dirname(fromKey);
  let target = path.posix.normalize(path.posix.join(fromDir, spec));
  if (!target.endsWith('.js')) target += '.js';
  if (!modules.has(target)) throw new Error(`无法解析 ${fromKey} 中的 require('${spec}') -> ${target}`);
  return target;
}

const wrapped = [];
for (const [key, source] of modules) {
  const code = source.replace(
    /require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g,
    (whole, quote, spec) => `__require(${JSON.stringify(resolveRelative(key, spec))})`,
  );
  wrapped.push(`${JSON.stringify(key)}: function (module, exports, __require, require) {\n${code}\n}`);
}

const banner = `'use strict';
// 由 tools/build.js 生成，请勿直接编辑；源码在 src/main.js 与 lib/*.js。
const __nativeRequire = require;
const __modules = {
${wrapped.join(',\n')}
};
const __cache = Object.create(null);
function __require(id) {
  if (__cache[id]) return __cache[id].exports;
  const factory = __modules[id];
  if (!factory) throw new Error('模块不存在：' + id);
  const module = { exports: {} };
  __cache[id] = module;
  factory(module, module.exports, __require, __nativeRequire);
  return module.exports;
}
const __entry = __require(${JSON.stringify(entry)});
module.exports = __entry;
`;

const outPath = path.join(root, 'main.js');
fs.writeFileSync(outPath, banner, 'utf8');
console.log(`built ${outPath} (${Buffer.byteLength(banner)} bytes, ${modules.size} modules)`);
