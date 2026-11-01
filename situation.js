// 状況把握の係(設計メモ docs/設計メモ.md の3章)。
//
//   const { analyzeSituation, formatSituation } = require('./situation.js');
//   const s = analyzeSituation(me, opp);   // me = いま手番の側、opp = 相手
//   console.log(formatSituation(s));
//
// 盤面・手数・予告を見て「人がまず数えること」を、自分と相手の両方について1つの表(状況表)にまとめる。
// 計算だけで判断はしない(判断は方針選択の係の仕事)。
// 中身はできるだけ engine.js の今ある部品を使う。同じ盤面の答えは engine.js 側が覚えて使い回す。
//
// 段階A で入れたのは、今ある部品で計算できる項目だけ。
// 「本線の最大(ツモ確定で、あと何手で何連鎖まで伸ばせるか)」と「撃ったら撃ち返されるか」は段階C で足す。
const E = require('./engine.js');
const W = require('./weights.js');   // 副砲の判定に使う fukuhouKeep(0.8)。探索AI・relationFeatures と同じ値

const { WIDTH, HEIGHT } = E;
const GAMEOVER_X = E.RULES.gameoverX, GAMEOVER_Y = E.RULES.gameoverY;
const MAX_OJAMA_DROP = E.RULES.maxOjamaDrop;
const RENSA_TEZON = E.RULES.rensaTezon, DROP_BONUS = E.RULES.dropBonus;
const OJAMA_RATE = E.OJAMA_RATE;

function heightsOf(board){
  const h = new Array(WIDTH);
  for (let x = 0; x < WIDTH; x++){ const y = board[x].indexOf(0); h[x] = y === -1 ? HEIGHT : y; }
  return h;
}

// 一度にn個降ったら負けになる、一番小さいn。降り方は engine.js の simDropOjama と同じ
// (6個ごとに1段ずつ、余りは ojamaIchi の位置から決まった列の順に)。
// 1回に降るのは最大30個なので、30より大きければ「次の1回では死なない」という意味になる。
function ojamaToDie(sim){
  if (sim.board[GAMEOVER_X][GAMEOVER_Y] !== 0) return 0;
  const cap = WIDTH * HEIGHT;
  for (let n = 1; n <= cap; n++){
    const t = { board: E.cloneBoard(sim.board), ojamaIchi: sim.ojamaIchi || 0 };
    simDropOjama(t, n);
    if (t.board[GAMEOVER_X][GAMEOVER_Y] !== 0) return n;
  }
  return Infinity;   // 3列目が詰まらない(他の列が満杯で降る場所が無いなど)
}
// engine.js の simDropOjama は書き出していないので、同じ手順をここに持つ
const OJAMA_ORDER = E.RULES.ojamaOrder, OJAMA_COLOR = E.RULES.ojamaColor;
function simDropOjama(sim, count){
  const drop = (x) => { const y = sim.board[x].indexOf(0); if (y !== -1) sim.board[x][y] = OJAMA_COLOR; };
  const per = Math.floor(count / WIDTH), rem = count % WIDTH;
  for (let g = 0; g < per; g++) for (let x = 0; x < WIDTH; x++) drop(x);
  let ichi = sim.ojamaIchi;
  for (let g = 0; g < rem; g++){ drop(OJAMA_ORDER[ichi]); ichi = (ichi + 1) % WIDTH; }
  sim.ojamaIchi = ichi;
}

