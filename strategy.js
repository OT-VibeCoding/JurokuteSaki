// 方針選択の係(設計メモ docs/設計メモ.md の4章)。段階E の最初の版。
//
//   const { makePlanChooser } = require('./strategy.js');
//   const choose = makePlanChooser({ fukuhou: true, budget: 200 });
//   const mv = choose(me, opp, piece, order);
//
// 今入っている方針は3つ。
//   大きく撃ち返す(counter: true) … 相手の本線で大きな予告(counterMin 個以上)が来たら、この手番で置ける回数のうちに撃てる撃ち方を
//                                     候補を広く(counterWidth)読んで探し、「予告より多く撃てる、一番早い撃ち方」で撃つ(v0.10.12)
//   副砲で攻める(fukuhou: true)  … この手番のうちに強い副砲を撃てて、fukuhou.js の判定(shio さんの基準)で「撃ってよい」と出たら、その手順で撃つ
//   それ以外                       … 今ある「探索AI+大連鎖構築」(planner.js の chooseMoveWithPlan)に任せる(本線を組み、撃つ時期は探索で決める)
//                                    builder: 'ama' なら、組む手だけを ama 方式(builder.js の amaSearch、毎手読み直す)にする(v0.10.13)
//   勝率で決める(value: 'runs/tri/r0/value.json') … 撃つか組むかを、手番の終わりの局面の勝率の見積もり(value.js)で決める(v0.10.19)
// どれを入れるかを変えたAIどうしを戦わせると、その方針が勝ちにつながるかが分かる。
const E = require('./engine.js');
const P = require('./planner.js');
const B = require('./builder.js');
const S = require('./situation.js');
const F = require('./fukuhou.js');
const X = require('./exchange.js');
const V = require('./value.js');
const WEIGHTS = require('./weights.js');

const CYCLE = E.RULES.tsumoCycle;
function boardKey(b){ let s = ''; for (const col of b) s += col.join(''); return s; }
const heightsOf = (b) => b.map(col => { const y = col.indexOf(0); return y === -1 ? E.HEIGHT : y; });
// 崩れ(本家 ama の gaze.cpp get_redundancy): 列ごとに、撃つ前と撃ったあとの低いほうの高さまでで、下から見て最初に変わったマスより上の段数を足す
function redundancy(pre, now){
  const hp = heightsOf(pre), hn = heightsOf(now);
  let r = 0;
  for (let x = 0; x < E.WIDTH; x++){
    const h = Math.min(hp[x], hn[x]);
    for (let y = 0; y < h; y++) if (pre[x][y] !== now[x][y]){ r += h - y; break; }
  }
  return r;
}
// 撃ち方の手順を置いたあとも本線の土台が残るか(double.base、v0.10.66。本家 ama の ai.cpp classify_crush の条件)
function keepsBase(board, order, idx, moves, base){
  let b = E.cloneBoard(board), pre = b;
  for (let k = 0; k < moves.length; k++){
    const p = E.TSUMO_PATTERNS[order[(idx + k) % CYCLE]];
    pre = b; b = E.cloneBoard(b);
    if (!E.simulateMove(b, moves[k].col, moves[k].rot, p.axis, p.child).dropped) return false;
  }
  const h = heightsOf(b);
  if (b.reduce((s, col) => s + col.filter(v => v !== 0).length, 0) < (base.remain || 24)) return false;
  if (h[0] < 4 || h[1] < 4 || h[2] < 4 || h[3] < 3 || h[4] < 3 || h[5] < 3) return false;
  return redundancy(pre, b) <= (base.red === undefined ? 4 : base.red);
}

// 撃ち方の手順が、この手番の中で本当に撃てるか(ちぎりで手数が減って、撃つ前に手番が終わることがある)
function firesInTurn(me, opp, order, moves){
  const m = Object.assign({}, me, { board: E.cloneBoard(me.board) });
  const o = Object.assign({}, opp, { board: E.cloneBoard(opp.board) });
  const t = X.playTurn(m, o, order, moves, true, { width: 30, buildWidth: 30 });
  return t.planDone && t.fired.length > 0 && !t.gameOver;
}

