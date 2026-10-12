import { describe, it, expect } from 'vitest';
import { makeBackup, backupFileName, parseBackup, mergeBackup, dataSize, formatSize } from '../../backup.js';
import { addWords, createSet } from '../../sets.js';

describe('バックアップ', () => {
  it('書き出して読み込むと、テストと語が元に戻る', () => {
    const sets = [], words = [];
    const s = createSet(sets, '中間テスト');
    addWords(words, s.id, [{ word: '天井', reading: 'てんじょう' }]);
    const back = parseBackup(JSON.stringify(makeBackup(sets, words)));
    expect(back.sets).toEqual(sets);
    expect(back.words).toEqual(words);
  });

  it('ほかのファイルは、理由を付けて断る', () => {
    expect(() => parseBackup('not json')).toThrow('ファイルの形式が違います');
    expect(() => parseBackup('{"a":1}')).toThrow('このアプリのバックアップファイルではありません');
    expect(() => parseBackup(JSON.stringify({ app: 'kanji-kakitori-drill', version: 99, sets: [], words: [] }))).toThrow('新しい版');
  });

  it('ファイル名に日時を入れる', () => {
    expect(backupFileName(new Date(2026, 9, 12, 15, 3))).toBe('kanji-drill-20261012-1503.json');
  });

  it('合わせる: ないテスト・語は足し、同じ語は新しく更新した方の成績を残す', () => {
    const set = { id: 's1', name: '中間', updatedAt: 1 };
    const ipad = {
      sets: [set],
      words: [
        { id: 'a', word: '天井', setId: 's1', result: 'pass', passedAt: 1, updatedAt: 100 },
        { id: 'b', word: '期限', setId: 's1', result: 'fail', misses: 1, updatedAt: 300 },
      ],
    };
    const iphone = {
      sets: [{ ...set }, { id: 's2', name: '期末', updatedAt: 5 }],
      words: [
        { id: 'a', word: '天井', setId: 's1', result: 'fail', misses: 1, updatedAt: 200 }, // iPhone の方が新しい
        { id: 'b', word: '期限', setId: 's1', result: 'pass', passedAt: 1, updatedAt: 250 }, // iPad の方が新しい
        { id: 'c', word: '保護', setId: 's2', updatedAt: 10 },
      ],
    };
    const r = mergeBackup(ipad, iphone);
    expect(r.sets.map((s) => s.name)).toEqual(['中間', '期末']);
    expect(r.addedSets).toBe(1);
    expect(r.addedWords).toBe(1);
    expect(r.updatedWords).toBe(1);
    const by = Object.fromEntries(r.words.map((w) => [w.id, w]));
    expect(by.a.result).toBe('fail');
    expect(by.b.result).toBe('fail');
    expect(by.c.word).toBe('保護');
    // 元のデータは書き換えない
    expect(ipad.words[0].result).toBe('pass');
  });

  it('合わせる: テストの名前は、新しく変えた方を残す', () => {
    const r = mergeBackup({ sets: [{ id: 's1', name: '古い名前', updatedAt: 1 }], words: [] }, { sets: [{ id: 's1', name: '新しい名前', updatedAt: 2 }], words: [] });
    expect(r.sets).toEqual([{ id: 's1', name: '新しい名前', updatedAt: 2 }]);
  });

  it('データの大きさ: 200 語で 100KB 未満(写真は保存しない)', () => {
    const sets = [], words = [];
    const s = createSet(sets, '中間テスト');
    const entries = Array.from({ length: 200 }, (_, i) => ({ word: `漢字${i}`, reading: `かんじ${i}`, before: '有名作家の', after: '会' }));
    addWords(words, s.id, entries);
    const size = dataSize({ sets, words });
    expect(size).toBeLessThan(100 * 1024);
    expect(formatSize(size)).toMatch(/KB$/);
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
