// ヘッドレス自己対戦トレーニングハーネス(ブラウザ非依存・Node.js単体で動く)。
// index.html中の純粋なゲームロジック(盤面計算・アルファベータ探索)を複製し、
// 評価関数の重み(WEIGHTS)を外部から差し替えられるようにして、山登り法で
// 「勝率の高い重み」を探索する。commitDrop/finishTurn/renderAll等のDOM依存部分は使わない。

// ==== ゲームルール(設定として差し替え可能) ====
// ルールの定数はすべてこの1か所に集約してある。環境変数 PUYO_RULES にJSONファイルの
// パスを渡すと、その内容で上書きできる。マージンルールの検証など「ルールを変えて
// 学習し直して測る」作業を、コードを触らずに行えるようにするための仕組み。
const fs_ = require('fs');
const DEFAULT_RULES = {
  width: 6, height: 13,          // 盤面の大きさ
  gameoverX: 2, gameoverY: 11,   // 窒息判定のマス
  connectTopOffset: 1,           // 上から何段を「連結しない段」とするか(1 = 13段目のみ)
  ojamaColor: 5,
  maxOjamaDrop: 30,              // 1度に降るおじゃまの上限
  ojamaRate: 70,                 // おじゃま1個あたりの得点(小さいほど火力が高い)
  onePBonus: 0.5,                // 1Pの先手ボーナス
  rensaTezon: 1.5,               // 連鎖1つあたりに払う手数
  chigiriTezon: 0.5,             // ちぎりで払う手数
  ojamaTezon: 1.0,               // おじゃまを受けた側の相手に入る手数
  dropBonus: 10,                 // 1手置くごとの得点
  ojamaOrder: [0,3,2,4,1,5],     // おじゃまが降る列の順番
  tsumoCycle: 16,                // ツモ周期
  rensaB: [0,0,8,16,32,64,96,128,160,192,224,256,288,320,352,384,416,448,480,512],
  renketsuB: [0,0,0,0,0,2,3,4,5,6,7,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10],
  irokazuB: [0,0,3,6,12,24],
};
function loadRules(){
  const p = process.env.PUYO_RULES;
  if (!p) return { ...DEFAULT_RULES };
  return Object.assign({}, DEFAULT_RULES, JSON.parse(fs_.readFileSync(p, 'utf8')));
}
const RULES = loadRules();

const WIDTH = RULES.width, HEIGHT = RULES.height;
const GAMEOVER_X = RULES.gameoverX, GAMEOVER_Y = RULES.gameoverY;
const OJAMA_COLOR = RULES.ojamaColor;
const MAX_OJAMA_DROP = RULES.maxOjamaDrop;
const OJAMA_RATE = RULES.ojamaRate;
const ONE_P_BONUS = RULES.onePBonus, RENSA_TEZON = RULES.rensaTezon;
const CHIGIRI_TEZON = RULES.chigiriTezon, OJAMA_TEZON = RULES.ojamaTezon, DROP_BONUS = RULES.dropBonus;
const OJAMA_ORDER = RULES.ojamaOrder;
const CYCLE = RULES.tsumoCycle;
const RENSA_B = RULES.rensaB, RENKETSU_B = RULES.renketsuB, IROKAZU_B = RULES.irokazuB;

const UP=0, LEFT=1, DOWN=2, RIGHT=3;
const CONNECT_TOP = HEIGHT - RULES.connectTopOffset; // この段より上は連結しない

const TSUMO_PATTERNS = [];
for (let axis=1; axis<=4; axis++){
  for (let child=1; child<=4; child++){
    TSUMO_PATTERNS.push({axis, child});
  }
}

