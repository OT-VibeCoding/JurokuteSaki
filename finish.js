// 本線の仕上げの読み(作業記録 第45期〜。shio さんと決めた作り方)。
//
//   const F = require('./finish.js');
//   const r = F.finishSearch(me, order, { maxPlace: 8 });
//   r.pareto … 撃ち方の候補。「使う手数」と「送るおじゃま」のどちらでも他に負けていないものだけ(使う手数の少ない順)
//   r.complete … 全部読み切れたか(時間や局面数の上限で打ち切ったら false)
//
// 決まりごと:
//   - 深さは置く回数ではなく手数で決める。手数が 0 より多い間は置ける(engine.js の applyEconomics と同じ)。
//     ちぎりは 0.5 多く払うので、ちぎり2回ごとに置ける回数が1回減る。maxPlace は置く回数の上限(読む量の上限)
//   - 途中で消える置き方はしない。消えた手がその筋の発火で、そこで終わり(第1段。1連鎖を使う形は後で足す)
//   - 「使う手数」= 置いた回数 + ちぎり×0.5 + 連鎖数×1.5(足りない分は相手に渡るが、ここでは使った量として数える)
//   - 3列目の上(負けの場所)が埋まる手は捨てる
// 答えを変えずに読む量を減らす工夫:
//   - 同じ盤面・同じ残り手数・同じ深さにたどり着いたら、2回目は読まない(別の列への置き方は順番を入れ替えても同じ盤面になる)
//   - 2個とも同じ色の組は、上向きと下向き、左向きと1列左の右向きが同じ盤面になるので、片方だけ試す
// 止め方: opts.enough(候補) が true を返したら、その時点で読むのをやめる(十分な答えが出たら採用する、という決め方)。
// 何を良しとするか(候補の比べ方・止める条件)は外から渡す。将来、副砲への返しにも使うため(shio さんの希望)。
const E = require('./engine.js');

const CYCLE = E.RULES.tsumoCycle;
const GX = E.RULES.gameoverX, GY = E.RULES.gameoverY;
const W = E.WIDTH, H = E.HEIGHT;
const RATE = E.OJAMA_RATE, DROP = E.RULES.dropBonus, RT = E.RULES.rensaTezon, CT = E.RULES.chigiriTezon;

// 盤面と残り手数から、まとめるための鍵(数字2つを1つの数に)
function keyOf(board, cost){
  let h1 = 0x811c9dc5 | 0, h2 = 0x01000193 | 0;
  for (let x = 0; x < W; x++){
    const col = board[x];
    for (let y = 0; y < H; y++){
      const v = col[y];
      if (v === 0) break;   // 列の上は空き(ぷよは下から詰まっている)
      h1 = Math.imul(h1 ^ (v + x * 8 + y * 64), 0x01000193);
      h2 = Math.imul(h2 ^ (v * 131 + x * 7 + y * 977), 0x5bd1e995);
    }
    h1 = Math.imul(h1 ^ (0x100 + x), 0x01000193);
  }
  h2 = Math.imul(h2 ^ Math.round(cost * 2), 0x5bd1e995);
  return (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff);
}

// 置いた2個のどちらかが、4個以上のつながりになるか(消えるか)。消えないなら、連鎖の計算(重い)を省ける
const CT_TOP = E.CONNECT_TOP;
const FF_seen = new Uint32Array(W * H), FF_stack = new Int16Array(W * H);
let FF_gen = 0;   // 印の世代(毎回 0 で消し直さずに済むように)
function popsAt(board, x0a, y0a, x0b, y0b){
  for (let t = 0; t < 2; t++){
    const x0 = t ? x0b : x0a, y0 = t ? y0b : y0a;
    if (y0 < 0 || y0 >= CT_TOP) continue;
    const c = board[x0][y0];
    const g = ++FF_gen;
    let sp = 0, n = 0;
    FF_stack[sp++] = x0 * H + y0; FF_seen[x0 * H + y0] = g;
    while (sp){
      const v = FF_stack[--sp], x = (v / H) | 0, y = v % H;
      n++;
      if (n >= 4) return true;
      if (x > 0 && FF_seen[v - H] !== g && board[x - 1][y] === c){ FF_seen[v - H] = g; FF_stack[sp++] = v - H; }
      if (x < W - 1 && FF_seen[v + H] !== g && board[x + 1][y] === c){ FF_seen[v + H] = g; FF_stack[sp++] = v + H; }
      if (y > 0 && FF_seen[v - 1] !== g && board[x][y - 1] === c){ FF_seen[v - 1] = g; FF_stack[sp++] = v - 1; }
      if (y < CT_TOP - 1 && FF_seen[v + 1] !== g && board[x][y + 1] === c){ FF_seen[v + 1] = g; FF_stack[sp++] = v + 1; }
    }
  }
  return false;
}
// 撃ったあとに残る本線の目安(finish.cpp の virtualFire と同じ): どこかの列に1個だけ足したら撃てる、一番大きい点
function virtualFire(board){
  let best = 0;
  for (let x = 0; x < W; x++){
    const y = board[x].indexOf(0);
    if (y < 0 || y >= E.CONNECT_TOP) continue;
    for (let c = 1; c <= 4; c++){
      board[x][y] = c;
      if (popsAt(board, x, y, x, -1)){
        const t = E.cloneBoard(board);
        const r = E.simulateResolveChains(t);
        if (r.totalPoint > best) best = r.totalPoint;
      }
      board[x][y] = 0;
    }
  }
  return best;
}

