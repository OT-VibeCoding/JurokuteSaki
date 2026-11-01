// 仕上げの読みの C++ 版(native/finish.exe)を node から使う(v0.10.29)。答えの形は finish.js の finishSearch と同じ。
//
//   const FN = require('./finish_native.js');
//   const r = FN.finishSearch(me, order, { maxPlace: 7 });          // 1局面
//   const rs = FN.finishSearchMany([{ me, order, opts }, …]);         // まとめて(プログラムを1回起こすだけで済む)
//
// finish.exe が無いとき(作り直していない PC など)は、JavaScript 版の finish.js で同じ読みをする(遅いが答えは同じ)。
// ルールの数(点数の表など)は engine.js から渡すので、C++ 側にルールの数を写していない。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('./engine.js');

// 環境変数 FINISH_EXE で別のプログラムを使える(開発中は native\finish_dev.exe。自己対戦などが動いている間に finish.exe を書き換えないため)
const EXE = process.env.FINISH_EXE ? path.resolve(process.env.FINISH_EXE) : path.join(__dirname, 'native', 'finish.exe');
const CYCLE = E.RULES.tsumoCycle;
let usable = null;
const available = () => (usable === null ? (usable = fs.existsSync(EXE)) : usable);

function rulesLine(){
  const R = E.RULES;
  const list = (a) => `${a.length} ${a.join(' ')}`;
  return `R ${E.WIDTH} ${E.HEIGHT} ${E.CONNECT_TOP} ${R.gameoverX} ${R.gameoverY} ${R.ojamaColor} ${E.OJAMA_RATE} ${R.dropBonus} ` +
         `${Math.round(R.rensaTezon * 2)} ${Math.round(R.chigiriTezon * 2)} ${list(R.rensaB)} ${list(R.renketsuB)} ${list(R.irokazuB)}`;
}
// keep: 撃ったあとに残るものも比べる。true か 'colored' = 残る色ぷよの数(v0.10.34)、'honsen' = 1個足せば撃てる一番大きい点(残る本線、v0.10.35)
// 'single' = 単発(1連鎖)だけを集める(v0.10.41)、'double' = 2連鎖だけを集める(v0.10.54)、
// 'singleDouble' = 1回の読みで両方を集める(答えの pareto が1連鎖、pareto2 が2連鎖。v0.10.54、同じ手順を2回たどらないため)
const keepCode = (k) => k === 'singleDouble' ? 5 : k === 'double' ? 4 : k === 'single' ? 3 : k === 'honsen' ? 2 : k ? 1 : 0;
function queryLine(me, order, opts){
  opts = opts || {};
  const maxPlace = opts.maxPlace || 8;
  const startIdx = (me.tsumoCount - 1 + CYCLE) % CYCLE;
  const seq = [];
  for (let i = 0; i < maxPlace; i++){ const p = E.TSUMO_PATTERNS[order[(startIdx + i) % CYCLE]]; seq.push(p.axis, p.child); }
  const board = me.board.map(col => col.join('')).join('');
  // keep: 撃ったあとに残る色ぷよの数も比べる(副砲への返し用、v0.10.34)
  // beam / tail: B の読み方(前半は良さそうな盤面を beam 個だけ残し、最後の tail 手は全部読む)。beam を省くと全部読む
  return `Q ${board} ${Math.round(me.cost * 2)} ${me.point || 0} ${maxPlace} ${opts.nodeLimit || 0} ${opts.timeMs || 0} ${maxPlace} ${seq.join(' ')} ${opts.beam || 0} ${opts.tail || 0} ${keepCode(opts.keep) | (opts.keepFlags || 0)}`;   // keepFlags: 16 = 2連鎖の効率の悪い形を除く、32 = 2連鎖は残る本線も比べる、64 + 点×256 = 2連鎖はぷよ1個あたりその点未満を除く(v0.10.56)
}
function parseAnswer(line, keep){
  const keepMode = !!keep;
  const t = line.trim().split(/\s+/).map(Number);   // 先頭の A は NaN になる
  let i = 1;
  const nodes = t[i++], complete = t[i++] === 1;
  const readList = () => {
    const k = t[i++], list = [];
    for (let j = 0; j < k; j++){
      const used = t[i++] / 2, ojama = t[i++], chain = t[i++], at = t[i++], kp = keepMode ? t[i++] : null, nm = t[i++];
      const moves = [];
      for (let m = 0; m < nm; m++){ moves.push({ col: t[i++], rot: t[i++] }); }
      list.push({ used, ojama, chain, at, keep: kp, moves });
    }
    return list;
  };
  const pareto = readList();
  return keep === 'singleDouble' ? { pareto, pareto2: readList(), nodes, complete } : { pareto, nodes, complete };
}

function finishSearchMany(jobs){
  if (!available()){
    if (jobs.some(j => j.opts && j.opts.beam)) throw new Error('B の読み方(beam)は finish.exe でしか使えません。native\build.bat で作ってください');
    const F = require('./finish.js');
    return jobs.map(j => F.finishSearch(j.me, j.order, j.opts));
  }
  const input = [rulesLine()].concat(jobs.map(j => queryLine(j.me, j.order, j.opts)), ['E']).join('\n') + '\n';
  const r = spawnSync(EXE, [], { input, encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
  if (r.status !== 0) throw new Error(`finish.exe が失敗しました: ${r.stderr || r.error}`);
  return r.stdout.split('\n').filter(l => l.startsWith('A')).map((l, i) => parseAnswer(l, jobs[i].opts && jobs[i].opts.keep));
}
// 1局面ずつのときは、プログラムを開いたままにして待って答えを受け取る(native_bridge.js、v0.10.38)。
// 毎回起こすと40msほどかかり、測ると対局の時間の3割以上がそれだった。答えは finishSearchMany と同じ(verify_finish_bridge.js で確かめる)
function finishSearch(me, order, opts){
  if (!available()) return finishSearchMany([{ me, order, opts }])[0];
  return parseAnswer(require('./native_bridge.js').call(queryLine(me, order, opts)), opts && opts.keep);
}

module.exports = { finishSearch, finishSearchMany, available };
