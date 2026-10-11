// node_modules から、ブラウザで使うファイルを vendor/ にコピーする(npm install のあとに 1 回実行)。
//   node scripts/copy-vendor.mjs
//
// vendor/kuromoji/kuromoji.js      … 辞書のローダーにパッチを当てる(下記)
// vendor/kuromoji/dict/*.dat.gz
// vendor/tesseract/tesseract.min.js, worker.min.js
// vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js, tesseract-core-lstm.wasm.js
// vendor/tesseract/lang/jpn.traineddata.gz, jpn_vert.traineddata.gz (4.0.0_best_int)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const V = path.join(ROOT, 'vendor');

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(path.relative(ROOT, to), (fs.statSync(to).size / 1024).toFixed(0) + ' KB');
}

fs.rmSync(V, { recursive: true, force: true });

// ---- kuromoji ----
// サーバーが Content-Encoding: gzip を付けて配信すると、ブラウザが展開済みのデータを渡してくるので、
// 二重に展開して失敗する。gzip の先頭バイト(1f 8b)を見て、展開済みなら展開を飛ばす。
const KURO_ORIG =
  '        var gz = new zlib.Zlib.Gunzip(new Uint8Array(arraybuffer));\n' +
  '        var typed_array = gz.decompress();\n' +
  '        callback(null, typed_array.buffer);';
const KURO_PATCH =
  '        var bytes = new Uint8Array(arraybuffer);\n' +
  '        if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {\n' +
  '            callback(null, arraybuffer); // 展開済み(Content-Encoding: gzip で配信された)\n' +
  '            return;\n' +
  '        }\n' +
  '        var gz = new zlib.Zlib.Gunzip(bytes);\n' +
  '        var typed_array = gz.decompress();\n' +
  '        callback(null, typed_array.buffer);';
{
  const src = fs.readFileSync(path.join(NM, 'kuromoji/build/kuromoji.js'), 'utf8').replace(/\r\n/g, '\n');
  if (!src.includes(KURO_ORIG)) throw new Error('kuromoji.js のパッチ箇所が見つかりません(バージョンが違う?)');
  const out = path.join(V, 'kuromoji/kuromoji.js');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, '/* kuromoji.js 0.1.2 (Apache-2.0) — 辞書の二重展開を防ぐパッチ入り */\n' + src.replace(KURO_ORIG, KURO_PATCH));
  console.log('vendor/kuromoji/kuromoji.js (patched)');
  for (const f of fs.readdirSync(path.join(NM, 'kuromoji/dict'))) {
    if (f.endsWith('.dat.gz')) copy(path.join(NM, 'kuromoji/dict', f), path.join(V, 'kuromoji/dict', f));
  }
  copy(path.join(NM, 'kuromoji/LICENSE-2.0.txt'), path.join(V, 'kuromoji/LICENSE-2.0.txt'));
  copy(path.join(NM, 'kuromoji/NOTICE.md'), path.join(V, 'kuromoji/NOTICE.md'));
}

// ---- Tesseract.js ----
for (const f of ['tesseract.min.js', 'worker.min.js']) copy(path.join(NM, 'tesseract.js/dist', f), path.join(V, 'tesseract', f));
copy(path.join(NM, 'tesseract.js/LICENSE.md'), path.join(V, 'tesseract/LICENSE.md'));
for (const f of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']) {
  copy(path.join(NM, 'tesseract.js-core', f), path.join(V, 'tesseract/core', f));
}
copy(path.join(NM, 'tesseract.js-core/LICENSE'), path.join(V, 'tesseract/core/LICENSE'));
for (const lang of ['jpn', 'jpn_vert']) {
  copy(
    path.join(NM, `@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`),
    path.join(V, `tesseract/lang/${lang}.traineddata.gz`),
  );
}
