// C++ の読みが手本(web/record_ref.js で PC の C++ から作ったもの)と同じ答えを返すかを比べる(v0.10.88)。
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

// GitHub Actions では、違いを注記(::error::)にも書く(記録の本文はログインしないと読めないが、注記は読めるため)
const GHA = !!process.env.GITHUB_ACTIONS;
const note = (s) => GHA && console.log(`::error::${s.replace(/\n/g, '%0A')}`);

answers().then((got) => {
  let bad = 0;
  const kinds = {};
  for (let i = 0; i < want.length; i++){
    if (got[i] !== want[i]){
      const msg = `違う ${i + 1}番目: ${qs[i].slice(0, 60)}…\n  手本 ${want[i].slice(0, 200)}\n  答え ${String(got[i]).slice(0, 200)}`;
      if (bad < 3){ console.log(msg); note(msg); }
      kinds[qs[i][0]] = (kinds[qs[i][0]] || 0) + 1;
      bad++;
    }
  }
  if (got.length !== want.length) console.log(`答えの数が違う: 手本 ${want.length} / 答え ${got.length}`);
  const sum = bad || got.length !== want.length ? `NG(${args.exe || args.wasm}): ${want.length}個中 ${bad}個が違う(問い合わせの種類ごと ${JSON.stringify(kinds)})` : `OK: ${want.length}個すべて同じ答え`;
  console.log(sum);
  if (bad || got.length !== want.length) note(sum);
  process.exit(bad || got.length !== want.length ? 1 : 0);
}).catch((e) => { console.error(e); note(`止まった(${args.exe || args.wasm}): ${e && e.stack || e}`); process.exit(1); });
