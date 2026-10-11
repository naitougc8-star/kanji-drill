// 読み(ひらがな)から、答えの漢字の候補を出す。
// 書き取りプリントには答えの漢字が書かれていないので、「てんじょう」→ 天井 のように辞書で引き、
// 前後の文に当てはめたときの自然さ(kuromoji の文全体のコスト)で並べる。
// 純粋な関数は DOM に依存しない(Node でテストできる)。

import { kataToHira, hasKanji } from './words.js';

const MAX_CANDIDATES = 8;
// 並べ替えのときの不利な点数(kuromoji のコストと同じ単位)
const PENALTY_SPLIT = 1500; // 2 つの語をつないで作った候補
const PENALTY_RARE = 1500; // 常用漢字でない字 1 字ごと
const KANJI_RE = /[一-鿿]/;

/** 読みとして使える形にそろえる(カタカナ → ひらがな、仮名以外を除く) */
export function normalizeReading(s) {
  return kataToHira(s || '').replace(/[^ぁ-ゖー]/g, '');
}

/**
 * 候補を作る。
 * @param {string} reading ひらがな
 * @param {{lookup: (r: string) => Promise<string[]>, score?: (text: string) => number, common?: Set<string>, before?: string, after?: string}} opts
 *   lookup: 読みに完全一致する表記(よく使う順)。score: 文のコスト(小さいほど自然)。common: 常用漢字
 * @returns {Promise<string[]>}
 */
export async function candidates(reading, opts) {
  const r = normalizeReading(reading);
  if (!r) return [];
  const { lookup, score, common, before = '', after = '' } = opts;
  const found = new Map(); // 表記 → { rank: 作り方の順位, split: 2 語をつないだか }
  const add = (s, rank, split = false) => {
    if (hasKanji(s) && !found.has(s)) found.set(s, { rank, split });
  };
  // 1. 完全一致
  (await lookup(r)).forEach((s, i) => add(s, i));
  // 2. 後ろの仮名を送り仮名・活用語尾として残す(だまって → 黙っ + て)
  for (let i = r.length - 1; i >= 1 && r.length - i <= 4; i--) {
    (await lookup(r.slice(0, i))).slice(0, 3).forEach((s, k) => add(s + r.slice(i), 100 + (r.length - i) * 10 + k));
  }
  // 3. 2 つの語に分ける(ぎゅうどん → 牛 + 丼)
  for (let i = 1; i < r.length; i++) {
    const a = (await lookup(r.slice(0, i))).slice(0, 5);
    if (!a.length) continue;
    const b = (await lookup(r.slice(i))).slice(0, 5);
    for (const x of a) for (const y of b) add(x + y, 200 + Math.abs(r.length / 2 - i), true);
  }
  const rare = (s) => (common ? [...s].filter((c) => KANJI_RE.test(c) && !common.has(c)).length : 0);
  const penalty = (s) => (found.get(s).split ? PENALTY_SPLIT : 0) + rare(s) * PENALTY_RARE;
  let list = [...found.keys()]
    .sort((x, y) => penalty(x) - penalty(y) || found.get(x).rank - found.get(y).rank)
    .slice(0, 40);
  if (score) {
    const costs = new Map(list.map((s) => [s, score(before + s + after) + penalty(s)]));
    list = list.slice().sort((x, y) => costs.get(x) - costs.get(y) || found.get(x).rank - found.get(y).rank);
  }
  return list.slice(0, MAX_CANDIDATES);
}

/**
 * kuromoji の tokenizer から、文のコスト(小さいほど自然)を返す関数を作る。
 * 公開 API ではないが、kuromoji 0.1.2 の getLattice と viterbi_searcher.forward を使う。
 */
export function makeScorer(tokenizer) {
  return (text) => {
    try {
      const lattice = tokenizer.getLattice(text);
      tokenizer.viterbi_searcher.forward(lattice);
      const eos = lattice.nodes_end_at[lattice.eos_pos];
      return eos && eos[0] ? eos[0].shortest_cost : Infinity;
    } catch {
      return Infinity;
    }
  };
}

/**
 * 読み取った 1 行の中から、書き取る部分の候補(辞書に載っている仮名の並び)を選ぶ。
 * 最初に選んでおくだけなので、ユーザーがタップで直せる。
 * @returns {Promise<[number, number] | null>} [開始, 終了(含まない)]
 */
export async function guessTarget(line, lookup) {
  const chars = [...line];
  let best = null;
  for (let s = 0; s < chars.length; s++) {
    if (!/[ぁ-ゖ]/.test(chars[s])) continue;
    for (let e = chars.length; e > s + 1; e--) {
      const part = chars.slice(s, e);
      if (!part.every((c) => /[ぁ-ゖー]/.test(c))) continue;
      if (best && e - s <= best[1] - best[0]) break;
      if ((await lookup(part.join(''))).length) {
        best = [s, e];
        break;
      }
    }
  }
  return best;
}

// ---------- ブラウザ用: 辞書の遅延読み込み ----------

let indexPromise = null;
const buckets = new Map();

function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetch('data/yomi/index.json').then((r) => {
      if (!r.ok) throw new Error(`読みの辞書を読み込めませんでした(${r.status})`);
      return r.json();
    });
    indexPromise.catch(() => (indexPromise = null));
  }
  return indexPromise;
}

/** 常用漢字の集合(候補の並べ替えに使う。ブラウザ用) */
export async function commonKanji() {
  return new Set((await loadIndex()).joyo || '');
}

/** data/yomi/ から引く lookup 関数(ブラウザ用) */
export async function lookupBrowser(reading) {
  if (!reading) return [];
  const index = await loadIndex();
  const key = reading.codePointAt(0).toString(16);
  if (!index.buckets.includes(key)) return [];
  if (!buckets.has(key)) {
    const p = fetch(`data/yomi/y${key}.json`).then((r) => {
      if (!r.ok) throw new Error(`読みの辞書を読み込めませんでした(${r.status})`);
      return r.json();
    });
    buckets.set(key, p);
    p.catch(() => buckets.delete(key));
  }
  const v = (await buckets.get(key))[reading];
  return v ? v.split(',') : [];
}