// ==== 連鎖をくわしく解く(段階D) ====
// engine.js の simulateResolveChains と同じ手順で連鎖を最後まで解き、各段で「何個・何色消えたか」と、
// 消えたぷよが「元の盤面のどこにあったか」を返す。盤面は書き換えない。
// 連鎖数・得点・最後の盤面が simulateResolveChains と一致することは verify_situation.js で照合している。
const RENSA_B = E.RULES.rensaB, RENKETSU_B = E.RULES.renketsuB, IROKAZU_B = E.RULES.irokazuB;
function resolveChainsDetailed(board){
  const cell = [], from = [];      // from = そのマスのぷよが元の盤面のどこにあったか(x*HEIGHT+y)
  for (let x = 0; x < WIDTH; x++){ cell.push(board[x].slice()); from.push(board[x].map((_, y) => x * HEIGHT + y)); }
  const CTOP = E.CONNECT_TOP;
  let rensasu = 0, totalPoint = 0;
  const steps = [], cleared = [];
  while (true){
    const seen = cell.map(c => c.map(() => false)), clear = cell.map(c => c.map(() => false));
    let puyo = 0, renketsu = 0, ngroups = 0;
    const colors = new Set(), sizes = [];
    for (let x = 0; x < WIDTH; x++) for (let y = 0; y < CTOP; y++){
      const c = cell[x][y];
      if (c === 0 || c === OJAMA_COLOR || seen[x][y]) continue;
      const grp = [[x, y]], st = [[x, y]]; seen[x][y] = true;
      while (st.length){
        const [cx, cy] = st.pop();
        for (const [nx, ny] of [[cx, cy - 1], [cx, cy + 1], [cx - 1, cy], [cx + 1, cy]]){
          if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= CTOP || seen[nx][ny] || cell[nx][ny] !== c) continue;
          seen[nx][ny] = true; grp.push([nx, ny]); st.push([nx, ny]);
        }
      }
      if (grp.length < 4) continue;
      ngroups++; puyo += grp.length; colors.add(c); sizes.push(grp.length);
      renketsu += RENKETSU_B[Math.min(grp.length, RENKETSU_B.length - 1)];
      for (const [gx, gy] of grp){
        clear[gx][gy] = true;
        for (const [nx, ny] of [[gx, gy - 1], [gx, gy + 1], [gx - 1, gy], [gx + 1, gy]]){
          if (nx >= 0 && nx < WIDTH && ny >= 0 && ny < CTOP && cell[nx][ny] === OJAMA_COLOR) clear[nx][ny] = true;
        }
      }
    }
    if (!ngroups) break;
    rensasu++;
    const bonus = RENSA_B[Math.min(rensasu, RENSA_B.length - 1)] + renketsu + IROKAZU_B[Math.min(colors.size, IROKAZU_B.length - 1)];
    totalPoint += bonus === 0 ? 10 * puyo : 10 * puyo * bonus;
    steps.push({ puyo, colors: colors.size, groups: ngroups, sizes });   // sizes = その段で消えた塊それぞれの個数
    for (let x = 0; x < WIDTH; x++){
      const nc = [], nf = [];
      for (let y = 0; y < HEIGHT; y++){
        if (clear[x][y]){ if (from[x][y] >= 0 && cell[x][y] !== OJAMA_COLOR) cleared.push(from[x][y]); continue; }
        if (cell[x][y] !== 0){ nc.push(cell[x][y]); nf.push(from[x][y]); }
      }
      while (nc.length < HEIGHT){ nc.push(0); nf.push(-1); }
      cell[x] = nc; from[x] = nf;
    }
  }
  return { rensasu, totalPoint, steps, cleared, board: cell };
}

// 強い副砲かどうか(shio さんの基準、2026-10-21):
//   'tan2'    … 2色・10個以上の単発(1連鎖)
//   'double2' … 2連鎖ダブル(2連鎖目で2色以上が同時に消える)。2連鎖目が10個以上ならなお良い(good)
//   'rensa5'  … 5連鎖
// どれでもなければ null
function strongFukuhouKind(steps){
  const n = steps.length;
  if (n === 1 && steps[0].colors >= 2 && steps[0].puyo >= 10) return { kind: 'tan2', good: true };
  if (n === 2 && steps[1].colors >= 2) return { kind: 'double2', good: steps[1].puyo >= 10 };
  if (n === 5) return { kind: 'rensa5', good: true };
  return null;
}
const KIND_LABEL = { tan2: '2色10個以上の単発', double2: '2連鎖ダブル', rensa5: '5連鎖' };

// 本線に使っているぷよの印。仮想の1個で撃てる中で一番得点の高い発火点を撃ったとき、消えるぷよ(元の盤面の位置)。
// 戻り値: marks[x][y] = true(本線のぷよ)。本線が無ければすべて false
function honsenMarks(board){
  let best = null;
  for (const ig of E.findIgnitions(board)){
    const b2 = E.cloneBoard(board);
    b2[ig.col][ig.row] = ig.color;
    const d = resolveChainsDetailed(b2);
    if (!best || d.totalPoint > best.d.totalPoint) best = { d, ig };
  }
  const marks = Array.from({ length: WIDTH }, () => new Array(HEIGHT).fill(false));
  if (best) for (const k of best.d.cleared){
    const x = (k / HEIGHT) | 0, y = k % HEIGHT;
    if (!(x === best.ig.col && y === best.ig.row)) marks[x][y] = true;   // 仮想の1個は盤面に無いので除く
  }
  return marks;
}

