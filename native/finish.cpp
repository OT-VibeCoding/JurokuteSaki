// 本線の仕上げの読み(finish.js と同じ読み方)を C++ で速く行うプログラム(作業記録 第45期〜、v0.10.29)。
//
// 使い方: node から finish_native.js を通して使う(標準入力に問い合わせを書き、標準出力から答えを読む)。
//   1行目: ルールの数(engine.js の RULES から finish_native.js が作る。点数の表などをここに写さないため)
//     R 幅 高さ つながる段 負けの列 負けの段 おじゃまの色 おじゃまの率 置く点 連鎖の手数×2 ちぎりの手数×2 n 連鎖の表… n つながりの表… n 色数の表…
//   問い合わせ: Q 盤面(列ごとに下から13段の数字78文字) 手数×2 点 置く回数の上限 局面数の上限 時間の上限(ms) n 軸の色 子の色 …(これから来るツモ n 組)
//               残す盤面の数 全部読む手数(B。残す数が0なら全部読む) 撃ったあとに残るものも比べるか(0 比べない / 1 色ぷよの数 / 2 1個足せば撃てる一番大きい点)
//   答え: A 読んだ局面の数 読み切れたか(1/0) 候補の数 { 使う手数×2 おじゃま 連鎖数 何手目 [残る色ぷよ(比べるときだけ)] 手の数 列 向き … } …
//   E で終わる
// 決まりごと・読む量を減らす工夫は finish.js と同じ(手数は0.5刻みなので、2倍した整数で数える)。
// ブラウザ用(WebAssembly)にも変換できるよう、Windows 専用の書き方はしない。
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <vector>
#include <string>
#include <chrono>
#include <algorithm>

static int W = 6, H = 13, CTOP = 12, GX = 2, GY = 11, OJ = 5, RATE = 70, DROP = 10, RT2 = 3, CT2 = 1;
static std::vector<int> RENSA, RENKETSU, IROKAZU;
static bool FAST = true;   // 環境変数 FINISH_SLOW=1 なら、確かめ用に元の手順(resolve)で計算する

struct Board {
  uint8_t c[6][13];
  int8_t h[6];
};

// engine.js の simulateResolveChains と同じ手順(点数も同じ)
static void resolve(Board& b, int& rensasu, int& total){
  rensasu = 0; total = 0;
  static uint8_t seen[6][13], clr[6][13];
  static int stk[78], grp[78];
  for (;;){
    memset(seen, 0, sizeof seen); memset(clr, 0, sizeof clr);
    int totalPuyo = 0, renketsu = 0, colorMask = 0, ngroups = 0;
    for (int x = 0; x < W; x++) for (int y = 0; y < CTOP; y++){
      int col = b.c[x][y];
      if (!col || col == OJ || seen[x][y]) continue;
      int sp = 0, gn = 0;
      stk[sp++] = x * 16 + y; seen[x][y] = 1;
      while (sp){
        int k = stk[--sp]; grp[gn++] = k;
        int cx = k >> 4, cy = k & 15;
        if (cy > 0 && !seen[cx][cy - 1] && b.c[cx][cy - 1] == col){ seen[cx][cy - 1] = 1; stk[sp++] = k - 1; }
        if (cy + 1 < CTOP && !seen[cx][cy + 1] && b.c[cx][cy + 1] == col){ seen[cx][cy + 1] = 1; stk[sp++] = k + 1; }
        if (cx > 0 && !seen[cx - 1][cy] && b.c[cx - 1][cy] == col){ seen[cx - 1][cy] = 1; stk[sp++] = k - 16; }
        if (cx + 1 < W && !seen[cx + 1][cy] && b.c[cx + 1][cy] == col){ seen[cx + 1][cy] = 1; stk[sp++] = k + 16; }
      }
      if (gn >= 4){
        ngroups++; totalPuyo += gn; colorMask |= (1 << col);
        renketsu += RENKETSU[std::min<int>(gn, (int)RENKETSU.size() - 1)];
        for (int i = 0; i < gn; i++){
          int cx = grp[i] >> 4, cy = grp[i] & 15;
          clr[cx][cy] = 1;
          // 塊に隣接するおじゃま(連結する段の中だけ)も一緒に消える
          if (cy > 0 && b.c[cx][cy - 1] == OJ) clr[cx][cy - 1] = 1;
          if (cy + 1 < CTOP && b.c[cx][cy + 1] == OJ) clr[cx][cy + 1] = 1;
          if (cx > 0 && b.c[cx - 1][cy] == OJ) clr[cx - 1][cy] = 1;
          if (cx + 1 < W && b.c[cx + 1][cy] == OJ) clr[cx + 1][cy] = 1;
        }
      }
    }
    if (!ngroups) break;
    rensasu++;
    int iro = 0; for (int c = 1; c <= 4; c++) if (colorMask & (1 << c)) iro++;
    int bonus = RENSA[std::min<int>(rensasu, (int)RENSA.size() - 1)] + renketsu + IROKAZU[std::min<int>(iro, (int)IROKAZU.size() - 1)];
    total += bonus == 0 ? 10 * totalPuyo : 10 * totalPuyo * bonus;
    // 消して、各列を下に詰める
    for (int x = 0; x < W; x++){
      int w = 0;
      for (int y = 0; y < H; y++) if (!clr[x][y] && b.c[x][y]) b.c[x][w++] = b.c[x][y];
      for (int y = w; y < H; y++) b.c[x][y] = 0;
      b.h[x] = (int8_t)w;
    }
  }
}

