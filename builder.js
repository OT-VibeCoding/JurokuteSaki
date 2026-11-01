// 連鎖構築の係(設計メモ docs/設計メモ.md の5章)。段階B では「本線を伸ばす」だけを入れてある。
// ※ まだ今の planner.js より良い組み立てにはなっていない(試作。比べ方は verify_builder.js)。
//
//   const { planHonsen } = require('./builder.js');
//   const plan = planHonsen(board, order, tsumoIndex, { horizon: 16, width: 40 });
//   // plan.moves … 置く手の並び(先頭から順に置く)
//
// やり方はツモ確定を使ったビームサーチ(良さそうな盤面を一定数だけ残して1手ずつ先へ進める)。
// planner.js の planBuild と同じ形だが、盤面の良さの物差しを「連鎖の伸びしろ(engine.js の deepChainPotential)」
// 中心に変えた。伸びしろの考え方は ama(citrus610/ama、MIT License)の連鎖の探し方に倣っている。
//
// 伸びしろの計算は1回0.24msと重い(planBuild が使う maxChainRensasu の約30倍)。全部の候補に使うと
// 1回の計画に数秒かかるので、2段構えにしている。
//   1段目: 全部の候補を軽い点数(仮想の1個で撃てる連鎖数+形)で並べる
//   2段目: 上位だけを伸びしろで採点し直して、残す盤面を決める
// 計画の途中では撃たない(連鎖が起きる手は候補から外す)。撃つかどうかは方針の係が決める。
const E = require('./engine.js');

const { WIDTH, HEIGHT, CONNECT_TOP } = E;
const GAMEOVER_X = E.RULES.gameoverX, GAMEOVER_Y = E.RULES.gameoverY;
const OJAMA_COLOR = E.RULES.ojamaColor, CYCLE = E.RULES.tsumoCycle;

// 点数の重み(最初に決めた仮の値)。v0.10.3 の時点では、どの重みでも planner.js の planBuild を
// 「3手以内に撃てる連鎖」で上回れていない(README の v0.10.3、docs/作業記録.md の第20期)
const DEFAULT_W = {
  chain: 1000,     // 伸びしろの連鎖数 1つあたり
  need: -150,      // 撃つまでにあと何個足すか 1個あたり(少ないほど撃ちやすい)
  chi: 60,         // 発火点の横の広がり(広いほど、連鎖の尻尾を伸ばしやすい)
  link2: 40,       // 同じ色2個のつながり 1組あたり
  link3: 90,       // 同じ色3個のつながり 1組あたり
  bump: -50,       // 隣の列との高さの差 1段あたり
  well: -80,       // 両隣より低い谷 1段あたり
  high: -400,      // 10段より上に積んだ列 1段あたり
  col3: -1500,     // 3列目が10段以上(窒息が近い)
  chigiri: -120,   // ちぎり1回あたり(手数0.5の損)
};

function boardKey(b){ let s = ''; for (let x = 0; x < WIDTH; x++) for (let y = 0; y < HEIGHT; y++) s += b[x][y]; return s; }
function heightsOf(b){
  const h = new Array(WIDTH);
  for (let x = 0; x < WIDTH; x++){ const y = b[x].indexOf(0); h[x] = y === -1 ? HEIGHT : y; }
  return h;
}

// 同じ色のつながりの数(2個の塊・3個の塊)。4個以上は消えているので無い
function links(b){
  const seen = new Uint8Array(WIDTH * HEIGHT);
  let l2 = 0, l3 = 0;
  for (let x = 0; x < WIDTH; x++) for (let y = 0; y < CONNECT_TOP; y++){
    const c = b[x][y];
    if (!c || c === OJAMA_COLOR || seen[x * HEIGHT + y]) continue;
    let n = 0; const st = [[x, y]]; seen[x * HEIGHT + y] = 1;
    while (st.length){
      const [cx, cy] = st.pop(); n++;
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]){
        if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= CONNECT_TOP) continue;
        if (seen[nx * HEIGHT + ny] || b[nx][ny] !== c) continue;
        seen[nx * HEIGHT + ny] = 1; st.push([nx, ny]);
      }
    }
    if (n === 2) l2++; else if (n === 3) l3++;
  }
  return [l2, l3];
}

