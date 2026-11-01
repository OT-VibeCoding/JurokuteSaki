// バージョン情報。VERSIONファイルを唯一の情報源とし、Node側・Python側の両方で読む。
const fs = require('fs');
const path = require('path');
const VERSION = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim();
// データ形式の版。これが変わると過去のデータと混ぜられない。
//   1 = 自分のツモ8手のみ
//   2 = 自分のツモ16手 + 相手のツモ8手
const DATA_FORMAT = 2;
module.exports = { VERSION, DATA_FORMAT };
