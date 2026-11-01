// ブラウザ版の最新AIの係(Web Worker、v0.10.88)。画面とは別に動くので、考えている間も画面は止まらない。
// index.html から { id, body } を受け取り、server.js の /ai/move と同じ形の body で手を決めて { id, move, ms } を返す。
importScripts('finish_wasm.js', 'puyo_ai.js');

const ready = createFinish().then((M) => {
  globalThis.__finishQuery = M.cwrap('finish_query', 'string', ['string']);
});

// strategy.js の指し方は撃っている途中の手順などを手をまたいで覚えるので、対戦ごと・プレイヤーごとに作る(server.js と同じ)
const choosers = new Map();
function getChooser(matchId, player){
  const k = `${matchId}:${player}`;
  if (!choosers.has(k)){
    if (choosers.size > 32) choosers.clear();
    const { makePlanChooser } = PuyoAI.require('strategy.js');
    choosers.set(k, makePlanChooser(PuyoAI.require('web/tri_config.js')('value.json')));
  }
  return choosers.get(k);
}

// 画面から届いた状態を、engine.js が扱える形に直す(server.js の toSim と同じ)
function toSim(o){
  return { board: o.board.map(col => col.slice()), cost: o.cost, point: o.point || 0,
           totalPoint: o.totalPoint || 0, ojamaYokoku: o.ojamaYokoku,
           ojamaIchi: o.ojamaIchi, tsumoCount: o.tsumoCount };
}

onmessage = async (e) => {
  const { id, body } = e.data;
  try {
    await ready;
    const t0 = performance.now();
    const mv = getChooser(body.matchId, body.player)(toSim(body.me), toSim(body.opp), body.piece, body.order);
    postMessage({ id, move: mv ? { col: mv.col, rot: mv.rot } : null, ms: Math.round(performance.now() - t0) });
  } catch (err){
    postMessage({ id, error: String(err && err.message || err) });
  }
};
