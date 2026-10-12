import { describe, it, expect } from 'vitest';
import { judge, hungarian, resample, toTemplate, normalizePair, CHAR_GROUPS, LEVELS } from '../../judge.js';
import { simulate, rng, NOISE, loadTemplate, GRADE12, CONFUSABLE_SAME, CONFUSABLE_COUNT } from '../simulate.js';

/** お手本を、キャンバス座標(300px)の [[x,y],...] にそのまま写したもの */
function exact(ch, scale = 300 / 109) {
  return toTemplate(loadTemplate(ch)).map((s) => s.map(([x, y]) => [x * scale + 10, y * scale + 10]));
}

function passRate(chars, level, noise, trials, seed) {
  const r = rng(seed);
  let pass = 0, total = 0;
  for (const ch of chars) {
    const t = loadTemplate(ch);
    for (let k = 0; k < trials; k++) {
      total++;
      if (judge(simulate(t, noise, r), t, { level, char: ch }).pass) pass++;
    }
  }
  return pass / total;
}

function falsePass(a, b, level, trials, seed) {
  const r = rng(seed);
  const ta = loadTemplate(a), tb = loadTemplate(b);
  let pass = 0;
  for (let k = 0; k < trials; k++) if (judge(simulate(ta, NOISE.normal, r), tb, { level, char: b }).pass) pass++;
  return pass / trials;
}

describe('基本の動作', () => {
  it('お手本どおりに書けば、どの厳しさでも合格', () => {
    for (const ch of GRADE12) {
      for (const level of Object.keys(LEVELS)) {
        const res = judge(exact(ch), loadTemplate(ch), { level, char: ch });
        expect(res.pass, `${ch} ${level} ${JSON.stringify(res.reasons)}`).toBe(true);
      }
    }
  });

  it('画数が違えば、両方の画数を理由に出して不合格', () => {
    const u = exact('日').slice(0, 3);
    const res = judge(u, loadTemplate('日'));
    expect(res.pass).toBe(false);
    expect(res.reasons[0].text).toBe('画数が違います(正解 4 画 / あなた 3 画)');
  });

  it('何も書かなければ不合格', () => {
    expect(judge([], loadTemplate('日')).pass).toBe(false);
  });

  it('逆向きに書いた筆画は「書く向きが逆です」(筆画番号付き)', () => {
    const u = exact('十');
    u[0] = u[0].slice().reverse();
    const res = judge(u, loadTemplate('十'));
    expect(res.pass).toBe(false);
    expect(res.reasons).toEqual([{ stroke: 0, text: '1 画目: 書く向きが逆です' }]);
  });

  it('書き順の判定: オフなら合格(注意だけ)、オンなら「書き順が違います(形は合っています)」', () => {
    const u = exact('十');
    const swapped = [u[1], u[0]];
    const off = judge(swapped, loadTemplate('十'), { checkOrder: false });
    expect(off.pass).toBe(true);
    expect(off.notes.join()).toContain('書き順');
    const on = judge(swapped, loadTemplate('十'), { checkOrder: true });
    expect(on.pass).toBe(false);
    expect(on.reasons[0].text).toBe('書き順が違います(形は合っています)');
    expect(on.reasons.slice(1).map((r) => r.stroke)).toEqual([0, 1]);
  });

  it('短すぎる筆画は「N 画目: 短すぎます」', () => {
    // 「土」の 3 画目(長い横画)を半分の長さにする
    const u = exact('土');
    const s = u[2];
    const mid = [(s[0][0] + s[s.length - 1][0]) / 2, (s[0][1] + s[s.length - 1][1]) / 2];
    u[2] = [[mid[0] - 40, mid[1]], [mid[0] + 40, mid[1]]];
    const res = judge(u, loadTemplate('土'));
    expect(res.pass).toBe(false);
    expect(res.reasons.some((r) => r.stroke === 2 && /3 画目/.test(r.text))).toBe(true);
  });

  it('1 点だけの筆画(点)も 1 画として数える', () => {
    const u = exact('主');
    const p = u[0][0];
    u[0] = [p]; // 1 画目の点を 1 点のタップにする
    const res = judge(u, loadTemplate('主'));
    expect(res.reasons.every((r) => !r.text.includes('画数'))).toBe(true);
  });

  it('「一」のような細長い字も判定できる(uniform 正規化)', () => {
    const N = normalizePair(exact('一'), toTemplate(loadTemplate('一')));
    expect(N.mode).toBe('uniform');
    expect(judge(exact('一'), loadTemplate('一')).pass).toBe(true);
    // 縦に書いたら不合格
    const vert = [[[150, 20], [150, 280]]];
    expect(judge(vert, loadTemplate('一')).pass).toBe(false);
  });
});

