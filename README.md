# JurokuteSaki — ターン制ぷよぷよ

ブラウザで遊べるターン制のぷよぷよと、その最新AIです。

**遊ぶ:** https://ot-vibecoding.github.io/JurokuteSaki/

サーバーは要りません。AI はブラウザの中で考えます(1手 0.1〜0.5 秒ほど)。

## 普通のぷよぷよと違うところ

- ツモは16組の並びで、対局の始めから両者に全部見えています。
- 両者に「手数」があり、使い切ると相手の手番になります。置く: 1、ちぎり: +0.5、連鎖: 1連鎖につき 1.5。
- 予告おじゃまは、受ける側の手番の終わりに最大30個ずつ降ります。

## 中身

| 場所 | 中身 |
|---|---|
| `index.html` | ゲームの画面 |
| `strategy.js` ほか | 最新AI(tri)。読みで候補を出し、自己対戦で学んだ勝率の見積もり(`runs/tri/r14_td/value.json`)で選ぶ |
| `native/finish.cpp` | 読みの重い部分(C++)。ブラウザ用には WebAssembly に変換する(`native/finish_wasm.cpp`) |
| `web/` | ブラウザ版を作る道具と、PC 版と同じ手を打つかの確かめ |
| `.github/workflows/pages.yml` | push すると、まとめる → 変換 → 確かめ → 公開 を GitHub が行う |

手元で作るとき: `node web/build_web.js --out dist` のあと、`em++`(Emscripten)で `native/finish_wasm.cpp` を `dist/ai/finish_wasm.js` に変換します(コマンドは `pages.yml` と同じ)。

## 参考にしたもの

- **ama**(https://github.com/citrus610/ama) … 本家ぷよぷよ通のAI。`engine.js` の `deepChainPotential`(連鎖の伸びしろの探し方)は ama の `ai/search/dfs/quiet.cpp` の考え方と手順に、`builder.js` の `amaSearch`(組み立てのビームサーチ。C++ 版は `native/ama_part.inc`)と、その盤面の点数・伸びしろの探し方・重みは ama の `ai/search/beam/` と `config.json` の手順と値に倣い、このゲームのルールに合わせて書き直したものです。ama は次の MIT ライセンスで公開されています。

```
MIT License

Copyright (c) 2023 citrus610

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