function mulberry32(seed){
  let t = seed >>> 0;
  return function(){
    t |= 0; t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function generateTsumoOrder(seed){
  const rng = mulberry32(seed);
  const arr = [...Array(CYCLE).keys()];
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ==== 盤面(index.htmlと完全一致) ====
function makeEmptyBoard(){
  return Array.from({length: WIDTH}, () => new Array(HEIGHT).fill(0));
}
function childColumn(col, rot){
  if (rot === LEFT) return col - 1;
  if (rot === RIGHT) return col + 1;
  return col;
}
function columnHasSpace(board, col){
  return board[col].some(v => v === 0);
}
function canDrop(board, col, rot){
  const cc = childColumn(col, rot);
  if (cc === col) return columnHasSpace(board, col);
  return columnHasSpace(board, col) || columnHasSpace(board, cc);
}
function dropIntoColumn(board, col, color){
  const idx = board[col].indexOf(0);
  if (idx === -1) return -1;
  board[col][idx] = color;
  return idx;
}
function placePiece(board, col, rot, axisColor, childColor){
  if (!canDrop(board, col, rot)) return { dropped: false };
  const cc = childColumn(col, rot);
  let axisRow, childRow;
  if (rot === DOWN){
    childRow = dropIntoColumn(board, col, childColor);
    axisRow = dropIntoColumn(board, col, axisColor);
  } else {
    axisRow = dropIntoColumn(board, col, axisColor);
    childRow = dropIntoColumn(board, cc, childColor);
  }
  const chigiri = (col !== cc && axisRow !== childRow);
  return { dropped: true, axisRow, childRow, chigiri };
}
function findClearGroups(board){
  const visited = Array.from({length: WIDTH}, () => new Array(HEIGHT).fill(false));
  const groups = [];
  const ojamaToClear = new Set();
  for (let x = 0; x < WIDTH; x++){
    for (let y = 0; y < CONNECT_TOP; y++){
      const c = board[x][y];
      if (c === 0 || c === OJAMA_COLOR || visited[x][y]) continue;
      const cells = [[x,y]];
      const stack = [[x,y]];
      const localOjama = [];
      visited[x][y] = true;
      while (stack.length){
        const [cx, cy] = stack.pop();
        const neighbors = [[cx,cy-1],[cx,cy+1],[cx-1,cy],[cx+1,cy]];
        for (const [nx, ny] of neighbors){
          if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= CONNECT_TOP) continue;
          const nv = board[nx][ny];
          if (nv === OJAMA_COLOR){ localOjama.push([nx,ny]); continue; }
          if (nv === c && !visited[nx][ny]){
            visited[nx][ny] = true;
            cells.push([nx,ny]);
            stack.push([nx,ny]);
          }
        }
      }
      if (cells.length >= 4){
        groups.push({ color: c, cells });
        for (const [ox, oy] of localOjama) ojamaToClear.add(ox + ',' + oy);
      }
    }
  }
  return { groups, ojamaToClear };
}
function scoreStep(rensasu, groups){
  let totalPuyo = 0, renketsu = 0;
  const colors = new Set();
  for (const g of groups){
    totalPuyo += g.cells.length;
    renketsu += RENKETSU_B[Math.min(g.cells.length, RENKETSU_B.length - 1)];
    colors.add(g.color);
  }
  const irokazu = colors.size;
  const bonus = RENSA_B[Math.min(rensasu, RENSA_B.length - 1)] + renketsu + IROKAZU_B[Math.min(irokazu, IROKAZU_B.length - 1)];
  return bonus === 0 ? 10 * totalPuyo : 10 * totalPuyo * bonus;
}
function applyGravity(board){
  for (let x = 0; x < WIDTH; x++){
    const col = board[x];
    const vals = col.filter(v => v !== 0);
    for (let y = 0; y < HEIGHT; y++){
      col[y] = y < vals.length ? vals[y] : 0;
    }
  }
}
function cloneBoard(board){
  return board.map(col => col.slice());
}
function enumerateLegalMoves(board){
  const moves = [];
  for (let rot = 0; rot < 4; rot++){
    const colMin = (rot === LEFT) ? 1 : 0;
    const colMax = (rot === RIGHT) ? WIDTH - 2 : WIDTH - 1;
    for (let col = colMin; col <= colMax; col++){
      if (canDrop(board, col, rot)) moves.push({ col, rot });
    }
  }
  return moves;
}
// 連鎖を最後まで解決して { 連鎖数, 得点 } を返す(盤面は書き換わる)。
// v0.9.9で高速化した。以前は塊の検出のたびに配列や「x,y」の文字列を大量に作っていたので、
// 1次元の型付き配列の上で同じ処理をするようにした。消える塊・巻き込まれるおじゃま・得点・
// 落下後の盤面は以前の実装(simulateResolveChainsRef)と完全に一致する(多数の盤面で照合済み)。
const SR_N = WIDTH * HEIGHT;
const SR_cell = new Int8Array(SR_N), SR_seen = new Uint8Array(SR_N), SR_clear = new Uint8Array(SR_N);
const SR_stack = new Int16Array(SR_N), SR_group = new Int16Array(SR_N);
function simulateResolveChains(board){
  const cell = SR_cell, seen = SR_seen, clear = SR_clear, stack = SR_stack, grp = SR_group;
  for (let x = 0; x < WIDTH; x++){ const col = board[x], b = x * HEIGHT; for (let y = 0; y < HEIGHT; y++) cell[b + y] = col[y]; }
  let rensasu = 0, totalPoint = 0;
  while (true){
    seen.fill(0); clear.fill(0);
    let totalPuyo = 0, renketsu = 0, colorMask = 0, ngroups = 0;
    for (let x = 0; x < WIDTH; x++){
      for (let y = 0; y < CONNECT_TOP; y++){
        const k0 = x * HEIGHT + y, c = cell[k0];
        if (c === 0 || c === OJAMA_COLOR || seen[k0]) continue;
        let sp = 0, gn = 0;
        stack[sp++] = k0; seen[k0] = 1;
        while (sp){
          const k = stack[--sp]; grp[gn++] = k;
          const cx = (k / HEIGHT) | 0, cy = k - cx * HEIGHT;
          if (cy > 0){ const n = k - 1; if (!seen[n] && cell[n] === c){ seen[n] = 1; stack[sp++] = n; } }
          if (cy + 1 < CONNECT_TOP){ const n = k + 1; if (!seen[n] && cell[n] === c){ seen[n] = 1; stack[sp++] = n; } }
          if (cx > 0){ const n = k - HEIGHT; if (!seen[n] && cell[n] === c){ seen[n] = 1; stack[sp++] = n; } }
          if (cx + 1 < WIDTH){ const n = k + HEIGHT; if (!seen[n] && cell[n] === c){ seen[n] = 1; stack[sp++] = n; } }
        }
        if (gn >= 4){
          ngroups++; totalPuyo += gn; colorMask |= (1 << c);
          renketsu += RENKETSU_B[Math.min(gn, RENKETSU_B.length - 1)];
          for (let i = 0; i < gn; i++){
            const k = grp[i]; clear[k] = 1;
            const cx = (k / HEIGHT) | 0, cy = k - cx * HEIGHT;
            // 塊に隣接するおじゃま(連結する段の中だけ)も一緒に消える
            if (cy > 0 && cell[k - 1] === OJAMA_COLOR) clear[k - 1] = 1;
            if (cy + 1 < CONNECT_TOP && cell[k + 1] === OJAMA_COLOR) clear[k + 1] = 1;
            if (cx > 0 && cell[k - HEIGHT] === OJAMA_COLOR) clear[k - HEIGHT] = 1;
            if (cx + 1 < WIDTH && cell[k + HEIGHT] === OJAMA_COLOR) clear[k + HEIGHT] = 1;
          }
        }
      }
    }
    if (ngroups === 0) break;
    rensasu++;
    let irokazu = 0; for (let c = 1; c <= 4; c++) if (colorMask & (1 << c)) irokazu++;
    const bonus = RENSA_B[Math.min(rensasu, RENSA_B.length - 1)] + renketsu + IROKAZU_B[Math.min(irokazu, IROKAZU_B.length - 1)];
    totalPoint += bonus === 0 ? 10 * totalPuyo : 10 * totalPuyo * bonus;
    // 消して、各列を下に詰める
    for (let x = 0; x < WIDTH; x++){
      const b = x * HEIGHT; let w = b;
      for (let y = 0; y < HEIGHT; y++){ const k = b + y; if (!clear[k] && cell[k] !== 0) cell[w++] = cell[k]; }
      while (w < b + HEIGHT) cell[w++] = 0;
    }
  }
  for (let x = 0; x < WIDTH; x++){ const col = board[x], b = x * HEIGHT; for (let y = 0; y < HEIGHT; y++) col[y] = cell[b + y]; }
  return { rensasu, totalPoint };
}
// 以前の実装。高速版と答えが一致することを確かめるためだけに残してある。
function simulateResolveChainsRef(board){
  let rensasu = 0, totalPoint = 0;
  while (true){
    const { groups, ojamaToClear } = findClearGroups(board);
    if (groups.length === 0) break;
    rensasu++;
    totalPoint += scoreStep(rensasu, groups);
    for (const g of groups) for (const [x,y] of g.cells) board[x][y] = 0;
    for (const key of ojamaToClear){
      const [x,y] = key.split(',').map(Number);
      board[x][y] = 0;
    }
    applyGravity(board);
  }
  return { rensasu, totalPoint };
}
// 連鎖の段ごとの内訳(記録・分析用、v0.10.55。指し手には使わない)。board は置いたあと・消える前の盤面(書き換えない)。
// 段ごとに { puyo: 消えた色ぷよの数, groups: 塊ごとの数, colors: 色の数, ojama: 一緒に消えたおじゃま, point: その段の点 }
function chainSteps(board){
  const b = cloneBoard(board), steps = [];
  for (let rensasu = 1; ; rensasu++){
    const { groups, ojamaToClear } = findClearGroups(b);
    if (!groups.length) break;
    steps.push({ puyo: groups.reduce((a, g) => a + g.cells.length, 0), groups: groups.map(g => g.cells.length),
                 colors: new Set(groups.map(g => g.color)).size, ojama: ojamaToClear.size, point: scoreStep(rensasu, groups) });
    for (const g of groups) for (const [x, y] of g.cells) b[x][y] = 0;
    for (const key of ojamaToClear){ const [x, y] = key.split(',').map(Number); b[x][y] = 0; }
    applyGravity(b);
  }
  return steps;
}
function simulateMove(board, col, rot, axisColor, childColor){
  const placed = placePiece(board, col, rot, axisColor, childColor);
  if (!placed.dropped) return { dropped: false };
  const { rensasu, totalPoint } = simulateResolveChains(board);
  return { dropped: true, chigiri: placed.chigiri, rensasu, totalPoint };
}
function isGameOverBoard(board){
  return board[GAMEOVER_X][GAMEOVER_Y] !== 0;
}
function simDropOjama(sim, count){
  const per = Math.floor(count / WIDTH);
  const rem = count % WIDTH;
  for (let g = 0; g < per; g++){
    for (let h = 0; h < WIDTH; h++) dropIntoColumn(sim.board, h, OJAMA_COLOR);
  }
  let ichi = sim.ojamaIchi;
  for (let g = 0; g < rem; g++){
    dropIntoColumn(sim.board, OJAMA_ORDER[ichi], OJAMA_COLOR);
    ichi = (ichi + 1) % WIDTH;
  }
  sim.ojamaIchi = ichi;
}
function applyEconomics(mover, opponent, res){
  if (res.chigiri) mover.cost -= CHIGIRI_TEZON;
  mover.cost -= 1;
  mover.point += DROP_BONUS;
  mover.totalPoint += DROP_BONUS;
  if (res.rensasu > 0){
    mover.point += res.totalPoint;
    mover.totalPoint += res.totalPoint;
    const ojama = Math.floor(mover.point / OJAMA_RATE);
    mover.point %= OJAMA_RATE;
    mover.ojamaYokoku -= ojama;
    if (mover.ojamaYokoku < 0){
      opponent.ojamaYokoku -= mover.ojamaYokoku;
      mover.ojamaYokoku = 0;
    }
    mover.cost -= res.rensasu * RENSA_TEZON;
  }
  if (isGameOverBoard(mover.board)) return { gameOver: true, turnSwitched: false };
  if (mover.cost <= 0){
    opponent.cost += 1;
    if (mover.cost < 0) opponent.cost -= mover.cost;
    mover.cost = 0;
    if (mover.ojamaYokoku > 0){
      let dropped;
      if (mover.ojamaYokoku < MAX_OJAMA_DROP){ dropped = mover.ojamaYokoku; mover.ojamaYokoku = 0; }
      else { dropped = MAX_OJAMA_DROP; mover.ojamaYokoku -= MAX_OJAMA_DROP; }
      simDropOjama(mover, dropped);
      opponent.cost += OJAMA_TEZON;
    }
    if (isGameOverBoard(mover.board)) return { gameOver: true, turnSwitched: false };
    return { gameOver: false, turnSwitched: true };
  }
  return { gameOver: false, turnSwitched: false };
}
function cloneSimPlayer(st){
  return {
    board: cloneBoard(st.board), cost: st.cost, point: st.point, totalPoint: st.totalPoint,
    ojamaYokoku: st.ojamaYokoku, ojamaIchi: st.ojamaIchi, tsumoCount: st.tsumoCount,
  };
}
function newSimPlayer(cost){
  return { board: makeEmptyBoard(), cost, point: 0, totalPoint: 0, ojamaYokoku: 0, ojamaIchi: 0, tsumoCount: 0 };
}
function simDealTsumoOrder(sim, order){
  const pat = TSUMO_PATTERNS[order[sim.tsumoCount % CYCLE]];
  sim.tsumoCount++;
  return { axis: pat.axis, child: pat.child };
}

// ==== 評価関数(index.htmlのAI_WEIGHTS構造と完全一致・Wを外から渡す) ====
function estimateChainPotential(board, W){
  const visited = Array.from({length: WIDTH}, () => new Array(HEIGHT).fill(false));
  let potential = 0;
  for (let x = 0; x < WIDTH; x++){
    for (let y = 0; y < CONNECT_TOP; y++){
      const c = board[x][y];
      if (c === 0 || c === OJAMA_COLOR || visited[x][y]) continue;
      const stack = [[x,y]];
      visited[x][y] = true;
      let size = 0;
      while (stack.length){
        const [cx, cy] = stack.pop();
        size++;
        const neighbors = [[cx,cy-1],[cx,cy+1],[cx-1,cy],[cx+1,cy]];
        for (const [nx, ny] of neighbors){
          if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= CONNECT_TOP || visited[nx][ny]) continue;
          if (board[nx][ny] === c){ visited[nx][ny] = true; stack.push([nx,ny]); }
        }
      }
      if (size === 2) potential += W.chainPot2;
      else if (size === 3) potential += W.chainPot3;
    }
  }
  return potential;
}
function evaluateBoard(board, W){
  const heights = new Array(WIDTH).fill(0);
  let totalHeight = 0, holes = 0;
  for (let x = 0; x < WIDTH; x++){
    let h = 0, seenFilled = false, colHoles = 0;
    for (let y = HEIGHT - 1; y >= 0; y--){
      if (board[x][y] !== 0){ if (!seenFilled){ h = y + 1; seenFilled = true; } }
      else if (seenFilled) colHoles++;
    }
    heights[x] = h; totalHeight += h; holes += colHoles;
  }
  let bumpiness = 0;
  for (let x = 0; x < WIDTH - 1; x++) bumpiness += Math.abs(heights[x] - heights[x+1]);
  const dangerHeight = heights[GAMEOVER_X];
  const dangerPenalty = Math.max(0, dangerHeight - (GAMEOVER_Y - 2));
  let score = 0;
  score -= totalHeight * W.heightPenalty;
  score -= bumpiness * W.bumpPenalty;
  score -= holes * W.holePenalty;
  score -= dangerPenalty * dangerPenalty * W.dangerPenalty;
  score += estimateChainPotential(board, W) * W.chainPotentialWeight;
  return score;
}
// ==== v3評価: 火力を「連鎖数」ではなく「おじゃま数 ÷ 手数」で測る ====
function evaluateMoveResult(result, boardAfter, urgentYokoku, W){
  let fireScore = 0;
  if (result.rensasu > 0){
    const ojama = result.totalPoint / OJAMA_RATE;      // 送れるおじゃま数
    const tezon = result.rensasu * RENSA_TEZON;        // 発火で余分に払う手数
    const eff = ojama / tezon;                         // 手数1あたりのおじゃま数
    const urgency = Math.min(1, Math.max(0, urgentYokoku || 0) / 20);
    const weight = Math.max(Math.min(1, ojama / W.fireFullOjama), urgency * W.fireUrgencyMul, W.fireMinWeight);
    fireScore = (ojama * W.fireOjamaMul + eff * W.fireEffMul) * weight;
  }
  return fireScore + evaluateBoard(boardAfter, W);
}

// ==== 連結成分のラベリング(各マスが属する塊のIDとサイズ) ====
function labelGroups(board){
  const id = Array.from({length: WIDTH}, () => new Array(HEIGHT).fill(-1));
  const sizes = [];
  for (let x = 0; x < WIDTH; x++){
    for (let y = 0; y < CONNECT_TOP; y++){
      const c = board[x][y];
      if (c === 0 || c === OJAMA_COLOR || id[x][y] !== -1) continue;
      const gid = sizes.length;
      let size = 0;
      const stack = [[x,y]];
      id[x][y] = gid;
      while (stack.length){
        const [cx, cy] = stack.pop();
        size++;
        const nb = [[cx,cy-1],[cx,cy+1],[cx-1,cy],[cx+1,cy]];
        for (const [nx, ny] of nb){
          if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= CONNECT_TOP) continue;
          if (id[nx][ny] !== -1) continue;
          if (board[nx][ny] === c){ id[nx][ny] = gid; stack.push([nx,ny]); }
        }
      }
      sizes.push(size);
    }
  }
  return { id, sizes };
}