// 形の点数(連鎖の中身によらない部分)
function shapeScore(b, h, w){
  let bump = 0, well = 0, high = 0;
  for (let x = 0; x < WIDTH - 1; x++) bump += Math.abs(h[x] - h[x + 1]);
  for (let x = 0; x < WIDTH; x++){
    const l = x > 0 ? h[x - 1] : HEIGHT, r = x < WIDTH - 1 ? h[x + 1] : HEIGHT;
    const d = Math.min(l, r) - h[x];
    if (d >= 2) well += d - 1;          // 1段の段差は普通にあるので、2段以上の谷だけ数える
    if (h[x] > 10) high += h[x] - 10;
  }
  const [l2, l3] = links(b);
  return bump * w.bump + well * w.well + high * w.high + (h[GAMEOVER_X] >= 10 ? w.col3 : 0) +
         l2 * w.link2 + l3 * w.link3;
}

// 仮想の1個で撃てる最大の連鎖数(1段目の軽い点数用)
function quickChain(b){
  let best = 0;
  for (const ig of E.findIgnitions(b)){
    const b2 = E.cloneBoard(b);
    b2[ig.col][ig.row] = ig.color;
    const r = E.simulateResolveChains(b2).rensasu;
    if (r > best) best = r;
  }
  return best;
}

// 盤面の点数(2段目)。伸びしろ+形
function buildScore(b, w, q){
  const h = heightsOf(b);
  const [chain, , need, , chi] = E.deepChainPotential(b);
  return chain * w.chain + need * w.need + chi * w.chi + (q || 0) * (w.quick || 0) + shapeScore(b, h, w);
}

// 本線を伸ばす計画を作る。
//   board      … 今の盤面
//   order      … ツモの並び(16手で1周)
//   tsumoIndex … 次に置くツモが order の何番目か(engine.js の sim なら tsumoCount - 1)
//   opts       … horizon(何手先まで読むか)・width(残す盤面の数)・pre(2段目に回す数。width の何倍か)・w(重み)
// 戻り値 { moves, score, chain(計画の最後の盤面の伸びしろ連鎖数), evals(伸びしろを計算した回数) }
// 点数の付け方(opts.mode)
//   'deep'   … 上の DEFAULT_W の点数(伸びしろ+形)
//   'hybrid' … planner.js の planBuild の点数(仮想1個の連鎖数×(60+10×手目)+形)に、伸びしろを足したもの。
//              w.deepMul は「伸びしろ1連鎖」を「仮想1個の1連鎖」の何倍に数えるか、w.chigiriPt はちぎり1回の減点
const PLANNER = require('./planner.js');
function planHonsen(board, order, tsumoIndex, opts){
  opts = opts || {};
  const horizon = opts.horizon || 16, width = opts.width || 40, pre = opts.pre || 2;
  const w = Object.assign({}, DEFAULT_W, opts.w || {});
  const hybrid = (opts.mode || w.mode) === 'hybrid';
  let beam = [{ board, moves: [], chig: 0, s: 0 }];
  let evals = 0;
  for (let i = 0; i < horizon; i++){
    const pat = E.TSUMO_PATTERNS[order[(tsumoIndex + i) % CYCLE]];
    const cand = [], seen = new Set();
    for (const st of beam){
      for (const mv of E.enumerateLegalMoves(st.board)){
        const b2 = E.cloneBoard(st.board);
        const r = E.simulateMove(b2, mv.col, mv.rot, pat.axis, pat.child);
        if (!r.dropped || r.rensasu > 0) continue;              // 計画の途中では撃たない
        if (b2[GAMEOVER_X][GAMEOVER_Y] !== 0) continue;          // 窒息
        const k = boardKey(b2);
        if (seen.has(k)) continue;
        seen.add(k);
        const chig = st.chig + (r.chigiri ? 1 : 0);
        const q = quickChain(b2);
        const s1 = hybrid
          ? q * (60 + 10 * (tsumoIndex + i)) + PLANNER.buildShapeScore(b2) - chig * (w.chigiriPt || 0)
          : q * w.chain + shapeScore(b2, heightsOf(b2), w) + chig * w.chigiri;
        cand.push({ board: b2, moves: st.moves.concat([mv]), chig, q, s1 });
      }
    }
    if (!cand.length) break;
    // 1段目: 軽い点数で上位を選ぶ。同じ連鎖数ばかりにならないよう、連鎖数ごとの上限を設ける(planBuild と同じ考え)
    cand.sort((a, b) => b.s1 - a.s1);
    const cap = Math.max(3, Math.ceil(width * pre / 3));
    const perQ = new Map(), short = [];
    for (const st of cand){
      const n = perQ.get(st.q) || 0;
      if (n >= cap) continue;
      perQ.set(st.q, n + 1);
      short.push(st);
      if (short.length >= width * pre) break;
    }
    // 2段目: 伸びしろで採点し直す
    for (const st of short){
      st.s = hybrid
        ? st.s1 + E.deepChainPotential(st.board)[0] * (60 + 10 * (tsumoIndex + i)) * (w.deepMul != null ? w.deepMul : 1)
        : buildScore(st.board, w, st.q) + st.chig * w.chigiri;
      evals++;
    }
    short.sort((a, b) => b.s - a.s);
    beam = short.slice(0, width);
  }
  const top = beam[0];
  return { moves: top ? top.moves : [], score: top ? top.s : 0,
           chain: top ? E.deepChainPotential(top.board)[0] : 0, evals };
}