// 盤面の埋まり具合(見えている12段 = 72マスのうち、ぷよがあるマスの割合)
const VISIBLE_ROWS = 12;
function fillRatio(board){
  let n = 0;
  for (let x = 0; x < WIDTH; x++) for (let y = 0; y < VISIBLE_ROWS; y++) if (board[x][y] !== 0) n++;
  return n / (WIDTH * VISIBLE_ROWS);
}
const ENDGAME_FILL = 0.7;   // 終盤: お互いの盤面が7割以上埋まっているとき(shio さんの基準、2026-10-21)

// 片側ぶんの状況
function sideSituation(sim){
  const board = sim.board;
  const h = heightsOf(board);
  let space = 0;
  for (let x = 0; x < WIDTH; x++) for (let y = 0; y < HEIGHT; y++) if (board[x][y] === 0) space++;

  // 本線と副砲。analyzeBoard は「仮想の1個で発火したら」を全部の発火点で試した結果を持っている
  const prof = E.analyzeBoard(board, W);
  // 今撃てる一番大きい攻撃(おじゃまが一番多い発火点)。
  // おじゃま数は実際の手数の計算(applyEconomics)と同じく、持ち越しの点と置いた点(10点)を足してから切り捨てる
  const point = sim.point || 0;
  const send = (ojamaRaw) => Math.floor((point + DROP_BONUS + Math.round(ojamaRaw * OJAMA_RATE)) / OJAMA_RATE);
  const hon = prof.honsen;
  const fireNow = hon.ojama > 0
    ? { chain: Math.round(hon.cost / RENSA_TEZON), ojama: send(hon.ojama), tezon: 1 + hon.cost }
    : { chain: 0, ojama: 0, tezon: 0 };
  // 一番長い連鎖(おじゃまが一番多いものとは違うことがある)
  let maxChainNow = 0;
  for (const a of prof.answers){ const c = Math.round(a.cost / RENSA_TEZON); if (c > maxChainNow) maxChainNow = c; }
  const fk = prof.fukuhou;
  const fukuhou = fk.ojama > 0
    ? { chain: Math.round(fk.cost / RENSA_TEZON), ojama: send(fk.ojama), tezon: 1 + fk.cost, eff: fk.eff }
    : { chain: 0, ojama: 0, tezon: 0, eff: 0 };

  // 伸びしろ(ama 方式。あと何個足せば何連鎖になるか)
  const [pChain, pOjama, pNeed, pHeight, pChi] = E.deepChainPotential(board);

  const yokoku = Math.max(0, sim.ojamaYokoku || 0);
  return {
    cost: sim.cost,                                   // 残り手数
    yokoku,                                           // 自分に来ている予告おじゃま
    nextDrop: Math.min(yokoku, MAX_OJAMA_DROP),       // 手番の終わりに降る量
    heights: h,                                       // 各列の高さ(段数)
    space,                                            // 空きマス
    col3Margin: Math.max(0, GAMEOVER_Y - h[GAMEOVER_X]), // 3列目にあと何個積めるか(次の1個で負け、の手前まで)
    ojamaToDie: ojamaToDie(sim),                      // 一度に何個降ったら負けか
    fireNow,                                          // 今撃てる一番大きい攻撃 { 連鎖数, おじゃま, 使う手数 }
    maxChainNow,                                      // 今撃てる一番長い連鎖の連鎖数
    fukuhou,                                          // 副砲 { 連鎖数, おじゃま, 使う手数, 手数あたりのおじゃま }
    potential: { chain: pChain, ojama: pOjama, need: pNeed, height: pHeight, chi: pChi }, // 伸びしろ
    fill: fillRatio(board),                           // 見えている12段の埋まり具合(0〜1)
    _prof: prof,
  };
}

