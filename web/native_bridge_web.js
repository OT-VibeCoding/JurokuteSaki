// ブラウザ版の native_bridge.js(v0.10.88)。web/build_web.js がまとめるとき、native_bridge.js の代わりにこれを入れる。
// finish.exe の代わりに、WebAssembly にした C++(native/finish_wasm.cpp の finish_query)へ1行渡して答えの1行を受け取る。
// finish_query は ai_worker.js が globalThis.__finishQuery に置く。
// まとめたあとは ml の直下(native_bridge.js と同じ場所)にあるものとして読まれるので、require は './engine.js' と書く。
let opened = false;

function call(line){
  const q = globalThis.__finishQuery;
  if (!q) throw new Error('WebAssembly の読みがまだ用意できていません');
  if (!opened){
    // ルールの数(R の行)は最初に1回だけ送る(native_bridge.js と同じ)
    const E = require('./engine.js');
    const R = E.RULES;
    const list = (a) => `${a.length} ${a.join(' ')}`;
    q(`R ${E.WIDTH} ${E.HEIGHT} ${E.CONNECT_TOP} ${R.gameoverX} ${R.gameoverY} ${R.ojamaColor} ${E.OJAMA_RATE} ${R.dropBonus} ` +
      `${Math.round(R.rensaTezon * 2)} ${Math.round(R.chigiriTezon * 2)} ${list(R.rensaB)} ${list(R.renketsuB)} ${list(R.irokazuB)}`);
    opened = true;
  }
  return q(line).replace(/\n$/, '');
}

module.exports = { call };
