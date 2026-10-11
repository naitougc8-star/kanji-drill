import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { candidates, makeScorer, guessTarget, normalizeReading } from '../../yomi.js';
import { cleanLine } from '../../words.js';
import { removeLines, removeOutsideBlobs } from '../../marker.js';

const require = createRequire(import.meta.url);
const kuromoji = require('kuromoji');
const cache = {};
async function lookup(r) {
  const k = r.codePointAt(0).toString(16);
  const f = `data/yomi/y${k}.json`;
  if (!(k in cache)) cache[k] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  const v = cache[k][r];
  return v ? v.split(',') : [];
}
const common = new Set(JSON.parse(fs.readFileSync('data/yomi/index.json', 'utf8')).joyo);
let score;

beforeAll(async () => {
  const t = await new Promise((resolve, reject) =>
    kuromoji.builder({ dicPath: 'node_modules/kuromoji/dict/' }).build((e, tk) => (e ? reject(e) : resolve(tk))),
  );
  score = makeScorer(t);
});

describe('読みから答えの候補', () => {
  // 書き取りプリントによくある形(前, 読み, 後, 正解)。正解が 1 位に来ること。
  const cases = [
    ['', 'てんじょう', 'の高い家', '天井'],
    ['髪を', 'かわかす', '', '乾かす'],
    ['きふくの', 'ゆるやか', 'なおか', '緩やか'],
    ['', 'だまって', '聞く', '黙って'],
    ['それはルール', 'いはん', 'だ', '違反'],
    ['色が', 'ちがう', '', '違う'],
    ['', 'しんえん', 'な思想', '深遠'],
    ['', 'ほのお', 'があがる', '炎'],
    ['生きるのに水は', 'ひっす', '', '必須'],
    ['', 'ちきゅうぎ', 'をまわす', '地球儀'],
    ['', 'けいしゃ', 'した土地', '傾斜'],
    ['', 'おどろいた', '表情', '驚いた'],
    ['', 'くつした', 'をはく', '靴下'],
    ['', 'たいいくかん', 'にプール', '体育館'],
    ['', 'せきにん', 'をまぬがれる', '責任'],
    ['友達に', 'あやまる', '', '謝る'],
  ];
  for (const [before, reading, after, answer] of cases) {
    it(`${before}[${reading}]${after} → ${answer}`, async () => {
      const list = await candidates(reading, { lookup, score, common, before, after });
      expect(list[0], list.join(' ')).toBe(answer);
      expect(list.length).toBeLessThanOrEqual(8);
    });
  }

  it('文脈がなくても、正解が候補に入る(起伏・侯爵)', async () => {
    expect(await candidates('きふく', { lookup, score, common })).toContain('起伏');
    expect(await candidates('こうしゃく', { lookup, score, common, after: 'の位' })).toContain('侯爵');
  });

  it('kuromoji の辞書が読めなくても(辞書の順で)候補を出す', async () => {
    // 文脈で並べ替えられないので 1 位とは限らない(てんじょう は「添乗」が先に来る)
    expect(await candidates('てんじょう', { lookup, common })).toContain('天井');
  });

  it('カタカナや記号の混じった読みもそろえる', () => {
    expect(normalizeReading('テンジョウ ')).toBe('てんじょう');
  });

  it('書き取る部分の当たりを付ける(辞書に載っている、いちばん長い仮名の並び)', async () => {
    expect(await guessTarget('てんじょうの高い家', lookup)).toEqual([0, 5]);
    expect(await guessTarget('髪をかわかす', lookup)).toEqual([2, 6]);
    expect(await guessTarget('高い家', lookup)).toBeNull();
  });
});

describe('なぞって読み取った行の掃除', () => {
  it('傍線・括弧・数字などを取り除く', () => {
    expect(cleanLine('|(1)てんじょう\nの高い家」【 】-')).toBe('てんじょうの高い家');
    expect(cleanLine('。、それはルール[いはん]だ')).toBe('それはルールいはんだ');
  });

  it('文字の向きに沿った長い直線だけを消す', () => {
    const W = 40, H = 200;
    const g = new Uint8ClampedArray(W * H).fill(255);
    for (let y = 10; y < 190; y++) g[y * W + 35] = 0; // 長い縦線(傍線)
    for (let y = 20; y < 40; y++) g[y * W + 10] = 0; // 短い縦画(文字)
    removeLines(g, W, H, true, 60);
    expect(g[100 * W + 35]).toBe(255);
    expect(g[30 * W + 10]).toBe(0);
  });

  it('帯の外に大部分がはみ出した塊を消す', () => {
    const W = 30, H = 30;
    const g = new Uint8ClampedArray(W * H).fill(255);
    const inside = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 5; x < 20; x++) inside[y * W + x] = 1; // 帯
    for (let x = 8; x < 12; x++) g[10 * W + x] = 0; // 帯の中の塊
    for (let x = 17; x < 28; x++) g[20 * W + x] = 0; // 大部分が帯の外の塊
    removeOutsideBlobs(g, inside, W, H);
    expect(g[10 * W + 9]).toBe(0);
    expect(g[20 * W + 18]).toBe(255);
  });
});
