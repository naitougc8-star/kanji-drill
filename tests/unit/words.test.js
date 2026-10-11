import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { extractWords, segments, kataToHira, cleanText } from '../../words.js';

const require = createRequire(import.meta.url);
const kuromoji = require('kuromoji');
let tokenizer;

beforeAll(async () => {
  tokenizer = await new Promise((resolve, reject) =>
    kuromoji.builder({ dicPath: 'node_modules/kuromoji/dict/' }).build((e, t) => (e ? reject(e) : resolve(t))),
  );
});

describe('語の取り出し', () => {
  it('漢字を含む語に読みを付け、助詞・助動詞・記号を除く。同じ語は 1 回だけ', () => {
    const text = '今日は学校で漢字を覚える。明日も学校へ行く。';
    const words = extractWords(text, tokenizer.tokenize(text));
    const list = words.map((w) => `${w.word}:${w.reading}`);
    expect(list).toEqual(['今日:きょう', '学校:がっこう', '漢字:かんじ', '覚える:おぼえる', '明日:あした', '行く:いく']);
  });

  it('語が出てきた文の前後を持つ(文をまたがない)', () => {
    const text = '今日は学校で漢字を覚える。明日も学校へ行く。';
    const words = extractWords(text, tokenizer.tokenize(text));
    const w = words.find((x) => x.word === '漢字');
    expect(w.before).toBe('今日は学校で');
    expect(w.after).toBe('を覚える。');
    const m = words.find((x) => x.word === '明日');
    expect(m.before).toBe('');
    expect(m.after).toBe('も学校へ行く。');
  });

  it('segments は漢字 1 字ずつと仮名のかたまりに分ける', () => {
    expect(segments('覚える')).toEqual([{ kanji: true, text: '覚' }, { kanji: false, text: 'える' }]);
    expect(segments('お茶')).toEqual([{ kanji: false, text: 'お' }, { kanji: true, text: '茶' }]);
    expect(segments('人々')).toEqual([{ kanji: true, text: '人' }, { kanji: true, text: '々' }]);
  });

  it('カタカナをひらがなにする', () => {
    expect(kataToHira('ガッコウ')).toBe('がっこう');
  });

  it('OCR の結果の、文字の間の空白を取り除く', () => {
    expect(cleanText('今 日 は 学 校\r\n\r\n  ABC def  ')).toBe('今日は学校\nABC def');
  });
});
