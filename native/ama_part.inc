
// ==== 本線を組む読み(builder.js の amaSearch と同じ手順。v0.10.36、shio さんの希望で速くするため) ====
// JavaScript 版と、候補の並び・点数まで同じ答えになるように書いている(verify_ama_native.js で突き合わせる)。
// 並べ替えは JavaScript と同じく「同じ点なら先に入ったものが先」(stable_sort)。同じ盤面は最初に入った位置のまま置き換える(Map と同じ)。
namespace ama {
static const int ROWS12 = 12, PRUNE = 5000;
static const int SHAPE[6] = { 1, 1, 1, -1, -1, -1 };
// tearMul(v0.10.67、shio さんの指摘「ちぎりの0.5手を評価できているか」): 撃てた連鎖の点を、そこまでのちぎり1回ごとに (1 - tearMul) 倍にして比べる。0 なら今まで通り
struct Wt { double chain, y, key, chi, link2, link3, shape, well, bump, nuisance, tear, waste, tearMul; };
static void heights(const Board& b, int h[6]){ for (int x = 0; x < W; x++){ int y = 0; while (y < H && b.c[x][y]) y++; h[x] = y; } }
static void links(const Board& b, int& n2, int& n3){
  uint8_t l3[6][12]; memset(l3, 0, sizeof l3);
  auto same = [&](int x, int y, int c){ return x >= 0 && x < W && y >= 0 && y < ROWS12 && b.c[x][y] == c; };
  n3 = 0;
  for (int x = 0; x < W; x++) for (int y = 0; y < ROWS12; y++){
    int c = b.c[x][y]; if (!c || c == OJ) continue;
    bool u = same(x, y + 1, c), d = same(x, y - 1, c), l = same(x - 1, y, c), r = same(x + 1, y, c);
    if (((u || d) && (l || r)) || (u && d) || (l && r)){ l3[x][y] = 1; n3++; }
  }
  auto near3 = [&](int x, int y){ return l3[x][y] || (y + 1 < ROWS12 && l3[x][y + 1]) || (y > 0 && l3[x][y - 1]) || (x > 0 && l3[x - 1][y]) || (x + 1 < W && l3[x + 1][y]); };
  n2 = 0;
  for (int x = 0; x < W; x++) for (int y = 0; y < ROWS12; y++){
    int c = b.c[x][y]; if (!c || c == OJ) continue;
    if ((same(x, y + 1, c) || same(x - 1, y, c)) && !near3(x, y)) n2++;
  }
}
static int chiAt(const int h[6], int x){
  int chi = 0;
  if (x < W - 1){ for (int i = x + 1; i < W; i++){ if (h[i] > h[x]) break; chi++; } for (int i = x + 1; i < W; i++){ if (h[i] >= h[x]) break; chi++; } }
  if (x > 0){ for (int i = x - 1; i >= 0; i--){ if (h[i] > h[x]) break; chi++; } for (int i = x - 1; i >= 0; i--){ if (h[i] >= h[x]) break; chi++; } }
  return chi;
}
static int groupAt(const Board& b, int x0, int y0){
  int c = b.c[x0][y0]; uint8_t seen[6][13]; memset(seen, 0, sizeof seen);
  int st[80], sp = 0, n = 0; st[sp++] = x0 * 16 + y0; seen[x0][y0] = 1;
  while (sp){
    int k = st[--sp], cx = k >> 4, cy = k & 15; n++;
    const int nx[4] = { cx + 1, cx - 1, cx, cx }, ny[4] = { cy, cy, cy + 1, cy - 1 };
    for (int t = 0; t < 4; t++){
      int x = nx[t], y = ny[t];
      if (x < 0 || x >= W || y < 0 || y >= CTOP || seen[x][y] || b.c[x][y] != c) continue;
      seen[x][y] = 1; st[sp++] = x * 16 + y;
    }
  }
  return n;
}
static double eval(const Board& b, const Wt& w){
  int h[6]; heights(b, h);
  double q = -INFINITY;
  int lo = 2, hi = 2;
  for (int x = 3; x < W; x++){ if (h[x] > 11) break; hi = x; }
  for (int x = 1; x >= 0; x--){ if (h[x] > 11) break; lo = x; }
  for (int x = lo; x <= hi; x++){
    int dmax = std::min(3, 12 - h[x]);
    if (dmax <= 0) continue;
    for (int c = 1; c <= 4; c++){
      Board plan = b; int need = 0;
      for (int i = 0; i < dmax; i++){
        plan.c[x][h[x] + i] = (uint8_t)c; plan.h[x] = (int8_t)(h[x] + i + 1);
        if (groupAt(plan, x, h[x]) >= 4){ need = i + 1; break; }
      }
      if (!need) continue;
      // 盤面はもともと消える塊が無いので、積んだマスから調べれば resolve と同じ答えになる(速くするため)
      int st[3]; for (int i = 0; i < need; i++) st[i] = x * 16 + h[x] + i;
      int rensasu, total; resolveFrom(plan, st, need, rensasu, total);
      if (rensasu <= 1) continue;
      int r2, r3; links(plan, r2, r3);
      double s = rensasu * w.chain + h[x] * w.y + need * w.key + chiAt(h, x) * w.chi + r2 * w.link2 + r3 * w.link3;
      if (s > q) q = s;
    }
  }
  double v = q > -INFINITY ? q : 0;
  int sum = 0; for (int x = 0; x < W; x++) sum += h[x];
  int avg = sum / W;
  int shape = 0; for (int x = 0; x < W; x++) shape += std::abs(h[x] - avg - SHAPE[x]);
  int well = 0;
  if (h[0] < h[1]) well += h[1] - h[0];
  if (h[5] < h[4]) well += h[4] - h[5];
  for (int i = 1; i < 5; i++) if (h[i] < h[i - 1] && h[i] < h[i + 1]) well += std::min(h[i - 1], h[i + 1]) - h[i];
  int bump = 0; for (int i = 1; i < 5; i++) if (h[i] > h[i - 1] && h[i] > h[i + 1]) bump += h[i] - std::max(h[i - 1], h[i + 1]);
  int l2, l3; links(b, l2, l3);
  int garbage = 0; for (int x = 0; x < W; x++) for (int y = 0; y < H; y++) if (b.c[x][y] == OJ) garbage++;
  return v + shape * w.shape + well * w.well + bump * w.bump + l2 * w.link2 + l3 * w.link3 + garbage * w.nuisance;
}
struct Node { Board b; double action, ev; int index, chig; };
struct Cand { Mv mv; double score; int chain; double tail; };
// 置く(engine.js の simulateMove と同じ。連鎖も最後まで)。置けなければ false
static bool simMove(Board& b, const Mv& m, int a, int ch, bool& chig, int& rensasu, int& total){
  if (b.h[m.col] >= H && b.h[m.cc] >= H) return false;
  auto drop = [&](int x, int col){ if (b.h[x] >= H) return -1; int y = b.h[x]++; b.c[x][y] = (uint8_t)col; return y; };
  int ar, cr;
  if (m.rot == 2){ cr = drop(m.col, ch); ar = drop(m.col, a); } else { ar = drop(m.col, a); cr = drop(m.cc, ch); }
  chig = m.col != m.cc && ar != cr;
  rensasu = 0; total = 0;
  if (group4(b, m.col, ar) || group4(b, m.cc, cr)) resolveFast(b, m.col, ar, m.cc, cr, rensasu, total);
  return true;
}
template <class F> static void expand(const Node& node, int a, int ch, const Wt& w, F&& cb){
  for (const Mv& m : MOVES){
    Node child{ node.b, 0, 0, node.index, node.chig };
    bool chig; int rensasu, total;
    if (!simMove(child.b, m, a, ch, chig, rensasu, total)) continue;
    if (child.b.c[GX][GY] != 0) continue;   // 窒息
    child.action = node.action + (chig ? w.tear : 0) + rensasu * w.waste;
    child.chig += chig ? 1 : 0;
    cb(child, m, rensasu, total);
  }
}
static std::vector<Cand> search(const Board& root, const std::vector<std::pair<int,int>>& seq, int width, int depth, bool noFire, const Wt& w){
  std::vector<Cand> cand; std::vector<Node> layer;
  Node rootNode{ root, 0, 0, -1, 0 };
  auto worth = [&](int total, int chig){ return w.tearMul > 0 ? total * std::pow(1 - w.tearMul, chig) : (double)total; };
  expand(rootNode, seq[0].first, seq[0].second, w, [&](Node& child, const Mv& m, int rensasu, int total){
    if (noFire && rensasu) return;
    child.index = (int)cand.size();
    cand.push_back({ m, rensasu ? worth(total, child.chig) : 0, rensasu, -INFINITY });
    child.ev = eval(child.b, w);
    layer.push_back(child);
  });
  for (int i = 1; i < depth && !layer.empty(); i++){
    std::vector<Node> next; std::unordered_multimap<uint64_t, int> pos; pos.reserve(width * 24);
    int a = seq[i].first, ch = seq[i].second;
    for (const Node& node : layer){
      expand(node, a, ch, w, [&](Node& child, const Mv& m, int rensasu, int total){
        Cand& c = cand[child.index];
        if (rensasu && worth(total, child.chig) > c.score){ c.score = worth(total, child.chig); c.chain = rensasu; }
        if (rensasu && total >= PRUNE) return;   // 大きな連鎖を撃った筋はここまで
        uint64_t k = hashFull(child.b);
        int at = -1;
        for (auto r = pos.equal_range(k); r.first != r.second; ++r.first)
          if (!memcmp(next[r.first->second].b.c, child.b.c, sizeof child.b.c)){ at = r.first->second; break; }
        if (at >= 0 && next[at].action >= child.action) return;   // 同じ盤面なら、置き方の減点が少ないほうを残す
        child.ev = at >= 0 ? next[at].ev : eval(child.b, w);
        if (at >= 0) next[at] = child; else { pos.emplace(k, (int)next.size()); next.push_back(child); }
      });
    }
    std::stable_sort(next.begin(), next.end(), [](const Node& x, const Node& y){ return (y.action + y.ev) < (x.action + x.ev); });
    if ((int)next.size() > width) next.resize(width);
    layer.swap(next);
    for (const Node& n : layer){ Cand& c = cand[n.index]; if (n.action + n.ev > c.tail) c.tail = n.action + n.ev; }
  }
  std::stable_sort(cand.begin(), cand.end(), [](const Cand& x, const Cand& y){ return x.score != y.score ? x.score > y.score : x.tail > y.tail; });
  return cand;
}
// 問い合わせ: M 盤面78文字 読む手数 残す数 1手目で撃たない(1/0) 重み13個 n 軸 子 …
// 答え: M 候補の数 { 列 向き 得点 連鎖数 残った盤面の一番良い点(無ければ x) } …
static void handle(){
  static char bs[128]; int depth, width, noFire, nseq; Wt w;
  if (scanf("%127s %d %d %d %lf %lf %lf %lf %lf %lf %lf %lf %lf %lf %lf %lf %lf %d", bs, &depth, &width, &noFire,
            &w.chain, &w.y, &w.key, &w.chi, &w.link2, &w.link3, &w.shape, &w.well, &w.bump, &w.nuisance, &w.tear, &w.waste, &w.tearMul, &nseq) != 18) return;
  Board b; for (int x = 0; x < W; x++){ b.h[x] = 0; for (int y = 0; y < H; y++){ int v = bs[x * H + y] - '0'; b.c[x][y] = (uint8_t)v; if (v) b.h[x] = (int8_t)(y + 1); } }
  std::vector<std::pair<int,int>> seq(nseq);
  for (int i = 0; i < nseq; i++) scanf("%d %d", &seq[i].first, &seq[i].second);
  if (depth > nseq) depth = nseq;
  std::vector<Cand> cand;
  if (depth > 0) cand = search(b, seq, width, depth, noFire != 0, w);
  printf("M %d", (int)cand.size());
  for (auto& c : cand){
    if (std::isinf(c.tail)) printf(" %d %d %.17g %d x", c.mv.col, c.mv.rot, c.score, c.chain);
    else printf(" %d %d %.17g %d %.17g", c.mv.col, c.mv.rot, c.score, c.chain, c.tail);
  }
  printf("\n"); fflush(stdout);
}
}  // namespace ama