// 状況表を作る。me = いま手番の側、opp = 相手。どちらも engine.js の sim の形
// ({ board, cost, point, ojamaYokoku, ojamaIchi, tsumoCount })。
function analyzeSituation(me, opp){
  const m = sideSituation(me), o = sideSituation(opp);
  // 「撃ち返せるか」は探索AI・relationFeatures と同じ判定(engine.js の canAnswer)。
  // 手番でない側も、手番が回ってくれば最低1手数はもらえるので、手数は最低1として数える。
  // (注: このゲームは手数が足りなくても撃てる。足りない分は相手の手数に足される。
  //  canAnswer は「連鎖に払う手数が残り手数以内か」で見ているので、その分きびしめの判定になっている)
  const mb = Math.max(me.cost, 1), ob = Math.max(opp.cost, 1);
  const ans = (prof, x, budget) => E.canAnswer(prof, x, budget);
  const rel = {
    // 自分から見て
    canOffsetMyYokoku: ans(m._prof, m.yokoku, mb),        // 自分への予告を、手数のうちに撃って消せるか
    canCounterOppFire: ans(m._prof, o.fireNow.ojama, mb), // 相手の今の一番大きい攻撃に撃ち返せるか
    canCounterOppFukuhou: ans(m._prof, o.fukuhou.ojama, mb),
    // 相手から見て
    oppCanOffsetTheirYokoku: ans(o._prof, o.yokoku, ob),
    oppCanCounterMyFire: ans(o._prof, m.fireNow.ojama, ob),
    oppCanCounterMyFukuhou: ans(o._prof, m.fukuhou.ojama, ob),
    // 差(自分 − 相手)
    fireGap: m.fireNow.ojama - o.fireNow.ojama,
    potentialChainGap: m.potential.chain - o.potential.chain,
    endgame: m.fill >= ENDGAME_FILL && o.fill >= ENDGAME_FILL,   // 終盤か
  };
  delete m._prof; delete o._prof;
  return { me: m, opp: o, rel };
}