// ==== 発火点の列挙 ====
// 連鎖は「置いた色が既存の同色と繋がって4個以上になる」ときしか起きないので、
// 各列の着地マスに隣接している色(=露出している色)だけを候補にする。
// 隣接する同色の塊の合計+1が4未満なら即座に除外できるので、6列×4色の総当たりより大幅に軽い。
function findIgnitions(board){
  const { id, sizes } = labelGroups(board);
  const out = [];
  for (let x = 0; x < WIDTH; x++){
    const y = board[x].indexOf(0);
    if (y === -1 || y >= CONNECT_TOP) continue; // 列が満杯 or 13段目(繋がらない)
    const nb = [[x,y-1],[x-1,y],[x+1,y]];
    const byColor = new Map();
    for (const [nx, ny] of nb){
      if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= CONNECT_TOP) continue;
      const c = board[nx][ny];
      if (c === 0 || c === OJAMA_COLOR) continue;
      if (id[nx][ny] === -1) continue;
      if (!byColor.has(c)) byColor.set(c, new Set());
      byColor.get(c).add(id[nx][ny]);
    }
    for (const [c, gids] of byColor){
      let total = 1;
      for (const g of gids) total += sizes[g];
      if (total >= 4) out.push({ col: x, row: y, color: c });
    }
  }
  return out;
}

