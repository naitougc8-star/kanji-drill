// お手本(KanjiVG の筆画データ)の遅延読み込み。data/kXX.json を必要な分だけ fetch する。

const BASE = 'data/';
let indexPromise = null;
const buckets = new Map();

function fetchJson(url) {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url} を読み込めませんでした(${r.status})`);
    return r.json();
  });
}

function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetchJson(BASE + 'index.json').catch((e) => {
      indexPromise = null;
      throw e;
    });
  }
  return indexPromise;
}

/**
 * 字のお手本を返す。データがない字は null。
 * 通信に失敗したときは例外(呼び出し側で画面に出す)。
 */
export async function getStrokes(ch) {
  const cp = ch.codePointAt(0);
  const b = (cp >> 8).toString(16);
  const index = await loadIndex();
  if (!index.buckets.includes(b)) return null; // 存在しないファイルは取りに行かない(404 を出さない)
  if (!buckets.has(b)) {
    buckets.set(
      b,
      fetchJson(`${BASE}k${b}.json`).catch((e) => {
        buckets.delete(b);
        throw e;
      }),
    );
  }
  const data = await buckets.get(b);
  return data[cp.toString(16)] || null;
}