// resolve と同じ答えを、調べるマスを絞って速く出す(v0.10.29)。
// 盤面は置く前には消える塊が無い(読みの中では消えない手しか積まないため)ので、新しく消える塊は
// 「置いたぷよ」か「前の連鎖で落ちてきたぷよ」を必ず含む。そのマスからだけ塊を探す
// 調べ始めるマスを並びで渡す形(本線を組む読みで、縦に3個まで積んだときにも使う。v0.10.36)
static void resolveFrom(Board& b, const int* start, int nstart, int& rensasu, int& total);
// 直前の resolveFrom の、1段目・2段目の形(v0.10.56。2連鎖の効率の悪い形を除くため。shio さんの基準)
struct StepShape { int puyo, ngroups, size[8], color[8]; };
static StepShape LAST_STEP[2];
static int LAST_PUYO = 0;   // 直前の resolveFrom で消えた色ぷよの合計(v0.10.56、ぷよ1個あたりの点で区切るため)
static void resolveFast(Board& b, int x1, int y1, int x2, int y2, int& rensasu, int& total){
  int st[2], n = 0;
  if (y1 >= 0) st[n++] = x1 * 16 + y1;
  if (y2 >= 0) st[n++] = x2 * 16 + y2;
  resolveFrom(b, st, n, rensasu, total);
}
static void resolveFrom(Board& b, const int* start, int nstart, int& rensasu, int& total){
  rensasu = 0; total = 0; LAST_PUYO = 0;
  static uint32_t seen[6][13], clr[6][13]; static uint32_t g = 0;
  int cand[160], nc = 0, stk[78], grp[78];
  for (int i = 0; i < nstart; i++) cand[nc++] = start[i];
  while (nc){
    g++;
    int totalPuyo = 0, renketsu = 0, colorMask = 0, ngroups = 0, low[6] = { 99, 99, 99, 99, 99, 99 };
    StepShape sh; sh.puyo = 0; sh.ngroups = 0;
    for (int ci = 0; ci < nc; ci++){
      int x0 = cand[ci] >> 4, y0 = cand[ci] & 15;
      if (y0 >= CTOP || seen[x0][y0] == g) continue;
      int col = b.c[x0][y0];
      if (!col || col == OJ) continue;
      int sp = 0, gn = 0;
      stk[sp++] = x0 * 16 + y0; seen[x0][y0] = g;
      while (sp){
        int k = stk[--sp]; grp[gn++] = k;
        int cx = k >> 4, cy = k & 15;
        if (cy > 0 && seen[cx][cy - 1] != g && b.c[cx][cy - 1] == col){ seen[cx][cy - 1] = g; stk[sp++] = k - 1; }
        if (cy + 1 < CTOP && seen[cx][cy + 1] != g && b.c[cx][cy + 1] == col){ seen[cx][cy + 1] = g; stk[sp++] = k + 1; }
        if (cx > 0 && seen[cx - 1][cy] != g && b.c[cx - 1][cy] == col){ seen[cx - 1][cy] = g; stk[sp++] = k - 16; }
        if (cx + 1 < W && seen[cx + 1][cy] != g && b.c[cx + 1][cy] == col){ seen[cx + 1][cy] = g; stk[sp++] = k + 16; }
      }
      if (gn >= 4){
        if (ngroups < 8){ sh.size[ngroups] = gn; sh.color[ngroups] = col; }
        ngroups++; totalPuyo += gn; colorMask |= (1 << col);
        renketsu += RENKETSU[std::min<int>(gn, (int)RENKETSU.size() - 1)];
        auto mark = [&](int cx, int cy){ clr[cx][cy] = g; if (cy < low[cx]) low[cx] = cy; };
        for (int i = 0; i < gn; i++){
          int cx = grp[i] >> 4, cy = grp[i] & 15;
          mark(cx, cy);
          if (cy > 0 && b.c[cx][cy - 1] == OJ) mark(cx, cy - 1);
          if (cy + 1 < CTOP && b.c[cx][cy + 1] == OJ) mark(cx, cy + 1);
          if (cx > 0 && b.c[cx - 1][cy] == OJ) mark(cx - 1, cy);
          if (cx + 1 < W && b.c[cx + 1][cy] == OJ) mark(cx + 1, cy);
        }
      }
    }
    if (!ngroups) break;
    rensasu++;
    LAST_PUYO += totalPuyo;
    if (rensasu <= 2){ sh.puyo = totalPuyo; sh.ngroups = std::min(ngroups, 8); LAST_STEP[rensasu - 1] = sh; }
    int iro = 0; for (int c = 1; c <= 4; c++) if (colorMask & (1 << c)) iro++;
    int bonus = RENSA[std::min<int>(rensasu, (int)RENSA.size() - 1)] + renketsu + IROKAZU[std::min<int>(iro, (int)IROKAZU.size() - 1)];
    total += bonus == 0 ? 10 * totalPuyo : 10 * totalPuyo * bonus;
    // 消した列だけ下に詰める。落ちたぷよ(位置が変わったもの)が次に調べるマス
    nc = 0;
    for (int x = 0; x < W; x++){
      if (low[x] == 99) continue;
      int w = low[x];
      for (int y = low[x]; y < b.h[x]; y++){
        if (clr[x][y] == g) continue;
        b.c[x][w] = b.c[x][y];
        if (w != y) cand[nc++] = x * 16 + w;
        w++;
      }
      for (int y = w; y < b.h[x]; y++) b.c[x][y] = 0;
      b.h[x] = (int8_t)w;
    }
  }
}

