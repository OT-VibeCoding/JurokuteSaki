// まとめた最新AI(dist/ai/puyo_ai.js)が、手本(web/record_ref.js で PC 版から作ったもの)と同じ手を打つかを比べる(v0.10.88)。
//
//   node web/test_web.js --exe native/finish.exe         // まとめた JS + PC の C++(まとめ方の確かめ)
//   node web/test_web.js --wasm dist/ai/finish_wasm.js   // まとめた JS + WebAssembly(ブラウザと同じ組み合わせ)
//
// puyo_ai.js は node の部品が無い入れ物(vm)の中で読むので、ブラウザで足りないものがあればここで止まる。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = { exe: '', wasm: '', dist: path.join(__dirname, '..', 'dist'), ref: path.join(__dirname, 'test', 'ref_games.json') };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];

async function finishQuery(){
  if (args.wasm){
    const M = await require(path.resolve(args.wasm))();
    return M.cwrap('finish_query', 'string', ['string']);
  }
  // PC の C++: ルールの行は native_bridge.js が自分で送るので、ここでは答えの無い R の行を渡さない
  process.env.FINISH_EXE = path.resolve(args.exe);
  const NB = require(path.join(__dirname, '..', 'native_bridge.js'));
  return (line) => line.startsWith('R ') ? '' : NB.call(line) + '\n';
}

(async () => {
  const ctx = vm.createContext({ console, performance });
  ctx.__finishQuery = await finishQuery();
  vm.runInContext(fs.readFileSync(path.join(args.dist, 'ai', 'puyo_ai.js'), 'utf8'), ctx, { filename: 'puyo_ai.js' });
  const AI = ctx.PuyoAI;
  const E = AI.require('engine.js');
  const { makePlanChooser } = AI.require('strategy.js');
  const config = AI.require('web/tri_config.js')('value.json');
  const ref = JSON.parse(fs.readFileSync(args.ref, 'utf8'));
  let bad = 0;
  for (const g of ref.games){
    const ch = [makePlanChooser(config), makePlanChooser(config)];
    const order = E.generateTsumoOrder(g.seed);
    const P = [E.newSimPlayer(E.ONE_P_BONUS), E.newSimPlayer(0)];
    let active = 0, current = E.simDealTsumoOrder(P[0], order), same = 0;
    const t0 = Date.now();
    for (; same < g.moves.length; same++){
      const mv = ch[active](P[active], P[1 - active], current, order);
      if (!mv || mv.col * 4 + mv.rot !== g.moves[same]) break;
      const out = E.applyEconomics(P[active], P[1 - active], E.simulateMove(P[active].board, mv.col, mv.rot, current.axis, current.child));
      if (out.gameOver) { same++; break; }
      if (out.turnSwitched) active = 1 - active;
      current = E.simDealTsumoOrder(P[active], order);
    }
    const ok = same === g.moves.length;
    if (!ok) bad++;
    console.log(`シード${g.seed}: ${ok ? '同じ' : `${same + 1}手目で違う`}(${same}/${g.moves.length}手、${((Date.now() - t0) / Math.max(1, same)).toFixed(0)}ms/手)`);
  }
  const sum = bad ? `NG: ${ref.games.length}局中 ${bad}局が違う` : `OK: ${ref.games.length}局すべて同じ手`;
  console.log(sum);
  if (bad && process.env.GITHUB_ACTIONS) console.log(`::error::${sum}`);   // 注記はログインしなくても読める
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error(e);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::止まった: ${String(e && e.stack || e).replace(/\n/g, '%0A')}`);
  process.exit(1);
});
