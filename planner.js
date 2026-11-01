// 新AI: v3r(新ルール)の上に、大連鎖の組み立て計画(ビームサーチ)を載せたもの。
// index.html に実装したものと同じロジックをヘッドレスで動かすためのラッパー。
const E = require('./engine.js');
const W_ = E.WIDTH, H_ = E.HEIGHT, CT = E.CONNECT_TOP;

const PLAN_HORIZON = 16, PLAN_WIDTH = 100;
const BUILD_TARGET_CHAIN = +(process.env.BTC || 14), BUILD_MIN_SPACE = 10;

function boardKey(b){ let s=''; for (let x=0;x<W_;x++) for (let y=0;y<H_;y++) s+=b[x][y]; return s; }

function maxChainRensasu(board){
  let best = 0;
  for (const ig of E.findIgnitions(board)){
    const b2 = E.cloneBoard(board);
    b2[ig.col][ig.row] = ig.color;
    const { rensasu } = E.simulateResolveChains(b2);
    if (rensasu > best) best = rensasu;
  }
  return best;
}
function buildShapeScore(board){
  let pairs=0, holes=0, bump=0, maxH=0;
  const hs = new Array(W_).fill(0);
  for (let x=0;x<W_;x++){
    let seen=false;
    for (let y=H_-1;y>=0;y--){
      if (board[x][y]!==0){ if(!seen){ hs[x]=y+1; seen=true; } } else if (seen) holes++;
    }
    if (hs[x]>maxH) maxH=hs[x];
  }
  for (let x=0;x<W_;x++) for (let y=0;y<CT;y++){
    const c=board[x][y];
    if (!c || c===5) continue;
    if (x+1<W_ && board[x+1][y]===c) pairs++;
    if (y+1<CT && board[x][y+1]===c) pairs++;
  }
  for (let x=0;x<W_-1;x++) bump += Math.abs(hs[x]-hs[x+1]);
  return pairs*4 - holes*25 - bump*2 - Math.max(0,maxH-12)*40;
}
function planBuild(board, order, tsumoIndex, horizon, width){
  let beam = [{ board, moves: [] }];
  for (let i=0;i<horizon;i++){
    const pat = E.TSUMO_PATTERNS[order[(tsumoIndex+i)%E.RULES.tsumoCycle]];
    const cand=[], seen=new Set();
    for (const st of beam){
      for (const mv of E.enumerateLegalMoves(st.board)){
        const b2 = E.cloneBoard(st.board);
        const res = E.simulateMove(b2, mv.col, mv.rot, pat.axis, pat.child);
        if (!res.dropped || res.rensasu > 0) continue;
        if (b2[E.RULES.gameoverX][E.RULES.gameoverY] !== 0) continue;
        const k = boardKey(b2);
        if (seen.has(k)) continue;
        seen.add(k);
        const chain = maxChainRensasu(b2);
        cand.push({ board:b2, moves: st.moves.concat([mv]), chain,
                    s: chain*(60+10*(tsumoIndex+i)) + buildShapeScore(b2) });
      }
    }
    if (!cand.length) break;
    cand.sort((a,b)=>b.s-a.s);
    const perChain=new Map(), picked=[];
    const cap = Math.max(3, Math.ceil(width/3));
    for (const st of cand){
      const n = perChain.get(st.chain)||0;
      if (n>=cap) continue;
      perChain.set(st.chain, n+1);
      picked.push(st);
      if (picked.length>=width) break;
    }
    beam = picked;
  }
  return beam[0] ? beam[0].moves : [];
}
// ==== 相手の状態を見てモードを切り替える ====
// BUILD : 相手に火力が無い(撃った直後など)安全な時間帯 → 大連鎖を伸ばす
// TRADE : 相手が大火力を抱えている → 副砲で削りつつ受けを保つ
// DEFEND: おじゃまが飛んできている → 受ける(探索の判断に任せる)
// ENDGAME: 双方の置き場所が少ない → 小連鎖の交換より大連鎖が決め手になる
const ENDGAME_SPACE = +(process.env.EGS || 26);
const SAFE_OPP_OJAMA = +(process.env.SOO || 12);
const SAFE_TARGET_CHAIN = +(process.env.STC || 17);
const TRADE_TARGET_CHAIN = +(process.env.TTC || 11);

