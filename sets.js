// テスト(出題の範囲)ごとに語をまとめる。中間テスト・期末テストなど、テストごとに写真 10〜20 枚分の語を管理する。
// 語は setId(どのテストか)と photo(テストの中で何枚目の写真から取り込んだか)を持つ。
//   photo: 1, 2, 3 … = 写真(取り込み 1 回分)、0 = 手で追加した語、null = 以前に取り込んだ語(テスト機能の前のデータ)
// DOM に依存しない(Node でテストできる)。

import { newId } from './words.js';

/** 保存データを読み込み、テストがなければ「テスト 1」を作って、これまでの語をすべて入れる */
export function migrate(data) {
  const sets = Array.isArray(data.sets) ? data.sets.filter((s) => s && s.id && typeof s.name === 'string') : [];
  const words = Array.isArray(data.words) ? data.words : [];
  if (!sets.length) sets.push({ id: newId(), name: 'テスト 1' });
  const ids = new Set(sets.map((s) => s.id));
  for (const w of words) {
    if (!ids.has(w.setId)) w.setId = sets[0].id;
    if (w.photo === undefined) w.photo = null;
  }
  const currentSet = ids.has(data.currentSet) ? data.currentSet : sets[0].id;
  return { sets, words, currentSet };
}

/** テストの語 */
export function wordsOf(words, setId) {
  return words.filter((w) => w.setId === setId);
}

/** テストの中の写真の数(手で追加した語・以前の語は数えない) */
export function photoCount(words, setId) {
  return new Set(wordsOf(words, setId).filter((w) => w.photo > 0).map((w) => w.photo)).size;
}

/** 次の写真の番号 */
export function nextPhoto(words, setId) {
  return wordsOf(words, setId).reduce((m, w) => Math.max(m, w.photo || 0), 0) + 1;
}

/**
 * 語をテストに追加する。同じテストに同じ語・同じ読みがあれば追加しない。
 * @param {object[]} words すべての語(書き換える)
 * @param {string} setId
 * @param {{word: string, reading: string, before?: string, after?: string}[]} entries
 * @param {'photo' | 'manual'} kind 写真 1 枚分の取り込み(新しい写真の番号を付ける)か、手で追加か
 * @returns {number} 追加した数
 */
export function addWords(words, setId, entries, kind = 'photo') {
  const photo = kind === 'manual' ? 0 : nextPhoto(words, setId);
  let added = 0;
  for (const e of entries) {
    const dup = words.some((w) => w.setId === setId && w.word === e.word && w.reading === e.reading);
    if (dup) continue;
    words.push({
      id: e.id || newId(),
      word: e.word,
      reading: e.reading || '',
      before: e.before || '',
      after: e.after || '',
      enabled: e.enabled !== false,
      manual: kind === 'manual',
      result: null,
      misses: 0,
      passedAt: null,
      setId,
      photo,
    });
    added++;
  }
  return added;
}

/** 写真ごとのまとまり(以前の語 → 写真 1, 2, … → 手で追加した語 の順) */
export function groupsOf(words, setId) {
  const map = new Map();
  for (const w of wordsOf(words, setId)) {
    const key = w.photo === null || w.photo === undefined ? 'old' : w.photo === 0 ? 'manual' : w.photo;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(w);
  }
  const rank = (k) => (k === 'old' ? -1 : k === 'manual' ? Infinity : k);
  return [...map.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([key, list], i, all) => ({
      key: String(key),
      // 写真の番号は、消した写真があっても 1 から詰めて表示する
      label: key === 'old' ? '以前に取り込んだ語' : key === 'manual' ? '手で追加した語' : `写真 ${all.filter((g) => typeof g[0] === 'number' && g[0] <= key).length}`,
      words: list,
    }));
}

/** 新しいテストを作る */
export function createSet(sets, name) {
  const set = { id: newId(), name: (name || '').trim() || `テスト ${sets.length + 1}` };
  sets.push(set);
  return set;
}

/**
 * テストを削除する(そのテストの語も消す)。テストが 1 つもなくなったら、空の「テスト 1」を作る。
 * @returns {{sets: object[], words: object[], currentSet: string}}
 */
export function deleteSet(sets, words, setId) {
  const restSets = sets.filter((s) => s.id !== setId);
  if (!restSets.length) restSets.push({ id: newId(), name: 'テスト 1' });
  return { sets: restSets, words: words.filter((w) => w.setId !== setId), currentSet: restSets[0].id };
}
