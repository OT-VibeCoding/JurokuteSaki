// ブラウザ版の確かめ用の手本を作る(v0.10.88。PC の finish.exe で打つ)。
//
//   node web/record_ref.js --games 3 --out web/test
//
// 書くもの:
//   ref_queries.txt  C++ への問い合わせと答え(1行目はルールの行。あとは「問い合わせ」「答え」の2行ずつ)
//   ref_games.json   対局ごとのシードと、打った手(列×4+向き)
// ブラウザ版(WebAssembly とまとめた JS)が同じ答え・同じ手を返すかを web/test_web.js で比べる。
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'engine.js'));
const NB = require(path.join(ROOT, 'native_bridge.js'));
const { makePlanChooser } = require(path.join(ROOT, 'strategy.js'));
const triConfig = require('./tri_config.js');

const args = { games: 3, out: path.join(__dirname, 'test'), seed: 777001, maxPlacements: 600 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2){ const k = argv[i].replace(/^--/, ''); args[k] = typeof args[k] === 'number' ? Number(argv[i + 1]) : argv[i + 1]; }

// 問い合わせと答えを横で写す
const log = [];
const call0 = NB.call;
NB.call = (line) => { const a = call0(line); log.push(line, a); return a; };

const R = E.RULES, list = (a) => `${a.length} ${a.join(' ')}`;
const rules = `R ${E.WIDTH} ${E.HEIGHT} ${E.CONNECT_TOP} ${R.gameoverX} ${R.gameoverY} ${R.ojamaColor} ${E.OJAMA_RATE} ${R.dropBonus} ` +
              `${Math.round(R.rensaTezon * 2)} ${Math.round(R.chigiriTezon * 2)} ${list(R.rensaB)} ${list(R.renketsuB)} ${list(R.irokazuB)}`;

const games = [];
for (let g = 0; g < args.games; g++){
  const seed = args.seed + g;
  const value = path.join(ROOT, 'runs', 'tri', 'r14_td', 'value.json');
  const ch = [makePlanChooser(triConfig(value)), makePlanChooser(triConfig(value))];
  const order = E.generateTsumoOrder(seed);
  const P = [E.newSimPlayer(E.ONE_P_BONUS), E.newSimPlayer(0)];
  let active = 0, winner = null;
  let current = E.simDealTsumoOrder(P[0], order);
  const moves = [];
  const t0 = Date.now();
  while (moves.length < args.maxPlacements){
    const me = P[active], opp = P[1 - active];
    const mv = ch[active](me, opp, current, order);
    if (!mv){ winner = 1 - active; break; }
    moves.push(mv.col * 4 + mv.rot);
    const res = E.simulateMove(me.board, mv.col, mv.rot, current.axis, current.child);
    const out = E.applyEconomics(me, opp, res);
    if (out.gameOver){ winner = 1 - active; break; }
    if (out.turnSwitched) active = 1 - active;
    current = E.simDealTsumoOrder(P[active], order);
  }
  games.push({ seed, winner, moves });
  console.log(`対局${g + 1}: シード${seed} ${moves.length}手 勝ち${winner === null ? 'なし' : winner + 1 + 'P'} ${((Date.now() - t0) / moves.length).toFixed(0)}ms/手 問い合わせ累計${log.length / 2}`);
}

fs.mkdirSync(args.out, { recursive: true });
fs.writeFileSync(path.join(args.out, 'ref_queries.txt'), [rules].concat(log).join('\n') + '\n');
fs.writeFileSync(path.join(args.out, 'ref_games.json'), JSON.stringify({ config: 'tri_config.js', value: 'runs/tri/r14_td/value.json', games }) + '\n');
console.log(`書きました: ${args.out}`);