// 置いた (x, y) のぷよの塊が4個以上か
static bool group4(const Board& b, int x0, int y0){
  if (y0 < 0 || y0 >= CTOP) return false;
  int col = b.c[x0][y0];
  if (!col || col == OJ) return false;
  static uint32_t mark[6][13]; static uint32_t gen = 0;
  gen++;
  int stk[78], sp = 0, n = 0;
  stk[sp++] = x0 * 16 + y0; mark[x0][y0] = gen;
  while (sp){
    int k = stk[--sp], cx = k >> 4, cy = k & 15;
    if (++n >= 4) return true;
    if (cy > 0 && mark[cx][cy - 1] != gen && b.c[cx][cy - 1] == col){ mark[cx][cy - 1] = gen; stk[sp++] = k - 1; }
    if (cy + 1 < CTOP && mark[cx][cy + 1] != gen && b.c[cx][cy + 1] == col){ mark[cx][cy + 1] = gen; stk[sp++] = k + 1; }
    if (cx > 0 && mark[cx - 1][cy] != gen && b.c[cx - 1][cy] == col){ mark[cx - 1][cy] = gen; stk[sp++] = k - 16; }
    if (cx + 1 < W && mark[cx + 1][cy] != gen && b.c[cx + 1][cy] == col){ mark[cx + 1][cy] = gen; stk[sp++] = k + 16; }
  }
  return false;
}

// 盤面の良し悪しの目安(B の前半で、残す盤面を選ぶのに使う): どこかの列に1個だけ足したら撃てる、一番大きい点。
// 足しても消えないなら0。1個で撃てる形は、仕上げの数手で大きく撃てる形に近い
static int virtualFire(const Board& b){
  int best = 0;
  for (int x = 0; x < W; x++){
    int y = b.h[x];
    if (y >= CTOP) continue;
    for (int c = 1; c <= 4; c++){
      Board t = b; t.c[x][y] = (uint8_t)c; t.h[x] = (int8_t)(y + 1);
      if (!group4(t, x, y)) continue;
      int r, tot; resolveFast(t, x, y, -1, -1, r, tot);
      if (tot > best) best = tot;
    }
  }
  return best;
}

