// 読み(ひらがな)→ 漢字の表記 の辞書(data/yomi/*.json)を、mecab-ipadic の CSV から作る。
//   node scripts/build-yomi.mjs
// 書き取りプリントの「てんじょう」→ 天井 のような、答えの候補を出すために使う。
//
// 出力: data/yomi/yXXXX.json(読みの先頭の字のコードポイントごと)
//   { "てんじょう": "天井,殿上,天上,天壌,添乗", ... }  常用漢字だけの表記が先、その中では mecab のコストが小さい順
//   index.json には常用漢字の一覧(joyo)も入れる(候補の並べ替えに使う)
// mecab-ipadic © Nara Institute of Science and Technology(ライセンスは NOTICE を参照)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'node_modules/mecab-ipadic-seed/lib/dict');
const OUT = path.join(ROOT, 'data/yomi');
// 固有名詞(人名・地名・組織名)と数は除く
const FILES = ['Noun.csv', 'Noun.adjv.csv', 'Noun.verbal.csv', 'Noun.adverbal.csv', 'Noun.nai.csv', 'Noun.others.csv', 'Verb.csv', 'Adj.csv', 'Adverb.csv', 'Adnominal.csv'];
const MAX_PER_READING = 8;
const KANJI = /[一-鿿々〆]/;
const JOYO = new Set(createRequire(import.meta.url)('joyo-kanji').kanji); // 常用漢字 2136 字(joyo-kanji, MIT)
const isJoyo = (s) => [...s].every((c) => !KANJI.test(c) || c === '々' || JOYO.has(c));

export function kataToHira(s) {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

function main() {
  const best = new Map(); // reading → Map(surface → cost)
  let rows = 0;
  for (const f of FILES) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const line of text.split('\n')) {
      const c = line.split(',');
      if (c.length < 12) continue;
      const surface = c[0], cost = Number(c[3]), reading = kataToHira(c[11] || '');
      if (!KANJI.test(surface) || !/^[ぁ-ゖー]+$/.test(reading)) continue;
      rows++;
      if (!best.has(reading)) best.set(reading, new Map());
      const m = best.get(reading);
      if (!m.has(surface) || m.get(surface) > cost) m.set(surface, cost);
    }
  }
  const buckets = new Map();
  for (const [reading, m] of best) {
    // 常用漢字だけで書ける表記を先に、その中ではコストの小さい順
    const list = [...m].sort((a, b) => isJoyo(b[0]) - isJoyo(a[0]) || a[1] - b[1]).slice(0, MAX_PER_READING).map((x) => x[0]);
    const key = reading.codePointAt(0).toString(16);
    if (!buckets.has(key)) buckets.set(key, {});
    buckets.get(key)[reading] = list.join(',');
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  let total = 0;
  for (const [key, obj] of buckets) {
    const json = JSON.stringify(obj);
    fs.writeFileSync(path.join(OUT, `y${key}.json`), json);
    total += Buffer.byteLength(json);
  }
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ source: 'mecab-ipadic 2.7.0-20070801', buckets: [...buckets.keys()].sort(), joyo: [...JOYO].join('') }));
  fs.copyFileSync(path.join(ROOT, 'node_modules/mecab-ipadic-seed/lib/dict/COPYING'), path.join(OUT, 'COPYING-ipadic.txt'));
  console.log(`${rows} 行 → 読み ${best.size} 種類, ${buckets.size} ファイル, 合計 ${(total / 1024 / 1024).toFixed(2)} MB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