// 「いま仮想の1個を置いて発火したら、最大で何連鎖・おじゃま何個か」を [連鎖数, おじゃま数] で返す。
// 自己対戦の記録(mc/mo/omc/omo)と、ネットへの入力(--chainfeat)の両方がこの関数を使う。
// 同じ関数を通すので、学習時と対局時で値がずれることはない。
function ignitionPotential(board){
  const igs = findIgnitions(board);
  let chain = 0, point = 0;
  for (const ig of igs){
    const b2 = cloneBoard(board);
    b2[ig.col][ig.row] = ig.color;
    const r = simulateResolveChains(b2);
    if (r.rensasu > chain) chain = r.rensasu;
    if (r.totalPoint > point) point = r.totalPoint;
  }
  return [chain, Math.floor(point / OJAMA_RATE)];
}

// ==== 連鎖の伸びしろ(詳しい版) ====
// 参考: citrus610/ama (https://github.com/citrus610/ama, MIT License) の ai/search/dfs/quiet.cpp。
// 考え方と手順はamaに倣い、このゲームのルール(盤面13段・13段目は連結しない・どの列にも置ける)に合わせて
// JavaScriptで書き直した。著作権表示とライセンス文は README.md の「参考にしたもの」にある。
//
// ignitionPotential は「どこかに1個置いたら」しか見ないが、こちらは次のことまで試す。
//   1. ある列に同じ色を1〜3個積み、発火するまで試す(縦置き)
//   2. 発火したあと他の列の高さが変わっていれば「まだ伸ばせる連鎖」とみなし、
//      発火後の盤面で新たに4個つながる場所を探して、元の盤面にその分を足し、連鎖が伸びるかを繰り返し試す
//      (伸ばすときは縦に1〜2個、平らな2列なら横に2個並べる置き方も試す)
//   3. 足したことで発火前に消えてしまう置き方(連鎖の切れ)と、窒息する置き方は除く
// 返すのは、見つかった中で一番長い連鎖について
//   [連鎖数, おじゃま数, 足した個数(あと何個で撃てるか), 発火点の高さ, 発火点の横の広がり]
// 盤面だけから決まるので、同じ盤面の答えは使い回す(木探索では相手の盤面が何度も同じになる)。
const DEEP_DEPTH = 3;            // 伸ばす試行を何段まで重ねるか(計算量との兼ね合いで決めた)
let DEEP_CACHE = new Map();
function columnHeights(board){
  const h = new Array(WIDTH);
  for (let x = 0; x < WIDTH; x++){ const y = board[x].indexOf(0); h[x] = y === -1 ? HEIGHT : y; }
  return h;
}
// (x,y) から同じ色でつながっている個数(連結する段だけ)。4以上で消える。
function groupSizeAt(board, x, y){
  const c = board[x][y];
  if (!c || c === OJAMA_COLOR || y >= CONNECT_TOP) return 0;
  const seen = new Uint8Array(WIDTH * HEIGHT);
  const stack = [x * HEIGHT + y]; seen[x * HEIGHT + y] = 1;
  let n = 0;
  while (stack.length){
    const k = stack.pop(); n++;
    const cx = (k / HEIGHT) | 0, cy = k % HEIGHT;
    if (cy > 0 && !seen[k - 1] && board[cx][cy - 1] === c){ seen[k - 1] = 1; stack.push(k - 1); }
    if (cy + 1 < CONNECT_TOP && !seen[k + 1] && board[cx][cy + 1] === c){ seen[k + 1] = 1; stack.push(k + 1); }
    if (cx > 0 && !seen[k - HEIGHT] && board[cx - 1][cy] === c){ seen[k - HEIGHT] = 1; stack.push(k - HEIGHT); }
    if (cx + 1 < WIDTH && !seen[k + HEIGHT] && board[cx + 1][cy] === c){ seen[k + HEIGHT] = 1; stack.push(k + HEIGHT); }
  }
  return n;
}
// 列xに n 個積んだとき窒息しないか、連結する段に収まるか
function canStack(h, x, n){
  if (h[x] + n > CONNECT_TOP) return false;
  if (x === GAMEOVER_X && h[x] + n > GAMEOVER_Y) return false;
  return true;
}
// 発火候補を列挙する(ama の quiet::generate に相当)。cb(x, color, need, dir) dir: 0=縦, 1=右へ横, -1=左へ横
function quietGenerate(board, h, xBan, drop, cb){
  const hchecked = new Uint8Array(WIDTH * 5);
  for (let x = 0; x < WIDTH; x++){
    if (x === xBan) continue;
    const dropMax = Math.min(drop, CONNECT_TOP - h[x]);
    if (dropMax <= 0) continue;
    const expandR = x < WIDTH - 1 && x + 1 !== xBan && h[x] === h[x + 1] && canStack(h, x + 1, 1);
    const expandL = x > 0 && x - 1 !== xBan && h[x] === h[x - 1] && canStack(h, x - 1, 1);
    for (let c = 1; c <= 4; c++){
      let dropped = 0;
      for (let i = 0; i < dropMax; i++) board[x][h[x] + i] = c;
      for (let i = 0; i < dropMax; i++){
        // i+1 個積んだ時点で、一番下の1個が4つ以上つながるか(上の分はまだ置いていない扱いにする)
        for (let j = i + 1; j < dropMax; j++) board[x][h[x] + j] = 0;
        const n = groupSizeAt(board, x, h[x]);
        for (let j = i + 1; j < dropMax; j++) board[x][h[x] + j] = c;
        if (n >= 4){ dropped = i + 1; break; }
      }
      for (let i = 0; i < dropMax; i++) board[x][h[x] + i] = 0;
      if (dropped){
        cb(x, c, dropped, 0);
        if (dropped > 1){
          if (expandR && !hchecked[x * 5 + c]){ hchecked[x * 5 + c] = 1; cb(x, c, 2, 1); }
          if (expandL && !hchecked[(x - 1) * 5 + c]){ hchecked[(x - 1) * 5 + c] = 1; cb(x, c, 2, -1); }
        }
      }
    }
  }
}
function chiAt(h, x){
  let chi = 0;
  if (x < WIDTH - 1){
    for (let i = x + 1; i < WIDTH; i++){ if (h[i] > h[x]) break; chi++; }
    for (let i = x + 1; i < WIDTH; i++){ if (h[i] >= h[x]) break; chi++; }
  }
  if (x > 0){
    for (let i = x - 1; i >= 0; i--){ if (h[i] > h[x]) break; chi++; }
    for (let i = x - 1; i >= 0; i--){ if (h[i] >= h[x]) break; chi++; }
  }
  return chi;
}
function countPuyo(board){
  let n = 0;
  for (let x = 0; x < WIDTH; x++) for (let y = 0; y < HEIGHT; y++) if (board[x][y]) n++;
  return n;
}
function deepChainPotential(board, depth){
  depth = depth || DEEP_DEPTH;
  const key = depth + '|' + boardKey(board);
  const hit = DEEP_CACHE.get(key);
  if (hit) return hit;
  const out = deepSearch(board, depth).out;
  if (DEEP_CACHE.size > 200000) DEEP_CACHE = new Map();
  DEEP_CACHE.set(key, out);
  return out;
}
// deepChainPotential と同じ探し方で、見つけた一番長い連鎖の「足したあとの盤面」(plan)も返す(v0.10.9)。
// 覚えておく仕組みは使わない(盤面を丸ごと覚えるとメモリが足りなくなるため)。
//   戻り値 { out: deepChainPotential と同じ5つの値, plan: 足したあとの盤面(見つからなければ null), x: 発火する列 }
function deepChainPlan(board, depth){
  return deepSearch(board, depth || DEEP_DEPTH);
}
function deepSearch(board, depth){
  const h0 = columnHeights(board);
  const n0 = countPuyo(board);
  let best = null;   // { chain, point, key, x, plan }
  const better = (a, b) => !b || a.chain > b.chain || (a.chain === b.chain &&
    (a.point > b.point || (a.point === b.point && a.key < b.key)));
  const record = (chain, point, x, plan) => {
    const r = { chain, point, x, key: countPuyo(plan) - n0, plan };
    if (better(r, best)) best = r;
  };
  // 伸ばす試行(ama の quiet::dfs に相当)
  const extend = (field, root, xBan, preChain, d) => {
    const rh = columnHeights(root);
    const fh = columnHeights(field);
    const work = cloneBoard(field);
    quietGenerate(work, fh, xBan, 2, (x, c, need, dir) => {
      if (dir === 0 && !canStack(rh, x, need)) return;
      if (dir !== 0 && (!canStack(rh, x, 1) || !canStack(rh, x + dir, 1))) return;
      const plan = cloneBoard(root);
      if (dir === 0){ for (let i = 0; i < need; i++) plan[x][rh[x] + i] = c; }
      else { plan[x][rh[x]] = c; plan[x + dir][rh[x + dir]] = c; }
      // 連鎖の切れ: 足した時点でもう4つつながってしまうなら、発火前に消えるので不可
      if (groupSizeAt(plan, x, rh[x]) > 3) return;
      if (dir !== 0 && groupSizeAt(plan, x + dir, rh[x + dir]) > 3) return;
      const sim = cloneBoard(plan);
      const r = simulateResolveChains(sim);
      if (r.rensasu > preChain){
        record(r.rensasu, r.totalPoint, xBan, plan);
        if (d > 1) extend(sim, plan, xBan, r.rensasu, d - 1);
      }
    });
  };
  const work = cloneBoard(board);
  quietGenerate(work, h0, -1, 3, (x, c, need, dir) => {
    if (dir !== 0) return;                       // 最初の発火は縦置きだけ(ama と同じ)
    if (!canStack(h0, x, need)) return;
    const plan = cloneBoard(board);
    for (let i = 0; i < need; i++) plan[x][h0[x] + i] = c;
    const sim = cloneBoard(plan);
    const r = simulateResolveChains(sim);
    if (r.rensasu < 1) return;
    record(r.rensasu, r.totalPoint, x, plan);
    if (depth < 2) return;
    // 発火点以外の列の高さが変わっていれば、まだ伸ばせる
    const sh = columnHeights(sim);
    let extendable = false;
    for (let i = 0; i < WIDTH; i++) if (i !== x && sh[i] !== h0[i]){ extendable = true; break; }
    if (extendable) extend(sim, plan, x, r.rensasu, depth - 1);
  });
  let out;
  if (!best) out = [0, 0, 0, 0, 0];
  else {
    const ph = columnHeights(best.plan); ph[best.x] = h0[best.x];
    out = [best.chain, Math.floor(best.point / OJAMA_RATE), best.key, h0[best.x], chiAt(ph, best.x)];
  }
  return { out, plan: best ? best.plan : null, x: best ? best.x : -1 };
}

