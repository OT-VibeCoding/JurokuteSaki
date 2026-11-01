// C++ のプログラム(native/finish.exe)を開いたままにして、1行の問い合わせに1行の答えを「待って」受け取る(v0.10.36)。
//
//   const NB = require('./native_bridge.js');
//   const line = NB.call('M ...');      // 答えの1行(文字列)
//
// なぜ: 1回ごとにプログラムを起こすと、それだけで 40ms ほどかかる(本線を組む読みは毎手呼ぶので、これが重い)。
// しくみ: 小さな手伝いの糸(worker)がプログラムとやりとりし、呼んだ側は共有の記憶(SharedArrayBuffer)を Atomics.wait で待つ。
//   自己対戦の各作業者(worker)の中からも使える(作業者ごとに1つずつ開く)。node が終わると入力が閉じて、プログラムも自分で終わる。
// ルールの数(R の行)は最初に1回だけ送る。使うプログラムは FINISH_EXE(既定 native/finish.exe)。
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const CAP = 1 << 22;   // 答えの1行の最大(4MB)

if (!isMainThread && workerData && workerData.nativeBridge){
  // 手伝いの糸: プログラムを起こし、届いた問い合わせを書き、答えの行を共有の記憶に入れて知らせる
  const { spawn } = require('child_process');
  const ctl = new Int32Array(workerData.sab, 0, 2), buf = new Uint8Array(workerData.sab, 8);
  const child = spawn(workerData.exe, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  child.stdin.write(workerData.rules + '\n');
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    pending += d;
    let i;
    while ((i = pending.indexOf('\n')) >= 0){
      const line = pending.slice(0, i); pending = pending.slice(i + 1);
      const bytes = Buffer.from(line, 'utf8');
      const n = Math.min(bytes.length, CAP);
      buf.set(bytes.subarray(0, n));
      Atomics.store(ctl, 1, n);
      Atomics.store(ctl, 0, 1);
      Atomics.notify(ctl, 0);
    }
  });
  child.on('exit', (code) => { Atomics.store(ctl, 1, -1); Atomics.store(ctl, 0, 1); Atomics.notify(ctl, 0); });
  parentPort.on('message', (line) => { child.stdin.write(line + '\n'); });
} else {
  let bridge = null;
  function open(){
    const E = require('./engine.js');
    const R = E.RULES;
    const list = (a) => `${a.length} ${a.join(' ')}`;
    const rules = `R ${E.WIDTH} ${E.HEIGHT} ${E.CONNECT_TOP} ${R.gameoverX} ${R.gameoverY} ${R.ojamaColor} ${E.OJAMA_RATE} ${R.dropBonus} ` +
                  `${Math.round(R.rensaTezon * 2)} ${Math.round(R.chigiriTezon * 2)} ${list(R.rensaB)} ${list(R.renketsuB)} ${list(R.irokazuB)}`;
    const exe = process.env.FINISH_EXE ? path.resolve(process.env.FINISH_EXE) : path.join(__dirname, 'native', 'finish.exe');
    const sab = new SharedArrayBuffer(8 + CAP);
    const w = new Worker(__filename, { workerData: { nativeBridge: true, exe, rules, sab } });
    w.unref();
    bridge = { w, ctl: new Int32Array(sab, 0, 2), buf: new Uint8Array(sab, 8) };
  }
  // 1行送って、答えの1行を返す(答えが来るまで待つ)
  function call(line){
    if (!bridge) open();
    const { w, ctl, buf } = bridge;
    Atomics.store(ctl, 0, 0);
    w.postMessage(line);
    Atomics.wait(ctl, 0, 0);
    const n = Atomics.load(ctl, 1);
    if (n < 0){ bridge = null; throw new Error('finish.exe が止まりました'); }
    return Buffer.from(buf.subarray(0, n)).toString('utf8');
  }
  module.exports = { call };
}
