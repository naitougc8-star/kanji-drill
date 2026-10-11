import { describe, it, expect } from 'vitest';
import { adaptiveDark, estimateSkew, findGrid, cellsFromGrid, horizontalLineRows, cleanColumn, fixKatakana, katakanaRuns } from '../../table.js';

/** 縦の罫線(間隔 gap)と横線 2 本の表を、傾き deg で描いた白黒画像 */
function drawTable(W, H, { cols = 5, gap = 80, deg = 0, x0 = 40, headerY = 60, bottomY = 360 } = {}) {
  const g = new Uint8ClampedArray(W * H).fill(230);
  const t = Math.tan((deg * Math.PI) / 180);
  const set = (x, y) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = 30;
  };
  for (let c = 0; c <= cols; c++) {
    for (let y = 20; y < H - 20; y++) for (let w = 0; w < 3; w++) set(x0 + c * gap + w + (y - H / 2) * t, y);
  }
  for (const yy of [headerY, bottomY]) {
    for (let x = x0; x <= x0 + cols * gap; x++) for (let w = 0; w < 3; w++) set(x, yy + w - (x - W / 2) * t);
  }
  return g;
}

describe('表の罫線', () => {
  it('写真の傾きを、縦の罫線から求める', () => {
    const W = 500, H = 420;
    for (const deg of [0, 1.5, -2.4]) {
      const g = drawTable(W, H, { deg });
      expect(estimateSkew(adaptiveDark(g, W, H, 21), W, H)).toBeCloseTo(deg, 0);
    }
  });

  it('縦の罫線から列を作り、右から左の順(縦書きの問題の順)に並べる。いちばん背の高い段を問題の段とする', () => {
    const W = 500, H = 420;
    const g = drawTable(W, H);
    const grid = findGrid(adaptiveDark(g, W, H, 21), W, H);
    expect(grid.v).toHaveLength(6);
    const cells = cellsFromGrid(grid, W, H);
    expect(cells).toHaveLength(5);
    expect(cells[0].x0).toBeGreaterThan(cells[4].x0); // 1 問目がいちばん右
    expect(cells[0].y0).toBeGreaterThan(55); // 番号の段(上)を除く
    expect(cells[0].y1).toBeLessThan(365); // 答えの段(下)を除く
  });

  it('列の中の、少し曲がった区切り線を見つける', () => {
    const W = 100, H = 300;
    const d = new Uint8Array(W * H);
    for (let x = 5; x < 95; x++) d[(40 + Math.round(x / 30)) * W + x] = 1; // 3px ほど曲がった横線
    for (let y = 100; y < 110; y++) for (let x = 40; x < 60; x++) d[y * W + x] = 1; // 字(線ではない)
    const rows = horizontalLineRows(d, W, H, 0, W, 0, H, 80);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((y) => y >= 38 && y <= 46)).toBe(true);
  });

  it('1 列の画像から、番号の段と罫線を消し、字だけを残す', () => {
    const W = 120, H = 400;
    const g = new Uint8ClampedArray(W * H).fill(220);
    for (let y = 0; y < H; y++) { g[y * W + 5] = 20; g[y * W + 114] = 20; } // 縦の罫線
    for (let x = 0; x < W; x++) g[50 * W + x] = 20; // 番号の段との区切り線
    for (let y = 20; y < 40; y++) g[y * W + 60] = 20; // 番号「1」
    for (let y = 100; y < 140; y++) for (let x = 45; x < 75; x++) if ((x + y) % 4 === 0) g[y * W + x] = 20; // 字
    const out = cleanColumn(g, W, H, { x0: 12, x1: 108, y0: 0, y1: H, cellW: 110 });
    expect(out[30 * W + 60]).toBe(255); // 番号は消える
    expect(out[200 * W + 5]).toBe(255); // 縦の罫線は消える
    let ink = 0;
    for (let y = 100; y < 140; y++) for (let x = 45; x < 75; x++) if (out[y * W + x] < 128) ink++;
    expect(ink).toBeGreaterThan(100); // 字は残る
  });
});

describe('カタカナの読み違いを直す', () => {
  it('カタカナに隣り合う、形の似た字をカタカナに直す', () => {
    expect(fixKatakana('寒いのでア力ギをする')).toBe('寒いのでアカギをする');
    expect(fixKatakana('有名作家のコウ工ン会')).toBe('有名作家のコウエン会');
    expect(fixKatakana('二ュース')).toBe('ニュース');
    expect(fixKatakana('ル一ル')).toBe('ルール');
  });

  it('カタカナと関係のない漢字・ひらがなは直さない', () => {
    expect(fixKatakana('力持ちの二人')).toBe('力持ちの二人');
    expect(fixKatakana('東京へ行く')).toBe('東京へ行く');
    expect(fixKatakana('ノウコウ民族')).toBe('ノウコウ民族');
  });

  it('小さい字と大きい字が重なった読み違いと、行の端の「っ」を直す', () => {
    expect(fixKatakana('有名作家のコウェエン会')).toBe('有名作家のコウエン会');
    expect(fixKatakana('姿をアラワスっ')).toBe('姿をアラワス');
    expect(fixKatakana('キャッチ')).toBe('キャッチ');
  });

  it('カタカナの並び(書き取る部分)を取り出す', () => {
    expect(katakanaRuns('奥地をタンケンする')).toEqual([[3, 7]]);
    expect(katakanaRuns('ジケンのゲンバ')).toEqual([[0, 3], [4, 7]]);
    expect(katakanaRuns('漢字')).toEqual([]);
  });
});