function makePlanChooser(opts){
  opts = Object.assign({ fukuhou: false, counter: false, counterMin: 18, counterWidth: 300, builder: 'plan', amaWidth: 100,
                         respond: false, smallMax: 5,
                         value: null, valueTries: 3, valueFireWidth: 100, oppReply: false, lazyBuild: false, finish: null, nativeAma: false, sideMinChain: 0, buildTries: 1, single: null, double: null, noise: null,
                         budget: 200, plies: 8, useModes: 0, width: 30, tries: 3 }, opts || {});
  // nativeAma: 本線を組む読みを C++ 版(ama_native.js、答えは同じで約10倍速い)で行う(v0.10.36)
  const AMA = opts.nativeAma ? require('./ama_native.js').amaSearch : B.amaSearch;
  // amaW: ama式の重みを変える(v0.10.67、tearMul = ちぎりの割り引き)。tearYokoku(v0.10.68、shio さんの案: 限られた手数での伸ばしが弱い)を付けると、
  // 予告におじゃまがその数以上あるとき(致死量 60個など)だけ amaW を使い、それ以外は今まで通りの重みで読む
  const amaWFor = (me) => opts.tearYokoku && (me.ojamaYokoku || 0) < opts.tearYokoku ? undefined : opts.amaW;
  const vnet = !opts.value ? null : (typeof opts.value === 'string' ? V.load(opts.value) : opts.value);
  let planState = { plan: null };
  let attack = null;          // 撃っている途中の手順(副砲・撃ち返し) { moves, idx, expectKey }
  let singlePlan = null;      // 進むと決めた単発の手順(次の手番にまたがるもの。v0.10.42) { moves, idx, expectKey, fire }
  const afterMove = (board, mv, piece) => { const b2 = E.cloneBoard(board); E.simulateMove(b2, mv.col, mv.rot, piece.axis, piece.child); return boardKey(b2); };
  const stats = { moves: 0, attacks: 0, judged: 0, rejected: 0, counters: 0, counterNone: 0 };

  // 1手を決めるのにかかった時間も数える(stats.ms、v0.10.40。思考時間の変化を追うため)
  function choose(me, opp, piece, order){
    const t0 = process.hrtime.bigint();
    try { return decide(me, opp, piece, order); } finally { stats.ms = (stats.ms || 0) + Number(process.hrtime.bigint() - t0) / 1e6; }
  }
  function decide(me, opp, piece, order){
    if (me.tsumoCount <= 1){ planState = { plan: null }; attack = null; singlePlan = null; }   // 新しい対局
    stats.moves++;
    const idx = (me.tsumoCount - 1 + CYCLE) % CYCLE;

    // 撃っている途中の副砲の手順を続ける(盤面が手順どおりのときだけ)
    if (attack && attack.idx < attack.moves.length && boardKey(me.board) === attack.expectKey){
      if (choose.onValue) choose.onValue({ continuing: true, left: attack.moves.length - attack.idx, tsumoCount: me.tsumoCount });
      return advance(me, piece);
    }
    attack = null;

    // 勝率の見積もりで「撃つか組むか」を決める(value、v0.10.19。古い探索AIを使わない)。
    // 候補: 組む(ama 方式の一番の手)/ この手番のうちに撃てる撃ち方いくつか(早いもの・多いもの)。
    // それぞれ手番の終わりまで実際の手数の計算でたどり、相手の手番の始まりの局面を value.js で見積もって、自分の勝率が一番高いものを選ぶ
    if (vnet && me.cost > 0){
      const T = Math.min(16, Math.ceil(me.cost));
      // lazyBuild(v0.10.21。shio さんの考え): 本線用の重い読み(ama)は「組む」と決まったときだけ走らせる。
      // 比べる段階の「組む」は、手番の残りを軽い組み立て(buildPlan)でたどった局面で見積もる
      const build = opts.lazyBuild ? null : AMA(me.board, order, idx, { width: opts.amaWidth, depth: 16, noFire: true, w: amaWFor(me) });
      const options = [];
      if (opts.lazyBuild) options.push({ kind: 'build', moves: null });
      // buildTries(v0.10.40、shio さんと決めた試し): 組む手を ama の上位から何手まで候補にするか。1 なら今まで通り一番の手だけ。
      // 増やすと、ama が見ていない「すぐ撃てる強い1連鎖を手元に残す」組み方も、勝率の見積もりで選べるようになる
      else for (let i = 0; i < Math.min(opts.buildTries, build.length); i++) options.push({ kind: 'build', moves: [build[i].mv], rank: i });
      // 予告が致死量のとき(tearYokoku)は、撃ち方の読みにもちぎりの割り引きを入れる(v0.10.68)
      const f = B.searchMaxFire(me.board, order, idx, { horizon: T, width: opts.valueFireWidth, point: me.point || 0, tearMul: opts.tearYokoku && amaWFor(me) ? amaWFor(me).tearMul : 0 });
      // sideMinChain(v0.10.38、確かめ用): 予告が来ていないときは、この連鎖数より小さい撃ち方を候補に入れない(4個消しで本線を崩す癖を確かめるため)
      const fires = f.curve.filter(c => c && (me.ojamaYokoku > 0 || c.chain >= opts.sideMinChain));
      const pickedFires = new Set();
      fires.slice().sort((a, b) => b.ojama - a.ojama).slice(0, opts.valueTries).forEach(c => pickedFires.add(c));
      fires.filter(c => c.ojama >= me.ojamaYokoku).sort((a, b) => a.at - b.at).slice(0, opts.valueTries).forEach(c => pickedFires.add(c));
      for (const c of pickedFires) options.push({ kind: 'fire', moves: c.moves, fire: c });
      // 仕上げの読み(finish、v0.10.31。shio さんと決めた形): 予告が来ている(相手が撃った)ときだけ、
      // finish.exe で「使う手数」と「送るおじゃま」のどちらでも負けていない撃ち方を集め、予告を消しきれるものの中から
      // shio さんのやりとりの計算(fukuhou.js の exchangeMargin)で1つ選んで、候補に足す。最後は他の候補と同じく勝率の見積もりで比べる
      if (opts.finish && me.ojamaYokoku > 0){
        const FN = require('./finish_native.js');
        const fo = opts.finish;
        const keep = fo.mode === 'keep' ? 'colored' : fo.mode === 'honsen' ? 'honsen' : null;   // honsen: 撃ったあとに残る本線を比べる(v0.10.35)
        const r = FN.finishSearch(me, order, { maxPlace: Math.min(fo.maxPlace || 8, Math.ceil(me.cost)), beam: fo.beam || 60, tail: fo.tail || 4, keep });
        stats.finish_calls = (stats.finish_calls || 0) + 1;
        if (keep){
          // 副砲への返しにも使う形(v0.10.34。shio さんの希望): 「使う手数」「送るおじゃま」「撃ったあとに残る色ぷよ」のどれでも負けていない
          // 撃ち方のうち、予告を消しきれるものを、使う手数ごとに残る色ぷよの多い2つまで(全体で16まで)候補に足し、勝率の見積もりに選ばせる
          const ok = r.pareto.filter(c => c.ojama >= me.ojamaYokoku).sort((a, b) => a.used - b.used || b.keep - a.keep);
          const perUsed = new Map(), picked = [];
          for (const c of ok){
            const n = perUsed.get(c.used) || 0;
            if (n >= 2) continue;
            perUsed.set(c.used, n + 1);
            picked.push(c);
            if (picked.length >= 16) break;
          }
          if (picked.length) stats.finish_found = (stats.finish_found || 0) + 1;
          for (const c of picked) options.push({ kind: 'fire', moves: c.moves, fire: c, finish: true });
        } else {
          let pick = null;
          for (const c of r.pareto){
            if (c.ojama < me.ojamaYokoku) continue;
            const mg = F.exchangeMargin(me, opp, order, c.moves).margin;
            if (!pick || mg > pick.mg) pick = { c, mg };
          }
          if (pick){ stats.finish_found = (stats.finish_found || 0) + 1; options.push({ kind: 'fire', moves: pick.c.moves, fire: pick.c, finish: true }); }
        }
      }
      // 単発探し(single、v0.10.41。shio さんの案): 毎手、数手先(depth)まで全部の置き方を読み、途中で消えずに最後の1手で
      // 1連鎖になる撃ち方のうち、ためた落下の点も込みでおじゃま min 個以上のものを候補に足す(おじゃまが一番多いもの・一番早いもの)。
      // 持ち手は気にせず読む(次の手番にまたがってよい)。進むかどうかは他の候補と同じく勝率の見積もりで決める
      // 2連鎖探しの直し(v0.10.56、shio さんと決めた1つずつの試し): double.shape = 効率の悪い形を読みの中で除く(1段目6個以上・2段目 4+4 の2色・2段目が同色のダブル = 塊2つで同じ色)、
      // double.after = 撃ったあとの残る本線も読みの中で比べ、残る本線が一番大きいものも候補に渡す、double.noKeep = 2連鎖には続ける余裕を付けない
      // double.eff = 点: 「連鎖の点 ÷ 消えた色ぷよの数」がこの点未満の2連鎖を読みの中で除く(v0.10.56、shio さんの案。78点)
      const doubleFlags = opts.double ? (opts.double.shape ? 16 : 0) | (opts.double.after ? 32 : 0) | (opts.double.eff ? 64 | (opts.double.eff << 8) : 0) : 0;
      // 2連鎖探し(double)も入れていて読む深さが同じなら、同じ手順を2回たどらないよう1回の読みで両方集める(v0.10.54、shio さんの指摘。答えは別々に読むのと同じ)
      // double.from = 手数: 2人の置いた数の合計(duel_net.js の記録の n と同じ数え方)がこの手数より前は2連鎖を探さない(v0.10.58、shio さんと決めた30手目。
      // 序盤に組みに行っては撃たずにやめる手が多かったため、作業記録 60)
      // double.oppMax = 連鎖数: 相手の本線(今撃てる・組めば の大きい方の連鎖数)がこれ以上なら2連鎖を探さない(v0.10.60、shio さんの案: 相手が15連鎖を超えたらもう打たない)
      const oppHonsenChain = () => { const [nc] = E.ignitionPotential(opp.board); const d = E.deepChainPotential(opp.board); return Math.max(nc, d[0]); };
      const doubleOn = opts.double && ((me.tsumoCount || 0) + (opp.tsumoCount || 0) - 1) >= (opts.double.from || 0)
                       && !(opts.double.oppMax && oppHonsenChain() >= opts.double.oppMax);
      const both = opts.single && doubleOn && (opts.single.depth || 4) === (opts.double.depth || 4)
        ? require('./finish_native.js').finishSearch(Object.assign({}, me, { cost: 99 }), order, { maxPlace: opts.single.depth || 4, keep: 'singleDouble', keepFlags: doubleFlags }) : null;
      if (opts.single){
        const FN = require('./finish_native.js');
        const r = both || FN.finishSearch(Object.assign({}, me, { cost: 99 }), order, { maxPlace: opts.single.depth || 4, keep: 'single' });
        stats.single_calls = (stats.single_calls || 0) + 1;
        const ok = r.pareto.filter(c => c.ojama >= (opts.single.min || 10));
        if (ok.length){
          stats.single_found = (stats.single_found || 0) + 1;
          const most = ok.slice().sort((a, b) => b.ojama - a.ojama || a.moves.length - b.moves.length)[0];
          const fast = ok.slice().sort((a, b) => a.moves.length - b.moves.length || b.ojama - a.ojama)[0];
          for (const c of new Set([most, fast])) options.push({ kind: 'single', moves: c.moves, fire: c });
        }
      }
      // 強い2連鎖探し(double、v0.10.54。shio さんの案: 副砲の鋭さを上げる): 単発探しと同じ読みで、最後の1手でちょうど2連鎖になる
      // 撃ち方のうち、おじゃま min 個以上のものを候補に足す。単発と同じ種類(kind 'single')として扱うので、続ける余裕(keep)も同じく効く
      if (doubleOn){
        const FN = require('./finish_native.js');
        const r = both ? { pareto: both.pareto2 } : FN.finishSearch(Object.assign({}, me, { cost: 99 }), order, { maxPlace: opts.double.depth || 4, keep: 'double', keepFlags: doubleFlags });
        stats.double_calls = (stats.double_calls || 0) + 1;
        // double.amaRatio(v0.10.60、shio さんの案: 2連鎖に向かう1手目には多少の色を付け、最後は ama で比べる): 次の手番にまたがる2連鎖は、
        // 1手目の ama の点数(その先16手で組める一番大きい連鎖の点)が、ama の一番の手の点数の amaRatio 以上のときだけ候補にする(本線への損が小さいものだけ)
        const amaOf = (mv) => { const c = build && build.find(x => x.mv.col === mv.col && x.mv.rot === mv.rot); return c ? c.score : null; };
        const amaOk = (c) => { if (!opts.double.amaRatio || !build || !build.length || c.moves.length <= 1 || !(build[0].score > 0)) return true;
                               const s = amaOf(c.moves[0]); return s !== null && s >= opts.double.amaRatio * build[0].score; };
        // double.base(v0.10.66、shio さんの見立て「2連鎖ダブルが本線の土台を使っている」と、本家 ama の潰しの条件 ai.cpp classify_crush):
        // 撃ったあとの盤が base.remain 個以上(おじゃまも数える)・左3列が4段以上・右3列が3段以上・崩れ(gaze.cpp get_redundancy)が base.red 以下のものだけ候補にする
        const baseOk = (c) => !opts.double.base || keepsBase(me.board, order, (me.tsumoCount - 1 + CYCLE) % CYCLE, c.moves, opts.double.base);
        const ok = r.pareto.filter(c => c.ojama >= (opts.double.min || 12) && amaOk(c) && baseOk(c));
        if (ok.length){
          stats.double_found = (stats.double_found || 0) + 1;
          const most = ok.slice().sort((a, b) => b.ojama - a.ojama || a.moves.length - b.moves.length)[0];
          const fast = ok.slice().sort((a, b) => a.moves.length - b.moves.length || b.ojama - a.ojama)[0];
          const keepBest = opts.double.after ? ok.slice().sort((a, b) => b.keep - a.keep || b.ojama - a.ojama)[0] : null;   // 残る本線が一番大きいもの
          for (const c of new Set([most, fast, keepBest].filter(Boolean))) options.push({ kind: 'single', moves: c.moves, fire: c, double: true });
        }
      }
      // やり抜く(single.keep、v0.10.42。shio さんと決めた直し): 前の手で進むと決めた単発の手順の続きも候補に入れる(盤面が手順どおりのときだけ)。
      // 予告が来ていなければ、ほかの候補が続きより keep 以上良くないかぎり続ける(Infinity なら必ず続ける)。予告が来たら、ふつうに比べる
      let committed = null;
      if (singlePlan){
        // keep を指定しないとき(v0.10.41 の形)は続きを候補に入れない(前の結果と同じ打ち方のまま)
        if (opts.single && opts.single.keep !== undefined && singlePlan.idx < singlePlan.moves.length && boardKey(me.board) === singlePlan.expectKey){
          committed = { kind: 'single', moves: singlePlan.moves.slice(singlePlan.idx), fire: singlePlan.fire, committed: true };
          options.push(committed);
        }
        singlePlan = null;
      }
      let best = null;
      const replyCache = new Map();   // 相手の返しの撃ち方の読み(oppReply 2)。この1手のうちだけ使い回す
      for (const op of options){
        const m = Object.assign({}, me, { board: E.cloneBoard(me.board) });
        const o = Object.assign({}, opp, { board: E.cloneBoard(opp.board) });
        const t = X.playTurn(m, o, order, op.moves, true, { width: 30, buildWidth: 30 });
        if (op.kind === 'fire' && !(t.planDone && t.fired.length)) continue;   // 手番のうちに撃てなかった
        // 単発は、この手番のうちに撃てるならその局面、撃てない(次の手番にまたがる)なら手順の途中で手番が終わった局面で見積もる
        if (op.kind === 'single') op.inTurn = !!(t.planDone && t.fired.length);
        if (t.gameOver) op.p = (m.board[2][11] !== 0) ? 0 : 1;
        else op.p = 1 - V.predict(vnet, V.featuresFor(vnet, o, m));                    // 相手の手番の始まり。相手の勝率の裏が自分の勝率
        // 相手の返し(oppReply、v0.10.83。shio さんとの対局で見えた弱点: 高く積んだところへ、相手が手番のうちに撃てる一撃で締められた)。
        // 相手がその手番で撃てる一番大きい撃ち方を撃った場合もたどり、次の自分の手番の始まりで見積もる。相手は自分に得な方を選ぶので、低い方を取る
        // oppReply 2(v0.10.84): 一番大きい撃ち方だけでなく、置く数ごとの一番の撃ち方をすべてたどる(手数の安い一撃も見るため)
        if (opts.oppReply && !t.gameOver && o.cost > 0){
          // 2 は撃ったあとの局面も一緒にもらい、相手の撃ち方の読みは1手のうちで使い回す(v0.10.85。答えは同じで速い)
          const plans = opts.oppReply === 2 ? X.firePlans(o, m, order, false, { width: 30, buildWidth: 30 }, replyCache)
                                            : [X.bestFirePlan(o, m, order, false, { width: 30, buildWidth: 30 })].filter(Boolean).map(rp => {
                                                const o2 = Object.assign({}, o, { board: E.cloneBoard(o.board) }), m2 = Object.assign({}, m, { board: E.cloneBoard(m.board) });
                                                const t2 = X.playTurn(o2, m2, order, rp, false, { width: 30, buildWidth: 30 });
                                                return { actor: o2, other: m2, gameOver: t2.gameOver };
                                              });
          for (const r of plans){
            // おじゃまは受ける側の手番の終わりに降るので、相手の手番で終局するのは相手の窒息だけ
            const p2 = r.gameOver ? 1 : V.predict(vnet, V.featuresFor(vnet, r.other, r.actor));
            stats.opp_reply_read = (stats.opp_reply_read || 0) + 1;
            if (p2 < op.p){ if (!op.replied) stats.opp_reply_lower = (stats.opp_reply_lower || 0) + 1; op.pBefore = op.pBefore !== undefined ? op.pBefore : op.p; op.p = p2; op.replied = true; }
          }
        }
        if (!best || op.p > best.p) best = op;
      }
      // keep は数のほか、手数で変える表 [[何手目から, 余裕], …] も受ける(v0.10.44。shio さんの案: 序盤は速攻になるので色を付けない)。
      // 手数は2人の置いた数の合計(duel_net.js の記録の n と同じ数え方。今の1手は含めない)
      let keepMargin = opts.single && opts.single.keep !== undefined ? opts.single.keep : 0;
      if (Array.isArray(keepMargin)){
        const n = (me.tsumoCount || 0) + (opp.tsumoCount || 0) - 1;
        keepMargin = keepMargin.reduce((m, [from, v]) => n >= from ? v : m, 0);
      }
      if (committed && opts.double && opts.double.noKeep && committed.fire && committed.fire.chain === 2) keepMargin = 0;   // 2連鎖には続ける余裕を付けない(v0.10.56)
      if (committed && committed.p !== undefined && best && best !== committed && me.ojamaYokoku === 0 && best.p < committed.p + keepMargin){
        best = committed;
        stats.single_kept = (stats.single_kept || 0) + 1;   // 見積もりでは別の手が上だったが、続けた
      }
      // ノイズ(noise、v0.10.49。自己対戦で局面の幅を広げるため。shio さんと決めた): 自分の until 手目までは、prob の割合で、
      // 見積もりが一番から within 以内の候補の中から無作為に選ぶ。両側に同じだけ入れるので、勝ち負けの答えは公平なまま
      if (opts.noise && best && (me.tsumoCount || 0) <= opts.noise.until) stats.noise_seen = (stats.noise_seen || 0) + 1;
      if (opts.noise && best && (me.tsumoCount || 0) <= opts.noise.until && Math.random() < opts.noise.prob){
        stats.noise_try = (stats.noise_try || 0) + 1;
        // 組む手の候補はふつう ama の一番の手1つだけなので、当たったときだけ ama の2・3番目の手も同じように見積もって混ぜる
        // (ama の点数は一番の手が飛び抜けていることが多く、点数で近い手を探すとほとんど入らなかった)
        const pool = options.slice();
        if (build) for (let i = opts.buildTries; i < Math.min(3, build.length); i++){
          const op = { kind: 'build', moves: [build[i].mv], rank: i };
          const m = Object.assign({}, me, { board: E.cloneBoard(me.board) });
          const o = Object.assign({}, opp, { board: E.cloneBoard(opp.board) });
          const t = X.playTurn(m, o, order, op.moves, true, { width: 30, buildWidth: 30 });
          op.p = t.gameOver ? ((m.board[2][11] !== 0) ? 0 : 1) : 1 - V.predict(vnet, V.featuresFor(vnet, o, m));
          pool.push(op);
        }
        const near = pool.filter(op => op.p !== undefined && op.p >= best.p - opts.noise.within);
        const pick = near[Math.floor(Math.random() * near.length)];
        if (pick !== best){ best = pick; stats.noise = (stats.noise || 0) + 1; }
      }
      if (best){
        stats['value_' + best.kind] = (stats['value_' + best.kind] || 0) + 1;
        if (best.double) stats.value_double = (stats.value_double || 0) + 1;   // 2連鎖探しの手に進むと決めた(v0.10.54)
        if (best.finish) stats.finish_used = (stats.finish_used || 0) + 1;
        if (best.kind === 'build' && best.rank > 0) stats.build_other = (stats.build_other || 0) + 1;   // ama の一番の手でない組む手を選んだ
        if (choose.onValue) choose.onValue({ options, best, tsumoCount: me.tsumoCount, yokoku: me.ojamaYokoku });   // 考えの表示用(server.js)
        if (best.kind === 'build'){
          if (best.moves) return best.moves[0];
          const c = AMA(me.board, order, idx, { width: opts.amaWidth, depth: 16, noFire: true, w: amaWFor(me) });
          if (c.length) return c[0].mv;
          // 組む手が見つからない(窒息しかけ)ときは、下の決め方に任せる
        } else if (best.kind === 'single' && !best.inTurn){
          // 次の手番にまたがる単発: 1手目だけ置く。次の手からも毎手読み直し、進み続けるかを勝率の見積もりで決め直す
          // (続きは singlePlan に覚えておき、次の手の候補に入れる)
          if (best.moves.length > 1) singlePlan = { moves: best.moves, idx: 1, expectKey: afterMove(me.board, best.moves[0], piece), fire: best.fire };
          return best.moves[0];
        } else {
          if (best.kind === 'single') stats[best.fire && best.fire.chain === 2 ? 'double_fire' : 'single_fire'] = (stats[best.fire && best.fire.chain === 2 ? 'double_fire' : 'single_fire'] || 0) + 1;   // 2連鎖探しの手は double_fire に数える
          if (choose.onCounter) choose.onCounter({ fire: best.fire, kind: 'value', tsumoCount: me.tsumoCount });
          attack = { moves: best.moves, idx: 0, expectKey: boardKey(me.board) };
          return advance(me, piece);
        }
      }
    }

    // 予告への返し方を、やりとりの有利不利で選ぶ(respond、v0.10.16。shio さんの考え)。
    // 候補: 本線で返す(予告より多く撃てる一番早い撃ち方)/ 小さく返す(5連鎖までで予告を相殺できる一番早い撃ち方)/ 受ける(撃たずに組む)。
    // それぞれ自分の手番を実際の手数の計算でたどり、fukuhou.js の exchangeMargin(渡した手数 ÷ 2 を相手の本線の頭に足す基準)で比べる
    if (opts.respond && me.ojamaYokoku > 0 && me.cost > 0){
      const T = Math.min(16, Math.ceil(me.cost));
      const f = B.searchMaxFire(me.board, order, idx, { horizon: T, width: opts.counterWidth, point: me.point || 0 });
      const earliest = (xs) => xs.sort((a, b) => a.at - b.at || b.ojama - a.ojama).slice(0, opts.tries)
                                 .find(c => firesInTurn(me, opp, order, c.moves)) || null;
      const big = earliest(f.curve.filter(c => c && c.ojama > me.ojamaYokoku));
      const small = earliest(f.curve.filter(c => c && c.chain <= opts.smallMax && c.ojama >= me.ojamaYokoku));
      const options = [{ kind: 'receive', moves: null }];
      if (big) options.push({ kind: 'honsen', moves: big.moves, fire: big });
      if (small && (!big || small.moves !== big.moves)) options.push({ kind: 'small', moves: small.moves, fire: small });
      let best = null;
      for (const op of options){
        op.margin = F.exchangeMargin(me, opp, order, op.moves).margin;
        if (!best || op.margin > best.margin) best = op;
      }
      if (best && best.margin > -Infinity){
        stats['respond_' + best.kind] = (stats['respond_' + best.kind] || 0) + 1;
        if (best.kind === 'receive'){
          const c = AMA(me.board, order, idx, { width: opts.amaWidth, depth: 16, noFire: true, w: amaWFor(me) });
          if (c.length) return c[0].mv;
        } else {
          if (choose.onCounter) choose.onCounter({ fire: best.fire, kind: best.kind, tsumoCount: me.tsumoCount });
          attack = { moves: best.moves, idx: 0, expectKey: boardKey(me.board) };
          return advance(me, piece);
        }
      }
    }

    // 大きく撃ち返す: 大きな予告が来ている。悩む場面なので、候補を広く読む
    if (opts.counter && !opts.respond && me.ojamaYokoku >= opts.counterMin && me.cost > 0){
      const T = Math.min(16, Math.ceil(me.cost));
      const f = B.searchMaxFire(me.board, order, idx, { horizon: T, width: opts.counterWidth, point: me.point || 0 });
      // 予告より多く撃てるもののうち一番早いもの(同じ手目ならおじゃまが多いもの)。無ければ一番多いもの
      const ok = f.curve.filter(c => c && c.ojama > me.ojamaYokoku);
      const cands = (ok.length ? ok.sort((a, b) => a.at - b.at || b.ojama - a.ojama)
                               : f.curve.filter(Boolean).sort((a, b) => b.ojama - a.ojama)).slice(0, opts.tries);
      const pick = ok.length ? cands.find(c => firesInTurn(me, opp, order, c.moves)) : null;
      if (pick){
        stats.counters++;
        if (choose.onCounter) choose.onCounter({ fire: pick, tsumoCount: me.tsumoCount });   // 対戦の記録用(duel_net.js --record)
        attack = { moves: pick.moves, idx: 0, expectKey: boardKey(me.board) };
        return advance(me, piece);
      }
      stats.counterNone++;     // 予告より多く撃てる撃ち方が無い → 探索に任せる(相殺・受ける)
    }

    // 副砲で攻める: 予告が来ていないときだけ(予告への対応は探索に任せる)
    if (opts.fukuhou && me.ojamaYokoku === 0 && me.cost >= 1){
      const T = Math.ceil(me.cost);
      const f = B.searchMaxFire(me.board, order, idx, { horizon: Math.min(T, 8), width: opts.width, point: me.point || 0,
                                                       onFire: S.strongOnFire });
      const cands = f.curve.filter(Boolean).sort((a, b) => b.ojama - a.ojama).slice(0, opts.tries);
      for (const c of cands){
        stats.judged++;
        const j = F.judgeFukuhou(me, opp, order, c.moves);
        if (!j.ok){ stats.rejected++; continue; }
        stats.attacks++;
        if (choose.onAttack) choose.onAttack({ judge: j, fire: c, tsumoCount: me.tsumoCount });   // 切り分け用(analyze_fukuhou.js)
        attack = { moves: c.moves, idx: 0, expectKey: boardKey(me.board) };
        return advance(me, piece);
      }
    }
    if (opts.builder === 'ama'){
      // 撃つかどうかは今までどおり探索で決め(chooseMoveWithPlan と同じ判断)、組む手だけを ama 方式で毎手読み直して決める
      const searchMv = E.searchBestMove(me, opp, piece, order, WEIGHTS, opts.budget, opts.plies);
      if (!searchMv) return null;
      if (P.shouldFireNow(me, opp, piece, searchMv, WEIGHTS, opts.useModes)) return searchMv;
      const c = AMA(me.board, order, idx, { width: opts.amaWidth, depth: 16, noFire: true, w: amaWFor(me) });
      return c.length ? c[0].mv : searchMv;
    }
    return P.chooseMoveWithPlan(me, opp, piece, order, WEIGHTS, opts.budget, opts.plies, planState, opts.useModes);
  }
  function advance(me, piece){
    const mv = attack.moves[attack.idx++];
    const b2 = E.cloneBoard(me.board);
    E.simulateMove(b2, mv.col, mv.rot, piece.axis, piece.child);
    attack.expectKey = boardKey(b2);
    if (attack.idx >= attack.moves.length) attack = null;
    return mv;
  }
  choose.stats = stats;
  return choose;
}

module.exports = { makePlanChooser };