// ==== この先 horizon 手のうちに撃てる最大(段階C。状況把握の「本線の最大」「撃ち返し」に使う) ====
// ツモ確定のビームサーチで組みながら、各手で「今のツモで撃ったら」を全部試して記録する。撃った筋はそこで終わり。
// 組む側の点数は planner.js の planBuild と同じ(段階Bで、これより良い点数は作れなかったため)。
//   board     … 盤面
//   order     … ツモの並び。startIdx … 次に置くツモが order の何番目か
//   opts      … horizon(何手先まで)・width(残す盤面の数)・point(持ち越しの点。おじゃまの数え方に使う)
// 戻り値
//   best  … 一番おじゃまが多い撃ち方 { chain, ojama, at(何手目に撃つか), tezon(撃ち終わるまでに使う手数), moves }
//   curve … curve[k-1] = k手目に撃つ中で一番おじゃまが多いもの(無ければ null)。「今撃てば○個、3手後なら○個」が分かる
// おじゃまの数え方は applyEconomics と同じ: 置くたびに10点、持ち越しの点も足して、70点で1個(切り捨て)。
// 使う手数 = 置いた回数 + ちぎり×0.5 + 連鎖数×1.5
function searchMaxFire(board, order, startIdx, opts){
  opts = opts || {};
  const horizon = opts.horizon || 16, width = opts.width || 40, point = opts.point || 0;
  const RATE = E.OJAMA_RATE, DROP = E.RULES.dropBonus, RT = E.RULES.rensaTezon, CT = E.RULES.chigiriTezon;
  // opts.onFire(置く前の盤面, 手, ツモ) … 撃つ手を見つけるたびに呼ぶ。null を返すとその撃ち方は記録しない。
  // オブジェクトを返すと、その中身を記録に足す(situation.js の「強い副砲」の見分けに使う)
  const onFire = opts.onFire || null;
  // opts.tearMul(v0.10.68、予告が致死量のときのちぎり): 撃ち方を比べるときはおじゃまをちぎり1回ごとに (1 - tearMul) 倍にし、
  // 残す盤面を選ぶときはちぎり1回ごとに1/3連鎖分(0.5手)を引く。0 なら今まで通り
  const tm = opts.tearMul || 0;
  const worth = (f) => tm ? f.ojama * Math.pow(1 - tm, f.chig) : f.ojama;
  let beam = [{ board, moves: [], chig: 0 }];
  let best = null;
  const curve = [];
  for (let i = 0; i < horizon && beam.length; i++){
    const pat = E.TSUMO_PATTERNS[order[(startIdx + i) % CYCLE]];
    const cand = [], seen = new Set();
    let stepBest = null;
    for (const st of beam){
      for (const mv of E.enumerateLegalMoves(st.board)){
        const b2 = E.cloneBoard(st.board);
        const r = E.simulateMove(b2, mv.col, mv.rot, pat.axis, pat.child);
        if (!r.dropped) continue;
        const chig = st.chig + (r.chigiri ? 1 : 0);
        if (r.rensasu > 0){
          let extra = null;
          if (onFire){ extra = onFire(st.board, mv, pat); if (!extra) continue; }
          const f = Object.assign({ chain: r.rensasu, ojama: Math.floor((point + DROP * (i + 1) + r.totalPoint) / RATE),
                      at: i + 1, tezon: (i + 1) + chig * CT + r.rensasu * RT, moves: st.moves.concat([mv]) }, extra);
          if (tm) f.chig = chig;
          if (!stepBest || worth(f) > worth(stepBest) || (worth(f) === worth(stepBest) && f.tezon < stepBest.tezon)) stepBest = f;
          continue;                                            // 撃った筋はここで終わり
        }
        if (b2[GAMEOVER_X][GAMEOVER_Y] !== 0) continue;
        const k = boardKey(b2);
        if (seen.has(k)) continue;
        seen.add(k);
        const q = quickChain(b2);
        const cw = 60 + 10 * (startIdx + i);
        // opts.score === 'deep' なら、あと何個か足せば撃てる連鎖(伸びしろ)も点数に入れる(重いので候補の数に注意)
        const s = q * cw + PLANNER.buildShapeScore(b2) + (opts.score === 'deep' ? E.deepChainPotential(b2)[0] * cw : 0) - (tm ? chig * cw / 3 : 0);
        cand.push({ board: b2, moves: st.moves.concat([mv]), chig, q, s });
      }
    }
    curve.push(stepBest);
    if (stepBest && (!best || worth(stepBest) > worth(best))) best = stepBest;
    cand.sort((a, b) => b.s - a.s);
    // 同じ連鎖数ばかりにならないよう、連鎖数ごとの上限を設ける(planBuild と同じ)
    const cap = Math.max(3, Math.ceil(width / 3)), perQ = new Map(), next = [];
    for (const st of cand){
      const n = perQ.get(st.q) || 0;
      if (n >= cap) continue;
      perQ.set(st.q, n + 1);
      next.push(st);
      if (next.length >= width) break;
    }
    beam = next;
  }
  return { best: best || { chain: 0, ojama: 0, at: 0, tezon: 0, moves: [] }, curve };
}

