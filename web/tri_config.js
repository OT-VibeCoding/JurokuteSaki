// ブラウザ版の最新AI(tri)の設定(v0.10.88)。server.js の tri と同じ(v0.10.86 の対戦サーバーと同じ強さ):
//   --finish 3 --single 4 --singlesched '30:0.03,40:0.06' --nativeama 1 --tearmul 0.12 --tearyokoku 60 --oppreply 2
// server.js を変えたら、ここも同じにする。
module.exports = (valuePath) => ({
  value: valuePath, builder: 'ama', budget: 200, nativeAma: true,
  finish: { maxPlace: 8, beam: 60, tail: 4, mode: 'honsen' },
  single: { depth: 4, min: 10, keep: [[30, 0.03], [40, 0.06]] },
  amaW: { tearMul: 0.12 }, tearYokoku: 60, oppReply: 2,
});
