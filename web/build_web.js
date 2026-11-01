// ブラウザ版の最新AIを作る(v0.10.88)。道具を足さずに、node の require で書いた部品を1つのファイルにまとめる。
//
//   node web/build_web.js --out dist
//
// 作るもの(dist の下。GitHub Pages にはこのフォルダをそのまま置く):
//   index.html         ゲームの画面(ml/index.html の写し)
//   ai/puyo_ai.js      strategy.js などをまとめたもの + 勝率の見積もり(value.json)
//   ai/ai_worker.js    画面を止めずに考える係(Web Worker)。finish_wasm.js と puyo_ai.js を読む
//   ai/finish_wasm.js  C++ の読みを WebAssembly にしたもの。これは GitHub Actions の em++ が作る(.github/workflows/pages.yml)
//
// まとめ方: './x.js' の require を文字通り拾って、ファイルごとに関数で包む。
// native_bridge.js(finish.exe とやりとりする)は web/native_bridge_web.js に差し替える。
// fs・path などの node の部品は、使われている分だけの小さな代わりを入れる(fs は value.json を読むだけ)。
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { VERSION } = require(path.join(ROOT, 'version.js'));

const args = { out: path.join(ROOT, 'dist'), value: path.join(ROOT, 'runs', 'tri', 'r14_td', 'value.json') };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = path.resolve(argv[i + 1]);

const ENTRIES = ['strategy.js', 'engine.js', 'web/tri_config.js'];
const REPLACE = { 'native_bridge.js': 'web/native_bridge_web.js' };
const BUILTIN = ['fs', 'path', 'child_process', 'worker_threads'];

// './x.js' を文字通り拾って、使われるファイルを全部集める
const mods = new Map();   // ml からの道筋 -> 中身
function add(rel){
  if (mods.has(rel)) return;
  const src = fs.readFileSync(path.join(ROOT, REPLACE[rel] || rel), 'utf8');
  mods.set(rel, src);
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)){
    const id = m[1];
    if (BUILTIN.includes(id)) continue;
    if (!id.startsWith('.')) throw new Error(`${rel}: まとめられない require('${id}')`);
    add(path.posix.normalize(path.posix.join(path.posix.dirname(rel), id)));
  }
}
ENTRIES.forEach(add);

const value = fs.readFileSync(args.value, 'utf8');
JSON.parse(value);   // 壊れていないか

// node の部品の代わり(使われている分だけ)
const SHIMS = `
var process = { env: {}, hrtime: { bigint: function(){ return BigInt(Math.round(performance.now() * 1e6)); } } };
var __builtin = {
  fs: {
    // 勝率の見積もり(value.json)だけを読む。ファイルがあるかの確かめ(finish.exe があるか)は、いつも「ある」と答える
    readFileSync: function(p){ if (/value\\.json$/.test(String(p))) return __VALUE_JSON; throw new Error('ブラウザ版では読めないファイル: ' + p); },
    existsSync: function(){ return true; },
  },
  path: {
    join: function(){ return Array.prototype.join.call(arguments, '/'); },
    resolve: function(){ return Array.prototype.join.call(arguments, '/'); },
    dirname: function(p){ return String(p).replace(/\\/[^\\/]*$/, '') || '.'; },
    basename: function(p){ return String(p).replace(/^.*\\//, ''); },
    relative: function(a, b){ return b; },
  },
  child_process: { spawnSync: function(){ throw new Error('ブラウザ版では使えません'); }, spawn: function(){ throw new Error('ブラウザ版では使えません'); } },
  worker_threads: { isMainThread: true, Worker: null, parentPort: null, workerData: null },
};`;

const parts = [];
for (const [rel, src] of mods){
  parts.push(`__defs[${JSON.stringify(rel)}] = function(module, exports, require, __filename, __dirname){\n${src}\n};`);
}
const bundle = `// ターン制ぷよぷよの最新AI(tri)のブラウザ版 v${VERSION}。web/build_web.js が作ったもの(手で直さない)。
// 中身: ${[...mods.keys()].join(' ')} + 勝率の見積もり ${path.relative(ROOT, args.value).replace(/\\/g, '/')}
(function(){
var __VALUE_JSON = ${JSON.stringify(value)};
${SHIMS}
var __defs = {}, __cache = {};
function __norm(p){ var out = []; p.split('/').forEach(function(s){ if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }); return out.join('/'); }
function __load(rel){
  if (__cache[rel]) return __cache[rel].exports;
  if (!__defs[rel]) throw new Error('まとめに入っていない部品: ' + rel);
  var module = { exports: {} };
  __cache[rel] = module;
  var dir = rel.indexOf('/') >= 0 ? rel.replace(/\\/[^\\/]*$/, '') : '.';
  __defs[rel](module, module.exports, function(id){ return __builtin[id] || __load(__norm(dir + '/' + id)); }, rel, dir);
  return module.exports;
}
${parts.join('\n')}
globalThis.PuyoAI = { VERSION: ${JSON.stringify(VERSION)}, require: __load };
})();
`;

fs.mkdirSync(path.join(args.out, 'ai'), { recursive: true });
fs.writeFileSync(path.join(args.out, 'ai', 'puyo_ai.js'), bundle);
fs.copyFileSync(path.join(__dirname, 'ai_worker.js'), path.join(args.out, 'ai', 'ai_worker.js'));
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(args.out, 'index.html'));
console.log(`作りました: ${args.out}(部品 ${mods.size}個、puyo_ai.js ${(bundle.length / 1024).toFixed(0)}KB)`);