// 仮想の1個で撃てる最大火力(おじゃま数)だけを返す軽い版。副砲判定の内側で使う。
function maxChainOjama(board){
  const igs = findIgnitions(board);
  let best = 0;
  for (const ig of igs){
    const b2 = cloneBoard(board);
    b2[ig.col][ig.row] = ig.color;
    const { rensasu, totalPoint } = simulateResolveChains(b2);
    if (rensasu > 0 && totalPoint > best) best = totalPoint;
  }
  return best / OJAMA_RATE;
}

const FUKUHOU_CANDIDATES = 3; // 副砲判定を行う候補数の上限(計算量対策)
let PROFILE_CACHE = new Map();
function resetProfileCache(){ PROFILE_CACHE = new Map(); }

// ==== 盤面のプロファイル: 本線・副砲・対応力 ====
// honsen: 仮想1個で撃てる最大火力(おじゃま数と手数)
// fukuhou: 撃っても本線がほぼ残る発火点のうち、手数効率が最良のもの
// answers: 全発火点の(火力,手数) — 相手の攻撃に撃ち返せるかの判定に使う
function analyzeBoard(board, W){
  const key = boardKey(board);
  const hit = PROFILE_CACHE.get(key);
  if (hit) return hit;

  const igs = findIgnitions(board);
  const fired = [];
  for (const ig of igs){
    const b2 = cloneBoard(board);
    b2[ig.col][ig.row] = ig.color;
    const { rensasu, totalPoint } = simulateResolveChains(b2);
    if (rensasu === 0) continue;
    const ojama = totalPoint / OJAMA_RATE;
    const cost = rensasu * RENSA_TEZON;
    fired.push({ rensasu, ojama, cost, eff: ojama / cost, after: b2 });
  }

  let honsen = { ojama: 0, cost: 0 };
  let honsenRef = null;
  for (const f of fired) if (f.ojama > honsen.ojama){ honsen = { ojama: f.ojama, cost: f.cost }; honsenRef = f; }

  // 副砲: 本線を食い潰さずに撃てるもののうち、手数効率が最良のもの。
  // 「撃った後にもう一度最大火力を測り、本線がW.fukuhouKeep以上残っているか」で判定する。
  let fukuhou = { ojama: 0, cost: 0, eff: 0 };
  if (honsen.ojama > 0 && fired.length > 1){
    const cands = fired.filter(f => f !== honsenRef).sort((a,b) => b.eff - a.eff).slice(0, FUKUHOU_CANDIDATES);
    for (const f of cands){
      if (f.eff <= fukuhou.eff) continue;
      const remain = maxChainOjama(f.after);
      if (remain >= honsen.ojama * W.fukuhouKeep){
        fukuhou = { ojama: f.ojama, cost: f.cost, eff: f.eff };
      }
    }
  }

  const prof = { honsen, fukuhou, answers: fired.map(f => ({ ojama: f.ojama, cost: f.cost })) };
  // いっぱいになったら作り直す(以前は止めていたが、自己対戦の長い作業では途中から全く効かなくなるため)。
  // 答えを覚えておくだけの仕組みなので、作り直しても結果は変わらない。
  if (PROFILE_CACHE.size >= 150000) PROFILE_CACHE = new Map();
  PROFILE_CACHE.set(key, prof);
  return prof;
}

