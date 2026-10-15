// 問題の種類(書き取り・読み・百人一首)。プリントの 1 問の文字から種類を見分け、出題で書く部分を決める。
// DOM に依存しない(Node でテストできる)。
//
// 語(保存する 1 件)の kind:
//   'kaki'     書き取り(省略時もこれ)。word = 答えの漢字、reading = 出題で見せる読み
//   'yomi'     読み。word = 出題で見せる漢字(例: 苛まれる)、reading = 答えの読み(例: さいなまれる)
//   'hyakunin' 百人一首。word = 歌、reading = 歌のかな、before = 出題で見せる初句(例: わたの原 や)、no = 歌の番号

import { hasKanji } from './words.js';
import { matchPoems } from './hyakunin.js';

export const KIND_LABEL = { kaki: '書き取り', yomi: '読み', hyakunin: '百人一首' };

export function kindOf(w) {
  return w && (w.kind === 'yomi' || w.kind === 'hyakunin') ? w.kind : 'kaki';
}

// 「(読み)」の印。縦書きの括弧は読み取りで消えたり「︵︶」になったりするので、括弧はなくてもよい
const YOMI_MARK = /[(（︵]?読み?[)）︶]?$/;

/** 「翡翠(読み)」のような、読みを答える問題か */
export function isYomiText(text) {
  const t = (text || '').replace(/[、。]+$/, '');
  return YOMI_MARK.test(t) && hasKanji(t.replace(YOMI_MARK, ''));
}

/** 読みの問題の、出題で見せる語(「(読み)」の印を除いたもの) */
export function yomiWord(text) {
  return (text || '').replace(/[、。]+$/, '').replace(YOMI_MARK, '').replace(/[、。]+$/, '');
}

/** 名前の欄・見出しなど、問題ではない欄か */
export function isHeaderText(text) {
  const t = (text || '').replace(/[\s、。]/g, '');
  if (!t) return false; // 何も読めなかった欄は、問題として残す(手で直せるように)
  return /氏名|百人一首|^国語|^[一二三]?年?[組]?[番]?$|^.?年.?組.?番.?$/.test(t);
}

/**
 * 読み取った 1 問の種類を決める。
 * - 「(読み)」の印がある → 読み
 * - カタカナの書き取る部分がなく、百人一首の初句に合う → 百人一首
 * - それ以外 → 書き取り
 */
export function detectKind(text) {
  if (isYomiText(text)) return 'yomi';
  if (!/[ァ-ヺ]{2,}/.test(text || '') && matchPoems(text).length) return 'hyakunin';
  return 'kaki';
}

/**
 * 読みの問題で、手で書く部分。語と読みの、前後の同じかな(送りがななど)は書かなくてよい。
 * 例: 苛まれる / さいなまれる → { head: '', write: 'さいな', tail: 'まれる' }
 *     お茶 / おちゃ → { head: 'お', write: 'ちゃ', tail: '' }
 */
export function yomiParts(word, reading) {
  const w = [...(word || '')], r = [...(reading || '')];
  let a = 0;
  while (a < w.length && a < r.length && w[a] === r[a] && !hasKanji(w[a])) a++;
  let b = 0;
  while (b < w.length - a && b < r.length - a && w[w.length - 1 - b] === r[r.length - 1 - b] && !hasKanji(w[w.length - 1 - b])) b++;
  return { head: r.slice(0, a).join(''), write: r.slice(a, r.length - b).join(''), tail: r.slice(r.length - b).join('') };
}
