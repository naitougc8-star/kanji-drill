import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { POEMS, matchPoems, editDistance, poemParts, checkKana, normalizeKana } from '../../hyakunin.js';
import { detectKind, isYomiText, yomiWord, yomiParts, isHeaderText, kindOf } from '../../kinds.js';
import { addWords } from '../../sets.js';

describe('百人一首のデータ', () => {
  it('1〜100 番の歌が、5 句ずつ、表記とかなでそろっている', () => {
    expect(POEMS.map((p) => p.no)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    for (const p of POEMS) {
      expect(p.ku, `${p.no} 番`).toHaveLength(5);
      expect(p.kanaKu, `${p.no} 番`).toHaveLength(5);
      for (const k of p.kanaKu) expect(k, `${p.no} 番`).toMatch(/^[ぁ-ゖー]+$/);
    }
  });
});

describe('初句から歌を探す', () => {
  it('プリントの初句(読み取りのごみが後ろに付いていてもよい)から歌を見つける', () => {
    expect(matchPoems('花の色は')[0].poem.no).toBe(9);
    expect(matchPoems('花の色は。了')[0].poem.no).toBe(9);
    expect(matchPoems('これやこの本')[0].poem.no).toBe(10);
    expect(matchPoems('天つ風だ')[0].poem.no).toBe(12);
    expect(matchPoems('はなのいろは')[0].poem.no).toBe(9); // かなで書かれた初句
  });

  it('初句が同じ歌は、続きの手がかりの字で選ぶ', () => {
    const m = matchPoems('わたの原や');
    expect(m[0].poem.no).toBe(11); // 八十島(やそしま)かけて
    expect(m[0].prompt).toBe('わたの原 や');
    expect(m.map((x) => x.poem.no)).toContain(76);
    expect(matchPoems('わたの原こ')[0].poem.no).toBe(76);
    expect(matchPoems('君がため惜')[0].poem.no).toBe(50);
  });

  it('1 字の読み違いは許す(4 字以上の初句)', () => {
    expect(matchPoems('花の色ば')[0].poem.no).toBe(9);
  });

  it('百人一首でない文には合わない', () => {
    expect(matchPoems('とてもアセル')).toHaveLength(0);
    expect(matchPoems('動物がムレル')).toHaveLength(0);
    expect(matchPoems('')).toHaveLength(0);
  });

  it('編集距離', () => {
    expect(editDistance('花の色は', '花の色は')).toBe(0);
    expect(editDistance('花の色ば', '花の色は')).toBe(1);
    expect(editDistance('花の色', '花の色は')).toBe(1);
  });
});

describe('問題の種類を見分ける', () => {
  it('「(読み)」の印がある問題は読み', () => {
    expect(isYomiText('翡翠(読み)')).toBe(true);
    expect(isYomiText('可哀想読み')).toBe(true); // 括弧が読み取りで消えた
    expect(isYomiText('往々︵読み︶')).toBe(true);
    expect(isYomiText('ヨシノヒロシ')).toBe(false);
    expect(yomiWord('苛まれる読み')).toBe('苛まれる');
    expect(yomiWord('翡翠(読み)')).toBe('翡翠');
    expect(detectKind('頓着読み')).toBe('yomi');
  });

  it('カタカナの書き取りと、百人一首を見分ける', () => {
    expect(detectKind('水面をオオウ')).toBe('kaki');
    expect(detectKind('花の色は')).toBe('hyakunin');
    expect(detectKind('わたの原や')).toBe('hyakunin');
  });

  it('名前の欄・見出しは問題ではない', () => {
    expect(isHeaderText('氏名')).toBe(true);
    expect(isHeaderText('一年組。番')).toBe(true);
    expect(isHeaderText('国語I百人一首')).toBe(true);
    expect(isHeaderText('マンインの電車')).toBe(false);
    expect(isHeaderText('')).toBe(false); // 読めなかった欄は残す
  });

  it('読みの問題で書く部分(送りがななど、語と同じかなは書かない)', () => {
    expect(yomiParts('苛まれる', 'さいなまれる')).toEqual({ head: '', write: 'さいな', tail: 'まれる' });
    expect(yomiParts('翡翠', 'ひすい')).toEqual({ head: '', write: 'ひすい', tail: '' });
    expect(yomiParts('傍から', 'はたから')).toEqual({ head: '', write: 'はた', tail: 'から' });
    expect(yomiParts('お茶', 'おちゃ')).toEqual({ head: 'お', write: 'ちゃ', tail: '' });
    expect(yomiParts('翡翠', '').write).toBe('');
  });

  it('種類のない語(前からのデータ)は書き取り', () => {
    expect(kindOf({ word: '覚える' })).toBe('kaki');
    expect(kindOf({ word: '翡翠', kind: 'yomi' })).toBe('yomi');
  });
});

describe('語の追加', () => {
  it('読み・百人一首の種類と歌の番号を残す。書き取りには種類を付けない', () => {
    const words = [];
    addWords(words, 's1', [
      { word: '覚える', reading: 'おぼえる' },
      { word: '翡翠', reading: 'ひすい', kind: 'yomi' },
      { word: POEMS[8].text, reading: POEMS[8].kana, before: '花の色は', kind: 'hyakunin', no: 9 },
    ]);
    expect(words[0].kind).toBeUndefined();
    expect(words[1].kind).toBe('yomi');
    expect(words[2]).toMatchObject({ kind: 'hyakunin', no: 9, before: '花の色は' });
  });
});

describe('ひらがなのお手本', () => {
  it('data/k30.json に、ひらがな(ぁ〜ゖ)の筆画がある', () => {
    const d = JSON.parse(fs.readFileSync('data/k30.json', 'utf8'));
    for (let cp = 0x3041; cp <= 0x3096; cp++) expect(d[cp.toString(16)], String.fromCharCode(cp)).toBeTruthy();
    expect(d['3055']).toHaveLength(3); // さ
    expect(d['306a']).toHaveLength(4); // な
  });
});

describe('百人一首の答え合わせ(ひらがなで入力)', () => {
  const p12 = POEMS[11];
  const parts = () => poemParts(p12.text, p12.kana, '天つ風');

  it('歌を、見せる初句と答える続きに分ける', () => {
    const p = parts();
    expect(p.givenText).toBe('天つ風');
    expect(p.givenKana).toBe('あまつかぜ');
    expect(p.restKana).toEqual(['くものかよひぢ', 'ふきとぢよ', 'をとめのすがた', 'しばしとどめむ']);
    expect(poemParts(POEMS[10].text, POEMS[10].kana, 'わたの原 や').hint).toBe('や');
  });

  it('正しく入力すれば合格(空白・カタカナ・句読点はかまわない)', () => {
    const p = parts();
    expect(checkKana(p.restKana, 'くものかよひぢ ふきとぢよ をとめのすがた しばしとどめむ').pass).toBe(true);
    expect(checkKana(p.restKana, 'くものかよひぢふきとぢよ、をとめのすがたしばしとどめむ').pass).toBe(true);
    expect(checkKana(p.restKana, 'クモノカヨヒヂ フキトヂヨ ヲトメノスガタ シバシトドメム').pass).toBe(true);
  });

  it('違った字(ぢ→じ、を→お)だけに印が付く', () => {
    const p = parts();
    const r = checkKana(p.restKana, 'くものかよひぢ ふきとじよ おとめのすがた しばしとどめむ');
    expect(r.pass).toBe(false);
    const miss = r.ku.map((ku) => ku.filter((c) => !c.ok).map((c) => c.ch).join(''));
    expect(miss).toEqual(['', 'ぢ', 'を', '']);
  });

  it('字が抜けても、後ろの字はずれずに比べる', () => {
    const p = parts();
    const r = checkKana(p.restKana, 'くものかよひぢ ふきとぢ をとめのすがた しばしとどめむ'); // 「よ」が抜けた
    const miss = r.ku.map((ku) => ku.filter((c) => !c.ok).map((c) => c.ch).join(''));
    expect(miss).toEqual(['', 'よ', '', '']);
  });

  it('出題で見せた手がかりの字(や)は、入力で省いてもよい', () => {
    const p = poemParts(POEMS[10].text, POEMS[10].kana, 'わたの原 や');
    expect(checkKana(p.restKana, 'そしまかけて こぎいでぬと ひとにはつげよ あまのつりぶね', p.hint).pass).toBe(true);
    expect(checkKana(p.restKana, 'やそしまかけて こぎいでぬと ひとにはつげよ あまのつりぶね', p.hint).pass).toBe(true);
  });

  it('入力のかなをそろえる', () => {
    expect(normalizeKana(' ヲトメ、の すがた。')).toBe('をとめのすがた');
  });
});

describe('百人一首の歌人と解説のページ', () => {
  it('100 首すべてに、歌人と全日本かるた協会「一日一首」のページがある', () => {
    const urls = new Set();
    for (const p of POEMS) {
      expect(p.author, `${p.no} 番`).toBeTruthy();
      expect(p.karutaUrl, `${p.no} 番`).toMatch(/^https:\/\/www\.karuta\.or\.jp\/karuta-everyday\/\d+\/$/);
      urls.add(p.karutaUrl);
    }
    expect(urls.size).toBe(100);
    expect(POEMS[11]).toMatchObject({ author: '僧正遍昭', karutaUrl: 'https://www.karuta.or.jp/karuta-everyday/2723/' });
  });
});