// ==== ama 方式の組み立て(v0.10.13、作業記録 第33期) ====
// 参考: citrus610/ama(https://github.com/citrus610/ama、MIT License)の ai/search/beam/(beam.cpp・eval.cpp・quiet.cpp)と
// config.json の "build" の重み。考え方と手順を ama に倣い、このゲームのルール(13段・ツモの並びが全部見えている)に合わせて書き直した。
//   - 毎手、今の盤面から depth 手先までビームサーチで読む。読みの途中で実際に撃てた一番大きい連鎖の得点を「最初の1手」ごとに集め、
//     それが一番大きい1手を選ぶ(盤面の点数は、残す候補を選ぶための目安にだけ使う)
//   - 大きな連鎖(PRUNE 点以上)を撃った筋はそこで打ち切る。小さな連鎖は許すが、消した連鎖1つにつき waste の減点
//   - ama は先のツモが分からないので6通りの仮のツモで読むが、このゲームはツモの並びが全部分かっているので、本物の並びで読む
//   - ama の「人の定石の形に合わせる点数」(form)は入れていない
const AMA_W = { chain: 1000, y: 289, key: -200, chi: 200, link2: 150, link3: 250, shape: -100, well: -100, bump: -100,
                nuisance: -250, tear: -250, waste: -250, tearMul: 0 };   // tearMul(v0.10.67): 撃てた連鎖の点を、そこまでのちぎり1回ごとに (1 - tearMul) 倍にして比べる
const AMA_PRUNE = 5000;
const AMA_SHAPE = [1, 1, 1, -1, -1, -1];   // 理想の形: 左3列が平均より1段高く、右3列が1段低い
const ROWS12 = 12;                          // つながりは12段目まで数える(ama と同じ)

