// 副砲で仕掛けたあとの読み合い(shio さんの考え、2026-10-21)。
//
//   const X = require('./exchange.js');
//   const r = X.compareAttack(me, opp, order, attackMoves);
//   // r.attack … 仕掛けた場合 / r.build … 仕掛けずに組んだ場合 / r.gain … 仕掛けた場合の得(おじゃま換算)
//
// 盤面・ツモ・手数はすべて見えているので、仕掛けたあとのやりとりを実際の手数の計算(engine.js の applyEconomics)どおりに追える。
//   1段目: 自分が手番を使う(副砲で仕掛ける / 仕掛けずに組む)。相手に送るおじゃまと、相手に渡る手数が決まる
//   2段目: 相手がもらった手数で返す(本線を撃ち返す / 撃たずに受けて組む)。相手は自分にとって良いほうを選ぶ
//   3段目: 自分がもらった手数で返す(本線を撃つ / 撃たずに組む)。自分は良いほうを選ぶ
//   … を opts.depth 段(既定5段)まで続ける。
// 最後の段の手番が終わった局面を、次の物差しで採点する(自分から見て、大きいほど良い。単位はおじゃまの数)。
//   (相手の予告 − 自分の予告) + (相手の盤面のおじゃま − 自分の盤面のおじゃま) × w.garbage
//   + (自分の今の本線の火力 − 相手の今の本線の火力) × w.honsen
//   今の本線の火力 = 仮想の1個で撃てる最大のおじゃま(analyzeBoard)。どちらかが窒息していれば ±1000000
// v0.10.7 では「16手先の本線の最大」で採点していたが、手数を考えておらず、組み方で大きくぶれたのでやめた(作業記録 第23期)。
// 各手番の中の手は、撃つ手順は searchMaxFire、組む手は planner.js の planBuild で決める(どちらも撃つまでは連鎖を起こさない)。
const E = require('./engine.js');
const P = require('./planner.js');
const B = require('./builder.js');

const CYCLE = E.RULES.tsumoCycle;
const GX = E.RULES.gameoverX, GY = E.RULES.gameoverY;
const DEAD = 1000000;
const pieceAt = (order, i) => E.TSUMO_PATTERNS[order[((i % CYCLE) + CYCLE) % CYCLE]];
const clone = (s) => Object.assign({}, s, { board: E.cloneBoard(s.board) });

// 組む手を決める。手番の残りの回数ぶんを planBuild で1回だけ計画し、その手順を返す(連鎖を起こさず、窒息しない手)。
// 計画できなければ、窒息しない手を1つだけ返す
function buildPlan(board, order, idx, n, width){
  const moves = P.planBuild(E.cloneBoard(board), order, idx, Math.max(1, Math.min(n, 8)), width);
  if (moves.length) return moves;
  const mv = anySafeMove(board, order, idx);
  return mv ? [mv] : [];
}
function anySafeMove(board, order, idx){
  const pat = pieceAt(order, idx);
  for (const mv of E.enumerateLegalMoves(board)){
    const b = E.cloneBoard(board);
    const r = E.simulateMove(b, mv.col, mv.rot, pat.axis, pat.child);
    if (r.dropped && b[GX][GY] === 0) return mv;
  }
  return E.enumerateLegalMoves(board)[0] || null;
}