// 攻撃量X以上を、残り手数budget以内で撃ち返せる発火点があるか
function canAnswer(prof, x, budget){
  if (x <= 0) return true;
  for (const a of prof.answers) if (a.ojama >= x && a.cost <= budget) return true;
  return false;
}

// ==== 探索の葉の評価(root視点) ====
function leafValue(rootSim, oppSim, W){
  let v = evaluateBoard(rootSim.board, W) - evaluateBoard(oppSim.board, W);
  v -= Math.max(0, rootSim.ojamaYokoku) * W.leafOjamaMul;
  v += Math.max(0, oppSim.ojamaYokoku) * W.leafOjamaMul;

  const r = analyzeBoard(rootSim.board, W);
  const o = analyzeBoard(oppSim.board, W);

  // 本線火力の差
  v += (r.honsen.ojama - o.honsen.ojama) * W.honsenDiff;
  // 副砲(手数効率)の差
  v += (r.fukuhou.eff - o.fukuhou.eff) * W.fukuhouDiff;

  // 手番でない側もターンが回れば最低1手数は得るので、対応力の判定はそれを見込む
  const rBudget = Math.max(rootSim.cost, 1), oBudget = Math.max(oppSim.cost, 1);
  // 相手の副砲に自分が対応できない = 危険
  if (o.fukuhou.ojama > 0 && !canAnswer(r, o.fukuhou.ojama, rBudget)) v -= W.noAnswerPenalty;
  // 自分の副砲に相手が対応できない = 撃てば通るので価値が高い
  if (r.fukuhou.ojama > 0 && !canAnswer(o, r.fukuhou.ojama, oBudget)) v += W.unansweredBonus;
  // 本線火力で負けているときは、副砲で攻めるしかないのでその価値を上げる
  if (r.honsen.ojama < o.honsen.ojama) v += r.fukuhou.eff * W.behindFukuhouMul;

  return v;
}

