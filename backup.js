// バックアップ(ファイルへの書き出し・読み込み)と、ほかの端末のデータとの合わせ込み。
// iPad で書き出したファイルを AirDrop や iCloud Drive で iPhone に渡し、「合わせる」で読み込む使い方を想定する。
// DOM に依存しない(Node でテストできる)。

export const BACKUP_APP = 'kanji-kakitori-drill';
export const BACKUP_VERSION = 1;
// localStorage の上限(Safari は 1 サイトあたり約 5MB)。これに近づいたら知らせる
export const STORAGE_LIMIT = 5 * 1024 * 1024;

/** 書き出すデータ(写真は含まない。判定の厳しさや画面の表示などの端末ごとの設定も含まない) */
export function makeBackup(sets, words, now = new Date()) {
  return { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: now.toISOString(), sets, words };
}

/** ファイル名(例: kanji-drill-20261012-1530.json) */
export function backupFileName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `kanji-drill-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}

/**
 * 読み込んだファイルの中身を確かめる。
 * @returns {{sets: object[], words: object[], exportedAt: string}}
 * @throws 形式が違うとき(理由を日本語で)
 */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('ファイルの形式が違います(このアプリで書き出したファイルを選んでください)');
  }
  if (!data || data.app !== BACKUP_APP || !Array.isArray(data.sets) || !Array.isArray(data.words)) {
    throw new Error('このアプリのバックアップファイルではありません');
  }
  if (data.version > BACKUP_VERSION) throw new Error('新しい版のアプリで書き出したファイルです。アプリを再読み込みしてから読み込んでください');
  const sets = data.sets.filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string');
  const ids = new Set(sets.map((s) => s.id));
  const words = data.words.filter((w) => w && typeof w.id === 'string' && typeof w.word === 'string' && ids.has(w.setId));
  return { sets, words, exportedAt: data.exportedAt || '' };
}

/**
 * ほかの端末のデータを合わせる。
 * - テスト: 同じテスト(id が同じ)はまとめ、名前(写真ごとのまとまりの名前も)は新しく変えた方を残す。ないテストは足す
 * - 語: 同じ語(id が同じ)は、新しく更新した方(updatedAt が大きい方)を残す。ない語は足す
 * - 片方で削除した語・テストは、合わせても消えない(削除は、それぞれの端末で行う)
 * @returns {{sets: object[], words: object[], addedSets: number, addedWords: number, updatedWords: number}}
 */
export function mergeBackup(cur, inc) {
  const sets = cur.sets.map((s) => ({ ...s }));
  let addedSets = 0;
  for (const s of inc.sets) {
    const mine = sets.find((x) => x.id === s.id);
    if (!mine) {
      sets.push({ ...s });
      addedSets++;
    } else if ((s.updatedAt || 0) > (mine.updatedAt || 0)) {
      mine.name = s.name;
      if (s.groupNames) mine.groupNames = { ...s.groupNames }; // 写真ごとのまとまりの名前
      mine.updatedAt = s.updatedAt;
    }
  }
  const words = cur.words.map((w) => ({ ...w }));
  const index = new Map(words.map((w, i) => [w.id, i]));
  let addedWords = 0, updatedWords = 0;
  for (const w of inc.words) {
    const i = index.get(w.id);
    if (i === undefined) {
      index.set(w.id, words.length);
      words.push({ ...w });
      addedWords++;
    } else if ((w.updatedAt || 0) > (words[i].updatedAt || 0)) {
      words[i] = { ...w };
      updatedWords++;
    }
  }
  return { sets, words, addedSets, addedWords, updatedWords };
}

/** 保存しているデータの大きさ(バイト、UTF-8) */
export function dataSize(obj) {
  return new TextEncoder().encode(JSON.stringify(obj)).length;
}

/** 大きさを読みやすく(例: 12 KB、1.3 MB) */
export function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