// actor の手番を最後まで進める。plan = 先に置く手の並び(撃つ手順)。使い切ったら組む手で手番を終える。
// dealt = 手番の最初のツモがもう配られているか(今の局面の手番の側は true)。
// 戻り値: { gameOver(actor が窒息), fired: [{ chain, sent }], planDone(plan を最後まで置けたか), moves: [{ col, rot }] }
function playTurn(actor, other, order, plan, dealt, opts){
  const out = { gameOver: false, fired: [], planDone: !plan || !plan.length, moves: [] };
  let first = true, build = [];
  for (let n = 0; n < 60; n++){
    if (!(first && dealt)) E.simDealTsumoOrder(actor, order);
    first = false;
    const idx = actor.tsumoCount - 1;
    const pat = pieceAt(order, idx);
    let mv = (plan && n < plan.length) ? plan[n] : null;
    if (!mv){
      // 組む計画が尽きたら(または盤面が計画と違う置き方になったら)手番の残りぶんを計画し直す
      if (!build.length) build = buildPlan(actor.board, order, idx, Math.ceil(actor.cost), opts.buildWidth);
      mv = build.shift() || anySafeMove(actor.board, order, idx);
    }
    if (!mv){ out.gameOver = true; return out; }
    const before = other.ojamaYokoku, mine = actor.ojamaYokoku;
    const r = E.simulateMove(actor.board, mv.col, mv.rot, pat.axis, pat.child);
    if (!r.dropped){ out.gameOver = true; return out; }
    out.moves.push(mv);
    const res = E.applyEconomics(actor, other, r);
    if (r.rensasu > 0) out.fired.push({ chain: r.rensasu, offset: mine - actor.ojamaYokoku, sent: other.ojamaYokoku - before });
    if (plan && n === plan.length - 1) out.planDone = true;
    if (res.gameOver){ out.gameOver = true; return out; }
    if (res.turnSwitched) return out;
  }
  return out;
}

// その手番で撃てる一番大きい撃ち方の手順(手番が終わる前に撃てるものだけ)。無ければ null
function bestFirePlan(actor, other, order, dealt, opts){
  const idx = dealt ? actor.tsumoCount - 1 : actor.tsumoCount;
  const f = B.searchMaxFire(actor.board, order, idx, { horizon: Math.min(16, Math.max(1, Math.ceil(actor.cost) + 1)),
                                                       width: opts.width, point: actor.point || 0 });
  const cands = f.curve.filter(Boolean).sort((a, b) => b.ojama - a.ojama);
  for (const c of cands.slice(0, 3)){
    // 実際に手番の中で撃てるか(ちぎりで手数が減って、撃つ前に手番が終わることがある)を試す
    const a = clone(actor), o = clone(other);
    const t = playTurn(a, o, order, c.moves, dealt, opts);
    if (t.planDone && t.fired.length) return c.moves;
  }
  return null;
}

// その手番で撃てる撃ち方の手順を、置く数ごとの一番の撃ち方からすべて(手番が終わる前に撃てるものだけ)。
// 一番大きい撃ち方だけでは、手数の安い一撃(1連鎖で20個など)が抜ける(v0.10.84、shio さんとの対局)
// 戻り値は撃ったあと(手番の終わり)の局面も付けた [{ moves, actor, other, gameOver }]。
// cache(Map)を渡すと、同じ盤面・置く数・点の撃ち方の読みを使い回す(v0.10.85。自分の候補が違っても相手の盤面は同じで、変わるのは手数と予告だけのため)
function firePlans(actor, other, order, dealt, opts, cache){
  const idx = dealt ? actor.tsumoCount - 1 : actor.tsumoCount;
  const horizon = Math.min(16, Math.max(1, Math.ceil(actor.cost) + 1));
  const key = cache ? `${actor.board.map(c => c.join('')).join('')}|${idx}|${horizon}|${actor.point || 0}` : null;
  let f = cache ? cache.get(key) : null;
  if (!f){
    f = B.searchMaxFire(actor.board, order, idx, { horizon, width: opts.width, point: actor.point || 0 });
    if (cache) cache.set(key, f);
  }
  const out = [];
  for (const c of f.curve.filter(Boolean)){
    const a = clone(actor), o = clone(other);
    const t = playTurn(a, o, order, c.moves, dealt, opts);
    if (t.planDone && t.fired.length) out.push({ moves: c.moves, actor: a, other: o, gameOver: t.gameOver });
  }
  return out;
}

