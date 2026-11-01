// 勝率の見積もり(作業記録 第38期〜)。局面を数字の並び(特徴)にする部分と、学習した小さなネットで勝率を出す部分。
//
//   const V = require('./value.js');
//   const f = V.features(me, opp);        // me = いま手番の側。状況表(situation.js)から作る
//   const v = V.load('runs/tri/r0/value.json');
//   const p = V.predict(v, f);           // me が勝つ確率(0〜1)
//
// 特徴は、人がまず数える量(状況表)をそのまま使う。盤面のマスは入れない(少ない対局数でも丸暗記しにくくするため)。
// おじゃまの数のように大きく振れる値は log(1+x) にして渡す。
const fs = require('fs');
const S = require('./situation.js');

// 特徴の版。1 = 59個(第38期)、2 = 1 に「色ぷよの数・盤面のおじゃまの数」とその差を足した65個(v0.10.26。shio さんの「ぷよ量」の考え)。
// 学習した重みには版が書いてあり、featuresFor でその版の特徴を作るので、古い重みもそのまま使える
const FEATURE_VERSION = 2;
const lg = (x) => Math.log1p(Math.max(0, x));

function sideFeatures(x){
  return [
    x.cost, lg(x.yokoku), lg(x.nextDrop), x.space / 78, x.col3Margin / 11, Math.min(x.ojamaToDie, 78) / 78,
    x.fireNow.chain, lg(x.fireNow.ojama), x.fireNow.tezon, x.maxChainNow,
    x.fukuhou.chain, lg(x.fukuhou.ojama), x.fukuhou.eff,
    x.potential.chain, lg(x.potential.ojama), x.potential.need, x.potential.height / 12, x.potential.chi,
    x.fill,
  ].concat(x.heights.map(h => h / 13));
}
const SIDE_NAMES = ['手数', '予告', '次に降る量', '空き', '3列目の余裕', '何個で負け',
  '今撃てる連鎖', '今撃てるおじゃま', '今撃つ手数', '一番長い連鎖', '副砲の連鎖', '副砲のおじゃま', '副砲の効率',
  '伸びしろの連鎖', '伸びしろのおじゃま', 'あと何個', '発火点の高さ', '発火点の広がり', '埋まり具合',
  '列1の高さ', '列2の高さ', '列3の高さ', '列4の高さ', '列5の高さ', '列6の高さ'];

// 盤面(13段すべて)の色ぷよの数と、おじゃまの数
function puyoCounts(board){
  let c = 0, g = 0;
  for (const col of board) for (const v of col){ if (v === 5) g++; else if (v) c++; }
  return [c, g];
}

// 局面 → 特徴(自分の分・相手の分・関係)。ver を省くと今の版
function features(me, opp, ver){
  ver = ver || FEATURE_VERSION;
  const s = S.analyzeSituation(me, opp);
  const r = s.rel;
  const base = sideFeatures(s.me).concat(sideFeatures(s.opp), [
    r.canOffsetMyYokoku ? 1 : 0, r.canCounterOppFire ? 1 : 0, r.canCounterOppFukuhou ? 1 : 0,
    r.oppCanOffsetTheirYokoku ? 1 : 0, r.oppCanCounterMyFire ? 1 : 0, r.oppCanCounterMyFukuhou ? 1 : 0,
    Math.sign(r.fireGap) * lg(Math.abs(r.fireGap)), r.potentialChainGap, r.endgame ? 1 : 0,
  ]);
  if (ver === 1) return base;
  const [mc, mg] = puyoCounts(me.board), [oc, og] = puyoCounts(opp.board);
  return base.concat([mc / 78, mg / 78, oc / 78, og / 78, (mc - oc) / 78, (mg - og) / 78]);
}
// 重み v に合わせた版の特徴
const featuresFor = (v, me, opp) => features(me, opp, v.featureVersion);
const FEATURE_NAMES = SIDE_NAMES.map(n => '自分の' + n).concat(SIDE_NAMES.map(n => '相手の' + n),
  ['自分の予告を消せる', '相手の最大に撃ち返せる', '相手の副砲に撃ち返せる', '相手は予告を消せる', '相手は自分の最大に撃ち返せる',
   '相手は自分の副砲に撃ち返せる', '火力の差', '伸びしろの差', '終盤',
   '自分の色ぷよの数', '自分の盤面のおじゃま', '相手の色ぷよの数', '相手の盤面のおじゃま', '色ぷよの数の差', 'おじゃまの数の差']);

// 学習した重み(train_value.py が書く JSON)を読む
function load(file){
  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!(v.featureVersion >= 1 && v.featureVersion <= FEATURE_VERSION)) throw new Error(`知らない特徴の版です(重み ${v.featureVersion} / 今 ${FEATURE_VERSION})`);
  return v;
}
// 勝つ確率。ネットの形: 標準化 → 全結合(ReLU)を何層か → 1つの出力 → シグモイド
function predict(v, f){
  let h = f.map((x, i) => (x - v.mean[i]) / v.std[i]);
  for (let L = 0; L < v.layers.length; L++){
    const { W, b } = v.layers[L];
    const out = new Array(b.length);
    for (let j = 0; j < b.length; j++){
      let s = b[j];
      const row = W[j];
      for (let i = 0; i < h.length; i++) s += row[i] * h[i];
      out[j] = (L < v.layers.length - 1) ? Math.max(0, s) : s;
    }
    h = out;
  }
  return 1 / (1 + Math.exp(-h[0]));
}

module.exports = { features, featuresFor, FEATURE_NAMES, FEATURE_VERSION, load, predict, puyoCounts };