// つながりの数(ama の get_link_23)。3個つながり = 同じ色の隣が2方向以上あるマス、
// 2個つながり = 上か左に同じ色がある(1組を1回だけ数える)マスで、3個つながりのマスとその隣を除いたもの
function amaLinks(b){
  const same = (x, y, c) => x >= 0 && x < WIDTH && y >= 0 && y < ROWS12 && b[x][y] === c;
  const l3 = [];
  for (let x = 0; x < WIDTH; x++){ l3.push(new Uint8Array(ROWS12)); }
  let n3 = 0;
  for (let x = 0; x < WIDTH; x++) for (let y = 0; y < ROWS12; y++){
    const c = b[x][y];
    if (!c || c === OJAMA_COLOR) continue;
    const u = same(x, y + 1, c), d = same(x, y - 1, c), l = same(x - 1, y, c), r = same(x + 1, y, c);
    if (((u || d) && (l || r)) || (u && d) || (l && r)){ l3[x][y] = 1; n3++; }
  }
  const near3 = (x, y) => l3[x][y] || (y + 1 < ROWS12 && l3[x][y + 1]) || (y > 0 && l3[x][y - 1]) ||
                          (x > 0 && l3[x - 1][y]) || (x + 1 < WIDTH && l3[x + 1][y]);
  let n2 = 0;
  for (let x = 0; x < WIDTH; x++) for (let y = 0; y < ROWS12; y++){
    const c = b[x][y];
    if (!c || c === OJAMA_COLOR) continue;
    if ((same(x, y + 1, c) || same(x - 1, y, c)) && !near3(x, y)) n2++;
  }
  return [n2, n3];
}
function amaChi(h, x){ return chiAt(h, x); }
function chiAt(h, x){
  let chi = 0;
  if (x < WIDTH - 1){
    for (let i = x + 1; i < WIDTH; i++){ if (h[i] > h[x]) break; chi++; }
    for (let i = x + 1; i < WIDTH; i++){ if (h[i] >= h[x]) break; chi++; }
  }
  if (x > 0){
    for (let i = x - 1; i >= 0; i--){ if (h[i] > h[x]) break; chi++; }
    for (let i = x - 1; i >= 0; i--){ if (h[i] >= h[x]) break; chi++; }
  }
  return chi;
}
// 同じ色を積む列の範囲(ama の get_bound): 3列目から左右へ、12段を超える列の手前まで
function amaBound(h){
  let lo = 2, hi = 2;
  for (let x = 3; x < WIDTH; x++){ if (h[x] > 11) break; hi = x; }
  for (let x = 1; x >= 0; x--){ if (h[x] > 11) break; lo = x; }
  return [lo, hi];
}
function groupAt(b, x, y){
  const c = b[x][y];
  const seen = new Set([x * HEIGHT + y]); const st = [[x, y]]; let n = 0;
  while (st.length){
    const [cx, cy] = st.pop(); n++;
    for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]){
      if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= CONNECT_TOP) continue;
      const k = nx * HEIGHT + ny;
      if (seen.has(k) || b[nx][ny] !== c) continue;
      seen.add(k); st.push([nx, ny]);
    }
  }
  return n;
}
// 盤面の点数(ama の evaluate。form と14段目と side は除く)
function amaEval(b, w){
  const h = heightsOf(b);
  let q = -Infinity;
  const [lo, hi] = amaBound(h);
  for (let x = lo; x <= hi; x++){
    const dmax = Math.min(3, 12 - h[x]);
    if (dmax <= 0) continue;
    for (let c = 1; c <= 4; c++){
      const plan = E.cloneBoard(b);
      let need = 0;
      for (let i = 0; i < dmax; i++){
        plan[x][h[x] + i] = c;
        if (groupAt(plan, x, h[x]) >= 4){ need = i + 1; break; }
      }
      if (!need) continue;
      const r = E.simulateResolveChains(plan);              // plan は消えたあとの盤面になる
      if (r.rensasu <= 1) continue;                           // ama と同じく2連鎖以上だけ数える
      const [r2, r3] = amaLinks(plan);
      const s = r.rensasu * w.chain + h[x] * w.y + need * w.key + chiAt(h, x) * w.chi + r2 * w.link2 + r3 * w.link3;
      if (s > q) q = s;
    }
  }
  let v = q > -Infinity ? q : 0;
  // 形
  const avg = Math.floor(h.reduce((a, c) => a + c, 0) / WIDTH);
  let shape = 0; for (let x = 0; x < WIDTH; x++) shape += Math.abs(h[x] - avg - AMA_SHAPE[x]);
  let well = 0;
  if (h[0] < h[1]) well += h[1] - h[0];
  if (h[5] < h[4]) well += h[4] - h[5];
  for (let i = 1; i < 5; i++) if (h[i] < h[i - 1] && h[i] < h[i + 1]) well += Math.min(h[i - 1], h[i + 1]) - h[i];
  let bump = 0; for (let i = 1; i < 5; i++) if (h[i] > h[i - 1] && h[i] > h[i + 1]) bump += h[i] - Math.max(h[i - 1], h[i + 1]);
  const [l2, l3] = amaLinks(b);
  let garbage = 0; for (let x = 0; x < WIDTH; x++) for (let y = 0; y < HEIGHT; y++) if (b[x][y] === OJAMA_COLOR) garbage++;
  return v + shape * w.shape + well * w.well + bump * w.bump + l2 * w.link2 + l3 * w.link3 + garbage * w.nuisance;
}