// 盤面にあるおじゃまの数
function garbageOf(board){
  let n = 0;
  for (let x = 0; x < E.WIDTH; x++) for (let y = 0; y < E.HEIGHT; y++) if (board[x][y] === E.RULES.ojamaColor) n++;
  return n;
}
// 今の本線の火力(仮想の1個で撃てる最大のおじゃま)
const honsenNow = (board) => E.analyzeBoard(board, require('./weights.js')).honsen.ojama;

// 局面の採点(me から見て)
function leafValue(me, opp, opts){
  if (me.board[GX][GY] !== 0) return { v: -DEAD };
  if (opp.board[GX][GY] !== 0) return { v: DEAD };
  const w = opts.w;
  const mg = garbageOf(me.board), og = garbageOf(opp.board);
  const mh = honsenNow(me.board), oh = honsenNow(opp.board);
  const v = (opp.ojamaYokoku - me.ojamaYokoku) + (og - mg) * w.garbage + (mh - oh) * w.honsen;
  return { v: Math.round(v * 10) / 10, myYokoku: me.ojamaYokoku, oppYokoku: opp.ojamaYokoku,
           myGarbage: mg, oppGarbage: og, myHonsen: Math.floor(mh), oppHonsen: Math.floor(oh), myCost: me.cost, oppCost: opp.cost };
}

const DEFAULT_OPTS = { width: 30, buildWidth: 30, depth: 5, w: { garbage: 1, honsen: 1 } };

// actor の手番から始めて、残り depth 段を読む。plan が与えられていれば、最初の手番はその手順で指す(1段目用)。
// 撃てる手番では「撃つ(その手番で撃てる一番大きい撃ち方)」と「組む」の2通りを試し、
// me の手番は採点が高いほう、相手の手番は低いほうを選ぶ。戻り値 { value, steps: [選ばれた流れ], alts: [1つ下の段の選択肢] }
function search(me, opp, order, actorIsMe, depth, plan, dealt, opts){
  const actor = actorIsMe ? me : opp, other = actorIsMe ? opp : me;
  const kinds = plan !== undefined ? [plan ? 'attack' : 'build'] : ['fire', 'build'];
  let best = null;
  const alts = [];
  for (const kind of kinds){
    const m = clone(me), o = clone(opp);
    const a = actorIsMe ? m : o, b = actorIsMe ? o : m;
    const p = kind === 'attack' ? plan : kind === 'fire' ? bestFirePlan(a, b, order, dealt, opts) : null;
    if (kind === 'fire' && !p) continue;                     // 撃てないなら「撃つ」は無い
    const t = playTurn(a, b, order, p, dealt, opts);
    const step = { who: actorIsMe ? 'me' : 'opp', kind, fired: t.fired, moves: t.moves, planDone: t.planDone,
                   after: { myCost: m.cost, oppCost: o.cost, myYokoku: m.ojamaYokoku, oppYokoku: o.ojamaYokoku } };
    let r;
    if (t.gameOver) r = { value: actorIsMe ? -DEAD : DEAD, steps: [], leaf: null };
    else if (depth <= 1){ const leaf = leafValue(m, o, opts); r = { value: leaf.v, steps: [], leaf, final: { me: m, opp: o } }; }
    else r = search(m, o, order, !actorIsMe, depth - 1, undefined, false, opts);
    const cand = { value: r.value, steps: [step].concat(r.steps), leaf: r.leaf, final: r.final };
    alts.push(cand);
    if (!best || (actorIsMe ? cand.value > best.value : cand.value < best.value)) best = cand;
  }
  return Object.assign({}, best, { alts });
}