// ==== 相手との関係(--chainfeat 3 の入力) ====
// 探索AIが盤面の評価に使っている「副砲」と「撃ち返せるか」を、ネットへの入力の形で返す。
// 探索AIは今のネットより強く、その差を生んでいる材料の一つがこれなので、ネットにも渡してみる。
//   副砲 … 撃っても本線(最大火力)が8割以上残る攻撃のうち、手数あたりのおじゃまが一番多いもの
//   撃ち返せるか … 相手の攻撃(または自分に来ている予告おじゃま)以上を、残り手数のうちに撃てる発火点があるか
// 戻り値: [自分の副砲のおじゃま, 自分の副砲の効率, 相手の副砲のおじゃま, 相手の副砲の効率,
//          相手の副砲を自分が撃ち返せない(1/0), 自分の副砲を相手が撃ち返せない(1/0),
//          自分の予告おじゃまを撃ち返せる(1/0), 相手の予告おじゃまを相手が撃ち返せる(1/0)]
// me / opp は { board, cost, ojamaYokoku } を持っていればよい。
const RELATION_W = { fukuhouKeep: 0.8 };   // 探索AIの重み(weights.js V3)と同じ値
function relationFeatures(me, opp){
  const pm = analyzeBoard(me.board, RELATION_W), po = analyzeBoard(opp.board, RELATION_W);
  const rBudget = Math.max(me.cost, 1), oBudget = Math.max(opp.cost, 1);
  return [
    pm.fukuhou.ojama, pm.fukuhou.eff, po.fukuhou.ojama, po.fukuhou.eff,
    (po.fukuhou.ojama > 0 && !canAnswer(pm, po.fukuhou.ojama, rBudget)) ? 1 : 0,
    (pm.fukuhou.ojama > 0 && !canAnswer(po, pm.fukuhou.ojama, oBudget)) ? 1 : 0,
    canAnswer(pm, me.ojamaYokoku, rBudget) ? 1 : 0,
    canAnswer(po, opp.ojamaYokoku, oBudget) ? 1 : 0,
  ];
}

const AI_LOSE_VALUE = -90000, AI_WIN_VALUE = 90000;

function boardKey(board){
  let s = '';
  for (let x = 0; x < WIDTH; x++) for (let y = 0; y < HEIGHT; y++) s += board[x][y];
  return s;
}
function stateKey(state){
  const r = state.root, o = state.opp;
  return boardKey(r.board) + '|' + boardKey(o.board) + '|' +
    r.cost.toFixed(1) + ',' + r.ojamaYokoku.toFixed(1) + ',' + r.tsumoCount + '|' +
    o.cost.toFixed(1) + ',' + o.ojamaYokoku.toFixed(1) + ',' + o.tsumoCount + '|' +
    state.toMove;
}