// 置き方の並び(finish.js の MOVES と同じ順)
struct Mv { int col, rot, cc; };
static std::vector<Mv> MOVES;

struct Fire { int used2, ojama, chain, at, keep; std::vector<Mv> moves; };   // keep = 撃ったあとに盤面に残る色ぷよの数(v0.10.34)

// 盤面の色ぷよ(おじゃま以外)の数
static int colored(const Board& b){ int n = 0; for (int x = 0; x < W; x++) for (int y = 0; y < b.h[x]; y++) if (b.c[x][y] != OJ) n++; return n; }

// まとめる表(64ビットの鍵。決まった大きさ。いっぱいなら覚えない = 同じ盤面をもう一度読むだけ)
struct Seen {
  std::vector<uint64_t> key; std::vector<uint32_t> gen; uint32_t g = 1; size_t mask;
  explicit Seen(int bits){ key.assign(size_t(1) << bits, 0); gen.assign(size_t(1) << bits, 0); mask = (size_t(1) << bits) - 1; }
  void reset(){ g++; }
  bool add(uint64_t k){
    size_t i = (size_t)(k ^ (k >> 29)) & mask;
    for (int p = 0; p < 32; p++, i = (i + 1) & mask){
      if (gen[i] != g){ gen[i] = g; key[i] = k; return true; }
      if (key[i] == k) return false;
    }
    return true;
  }
};
static Seen* SEEN = nullptr;

// 盤面の鍵は、マスごと・色ごとに決めたでたらめな数の排他的論理和(置くたび・戻すたびに1つ混ぜるだけで更新できる)
static uint64_t ZOB[6][13][6];
static uint64_t splitmix(uint64_t& s){ uint64_t z = (s += 0x9e3779b97f4a7c15ULL); z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL; z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL; return z ^ (z >> 31); }
static void initZob(){ uint64_t s = 20261025; for (int x = 0; x < 6; x++) for (int y = 0; y < 13; y++) for (int c = 0; c < 6; c++) ZOB[x][y][c] = splitmix(s); }
static uint64_t hashFull(const Board& b){ uint64_t h = 0; for (int x = 0; x < W; x++) for (int y = 0; y < b.h[x]; y++) h ^= ZOB[x][y][b.c[x][y]]; return h; }
static inline uint64_t keyOf(uint64_t h, int cost2, int depth){ uint64_t k = h ^ ((uint64_t)(cost2 + 1) * 0xd6e8feb86659fd93ULL) ^ ((uint64_t)(depth + 1) * 0xa0761d6478bd642fULL); return k ? k : 1; }

struct Search {
  Board b; int point0, maxPlace; long long nodeLimit; std::chrono::steady_clock::time_point deadline; bool useDeadline;
  std::vector<std::pair<int,int>> seq;   // 軸の色, 子の色
  std::vector<Fire> pareto, pareto2; std::vector<Mv> path;   // pareto2 は keepMode 5 の2連鎖の表
  long long nodes = 0; bool complete = true, stop = false;
  uint64_t hash = 0;