function countSpace(board){
  let n = 0;
  for (let x=0;x<W_;x++) for (let y=0;y<H_;y++) if (board[x][y]===0) n++;
  return n;
}
function decideMode(me, opp, W){
  const mySpace = countSpace(me.board), oppSpace = countSpace(opp.board);
  if (me.ojamaYokoku > 0) return 'DEFEND';
  if (mySpace <= ENDGAME_SPACE || oppSpace <= ENDGAME_SPACE) return 'ENDGAME';
  const op = E.analyzeBoard(opp.board, W);
  if (op.honsen.ojama < SAFE_OPP_OJAMA) return 'BUILD';
  return 'TRADE';
}
function shouldFireNow(me, opp, piece, mv, W, useModes){
  const b2 = E.cloneBoard(me.board);
  const res = E.simulateMove(b2, mv.col, mv.rot, piece.axis, piece.child);
  if (!res.dropped || res.rensasu === 0) return false;
  const space = countSpace(me.board);
  // useModes===3: しきい値を使わず、発火するかどうかは対戦用探索の判断に完全に委ねる
  if (useModes === 3) return true;
  if (!useModes || useModes === 1){ // 旧方式(Version 13相当)
    if (me.ojamaYokoku > 0) return true;
    if (res.rensasu >= BUILD_TARGET_CHAIN) return true;
    if (space <= BUILD_MIN_SPACE) return true;
    if (maxChainRensasu(opp.board) >= BUILD_TARGET_CHAIN) return true;
    return false;
  }
  const mode = decideMode(me, opp, W);
  if (mode === 'DEFEND') return true;
  if (space <= BUILD_MIN_SPACE) return true;
  const ojama = res.totalPoint / E.OJAMA_RATE;
  if (mode === 'ENDGAME'){
    // 相手を倒しきれる火力なら撃つ。届かないなら積み増して大連鎖を狙う。
    return ojama >= countSpace(opp.board) * 0.8;
  }
  const target = (mode === 'BUILD') ? SAFE_TARGET_CHAIN : TRADE_TARGET_CHAIN;
  if (res.rensasu >= target) return true;
  if (mode === 'TRADE'){
    // 相手に受けが無い副砲は通るので撃つ価値が高い(手数で損をしない範囲で)
    const op = E.analyzeBoard(opp.board, W);
    if (!E.canAnswer(op, ojama, Math.max(opp.cost, 1)) && res.rensasu <= 4) return true;
  }
  return false;
}
function nextPlanMove(me, state){
  const plan = state.plan;
  if (!plan) return null;
  if (plan.idx >= plan.moves.length || boardKey(me.board) !== plan.expectedKey){ state.plan = null; return null; }
  const mv = plan.moves[plan.idx];
  const b2 = E.cloneBoard(me.board);
  const t = E.placePiece(b2, mv.col, mv.rot, 1, 1);
  if (!t.dropped){ state.plan = null; return null; }
  return mv;
}
function advancePlan(me, state, mv, piece){
  const plan = state.plan;
  if (!plan) return;
  const b2 = E.cloneBoard(me.board);
  E.placePiece(b2, mv.col, mv.rot, piece.axis, piece.child);
  plan.expectedKey = boardKey(b2);
  plan.idx++;
}
// index.html の maybeTriggerAI と同じ判断順序
function chooseMoveWithPlan(me, opp, piece, order, W, tb, plies, state, useModes){
  const searchMv = E.searchBestMove(me, opp, piece, order, W, tb, plies);
  if (!searchMv) return null;
  if (shouldFireNow(me, opp, piece, searchMv, W, useModes)){ state.plan = null; return searchMv; }
  let mv = nextPlanMove(me, state);
  if (!mv){
    const startIndex = (me.tsumoCount - 1 + E.RULES.tsumoCycle) % E.RULES.tsumoCycle;
    const moves = planBuild(E.cloneBoard(me.board), order, startIndex, PLAN_HORIZON, PLAN_WIDTH);
    state.plan = moves.length ? { moves, idx: 0, expectedKey: boardKey(me.board) } : null;
    mv = nextPlanMove(me, state);
  }
  if (!mv) return searchMv;
  advancePlan(me, state, mv, piece);
  return mv;
}
module.exports = { chooseMoveWithPlan, maxChainRensasu, planBuild, decideMode, buildShapeScore, shouldFireNow };