// index.htmlのalphaBetaと同一ロジック。違いはmatch.orderの代わりにorder引数を、
// 単一のAI_WEIGHTS定数の代わりにW引数(このツリーを探索している本人の重み)を使う点のみ。
function alphaBeta(state, alpha, beta, tt, deadline, order, W){
  if (performance.now() > deadline) return { value: 0, move: null, timedOut: true };

  const key = stateKey(state);
  const origAlpha = alpha, origBeta = beta;
  const ttEntry = tt.get(key);
  let ttMove = null;
  if (ttEntry){
    ttMove = ttEntry.move;
    if (ttEntry.depth >= state.pliesLeft){
      if (ttEntry.flag === 'EXACT') return { value: ttEntry.value, move: ttEntry.move };
      if (ttEntry.flag === 'LOWER') alpha = Math.max(alpha, ttEntry.value);
      else if (ttEntry.flag === 'UPPER') beta = Math.min(beta, ttEntry.value);
      if (alpha >= beta) return { value: ttEntry.value, move: ttEntry.move };
    }
  }

  const moverIsRoot = (state.toMove === 'root');
  const moverSim = moverIsRoot ? state.root : state.opp;
  const otherSim = moverIsRoot ? state.opp : state.root;

  // rootFilter は根でのみ指定される。ネットワークが選んだ上位手だけに候補を絞り、
  // 浮いた時間を深さに回すための仕組み(指定が無ければ全合法手を見る)。
  let moves = enumerateLegalMoves(moverSim.board);
  if (state.rootFilter) moves = moves.filter(m => state.rootFilter.has(m.col * 4 + m.rot));
  const candidates = [];
  for (const mv of moves){
    const b2 = cloneBoard(moverSim.board);
    const res = simulateMove(b2, mv.col, mv.rot, state.piece.axis, state.piece.child);
    if (!res.dropped) continue;
    const isTTMove = ttMove && ttMove.col === mv.col && ttMove.rot === mv.rot;
    const quick = evaluateMoveResult(res, b2, moverSim.ojamaYokoku, W);
    candidates.push({ mv, b2, res, quick: isTTMove ? Infinity : quick });
  }
  if (candidates.length === 0){
    return { value: moverIsRoot ? AI_LOSE_VALUE : AI_WIN_VALUE, move: null };
  }
  candidates.sort((a, b) => b.quick - a.quick);

  const isLeafPly = state.pliesLeft <= 1;
  let bestValue = moverIsRoot ? -Infinity : Infinity;
  let bestMove = candidates[0].mv;
  let timedOut = false;

  for (const cand of candidates){
    const moverCopy = {
      board: cand.b2, cost: moverSim.cost, point: moverSim.point, totalPoint: moverSim.totalPoint,
      ojamaYokoku: moverSim.ojamaYokoku, ojamaIchi: moverSim.ojamaIchi, tsumoCount: moverSim.tsumoCount,
    };
    const otherCopy = cloneSimPlayer(otherSim);
    const outcome = applyEconomics(moverCopy, otherCopy, cand.res);

    let value;
    if (outcome.gameOver){
      value = moverIsRoot ? AI_LOSE_VALUE : AI_WIN_VALUE;
    } else if (isLeafPly){
      const rSim = moverIsRoot ? moverCopy : otherCopy;
      const oSim = moverIsRoot ? otherCopy : moverCopy;
      value = leafValue(rSim, oSim, W);
    } else {
      let nextToMove, nextMoverSim;
      if (outcome.turnSwitched){
        nextToMove = moverIsRoot ? 'opp' : 'root';
        nextMoverSim = otherCopy;
      } else {
        nextToMove = state.toMove;
        nextMoverSim = moverCopy;
      }
      const nextPiece = simDealTsumoOrder(nextMoverSim, order);
      const child = alphaBeta({
        root: moverIsRoot ? moverCopy : otherCopy,
        opp: moverIsRoot ? otherCopy : moverCopy,
        toMove: nextToMove,
        piece: nextPiece,
        pliesLeft: state.pliesLeft - 1,
      }, alpha, beta, tt, deadline, order, W);
      if (child.timedOut){ timedOut = true; break; }
      value = child.value;
    }

    if (moverIsRoot){
      if (value > bestValue){ bestValue = value; bestMove = cand.mv; }
      alpha = Math.max(alpha, bestValue);
    } else {
      if (value < bestValue){ bestValue = value; bestMove = cand.mv; }
      beta = Math.min(beta, bestValue);
    }
    if (alpha >= beta) break;
  }

  if (timedOut) return { value: bestValue, move: bestMove, timedOut: true };

  let flag;
  if (bestValue <= origAlpha) flag = 'UPPER';
  else if (bestValue >= origBeta) flag = 'LOWER';
  else flag = 'EXACT';
  tt.set(key, { depth: state.pliesLeft, value: bestValue, move: bestMove, flag });

  return { value: bestValue, move: bestMove };
}

function searchBestMove(rootSim, oppSim, piece, order, W, timeBudgetMs, maxPlies, rootFilter){
  const tt = new Map();
  resetProfileCache();
  const deadline = performance.now() + timeBudgetMs;
  let bestMove = null;
  for (let depth = 1; depth <= maxPlies; depth++){
    const result = alphaBeta(
      { root: rootSim, opp: oppSim, toMove: 'root', piece, pliesLeft: depth, rootFilter },
      -Infinity, Infinity, tt, deadline, order, W
    );
    if (result.timedOut) break;
    if (result.move) bestMove = result.move;
    if (performance.now() > deadline) break;
  }
  return bestMove;
}

// ==== 1試合をヘッドレスで最後まで進める ====
// weights = [P0の重み, P1の重み]。P0はONE_P_BONUSを持つ(実プレイの1P相当)。
function playGame(weights, seed, opts){
  const timeBudgetMs = opts.timeBudgetMs, maxPlies = opts.maxPlies, maxPlacements = opts.maxPlacements || 600;
  const order = generateTsumoOrder(seed);
  const P = [newSimPlayer(ONE_P_BONUS), newSimPlayer(0)];
  let active = 0;
  let current = simDealTsumoOrder(P[0], order);
  let placements = 0;

  while (placements < maxPlacements){
    const mover = P[active], opp = P[1 - active];
    const mv = searchBestMove(mover, opp, current, order, weights[active], timeBudgetMs, maxPlies);
    if (!mv) return { winner: 1 - active, placements, reason: 'no-move' };
    const b2 = cloneBoard(mover.board);
    const res = simulateMove(b2, mv.col, mv.rot, current.axis, current.child);
    mover.board = b2;
    const outcome = applyEconomics(mover, opp, res);
    placements++;
    if (outcome.gameOver) return { winner: 1 - active, placements, reason: 'gameover' };
    if (outcome.turnSwitched){
      active = 1 - active;
      current = simDealTsumoOrder(P[active], order);
    } else {
      current = simDealTsumoOrder(P[active], order);
    }
  }
  return { winner: null, placements, reason: 'cap' };
}

module.exports = {
  RULES, DEFAULT_RULES, TSUMO_PATTERNS, mulberry32,
  playGame, generateTsumoOrder, searchBestMove, cloneBoard, simulateMove,
  applyEconomics, simDealTsumoOrder, newSimPlayer, ONE_P_BONUS,
  findIgnitions, simulateResolveChains, enumerateLegalMoves, placePiece, CONNECT_TOP, chainSteps,
  ignitionPotential, deepChainPotential, deepChainPlan, DEEP_DEPTH, simulateResolveChainsRef, relationFeatures,
  analyzeBoard, canAnswer, leafValue,
  evaluateBoard, TSUMO_PATTERNS, makeEmptyBoard, WIDTH, HEIGHT, OJAMA_RATE,
};