// 今の盤面から depth 手先まで読み、最初の1手ごとの「その先で撃てた一番大きい連鎖の得点」を返す(得点の大きい順)。
//   戻り値 [{ mv, score(得点), chain(その連鎖数) }]。best = 先頭
function amaSearch(board, order, idx, opts){
  opts = opts || {};
  const width = opts.width || 100, depth = opts.depth || 16;
  const w = Object.assign({}, AMA_W, opts.w || {});
  const cand = [];
  let layer = [];
  const expand = (node, pat, cb) => {
    for (const mv of E.enumerateLegalMoves(node.board)){
      const b2 = E.cloneBoard(node.board);
      const r = E.simulateMove(b2, mv.col, mv.rot, pat.axis, pat.child);
      if (!r.dropped) continue;
      if (b2[GAMEOVER_X][GAMEOVER_Y] !== 0) continue;         // 窒息
      const action = node.action + (r.chigiri ? w.tear : 0) + (r.rensasu || 0) * w.waste;
      cb({ board: b2, action, index: node.index, chig: node.chig + (r.chigiri ? 1 : 0) }, mv, r);
    }
  };
  // 1手目(opts.noFire なら、1手目で連鎖を起こす手は外す。組むことだけを見たいとき)
  const worth = (total, chig) => w.tearMul > 0 ? total * Math.pow(1 - w.tearMul, chig) : total;
  expand({ board, action: 0, index: -1, chig: 0 }, E.TSUMO_PATTERNS[order[idx % CYCLE]], (child, mv, r) => {
    if (opts.noFire && r.rensasu) return;
    child.index = cand.length;
    cand.push({ mv, score: r.rensasu ? worth(r.totalPoint, child.chig) : 0, chain: r.rensasu || 0, tail: -Infinity });
    child.eval = amaEval(child.board, w);
    layer.push(child);
  });
  for (let i = 1; i < depth && layer.length; i++){
    const pat = E.TSUMO_PATTERNS[order[(idx + i) % CYCLE]];
    const next = new Map();
    for (const node of layer){
      expand(node, pat, (child, mv, r) => {
        const c = cand[child.index];
        if (r.rensasu && worth(r.totalPoint, child.chig) > c.score){ c.score = worth(r.totalPoint, child.chig); c.chain = r.rensasu; }
        if (r.rensasu && r.totalPoint >= AMA_PRUNE) return;  // 大きな連鎖を撃った筋はここまで
        const k = boardKey(child.board);
        const old = next.get(k);
        if (old && old.action >= child.action) return;        // 同じ盤面なら、置き方の減点が少ないほうを残す
        child.eval = old ? old.eval : amaEval(child.board, w);
        next.set(k, child);
      });
    }
    layer = [...next.values()].sort((a, b) => (b.action + b.eval) - (a.action + a.eval)).slice(0, width);
    // どこでも撃てなかったときのために、最初の1手ごとに、残った盤面の点数の一番良いものを覚えておく
    for (const n of layer){ const c = cand[n.index]; if (n.action + n.eval > c.tail) c.tail = n.action + n.eval; }
  }
  return cand.sort((a, b) => b.score - a.score || b.tail - a.tail);
}

module.exports = { planHonsen, buildScore, DEFAULT_W, searchMaxFire, amaSearch, amaEval, amaLinks, AMA_W };
