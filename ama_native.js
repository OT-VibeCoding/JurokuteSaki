// 本線を組む読み(builder.js の amaSearch)の C++ 版を使う(v0.10.36)。呼び方・答えは builder.js の amaSearch と同じ。
//
//   const { amaSearch } = require('./ama_native.js');
//   const c = amaSearch(board, order, idx, { width: 100, depth: 16, noFire: true });   // c[0].mv が一番の手
//
// native/finish.exe(または FINISH_EXE)を開いたままにして使う(native_bridge.js)。プログラムが無ければ builder.js の JavaScript 版を使う。
// 答えが JavaScript 版と同じことは verify_ama_native.js で確かめる。
const fs = require('fs');
const path = require('path');
const E = require('./engine.js');
const B = require('./builder.js');

const CYCLE = E.RULES.tsumoCycle;
const EXE = process.env.FINISH_EXE ? path.resolve(process.env.FINISH_EXE) : path.join(__dirname, 'native', 'finish.exe');
const KEYS = ['chain', 'y', 'key', 'chi', 'link2', 'link3', 'shape', 'well', 'bump', 'nuisance', 'tear', 'waste', 'tearMul'];
let usable = null;

function amaSearch(board, order, idx, opts){
  if (usable === null) usable = fs.existsSync(EXE);
  if (!usable) return B.amaSearch(board, order, idx, opts);
  opts = opts || {};
  const width = opts.width || 100, depth = opts.depth || 16;
  const w = Object.assign({}, B.AMA_W, opts.w || {});
  const seq = [];
  for (let i = 0; i < depth; i++){ const p = E.TSUMO_PATTERNS[order[(idx + i) % CYCLE]]; seq.push(p.axis, p.child); }
  const line = `M ${board.map(col => col.join('')).join('')} ${depth} ${width} ${opts.noFire ? 1 : 0} ${KEYS.map(k => w[k]).join(' ')} ${depth} ${seq.join(' ')}`;
  const t = require('./native_bridge.js').call(line).trim().split(/\s+/);
  const k = Number(t[1]), out = [];
  for (let j = 0, i = 2; j < k; j++){
    const col = Number(t[i++]), rot = Number(t[i++]), score = Number(t[i++]), chain = Number(t[i++]), tl = t[i++];
    out.push({ mv: { col, rot }, score, chain, tail: tl === 'x' ? -Infinity : Number(tl) });
  }
  return out;
}

module.exports = { amaSearch };
