import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToPolyline, rdp, parseSvg, tokenize } from '../../scripts/build-kanjivg.mjs';
import { loadTemplate } from '../simulate.js';

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

describe('KanjiVG の変換', () => {
  it('数値の区切りが省略されたパスも読める', () => {
    expect(tokenize('M31.5,24.5c1.12,1.12,1.74,2.75-0.09.5')).toEqual(['M', 31.5, 24.5, 'c', 1.12, 1.12, 1.74, 2.75, -0.09, 0.5]);
  });

  it('相対 c と s を絶対座標の折れ線にする', () => {
    const pts = pathToPolyline('M10,10c0,0,10,0,10,0s10,0,10,0', 4);
    expect(pts[0]).toEqual([10, 10]);
    expect(pts[4][0]).toBeCloseTo(20);
    expect(pts[8][0]).toBeCloseTo(30);
  });

  it('RDP で一直線上の点を省く', () => {
    expect(rdp([[0, 0], [1, 0.1], [2, 0], [3, 0]], 0.5)).toEqual([[0, 0], [3, 0]]);
  });

  it('SVG から番号順に筆画を取り出す', () => {
    const svg = '<path id="kvg:04e00-s2" d="M0,0L10,10"/><path id="kvg:04e00-s1" d="M5,5L6,50"/>';
    const s = parseSvg(svg, '04e00');
    expect(s).toEqual([[5, 5, 6, 50], [0, 0, 10, 10]]);
  });
});

describe('生成済みのお手本データ', () => {
  it('上位バイトごとのファイルに分かれ、合計 2.2MB 以下', () => {
    const files = fs.readdirSync(DATA).filter((f) => /^k[0-9a-f]+\.json$/.test(f));
    expect(files).toContain('k65.json');
    expect(files).toContain('k30.json');
    const total = files.reduce((s, f) => s + fs.statSync(path.join(DATA, f)).size, 0);
    expect(total).toBeLessThan(2.2 * 1024 * 1024);
  });

  it('画数が正しい', () => {
    const counts = { 日: 4, 目: 5, 曰: 4, 書: 10, 々: 3, 〆: 2, 鬱: 29, 礼: 5, 社: 7, 初: 7 };
    for (const [ch, n] of Object.entries(counts)) expect(loadTemplate(ch)?.length, ch).toBe(n);
  });

  it('座標は 0〜109 の整数', () => {
    for (const s of loadTemplate('鬱')) for (const v of s) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(109);
    }
  });
});
