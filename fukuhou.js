// 副砲として撃ってよいかの判定(shio さんの基準、2026-10-21)。
//
//   const F = require('./fukuhou.js');
//   const j = F.judgeFukuhou(me, opp, order, attackMoves);
//   // j.ok … 副砲として撃ってよいか / j.opp, j.me … 見積もった本線 / j.margin … 自分の本線 − 相手の本線(おじゃまの数)
//
// 考え方:
//   - 理論上、2手で1連鎖を組める
//   - 自分が副砲を撃つと、相手に手数が渡る。相手の本線は「今の本線 + (渡した手数 ÷ 2)連鎖」とみなす
//   - 相手がその本線を撃つと、自分に手数が渡る。自分の本線は「副砲を撃ったあとの本線 + (もらった手数 ÷ 2)連鎖」とみなす
//   - 足す連鎖は「連鎖の頭」に付く。最後の段の形(2色・3色同時消し=マルチ)はそのまま残り、連鎖の番号だけが後ろにずれる
//     (例: 11連鎖トリプルを持つ相手に6手渡すと、14連鎖トリプルとして計算する)
//   - 自分の本線が相手の本線を上回れば副砲として撃ってよい。相手の本線に負けるなら、副砲として不適切
//
// 本線は3通りを見て、大きいほうを使う。
//   now     … 今、仮想の1個で撃てる連鎖(analyzeBoard の本線と同じ)
//   deep    … あと何個か足せば撃てる連鎖(engine.js の deepChainPlan)。足す個数ぶんの手を先に使う(1手で2個置ける)
//   scratch … 本線が無くても、手数 ÷ 2 連鎖は一から組める
// 頭に足す連鎖は、4個・1色の消え方として得点を計算する。
const E = require('./engine.js');
const S = require('./situation.js');
const X = require('./exchange.js');

const R = E.RULES;
const RENSA_B = R.rensaB, RENKETSU_B = R.renketsuB, IROKAZU_B = R.irokazuB;
const at = (arr, i) => arr[Math.min(i, arr.length - 1)];

// 連鎖の各段(resolveChainsDetailed の steps)の頭に k 連鎖を足したときの得点
function stepsScore(steps, k){
  let total = 0;
  const one = (idx, puyo, sizes, colors) => {
    const bonus = at(RENSA_B, idx) + sizes.reduce((s, n) => s + at(RENKETSU_B, n), 0) + at(IROKAZU_B, colors);
    return bonus === 0 ? 10 * puyo : 10 * puyo * bonus;
  };
  for (let j = 1; j <= k; j++) total += one(j, 4, [4], 1);
  steps.forEach((s, i) => { total += one(i + 1 + k, s.puyo, s.sizes, s.colors); });
  return total;
}

// 本線の候補(now と deep)。それぞれ { kind, steps, extraMoves(撃つ前に先に使う手) }
function honsenCandidates(board){
  // 本線が無くても、手数があれば「手数 ÷ 2」連鎖は一から組める(頭に足す連鎖だけの本線)
  const out = [{ kind: 'scratch', steps: [], extraMoves: 0 }];
  let best = null;
  for (const ig of E.findIgnitions(board)){
    const b2 = E.cloneBoard(board);
    b2[ig.col][ig.row] = ig.color;
    const d = S.resolveChainsDetailed(b2);
    if (!best || d.totalPoint > best.totalPoint) best = d;
  }
  if (best && best.rensasu) out.push({ kind: 'now', steps: best.steps, extraMoves: 0 });
  const p = E.deepChainPlan(board);
  if (p.plan){
    const d = S.resolveChainsDetailed(p.plan);
    // 足す個数 p.out[2] のうち最後の1個は「撃つ1個」(now の仮想の1個と同じ扱い)。残りを1手2個で置く
    if (d.rensasu) out.push({ kind: 'deep', steps: d.steps, extraMoves: Math.ceil(Math.max(0, p.out[2] - 1) / 2) });
  }
  return out;
}

// 手数 tezon を使える本線の見積もり。{ ojama, chain, base(元の連鎖数), add(頭に足す連鎖数), kind, last(最後の段の色数) }
function projectHonsen(board, tezon){
  let best = { ojama: 0, chain: 0, base: 0, add: 0, kind: null, last: 0 };
  for (const c of honsenCandidates(board)){
    if (c.extraMoves > tezon) continue;                      // 撃てる形にする前に手数が尽きる
    const add = Math.max(0, Math.floor((tezon - c.extraMoves) / 2));
    const ojama = Math.floor(stepsScore(c.steps, add) / E.OJAMA_RATE);
    const chain = c.steps.length + add;
    if (chain && (ojama > best.ojama || (ojama === best.ojama && chain > best.chain))){
      best = { ojama, chain, base: c.steps.length, add, kind: c.kind, last: c.steps.length ? c.steps[c.steps.length - 1].colors : 1 };
    }
  }
  return best;
}