  // 他の候補に負けていなければ加える(負けている候補は手順を作らずに捨てる)。
  // keepMode なら「撃ったあとに残る色ぷよ」も比べる(副砲への返しのため。shio さんの希望: 返しで本線を崩さない)
  // keepMode 1 = 撃ったあとに残る色ぷよの数、2 = 撃ったあとに1個足せば撃てる一番大きい点(残る本線。v0.10.35、shio さんと決めた直し)
  // keepMode 3 = 単発(1連鎖)だけを集める(残るものは比べない。v0.10.41、shio さんの案: 数手先の強い単発を候補に足す)
  // keepMode 4 = 2連鎖だけを集める(v0.10.54、shio さんの案: 副砲の鋭さを上げるため、強い単発と同じ形で強い2連鎖も探す)
  // keepMode 5 = 1連鎖を pareto、2連鎖を pareto2 に分けて集める(v0.10.54、shio さんの指摘: 3 と 4 は同じ手順をたどるので、1回で両方集める。答えは 3 と 4 を別々に読むのと同じ)
  // keepMode の 16 の位: 2連鎖の効率の悪い形を除く(v0.10.56、shio さんの基準: 1段目6個以上 / 2段目が 4個+4個の2色 / 2段目が同色のダブル = 塊2つで同じ色)
  // keepMode の 64 の位: 2連鎖は「連鎖の点 ÷ 消えた色ぷよの数」が keepMode >> 8 点未満なら除く(v0.10.56、shio さんの案: 形より単純に効率で区切る。78点)
  // keepMode の 32 の位: 2連鎖は「撃ったあとに1個足せば撃てる一番大きい点(残る本線)」も比べる(v0.10.56、撃ったあとの形を読みの段階で比べる)
  int keepMode = 0;
  int base() const { return keepMode & 15; }
  int keepOf(const Board& bb) const { return base() == 2 ? virtualFire(bb) : base() == 1 ? colored(bb) : 0; }
  static bool shapeOk(int chain){
    if (chain != 2) return true;
    const StepShape& a = LAST_STEP[0]; const StepShape& c = LAST_STEP[1];
    if (a.puyo >= 6) return false;
    if (c.ngroups == 2 && c.size[0] == 4 && c.size[1] == 4 && c.color[0] != c.color[1]) return false;
    if (c.ngroups == 2 && c.color[0] == c.color[1]) return false;   // 同色のダブル(塊2つ・1色)。1色の8連結(塊1つ)や、3つ以上の塊の多色消しは残す
    return true;
  }
  // 連鎖を消した直後に呼ぶ(形は次の resolve で上書きされるので、残る本線を測る前に見る)
  void fireFound(int used2, int ojama, int total, const Board& after, int chain, int at, const Mv& last){
    if ((keepMode & 16) && !shapeOk(chain)) return;
    if ((keepMode & 64) && chain == 2 && total < (keepMode >> 8) * LAST_PUYO) return;
    int kp = ((keepMode & 32) && chain == 2) ? virtualFire(after) : keepOf(after);
    addFire(used2, ojama, kp, chain, at, last);
  }
  bool beats(int u1, int o1, int k1, int u2, int o2, int k2) const { return u1 <= u2 && o1 >= o2 && (!keepMode || k1 >= k2); }
  void addFire(int used2, int ojama, int keep, int chain, int at, const Mv& last){
    if (base() == 3 && chain != 1) return;
    if (base() == 4 && chain != 2) return;
    if (base() == 5 && chain != 1 && chain != 2) return;
    auto& pareto = (base() == 5 && chain == 2) ? this->pareto2 : this->pareto;
    for (auto& p : pareto) if (beats(p.used2, p.ojama, p.keep, used2, ojama, keep)) return;
    size_t w = 0;
    for (size_t i = 0; i < pareto.size(); i++) if (!beats(used2, ojama, keep, pareto[i].used2, pareto[i].ojama, pareto[i].keep)){ if (w != i) pareto[w] = std::move(pareto[i]); w++; }
    pareto.resize(w);
    Fire f; f.used2 = used2; f.ojama = ojama; f.chain = chain; f.at = at; f.keep = keep; f.moves = path; f.moves.push_back(last);
    pareto.push_back(std::move(f));
  }
  int drop(int x, int col){ if (b.h[x] >= H) return -1; int y = b.h[x]++; b.c[x][y] = (uint8_t)col; hash ^= ZOB[x][y][col]; return y; }
  // B(shio さんと決めた形): 前半 maxPlace - tail 手は、良さそうな盤面を beam 個だけ残して進み、最後の tail 手は全部読む。
  // 前半で消える置き方は、全部読むときと同じく発火として候補に入れる
  struct Node { Board b; uint64_t hash; int cost2, used2, score; std::vector<Mv> path; };
  void beamThenTail(int cost2, int beam, int tail){
    int front = maxPlace - tail;
    if (beam <= 0 || front <= 0){ dfs(cost2, 0, 0); return; }
    std::vector<Node> cur; cur.push_back({ b, hash, cost2, 0, 0, {} });
    for (int d = 0; d < front && !cur.empty() && !stop; d++){
      std::vector<Node> next;
      int a = seq[d].first, ch = seq[d].second;
      bool same = a == ch;
      for (Node& nd : cur){
        b = nd.b; hash = nd.hash; path = nd.path;
        for (const Mv& m : MOVES){
          if (same && (m.rot == 1 || m.rot == 2)) continue;
          if (b.h[m.col] >= H && b.h[m.cc] >= H) continue;
          Board keep = b; uint64_t keepH = hash;
          int ar, cr;
          if (m.rot == 2){ cr = drop(m.col, ch); ar = drop(m.col, a); } else { ar = drop(m.col, a); cr = drop(m.cc, ch); }
          nodes++;
          bool chig = m.col != m.cc && ar != cr;
          int pay2 = 2 + (chig ? CT2 : 0);
          if (group4(b, m.col, ar) || group4(b, m.cc, cr)){
            int rensasu, total; resolveFast(b, m.col, ar, m.cc, cr, rensasu, total);
            fireFound(nd.used2 + pay2 + rensasu * RT2, (point0 + DROP * (d + 1) + total) / RATE, total, b, rensasu, d + 1, m);
            b = keep; hash = keepH; continue;
          }
          int c2 = nd.cost2 - pay2;
          if (b.h[GX] > GY || c2 <= 0 || !SEEN->add(keyOf(hash, c2, d + 1))){ b = keep; hash = keepH; continue; }
          Node child{ b, hash, c2, nd.used2 + pay2, virtualFire(b), path };
          child.path.push_back(m);
          next.push_back(std::move(child));
          b = keep; hash = keepH;
        }
      }
      // 同点の順番は元のまま(stable_sort、v0.10.88)。std::sort だと同点の並びが作る環境(Windows / Linux / WebAssembly)で変わり、残す盤面も変わっていた
      std::stable_sort(next.begin(), next.end(), [](const Node& x, const Node& y){ return x.score > y.score; });
      if ((int)next.size() > beam) next.resize(beam);
      cur.swap(next);
    }
    for (Node& nd : cur){
      if (stop) break;
      b = nd.b; hash = nd.hash; path = nd.path;
      dfs(nd.cost2, nd.used2, front);
    }
  }
  void dfs(int cost2, int used2, int depth){
    if (stop) return;
    if (nodes > nodeLimit || (useDeadline && (nodes & 1023) == 0 && std::chrono::steady_clock::now() > deadline)){ complete = false; stop = true; return; }
    int a = seq[depth].first, ch = seq[depth].second;
    bool same = a == ch;
    for (const Mv& m : MOVES){
      if (same && (m.rot == 1 || m.rot == 2)) continue;
      if (b.h[m.col] >= H && b.h[m.cc] >= H) continue;   // どちらの列にも空きが無い
      int ar, cr;
      if (m.rot == 2){ cr = drop(m.col, ch); ar = drop(m.col, a); } else { ar = drop(m.col, a); cr = drop(m.cc, ch); }
      nodes++;
      bool chig = m.col != m.cc && ar != cr;
      int pay2 = 2 + (chig ? CT2 : 0);
      // 元に戻す(上に積んだ方から)
      auto undo = [&](){
        int ys[2] = { ar, cr }, xs[2] = { m.col, m.cc };
        int first = (ar >= cr) ? 0 : 1;
        for (int t = 0; t < 2; t++){ int i = t == 0 ? first : 1 - first; if (ys[i] >= 0){ hash ^= ZOB[xs[i]][ys[i]][b.c[xs[i]][ys[i]]]; b.c[xs[i]][ys[i]] = 0; b.h[xs[i]]--; } }
      };
      if (group4(b, m.col, ar) || group4(b, m.cc, cr)){
        Board b2 = b;
        undo();
        int rensasu, total;
        if (FAST) resolveFast(b2, m.col, ar, m.cc, cr, rensasu, total); else resolve(b2, rensasu, total);
        fireFound(used2 + pay2 + rensasu * RT2, (point0 + DROP * (depth + 1) + total) / RATE, total, b2, rensasu, depth + 1, m);
        continue;
      }
      int c2 = cost2 - pay2;
      if (b.h[GX] > GY || c2 <= 0 || depth + 1 >= maxPlace){ undo(); continue; }   // 負けの場所が埋まる / もう置けない / 読む上限
      if (!SEEN->add(keyOf(hash, c2, depth + 1))){ undo(); continue; }
      path.push_back(m);
      dfs(c2, used2 + pay2, depth + 1);
      path.pop_back();
      undo();
      if (stop) return;
    }
  }
};

