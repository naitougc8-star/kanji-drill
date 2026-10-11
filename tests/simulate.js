// 「模擬の手書き」を作る。お手本の筆画に、人間らしいゆらぎを足す。
// 判定のしきい値を検証するために使う(テストと scripts/calibrate.mjs で共用)。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unflatten } from '../judge.js';

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const cache = new Map();

/** Node 用: 字のお手本(フラット配列の配列)を data/ から読む */
export function loadTemplate(ch) {
  const cp = ch.codePointAt(0);
  const b = (cp >> 8).toString(16);
  if (!cache.has(b)) {
    const f = path.join(DATA, `k${b}.json`);
    cache.set(b, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
  }
  return cache.get(b)[cp.toString(16)] || null;
}

/** 再現できる乱数(mulberry32) */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // 正規分布(2.5σ で打ち切り)
  next.gauss = (sigma = 1) => {
    let g;
    do {
      const u = 1 - next(), v = next();
      g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    } while (Math.abs(g) > 2.5);
    return g * sigma;
  };
  return next;
}

/**
 * ゆらぎの大きさ(長さの単位はお手本の座標 = 109 で 1 字)。
 * aspect: 字全体の縦横の伸縮(対数), rot: 字全体の回転(度), shear: せん断,
 * shift: 筆画ごとの平行移動, scale: 筆画ごとの拡大縮小, srot: 筆画ごとの回転(度),
 * wobble: 低周波の波打ちの振幅, noise: 点のノイズ
 */
export const NOISE = {
  neat: { label: 'ていねい', aspect: 0.05, rot: 2, shear: 0.03, shift: 2, scale: 0.06, srot: 3, wobble: 0.8, noise: 0.3 },
  normal: { label: 'ふつう', aspect: 0.08, rot: 3, shear: 0.05, shift: 3, scale: 0.1, srot: 5, wobble: 1.5, noise: 0.5 },
  rough: { label: '雑', aspect: 0.12, rot: 5, shear: 0.08, shift: 4.5, scale: 0.15, srot: 8, wobble: 2.5, noise: 0.8 },
};

function densify(pts, step = 1) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const L = Math.hypot(x1 - x0, y1 - y0);
    const k = Math.max(1, Math.ceil(L / step));
    for (let s = 1; s <= k; s++) out.push([x0 + ((x1 - x0) * s) / k, y0 + ((y1 - y0) * s) / k]);
  }
  return out;
}

function rotAround(p, c, rad, s = 1) {
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const x = (p[0] - c[0]) * s, y = (p[1] - c[1]) * s;
  return [c[0] + x * cos - y * sin, c[1] + x * sin + y * cos];
}

/**
 * お手本から模擬の手書きを作る。
 * @param {Array} template KanjiVG のフラット配列の配列
 * @param {object} noise NOISE のいずれか
 * @param {function} r rng()
 * @param {{size?: number}} opt 出力するキャンバス上の字の大きさ(px)
 * @returns {number[][][]} [[[x,y],...], ...]
 */
export function simulate(template, noise, r, opt = {}) {
  const size = opt.size || 300;
  const k = size / 109;
  const deg = Math.PI / 180;
  const C = [54.5, 54.5];
  const ga = r.gauss(noise.aspect);
  const sx = Math.exp(ga / 2), sy = Math.exp(-ga / 2);
  const grot = r.gauss(noise.rot) * deg;
  const shear = r.gauss(noise.shear);
  return template.map((flat) => {
    let pts = densify(unflatten(flat));
    // 筆画ごとの拡大・回転・平行移動(筆画の中心まわり)
    const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
    const s = 1 + r.gauss(noise.scale);
    const sr = r.gauss(noise.srot) * deg;
    const dx = r.gauss(noise.shift), dy = r.gauss(noise.shift);
    pts = pts.map((p) => rotAround(p, c, sr, s)).map(([x, y]) => [x + dx, y + dy]);
    // 低周波の波打ち(筆画に垂直な方向)
    const amp = r.gauss(noise.wobble);
    const freq = 0.5 + r() * 1.0, phase = r() * 2 * Math.PI;
    const n = pts.length;
    if (n > 2) {
      pts = pts.map((p, i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
        const tx = b[0] - a[0], ty = b[1] - a[1];
        const L = Math.hypot(tx, ty) || 1;
        const w = amp * Math.sin(2 * Math.PI * freq * (i / (n - 1)) + phase);
        return [p[0] - (ty / L) * w, p[1] + (tx / L) * w];
      });
    }
    // 字全体の伸縮・せん断・回転 → キャンバス座標
    return pts.map((p) => {
      let x = (p[0] - C[0]) * sx, y = (p[1] - C[1]) * sy;
      x += shear * y;
      const q = rotAround([x, y], [0, 0], grot);
      return [
        (q[0] + C[0]) * k + r.gauss(noise.noise * k),
        (q[1] + C[1]) * k + r.gauss(noise.noise * k),
      ];
    });
  });
}

/** 教育漢字(1・2 年)。合格率の検証に使う */
export const GRADE12 =
  '一右雨円王音下火花貝学気九休玉金空月犬見五口校左三山子四糸字耳七車手十出女小上森人水正生青夕石赤千川先早草足村大男竹中虫町天田土二日入年白八百文木本名目立力林六' +
  '引羽雲園遠何科夏家歌画回会海絵外角楽活間丸岩顔汽記帰弓牛魚京強教近兄形計元言原戸古午後語工公広交光考行高黄合谷国黒今才細作算止市矢姉思紙寺自時室社弱首秋週春書少場色食心新親図数西声星晴切雪船線前組走多太体台地池知茶昼長鳥朝直通弟店点電刀冬当東答頭同道読内南肉馬売買麦半番父風分聞米歩母方北毎妹万明鳴毛門夜野友用曜来里理話';

/** 紛らわしいペア(画数が同じもの) */
export const CONFUSABLE_SAME = [
  ['日', '曰'], ['末', '未'], ['士', '土'], ['干', '千'], ['午', '牛'],
  ['人', '入'], ['刀', '力'], ['己', '已'], ['已', '巳'], ['己', '巳'],
];
/** 紛らわしいペア(画数が違うもの。100% 不合格になるはず) */
export const CONFUSABLE_COUNT = [
  ['日', '目'], ['待', '侍'], ['持', '特'], ['礼', '社'], ['初', '礼'],
  ['補', '福'], ['祝', '視'], ['未', '朱'], ['土', '王'],
];