// 副砲として撃ってよいか。attackMoves は、今の手番で撃つまでの手順(最後の1手で撃つ)
function judgeFukuhou(me0, opp0, order, attackMoves, opts){
  opts = Object.assign({ width: 30, buildWidth: 30 }, opts || {});
  const m = Object.assign({}, me0, { board: E.cloneBoard(me0.board) });
  const o = Object.assign({}, opp0, { board: E.cloneBoard(opp0.board) });
  // 1. 副砲を撃って手番を終える(撃ったあとに手数が残れば、組む手で手番を終える)。実際の手数の計算どおり
  const t = X.playTurn(m, o, order, attackMoves, true, opts);
  if (t.gameOver || !t.fired.length) return { ok: false, reason: t.gameOver ? '自分が窒息する' : '撃てなかった' };
  const sent = Math.max(0, o.ojamaYokoku);
  const oppTezon = o.cost;                                   // 相手の手番の手数(渡した手数を含む)
  // 2. 相手の本線(渡した手数で頭に足す)
  const oppH = projectHonsen(o.board, oppTezon);
  // 3. 相手がその本線を撃つと、自分に渡る手数: 手番が回ってきた分の1 + 使いすぎた分(連鎖1つにつき1.5。手数を使い切って撃つとみなす)
  const myTezon = oppH.chain ? m.cost + 1 + oppH.chain * R.rensaTezon : m.cost + 1;
  const myH = projectHonsen(m.board, myTezon);
  const margin = myH.ojama - oppH.ojama;
  return {
    ok: margin > 0, margin, sent, fired: t.fired,
    oppTezon, myTezon,
    opp: oppH, me: myH,
    reason: margin > 0 ? '自分の本線が上回る' : '相手の本線に負ける',
  };
}

// 手番の使い方(moves。null なら撃たずに組む=受ける)ごとの、やりとりの有利不利(v0.10.16)。
// judgeFukuhou と同じ基準(渡した手数 ÷ 2 を相手の本線の頭に足す、相手の本線でもらう手数 ÷ 2 を自分の本線の頭に足す)で、
// 「自分の本線 + 相手に向かっている予告」と「相手の本線」を比べる。予告が来ているときの返し方(本線で返す・小さく返す・受ける)の比べに使う。
//   戻り値 { margin(大きいほど有利。自分が窒息するなら -Infinity), fired, sent, opp, me, oppTezon, myTezon }
function exchangeMargin(me0, opp0, order, moves, opts){
  opts = Object.assign({ width: 30, buildWidth: 30 }, opts || {});
  const m = Object.assign({}, me0, { board: E.cloneBoard(me0.board) });
  const o = Object.assign({}, opp0, { board: E.cloneBoard(opp0.board) });
  const t = X.playTurn(m, o, order, moves, true, opts);      // 手番の終わりに、相殺しきれなかった予告は自分に降る
  if (t.gameOver) return { margin: -Infinity, fired: t.fired, reason: '自分が窒息する' };
  const pending = Math.max(0, o.ojamaYokoku);                // 相手に向かっている予告
  const oppH = projectHonsen(o.board, o.cost);
  const myTezon = oppH.chain ? m.cost + 1 + oppH.chain * R.rensaTezon : m.cost + 1;
  const myH = projectHonsen(m.board, myTezon);
  return { margin: myH.ojama + pending - oppH.ojama, fired: t.fired, sent: pending, opp: oppH, me: myH,
           oppTezon: o.cost, myTezon, myYokokuLeft: m.ojamaYokoku };
}

function formatJudge(j){
  if (!j.opp) return `副砲: 撃てない(${j.reason})`;
  const h = (x) => x.chain ? `${x.base}連鎖${x.last >= 2 ? `(最後に${x.last}色)` : ''}+頭に${x.add}連鎖 = ${x.chain}連鎖・おじゃま${x.ojama}個` : '本線なし';
  return [
    `副砲: ${j.fired.map(f => `${f.chain}連鎖`).join('、')}で相手に${j.sent}個 → 相手の手数${j.oppTezon}`,
    `  相手の本線: ${h(j.opp)}`,
    `  → 自分の手数${j.myTezon} / 自分の本線: ${h(j.me)}`,
    `  判定: ${j.ok ? '副砲として撃ってよい' : '副砲として不適切'}(${j.reason}、差${j.margin}個)`,
  ].join('\n');
}

module.exports = { judgeFukuhou, exchangeMargin, projectHonsen, honsenCandidates, stepsScore, formatJudge };