// ==== 重い項目(段階C)。節目のときだけ呼ぶ想定 ====
// analyzeSituation の表に、次の2つを足したものを返す。
//   me.maxFire / opp.maxFire … この先 horizon 手のうちに、実際のツモで撃てる最大(builder.js の searchMaxFire)。
//                              best = 一番おじゃまが多い撃ち方、curve[k-1] = k手目に撃つ中で一番おじゃまが多いもの
//   rel.counter              … 自分が今のツモで一番大きく撃ったら、相手はもらう手数のうちに撃ち返せるか。撃てないときは null
// order はツモの並び。手番の側(me)は今持っているツモが order[me.tsumoCount - 1]、
// 相手(opp)は次に配られるツモが order[opp.tsumoCount](engine.js の simDealTsumoOrder の数え方)。
// opts: horizon(既定16手=ツモ1周)・width(既定40)
const B = require('./builder.js');
const CYCLE = E.RULES.tsumoCycle;
// searchMaxFire の onFire に渡す、「強い副砲」に当たる撃ち方だけを記録する関数
function strongOnFire(b, mv, pat){
  const b2 = E.cloneBoard(b);
  E.placePiece(b2, mv.col, mv.rot, pat.axis, pat.child);
  const d = resolveChainsDetailed(b2);
  const k = strongFukuhouKind(d.steps);
  if (!k) return null;
  return { kind: k.kind, good: k.good, remainChain: E.ignitionPotential(d.board)[0] };  // 撃ったあとに残る本線の連鎖数
}
function analyzeSituationDeep(me, opp, order, opts){
  opts = opts || {};
  const horizon = opts.horizon || 16, width = opts.width || 40;
  const s = analyzeSituation(me, opp);
  const meIdx = (me.tsumoCount - 1 + CYCLE) % CYCLE, oppIdx = opp.tsumoCount % CYCLE;
  s.me.maxFire = B.searchMaxFire(me.board, order, meIdx, { horizon, width, point: me.point || 0 });
  s.opp.maxFire = B.searchMaxFire(opp.board, order, oppIdx, { horizon, width, point: opp.point || 0 });

  // 撃ったら撃ち返されるか。今のツモで一番おじゃまが多い撃ち方(maxFire の1手目)を実際に置いて、手数とおじゃまを計算する
  s.rel.counter = null;
  const now = s.me.maxFire.curve[0];
  if (now){
    const m = Object.assign({}, me, { board: E.cloneBoard(me.board) });
    const o = Object.assign({}, opp, { board: E.cloneBoard(opp.board) });
    const pat = E.TSUMO_PATTERNS[order[meIdx]];
    const r = E.simulateMove(m.board, now.moves[0].col, now.moves[0].rot, pat.axis, pat.child);
    const out = E.applyEconomics(m, o, r);
    // 相手が置ける回数: 手番が終わったなら、相手のその時点の手数。終わらないなら、こちらが手番を終えたときに最低+1
    const T = Math.min(horizon, Math.max(1, Math.ceil(out.turnSwitched ? o.cost : o.cost + 1)));
    const sent = Math.max(0, o.ojamaYokoku);                  // 相手に向かう予告(相殺したあと)
    const back = B.searchMaxFire(o.board, order, o.tsumoCount % CYCLE, { horizon: T, width, point: o.point || 0 }).best;
    s.rel.counter = {
      chain: r.rensasu, sent,                                 // 撃つ連鎖数と、相手に向かうおじゃま
      myTurnEnds: out.turnSwitched, gameOver: out.gameOver,
      oppMoves: T,                                            // 相手が撃ち返すまでに置ける回数
      oppBack: back.ojama, oppBackChain: back.chain, oppBackAt: back.at,
      returned: sent > 0 && back.ojama >= sent,               // 相手は全部消して、さらに送り返せるか
      net: back.ojama - sent,                                 // 送り返される量(マイナスなら相手が受けきれない分)
    };
  }

  // 強い副砲の手目ごとの表(段階D)。strongHorizon 手先まで(既定8手)、強い副砲(strongFukuhouKind)に当たる撃ち方だけを記録する。
  // 組む側の点数は本線向けなので、本線を組みながら作れる副砲だけが見つかる(副砲専用に組んだ場合より少なめに出る)
  const strongHorizon = opts.strongHorizon || 8;
  s.me.strongFire = B.searchMaxFire(me.board, order, meIdx, { horizon: strongHorizon, width, point: me.point || 0, onFire: strongOnFire });
  s.opp.strongFire = B.searchMaxFire(opp.board, order, oppIdx, { horizon: strongHorizon, width, point: opp.point || 0, onFire: strongOnFire });

  // 本線に使っているぷよの印と、その数
  for (const [x, sim] of [[s.me, me], [s.opp, opp]]){
    x.honsenMarks = honsenMarks(sim.board);
    let n = 0, total = 0;
    for (let cx = 0; cx < WIDTH; cx++) for (let cy = 0; cy < HEIGHT; cy++){
      if (x.honsenMarks[cx][cy]) n++;
      const c = sim.board[cx][cy]; if (c && c !== OJAMA_COLOR) total++;
    }
    x.honsenPuyo = n; x.otherPuyo = total - n;   // 本線のぷよ / 本線に使っていない色ぷよ
  }

  // おじゃまが降ったあとの盤面(自分に予告があるときだけ)。「わざと受ける」の判断に使う。
  // 今の手番でこれ以上置かずに降らせたとみなし、次のツモから組み直した場合を測る(おおよその値)
  s.me.afterDrop = null;
  if (s.me.nextDrop > 0){
    const a = { board: E.cloneBoard(me.board), ojamaIchi: me.ojamaIchi || 0 };
    simDropOjama(a, s.me.nextDrop);
    const dead = a.board[GAMEOVER_X][GAMEOVER_Y] !== 0;
    const nextIdx = me.tsumoCount % CYCLE;
    s.me.afterDrop = {
      dropped: s.me.nextDrop, dead,
      left: s.me.yokoku - s.me.nextDrop,                     // 降ったあとも残る予告
      ojamaToDie: dead ? 0 : ojamaToDie(a),
      maxFire: dead ? null : B.searchMaxFire(a.board, order, nextIdx, { horizon, width, point: me.point || 0 }),
      strongFire: dead ? null : B.searchMaxFire(a.board, order, nextIdx, { horizon: strongHorizon, width, point: me.point || 0, onFire: strongOnFire }),
    };
  }
  return s;
}

