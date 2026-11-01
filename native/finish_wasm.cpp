// ブラウザ版(WebAssembly)の入口(v0.10.88)。finish.cpp をそのまま取り込み、標準入力・標準出力の代わりに
// 文字列でやりとりする。読み方・答えは finish.exe とまったく同じ(web/test で確かめる)。
//
//   const char* finish_query(const char* lines)   // 問い合わせ(R / Q / M の行、いくつでも)を渡し、答えの行をまとめて返す
//
// 変換は GitHub Actions で行う(.github/workflows/pages.yml):
//   em++ -O2 -std=c++17 native/finish_wasm.cpp -o finish_wasm.js -sMODULARIZE ... -sEXPORTED_FUNCTIONS=_finish_query
#include <cstdio>
#include <cstdlib>
#include <string>

static FILE* g_in = nullptr;
static FILE* g_out = nullptr;
// finish.cpp の scanf / printf を、文字列につないだ g_in / g_out に向ける
#define scanf(...) fscanf(g_in, __VA_ARGS__)
#define printf(...) fprintf(g_out, __VA_ARGS__)
#define FINISH_NO_MAIN
#include "finish.cpp"
#undef scanf
#undef printf

static bool g_ready = false;
static std::string g_answer;

extern "C" const char* finish_query(const char* lines){
  if (!g_ready){ initAll(); g_ready = true; }
  std::string in(lines);
  in += "\n";
  g_in = fmemopen((void*)in.data(), in.size(), "r");
  char* buf = nullptr; size_t len = 0;
  g_out = open_memstream(&buf, &len);
  while (handleOne()){}
  fclose(g_in); fclose(g_out);
  g_answer.assign(buf ? buf : "", len);
  free(buf);
  return g_answer.c_str();
}