// 1段目の手(firstPlan。null なら仕掛けずに組む)から depth 段先までを読み、結果を返す。
//   value … 採点(me から見て)。steps … 選ばれた流れ(段ごと)。leaf … 最後の局面の採点の中身
//   lines … 2段目(相手)の返し方ごとの流れ(opts.lines が true のときだけ。表示用)
function evaluateLine(me0, opp0, order, firstPlan, opts){
  opts = Object.assign({}, DEFAULT_OPTS, opts || {});
  opts.w = Object.assign({}, DEFAULT_OPTS.w, (opts && opts.w) || {});
  const r = search(clone(me0), clone(opp0), order, true, opts.depth, firstPlan || null, true, opts);
  // 2段目の返し方ごとの流れ: 1段目を指したあとの局面から、相手の返し方を1つずつ固定して読み直したもの
  const lines = [];
  const m = clone(me0), o = clone(opp0);
  const t1 = playTurn(m, o, order, firstPlan || null, true, opts);
  if (opts.lines && !t1.gameOver && opts.depth > 1){   // 表示用。同じ読みをもう一度するので、必要なときだけ(opts.lines)
    for (const kind of ['fire', 'build']){
      const m2 = clone(m), o2 = clone(o);
      const p = kind === 'fire' ? bestFirePlan(o2, m2, order, false, opts) : null;
      if (kind === 'fire' && !p) continue;
      const t2 = playTurn(o2, m2, order, p, false, opts);
      const step2 = { who: 'opp', kind, fired: t2.fired, moves: t2.moves,
                      after: { myCost: m2.cost, oppCost: o2.cost, myYokoku: m2.ojamaYokoku, oppYokoku: o2.ojamaYokoku } };
      const rest = t2.gameOver ? { value: DEAD, steps: [], leaf: null }
        : opts.depth > 2 ? search(m2, o2, order, true, opts.depth - 2, undefined, false, opts)
        : { value: leafValue(m2, o2, opts).v, steps: [], leaf: leafValue(m2, o2, opts), final: { me: m2, opp: o2 } };
      lines.push({ value: rest.value, steps: [r.steps[0], step2].concat(rest.steps), leaf: rest.leaf, final: rest.final });
    }
  }
  return { value: r.value, steps: r.steps, leaf: r.leaf, final: r.final, lines };
}

// 副砲で仕掛ける場合と、仕掛けずに組む場合を比べる。gain > 0 なら仕掛けたほうが得
function compareAttack(me, opp, order, attackMoves, opts){
  const attack = evaluateLine(me, opp, order, attackMoves, opts);
  const build = evaluateLine(me, opp, order, null, opts);
  return { attack, build, gain: Math.round((attack.value - build.value) * 10) / 10 };
}

// 人が読むための表示
function formatLine(r){
  const f = (fs) => fs.length ? fs.map(x => `${x.chain}連鎖(相殺${x.offset}・送る${x.sent})`).join('、') : '撃たない';
  const name = { attack: '仕掛ける', build: '組む', fire: '撃つ' };
  const out = [];
  for (const line of r.lines.length ? r.lines : [r]){
    const chosen = r.lines.length && line.steps[1] && r.steps[1] && line.steps[1].kind === r.steps[1].kind ? '  ←相手はこれを選ぶ' : '';
    out.push(`相手が2段目で「${line.steps[1] ? (line.steps[1].kind === 'fire' ? '撃ち返す' : '受けて組む') : '-'}」場合${chosen}`);
    line.steps.forEach((s, i) => {
      const a = s.after;
      out.push(`  ${i + 1}段目(${s.who === 'me' ? '自分' : '相手'}): ${s.who === 'opp' && s.kind === 'build' ? '受けて組む' : name[s.kind]} ` +
               `${s.moves.length}手 ${f(s.fired)} → 手数 自分${a.myCost}・相手${a.oppCost} / 予告 自分${a.myYokoku}・相手${a.oppYokoku}`);
    });
    const l = line.leaf;
    out.push(l ? `  最後の局面: 盤面のおじゃま 自分${l.myGarbage}・相手${l.oppGarbage} / 今の本線の火力 自分${l.myHonsen}・相手${l.oppHonsen} / 採点 ${line.value}`
               : `  → ${line.value >= DEAD ? '相手が窒息' : line.value <= -DEAD ? '自分が窒息' : ''} 採点 ${line.value}`);
  }
  return out.join('\n');
}

module.exports = { evaluateLine, compareAttack, formatLine, playTurn, leafValue, DEAD, bestFirePlan, firePlans };