// 人が読むための表示
function formatSituation(s){
  const yn = (b) => b ? 'はい' : 'いいえ';
  const die = (n) => n === Infinity ? '詰まらない' : `${n}個`;
  const side = (name, x) => [
    `【${name}】手数${x.cost} / 予告${x.yokoku}(次に降る${x.nextDrop}) / 空き${x.space}マス / 列の高さ ${x.heights.join(',')}`,
    `  今撃てば: ${x.fireNow.chain}連鎖・おじゃま${x.fireNow.ojama}個・手数${x.fireNow.tezon}` +
      (x.maxChainNow > x.fireNow.chain ? `(一番長いのは${x.maxChainNow}連鎖)` : ''),
    `  副砲: ` + (x.fukuhou.chain > 0
      ? `${x.fukuhou.chain}連鎖・おじゃま${x.fukuhou.ojama}個・手数${x.fukuhou.tezon}(1手数あたり${x.fukuhou.eff.toFixed(2)}個)`
      : 'なし'),
    `  伸びしろ: あと${x.potential.need}個で${x.potential.chain}連鎖・おじゃま${x.potential.ojama}個(発火点の高さ${x.potential.height})`,
    `  窒息まで: 3列目にあと${x.col3Margin}個 / 一度に${die(x.ojamaToDie)}降ったら負け`,
    ...(x.maxFire ? [
      `  本線の最大(${x.maxFire.curve.length}手先まで): ` + (x.maxFire.best.chain
        ? `${x.maxFire.best.at}手目に${x.maxFire.best.chain}連鎖・おじゃま${x.maxFire.best.ojama}個(撃ち終わるまでに手数${x.maxFire.best.tezon})`
        : '撃てない'),
      `    手目ごと: ` + x.maxFire.curve.map((c, k) => `${k + 1}:${c ? c.ojama : '-'}`).join(' '),
    ] : []),
    ...(x.strongFire ? [
      `  強い副砲(${x.strongFire.curve.length}手先まで): ` + (x.strongFire.best.chain
        ? `${x.strongFire.best.at}手目に${KIND_LABEL[x.strongFire.best.kind]}・おじゃま${x.strongFire.best.ojama}個` +
          `(撃ったあと本線は${x.strongFire.best.remainChain}連鎖残る)`
        : '作れない'),
      `    手目ごと: ` + x.strongFire.curve.map((c, k) => `${k + 1}:${c ? c.ojama : '-'}`).join(' '),
    ] : []),
    ...(x.honsenMarks ? [`  本線のぷよ ${x.honsenPuyo}個 / 本線に使っていない色ぷよ ${x.otherPuyo}個 / 埋まり具合 ${Math.round(x.fill * 100)}%`] : []),
    ...(x.afterDrop ? [`  予告を受けたら: ${x.afterDrop.dropped}個降る → ` + (x.afterDrop.dead ? '負け'
      : `一度に${die(x.afterDrop.ojamaToDie)}で負け / 本線の最大 ${x.afterDrop.maxFire.best.at}手目に${x.afterDrop.maxFire.best.ojama}個 / ` +
        `強い副砲 ` + (x.afterDrop.strongFire.best.chain ? `${x.afterDrop.strongFire.best.at}手目に${x.afterDrop.strongFire.best.ojama}個` : 'なし'))] : []),
  ].join('\n');
  const r = s.rel;
  return [
    side('自分', s.me), side('相手', s.opp),
    `【関係】自分の予告を消せる:${yn(r.canOffsetMyYokoku)} / 相手の最大の攻撃に撃ち返せる:${yn(r.canCounterOppFire)} / ` +
      `相手の副砲に撃ち返せる:${yn(r.canCounterOppFukuhou)}`,
    `        相手は自分の最大の攻撃に撃ち返せる:${yn(r.oppCanCounterMyFire)} / 相手は自分の副砲に撃ち返せる:${yn(r.oppCanCounterMyFukuhou)}`,
    `        火力の差 ${r.fireGap >= 0 ? '+' : ''}${r.fireGap}個 / 伸びしろの差 ${r.potentialChainGap >= 0 ? '+' : ''}${r.potentialChainGap}連鎖` +
      ` / 終盤(お互い7割以上埋まっている):${yn(r.endgame)}`,
    ...(r.counter !== undefined ? [r.counter
      ? `        今撃つと: ${r.counter.chain}連鎖で相手に${r.counter.sent}個 → 相手は${r.counter.oppMoves}回置くうちに` +
        `${r.counter.oppBack}個(${r.counter.oppBackChain}連鎖)撃てる → ` +
        (r.counter.returned ? `撃ち返される(${r.counter.net}個戻ってくる)` : `受けきれない分が${-r.counter.net}個`)
      : '        今のツモでは撃てない'] : []),
  ].join('\n');
}

module.exports = { analyzeSituation, analyzeSituationDeep, formatSituation, ojamaToDie,
                   resolveChainsDetailed, strongFukuhouKind, strongOnFire, honsenMarks, fillRatio, ENDGAME_FILL };