// 同じ色の組なら、同じ盤面になる置き方を除く
// (E.enumerateLegalMoves と同じ決まり: 軸か子のどちらかの列に空きがあれば置ける)
const MOVES = [];
for (let rot = 0; rot < 4; rot++) for (let col = (rot === 1 ? 1 : 0); col <= (rot === 3 ? W - 2 : W - 1); col++)
  MOVES.push({ col, rot, cc: rot === 1 ? col - 1 : rot === 3 ? col + 1 : col });
function movesFor(board, pat){
  const same = pat.axis === pat.child, out = [];
  for (const m of MOVES){
    if (same && (m.rot === 1 || m.rot === 2)) continue;
    if (board[m.col][H - 1] === 0 || board[m.cc][H - 1] === 0) out.push(m);
  }
  return out;
}

function finishSearch(me, order, opts){
  opts = opts || {};
  const maxPlace = opts.maxPlace || 8;
  const nodeLimit = opts.nodeLimit || Infinity;
  const deadline = opts.timeMs ? Date.now() + opts.timeMs : Infinity;
  const enough = opts.enough || null;
  const startIdx = (me.tsumoCount - 1 + CYCLE) % CYCLE;   // 今持っているツモ(手番の側は1つ配られた状態)
  const point0 = me.point || 0;
  const seen = Array.from({ length: maxPlace }, () => new Set());
  let nodes = 0, complete = true, stop = false;
  let pareto = [];   // { used, ojama, chain, at, keep, moves }
  // opts.keep なら「撃ったあとに残る色ぷよ(keep)」も比べる(副砲への返しのため、v0.10.34)
  const beats = (a, b) => a.used <= b.used && a.ojama >= b.ojama && (!opts.keep || a.keep >= b.keep);

  const addFire = (c) => {
    // 使う手数が少ないほど、おじゃまが多いほど良い(keep なら残る色ぷよも多いほど良い)。どれでも負けている候補は捨てる
    if (pareto.some(p => beats(p, c))) return;
    pareto = pareto.filter(p => !beats(c, p));
    pareto.push(c);
    if (enough && enough(c)) stop = true;
  };

  // 盤面は1枚を使い回す(置いて、読んで、取り除く)。消える置き方のときだけ写しを作って連鎖を計算する
  const board = E.cloneBoard(me.board), path = [];
  (function dfs(cost, used, depth){
    if (stop) return;
    if (nodes > nodeLimit || (nodes & 1023) === 0 && Date.now() > deadline){ complete = false; stop = true; return; }
    const pat = E.TSUMO_PATTERNS[order[(startIdx + depth) % CYCLE]];
    for (const mv of movesFor(board, pat)){
      const pl = E.placePiece(board, mv.col, mv.rot, pat.axis, pat.child);
      nodes++;
      if (!pl.dropped) continue;
      const cc = mv.cc;
      const undo = () => { board[mv.col][pl.axisRow] = 0; board[cc][pl.childRow] = 0; };
      const pay = 1 + (pl.chigiri ? CT : 0);
      if (popsAt(board, mv.col, pl.axisRow, cc, pl.childRow)){
        const b2 = E.cloneBoard(board);
        undo();
        const r = E.simulateResolveChains(b2);
        const ojama = Math.floor((point0 + DROP * (depth + 1) + r.totalPoint) / RATE);
        let keep = 0;
        if (opts.keep === 'honsen') keep = virtualFire(b2);
        else for (const col of b2) for (const v of col) if (v && v !== 5) keep++;
        addFire({ used: used + pay + r.rensasu * RT, ojama, chain: r.rensasu, at: depth + 1, keep, moves: path.concat([mv]) });
        if (stop) return;
        continue;
      }
      const c2 = cost - pay;
      if (board[GX][GY] !== 0 || c2 <= 0 || depth + 1 >= maxPlace){ undo(); continue; }   // 負けの場所が埋まる / もう置けない / 読む上限
      const k = keyOf(board, c2);
      if (seen[depth + 1].has(k)){ undo(); continue; }
      seen[depth + 1].add(k);
      path.push(mv);
      dfs(c2, used + pay, depth + 1);
      path.pop();
      undo();
      if (stop) return;
    }
  })(me.cost, 0, 0);

  pareto.sort((a, b) => a.used - b.used);
  return { pareto, nodes, complete };
}

module.exports = { finishSearch, keyOf };
