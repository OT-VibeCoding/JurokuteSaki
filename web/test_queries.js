// C++ の読みが手本(web/record_ref.js で finish.exe から作ったもの)と同じ答えを返すかを比べる(v0.10.88)。
//
//   node web/test_queries.js --exe native/finish_dev.exe      // PC 版
//   node web/test_queries.js --wasm dist/ai/finish_wasm.js    // ブラウザ版(WebAssembly)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = { exe: '', wasm: '', ref: path.join(__dirname, 'test', 'ref_queries.txt') };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];

const lines = fs.readFileSync(args.ref, 'utf8').split('\n').filter(l => l.length);
const rules = lines[0], qs = [], want = [];
for (let i = 1; i + 1 < lines.length; i += 2){ qs.push(lines[i]); want.push(lines[i + 1]); }

async function answers(){
  if (args.exe){
    const r = spawnSync(path.resolve(args.exe), [], { input: [rules].concat(qs, ['E']).join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
    if (r.status !== 0) throw new Error(`失敗: ${r.stderr || r.error}`);
    return r.stdout.split('\n').filter(l => l.length);
  }
  const create = require(path.resolve(args.wasm));
  const M = await create();
  const q = M.cwrap('finish_query', 'string', ['string']);
  q(rules);
  return qs.map(l => q(l).replace(/\n$/, ''));
}

answers().then((got) => {
  let bad = 0;
  for (let i = 0; i < want.length; i++){
    if (got[i] !== want[i]){
      if (bad < 3) console.log(`違う ${i + 1}番目: ${qs[i].slice(0, 60)}…\n  手本 ${want[i].slice(0, 120)}\n  答え ${String(got[i]).slice(0, 120)}`);
      bad++;
    }
  }
  if (got.length !== want.length) console.log(`答えの数が違う: 手本 ${want.length} / 答え ${got.length}`);
  console.log(bad || got.length !== want.length ? `NG: ${want.length}個中 ${bad}個が違う` : `OK: ${want.length}個すべて同じ答え`);
  process.exit(bad || got.length !== want.length ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