#include <unordered_map>
#include <cmath>
#include "ama_part.inc"

static std::vector<int> readList(){ int n; if (scanf("%d", &n) != 1) return {}; std::vector<int> v(n); for (int i = 0; i < n; i++) scanf("%d", &v[i]); return v; }

// 始めに1回だけ用意する(v0.10.88: ブラウザ版 finish_wasm.cpp からも呼べるよう main から分けた。中身は前と同じ)
static void initAll(){
  for (int rot = 0; rot < 4; rot++) for (int col = (rot == 1 ? 1 : 0); col <= (rot == 3 ? 4 : 5); col++)
    MOVES.push_back({ col, rot, rot == 1 ? col - 1 : rot == 3 ? col + 1 : col });
  SEEN = new Seen(22);
  initZob();
  if (getenv("FINISH_SLOW")) FAST = false;
}

// 問い合わせを1つ読んで答える。E か入力の終わりなら false
static bool handleOne(){
  char tag[8];
  if (scanf("%7s", tag) != 1) return false;
  {
    if (tag[0] == 'E') return false;
    if (tag[0] == 'M'){ ama::handle(); return true; }   // 本線を組む読み(v0.10.36)
    if (tag[0] == 'R'){
      scanf("%d %d %d %d %d %d %d %d %d %d", &W, &H, &CTOP, &GX, &GY, &OJ, &RATE, &DROP, &RT2, &CT2);
      RENSA = readList(); RENKETSU = readList(); IROKAZU = readList();
      return true;
    }
    // Q
    static char bs[128];
    Search s; int cost2, nseq; long long timeMs;
    scanf("%127s %d %d %d %lld %lld %d", bs, &cost2, &s.point0, &s.maxPlace, &s.nodeLimit, &timeMs, &nseq);
    for (int x = 0; x < W; x++){ s.b.h[x] = 0; for (int y = 0; y < H; y++){ int v = bs[x * H + y] - '0'; s.b.c[x][y] = (uint8_t)v; if (v) s.b.h[x] = (int8_t)(y + 1); } }
    s.seq.resize(nseq);
    for (int i = 0; i < nseq; i++) scanf("%d %d", &s.seq[i].first, &s.seq[i].second);
    int beam = 0, tail = 0; scanf("%d %d %d", &beam, &tail, &s.keepMode);
    if (s.nodeLimit <= 0) s.nodeLimit = (long long)4e18;
    s.useDeadline = timeMs > 0;
    s.deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeMs > 0 ? timeMs : 0);
    if (s.maxPlace > nseq) s.maxPlace = nseq;
    SEEN->reset();
    s.hash = hashFull(s.b);
    if (cost2 > 0 && s.maxPlace > 0) s.beamThenTail(cost2, beam, tail);
    auto byUsed = [](const Fire& a, const Fire& b){ return a.used2 < b.used2; };
    std::stable_sort(s.pareto.begin(), s.pareto.end(), byUsed);   // 同点の順番は元のまま(上と同じ理由)
    std::stable_sort(s.pareto2.begin(), s.pareto2.end(), byUsed);
    printf("A %lld %d %d", s.nodes, s.complete ? 1 : 0, (int)s.pareto.size());
    // keepMode 5 は、1連鎖の表のあとに2連鎖の表(数 + 中身)を続ける
    for (int list = 0; list < (s.base() == 5 ? 2 : 1); list++){
      if (list == 1) printf(" %d", (int)s.pareto2.size());
      for (auto& f : (list == 0 ? s.pareto : s.pareto2)){
        // 残る色ぷよは、比べると頼まれたときだけ出す(前の形のまま問い合わせる側も、同じ答えの形で読めるように)
        if (s.keepMode) printf(" %d %d %d %d %d %d", f.used2, f.ojama, f.chain, f.at, f.keep, (int)f.moves.size());
        else printf(" %d %d %d %d %d", f.used2, f.ojama, f.chain, f.at, (int)f.moves.size());
        for (auto& m : f.moves) printf(" %d %d", m.col, m.rot);
      }
    }
    printf("\n"); fflush(stdout);
  }
  return true;
}

#ifndef FINISH_NO_MAIN
int main(){
  initAll();
  while (handleOne()){}
  return 0;
}
#endif