describe('部品', () => {
  it('resample は弧長で等間隔に n 点', () => {
    const r = resample([[0, 0], [10, 0], [10, 10]], 5);
    expect(r).toHaveLength(5);
    expect(r[2][0]).toBeCloseTo(10);
    expect(r[2][1]).toBeCloseTo(0);
    expect(r[4]).toEqual([10, 10]);
  });

  it('hungarian はコスト最小の割り当てを返す', () => {
    expect(hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]])).toEqual([1, 0, 2]);
  });

  it('己・已・巳 のスコアの基準値は、お手本データから計算した値と一致する', () => {
    for (const g of CHAR_GROUPS) {
      for (const ch of g.chars) {
        const t = toTemplate(loadTemplate(ch));
        expect(g.score(normalizePair(t, t).tRaw)).toBeCloseTo(g.centers[ch], 3);
      }
    }
  });
});

describe('模擬の手書きによる検証', () => {
  const chars = [...GRADE12];

  it('シビア・「ふつう」の誤差で、正しい字の合格率が 90% 以上', () => {
    const rate = passRate(chars, 'severe', NOISE.normal, 20, 1);
    console.log(`シビア/ふつう 合格率 ${(rate * 100).toFixed(1)}%`);
    expect(rate).toBeGreaterThanOrEqual(0.9);
  });

  it('「ていねい」の誤差なら、どの厳しさでも 95% 以上', () => {
    for (const level of Object.keys(LEVELS)) {
      expect(passRate(chars, level, NOISE.neat, 5, 2)).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('甘い: 「雑」の誤差でも 85% 以上が合格し、紛らわしいペアの誤合格は 20% 以下(標準と同じくらい)', () => {
    const lenient = passRate(chars, 'lenient', NOISE.rough, 8, 2);
    console.log(`甘い/雑 合格率 ${(lenient * 100).toFixed(1)}%`);
    expect(lenient).toBeGreaterThanOrEqual(0.85);
    expect(lenient).toBeGreaterThan(passRate(chars, 'standard', NOISE.rough, 8, 2));
    for (const [a, b] of CONFUSABLE_SAME) {
      for (const [x, y] of [[a, b], [b, a]]) expect(falsePass(x, y, 'lenient', 200, 7), `${x}→${y}`).toBeLessThanOrEqual(0.2);
    }
  });

  it('超甘い: 「雑」の誤差でも 95% 以上が合格する。形がはっきり違うペアは不合格のまま', () => {
    const rate = passRate(chars, 'superLenient', NOISE.rough, 8, 2);
    console.log(`超甘い/雑 合格率 ${(rate * 100).toFixed(1)}%`);
    expect(rate).toBeGreaterThanOrEqual(0.95);
    expect(rate).toBeGreaterThan(passRate(chars, 'lenient', NOISE.rough, 8, 2));
    for (const [x, y] of [['干', '千'], ['千', '干'], ['人', '入'], ['入', '人'], ['午', '牛'], ['牛', '午'], ['刀', '力'], ['力', '刀']]) {
      expect(falsePass(x, y, 'superLenient', 200, 7), `${x}→${y}`).toBeLessThanOrEqual(0.05);
    }
    // 横画の長さだけが違うペアも、半分以上は見分ける
    for (const [x, y] of [['末', '未'], ['未', '末'], ['士', '土'], ['土', '士'], ['日', '曰'], ['曰', '日']]) {
      expect(falsePass(x, y, 'superLenient', 200, 7), `${x}→${y}`).toBeLessThanOrEqual(0.4);
    }
  });

  it('紛らわしいペア(画数が同じ): シビアで誤合格 5% 以下、厳しさの順に誤合格が減る', () => {
    const rows = [];
    const order = ['superLenient', 'lenient', 'standard', 'severe'];
    const sum = Object.fromEntries(order.map((l) => [l, 0]));
    for (const [a, b] of CONFUSABLE_SAME) {
      for (const [x, y] of [[a, b], [b, a]]) {
        const rates = order.map((l) => falsePass(x, y, l, 200, 7));
        rows.push(`${x}→${y} ` + order.map((l, i) => `${LEVELS[l].label} ${(rates[i] * 100).toFixed(1)}%`).join(' / '));
        expect(rates[3], `${x}→${y}`).toBeLessThanOrEqual(0.05);
        order.forEach((l, i) => (sum[l] += rates[i]));
      }
    }
    console.log(rows.join('\n'));
    for (let i = 1; i < order.length; i++) expect(sum[order[i]]).toBeLessThanOrEqual(sum[order[i - 1]]);
  });

  it('紛らわしいペア(画数が違う): 100% 不合格', () => {
    for (const [a, b] of CONFUSABLE_COUNT) {
      for (const [x, y] of [[a, b], [b, a]]) {
        for (const level of Object.keys(LEVELS)) {
          expect(falsePass(x, y, level, 50, 3), `${x}→${y} ${level}`).toBe(0);
        }
      }
    }
  });
});
