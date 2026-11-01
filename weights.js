// v2(公開中)の重み
const V2 = {
  chainPot2: 2.643, chainPot3: 8.454, heightPenalty: 0.827, bumpPenalty: 1.395,
  holePenalty: 6.061, dangerPenalty: 17.082, chainPotentialWeight: 1.389,
  fireUrgencyMul: 1.032, fireMinWeight: 0.09, firePointMul: 3.712,
  fireRensaSqMul: 49.494, leafOjamaMul: 2.173,
};
// v3の初期値: 形の重みはv2を引き継ぎ、火力まわりを効率ベースに置き換え、本線/副砲/対応力を追加
const V3 = {
  chainPot2: 2.643, chainPot3: 8.454, heightPenalty: 0.827, bumpPenalty: 1.395,
  holePenalty: 6.061, dangerPenalty: 17.082, chainPotentialWeight: 1.389,
  leafOjamaMul: 2.173,
  fireFullOjama: 20, fireOjamaMul: 40, fireEffMul: 60,
  fireUrgencyMul: 1.032, fireMinWeight: 0.09,
  honsenDiff: 2.0, fukuhouDiff: 3.0, noAnswerPenalty: 15,
  unansweredBonus: 12, behindFukuhouMul: 3.0, fukuhouKeep: 0.8,
};
module.exports = V3; // 現在ゲームに載っている評価の重み
