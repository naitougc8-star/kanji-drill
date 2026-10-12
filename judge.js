// 書き取りの判定ロジック(DOM 非依存。ブラウザと Node の両方で動く)
//
// お手本(KanjiVG の筆画)とユーザーの筆画を 1 画ずつ照合する。
// 「何の字か当てる」方式ではないので、似た字を正解にしてしまうことがない。

/** 厳しさごとのしきい値。数値の根拠は README の「判定のしきい値」を参照。 */
export const LEVELS = {
  // 超甘い: 形のゆれをさらに大きく許す(画数・書き順・明らかに違う形は不合格のまま。横画の長さだけが違う似た字は通ることがある)
  superLenient: { label: '超甘い', mean: 0.26, max: 0.54, end: 0.33, lenLo: 0.42, lenHi: 2.4, lenAbs: 0.33, angle: 48, aspect: 0.8, relLen: 0.6, maxRot: 30, maxScale: 1.9, rule: 1.4, group: 0.55 },
  // 甘い: 字の形のゆれ(位置・長さ・角度)は大きく許し、似た字を見分けるチェック(長さの関係・字ごとのルール)は標準と同じくらいに残す
  lenient: { label: '甘い', mean: 0.2, max: 0.42, end: 0.26, lenLo: 0.5, lenHi: 2.0, lenAbs: 0.26, angle: 38, aspect: 0.65, relLen: 0.5, maxRot: 25, maxScale: 1.7, rule: 1.2, group: 0.5 },
  standard: { label: '標準', mean: 0.15, max: 0.32, end: 0.21, lenLo: 0.58, lenHi: 1.7, lenAbs: 0.2, angle: 30, aspect: 0.55, relLen: 0.5, maxRot: 20, maxScale: 1.5, rule: 1.2, group: 0.5 },
  severe: { label: 'シビア', mean: 0.11, max: 0.25, end: 0.16, lenLo: 0.68, lenHi: 1.48, lenAbs: 0.15, angle: 22, aspect: 0.42, relLen: 0.35, maxRot: 15, maxScale: 1.4, rule: 1.0, group: 0.32 },
};

export const DEFAULT_LEVEL = 'severe';
export const N_POINTS = 24;
const UNIFORM_RATIO = 0.22; // お手本の短辺/長辺がこれ未満なら縦横比を保って正規化
const LEN_MIN = 0.2; // これより短いお手本の筆画は長さの比ではなく差で判定
const CHORD_MIN = 0.12; // 始点→終点の距離がこれ以下なら角度は見ない
const PENALTY = 0.3;
const REVERSE_BIAS = 0.05;
const AFFINE_RIDGE = 0.02; // アフィン補正の正則化の強さ
// 平行な 2 本の長い筆画の「長さの比」を見る条件
const REL_MIN_LEN = 0.25; // どちらもこれより長い
const REL_MAX_ANGLE = 20; // 向きの差がこれ以下(度)
const REL_MIN_DIFF = 0.15; // お手本で長さがはっきり違う(|log 比| がこれ以上)

/**
 * 字ごとの追加ルール(筆画の形がほぼ同じで、端点の位置だけが違う字)。
 * 筆画の番号はお手本の番号(0 始まり)。点は [筆画, 'start' | 'end' | 'mid'(重心)]。
 * - dy:     p.y - a.y               (2 点の高さの差)
 * - ratioY: (p.y - a.y) / (b.y - a.y) (a と b の間のどの高さにあるか。0 = a, 1 = b)
 * お手本で同じ値を計算し、差が tol × LEVELS[].rule を超えたら不合格。
 * - aspect: 字全体の縦横比の許容差(対数)を、この字だけ tol × LEVELS[].rule に狭くする。
 */
export const CHAR_RULES = {
  // 日・曰: 縦横比だけが大きく違う(対数で約 0.4)。全体の許容差(シビアで log 1.42 = 0.35)では分けられない。
  日: [{ type: 'aspect', tol: 0.2 }],
  曰: [{ type: 'aspect', tol: 0.2 }],
  // 午・牛: 4 画目(縦画)が 2 画目の横画より上に突き出るかどうか
  午: [{ type: 'dy', p: [3, 'start'], a: [1, 'mid'], tol: 0.12, what: '書き始めの高さ' }],
  牛: [{ type: 'dy', p: [3, 'start'], a: [1, 'mid'], tol: 0.12, what: '書き始めの高さ' }],
  // 刀・力: 2 画目(ノ)が 1 画目の横画より上から出るかどうか
  刀: [{ type: 'dy', p: [1, 'start'], a: [0, 'start'], tol: 0.12, what: '書き始めの高さ' }],
  力: [{ type: 'dy', p: [1, 'start'], a: [0, 'start'], tol: 0.12, what: '書き始めの高さ' }],
};

/**
 * 筆画の形がほぼ同じで、1 か所の位置だけが違う字のグループ。
 * score(筆画の配列) で 1 次元の値を出し、グループ内でお手本の値(centers)がいちばん近い字を選ぶ。
 * 正解の字の値から、隣の字の値までの距離の 0.5 × LEVELS[].rule を超えたら不合格。
 */
export const CHAR_GROUPS = [
  {
    chars: ['己', '已', '巳'],
    stroke: 2,
    what: '書き始めの位置',
    // 3 画目(㇟)の「書き始めから角までの弧長 / 全体の弧長」と、「1 画目の書き始めからの高さの差」を
    // 組み合わせる(重みはシミュレーションでの線形判別から決めた。scripts/calibrate.mjs 参照)。
    score: hookScore,
    centers: { 己: 0.3158, 已: 0.417, 巳: 0.4856 }, // KanjiVG から計算(テストで一致を確認)
  },
];

/** ㇟ の角(始点と終点を結ぶ線から最も遠い点)までの弧長の割合 − 0.2 × 書き始めの高さ */
export function hookScore(S) {
  const s = resample(S[2], 128);
  const a = s[0], e = s[s.length - 1];
  const dx = e[0] - a[0], dy = e[1] - a[1], L = Math.hypot(dx, dy) || 1;
  let ci = 0, best = -1;
  s.forEach((p, i) => {
    const d = Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / L;
    if (d > best) { best = d; ci = i; }
  });
  const frac = polyLength(s.slice(0, ci + 1)) / (polyLength(s) || 1);
  return frac - 0.2 * (S[2][0][1] - S[0][0][1]);
}

export function groupOf(ch) {
  return CHAR_GROUPS.find((g) => g.chars.includes(ch)) || null;
}

// ---------- 幾何の小道具 ----------

/** KanjiVG の [x0,y0,x1,y1,...] を [[x,y],...] にする */
export function unflatten(flat) {
  const pts = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  return pts;
}

export function toTemplate(data) {
  return data.map((s) => (Array.isArray(s[0]) ? s : unflatten(s)));
}

export function bbox(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const [x, y] of s) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function polyLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** 弧長で等間隔に n 点へ再サンプルする */
export function resample(pts, n = N_POINTS) {
  if (pts.length === 0) return [];
  const total = polyLength(pts);
  if (total === 0 || pts.length === 1) return Array.from({ length: n }, () => [pts[0][0], pts[0][1]]);
  const step = total / (n - 1);
  const out = [[pts[0][0], pts[0][1]]];
  let acc = 0, i = 1, prev = pts[0];
  let target = step;
  while (out.length < n - 1 && i < pts.length) {
    const cur = pts[i];
    const seg = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    if (acc + seg >= target && seg > 0) {
      const t = (target - acc) / seg;
      const p = [prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t];
      out.push(p);
      acc = target;
      prev = p;
      target += step;
    } else {
      acc += seg;
      prev = cur;
      i++;
    }
  }
  const last = pts[pts.length - 1];
  while (out.length < n) out.push([last[0], last[1]]);
  return out;
}

function makeNormalizer(box, mode, weights) {
  const unit = Math.max(box.w, box.h) || 1;
  if (mode === 'uniform') {
    const ox = box.x - (unit - box.w) / 2, oy = box.y - (unit - box.h) / 2;
    return ([x, y]) => [(x - ox) / unit, (y - oy) / unit];
  }
  // stretch: 縦横を別々に 0〜1 へ。つぶれた方向はゼロ割りしないように下限を設ける。
  const w = Math.max(box.w, unit * 0.02), h = Math.max(box.h, unit * 0.02);
  return ([x, y]) => [((x - box.x) / w) * weights[0], ((y - box.y) / h) * weights[1]];
}

/** お手本・ユーザーそれぞれを正規化して 24 点に再サンプルする */
export function normalizePair(user, tmpl) {
  const tb = bbox(tmpl);
  const tunit = Math.max(tb.w, tb.h) || 1;
  const mode = Math.min(tb.w, tb.h) / tunit < UNIFORM_RATIO ? 'uniform' : 'stretch';
  const weights = mode === 'stretch' ? [tb.w / tunit, tb.h / tunit] : [1, 1];
  const ub = bbox(user);
  const nt = makeNormalizer(tb, mode, weights);
  const nu = makeNormalizer(ub, mode, weights);
  const tRaw = tmpl.map((s) => s.map(nt));
  const uRaw = user.map((s) => s.map(nu));
  return {
    mode,
    tRaw,
    uRaw,
    weights,
    tbox: tb,
    ubox: ub,
    t: tRaw.map((s) => resample(s)),
    u: uRaw.map((s) => resample(s)),
  };
}

function angleOf(p) {
  return Math.atan2(p[p.length - 1][1] - p[0][1], p[p.length - 1][0] - p[0][0]);
}

function chord(p) {
  return Math.hypot(p[p.length - 1][0] - p[0][0], p[p.length - 1][1] - p[0][1]);
}

/** 筆画ペアの比較 */
export function compareStroke(u, t, th) {
  const n = Math.min(u.length, t.length);
  let sum = 0, max = 0, cx = 0, cy = 0;
  for (let k = 0; k < n; k++) {
    const dx = u[k][0] - t[k][0], dy = u[k][1] - t[k][1];
    const d = Math.hypot(dx, dy);
    sum += d;
    if (d > max) max = d;
    cx += dx;
    cy += dy;
  }
  const mean = sum / n;
  const start = Math.hypot(u[0][0] - t[0][0], u[0][1] - t[0][1]);
  const end = Math.hypot(u[n - 1][0] - t[n - 1][0], u[n - 1][1] - t[n - 1][1]);
  const lu = polyLength(u), lt = polyLength(t);
  let lenRatio = null, lenDiff = null;
  if (lt > LEN_MIN) lenRatio = lu / lt;
  else lenDiff = lu - lt;
  let angle = null;
  if (chord(u) > CHORD_MIN && chord(t) > CHORD_MIN) {
    let a = Math.abs(angleOf(u) - angleOf(t)) * (180 / Math.PI);
    if (a > 180) a = 360 - a;
    angle = a;
  }
  const fails = [];
  if (lenRatio !== null && lenRatio < th.lenLo) fails.push('short');
  if (lenRatio !== null && lenRatio > th.lenHi) fails.push('long');
  if (lenDiff !== null && lenDiff > th.lenAbs) fails.push('long');
  if (lenDiff !== null && lenDiff < -th.lenAbs) fails.push('short');
  if (angle !== null && angle > th.angle) fails.push('angle');
  if (start > th.end) fails.push('start');
  if (end > th.end) fails.push('end');
  if (mean > th.mean) fails.push('mean');
  if (max > th.max) fails.push('max');
  const cost = mean + 0.5 * Math.max(start, end) + (fails.length ? PENALTY : 0);
  return { mean, max, start, end, lenRatio, lenDiff, angle, offset: [cx / n, cy / n], fails, ok: fails.length === 0, cost };
}

// ---------- 割り当て(ハンガリアン法) ----------

/** 正方行列のコスト最小割り当て。戻り値 a[i] = 行 i に割り当てた列 */
export function hungarian(cost) {
  const n = cost.length;
  const INF = Infinity;
  const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const a = new Array(n);
  for (let j = 1; j <= n; j++) a[p[j] - 1] = j - 1;
  return a;
}

// ---------- 字全体のアフィン補正 ----------

function solve3(A, b) {
  // 3x3 の連立一次方程式(クラメルの公式)
  const det = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-12) return null;
  return [0, 1, 2].map((c) => det(A.map((row, r) => row.map((v, k) => (k === c ? b[r] : v)))) / D);
}

/**
 * 対応点の組から、ユーザー → お手本の最小二乗アフィン変換を求める。
 * 戻り値: { m: [a, b, c, d, e, f], rot: 回転角(度), scale: [s1, s2] } (x' = a x + b y + c, y' = d x + e y + f)
 */
export function fitAffine(src, dst, ridge = AFFINE_RIDGE) {
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const bx = [0, 0, 0], by = [0, 0, 0];
  for (let k = 0; k < src.length; k++) {
    const v = [src[k][0], src[k][1], 1];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) S[r][c] += v[r] * v[c];
      bx[r] += v[r] * dst[k][0];
      by[r] += v[r] * dst[k][1];
    }
  }
  // リッジ正則化: 線形部分を単位行列に寄せる(「一」のように点が一直線に並ぶ字でも退化しない)
  const lam = ridge * src.length;
  S[0][0] += lam;
  S[1][1] += lam;
  bx[0] += lam;
  by[1] += lam;
  const px = solve3(S, bx), py = solve3(S, by);
  if (!px || !py) return null;
  const [a, b] = px, [d, e] = py;
  // 極分解で回転角と伸縮を取り出す
  const rot = Math.atan2(d - b, a + e);
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const s00 = cos * a + sin * d, s01 = cos * b + sin * e, s11 = -sin * b + cos * e;
  const tr = s00 + s11, dt = s00 * s11 - s01 * s01;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - dt));
  return { m: [a, b, px[2], d, e, py[2]], rot: (rot * 180) / Math.PI, scale: [tr / 2 + disc, tr / 2 - disc] };
}

function applyAffine(pts, m) {
  return pts.map(([x, y]) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]]);
}

// ---------- 理由の文言 ----------

function dirText(dx, dy) {
  const v = Math.abs(dy) >= 0.04 ? (dy > 0 ? '下' : '上') : '';
  const h = Math.abs(dx) >= 0.04 ? (dx > 0 ? '右' : '左') : '';
  if (v && h) return h + v; // 右下・左上 など
  return v || h;
}

function pointOffsetText(u, t) {
  const d = dirText(u[0] - t[0], u[1] - t[1]);
  return d ? `(${d}にずれています)` : '';
}

function strokeReason(m, uS, tS) {
  const f = m.fails;
  if (f.includes('short')) return m.lenRatio !== null ? `短すぎます(お手本の約 ${Math.round(m.lenRatio * 100)}%)` : '短すぎます';
  if (f.includes('long')) return m.lenRatio !== null ? `長すぎます(お手本の約 ${Math.round(m.lenRatio * 100)}%)` : '長すぎます';
  if (f.includes('angle')) return `向き(角度)が違います(約 ${Math.round(m.angle)}° ずれ)`;
  if (f.includes('start') && !f.includes('end')) return `書き始めの位置が違います${pointOffsetText(uS[0], tS[0])}`;
  if (f.includes('end') && !f.includes('start')) {
    const n = uS.length - 1;
    return `書き終わりの位置が違います${pointOffsetText(uS[n], tS[n])}`;
  }
  const d = dirText(m.offset[0], m.offset[1]);
  if (d) return `位置がずれています(${d}にずれています)`;
  return '形が違います';
}

// ---------- 判定 ----------

/** 対応点の回帰による縦横比のずれ(ユーザーの横の倍率 / 縦の倍率)。1 なら同じ。 */
function aspectByRegression(user, tmpl, assign, reversed) {
  const src = [], dst = [];
  assign.forEach((j, i) => {
    let u = resample(user[i]);
    if (reversed[i]) u = u.reverse();
    const t = resample(tmpl[j]);
    for (let k = 0; k < N_POINTS; k++) { src.push(t[k]); dst.push(u[k]); }
  });
  // お手本 → ユーザーのアフィン変換(傾き・せん断を同時に推定するので、横と縦の倍率が混ざりにくい)
  const fit = fitAffine(src, dst, 0);
  if (!fit) return 1;
  const sx = fit.m[0], sy = fit.m[4];
  if (sx <= 0 || sy <= 0) return Infinity;
  return sx / sy;
}

/** お手本の筆画 j に対応するユーザーの筆画(向きを合わせたもの)の配列 */
function userStrokesByTemplate(strokes, assign, reversed) {
  const out = [];
  assign.forEach((j, i) => {
    out[j] = reversed[i] ? strokes[i].slice().reverse() : strokes[i];
  });
  return out;
}

function pointOf(strokes, [s, at]) {
  const p = strokes[s];
  if (!p) return null;
  if (at === 'start') return p[0];
  if (at === 'end') return p[p.length - 1];
  return p.reduce((a, q) => [a[0] + q[0] / p.length, a[1] + q[1] / p.length], [0, 0]);
}

function ruleValue(rule, strokes) {
  const p = pointOf(strokes, rule.p), a = pointOf(strokes, rule.a);
  if (!p || !a) return null;
  if (rule.type === 'dy') return p[1] - a[1];
  const b = pointOf(strokes, rule.b);
  if (!b || Math.abs(b[1] - a[1]) < 1e-6) return null;
  return (p[1] - a[1]) / (b[1] - a[1]);
}

function evalAssignment(N, assign, th) {
  return assign.map((j, i) => compareStroke(N.u[i], N.t[j], th));
}

/**
 * 判定する。
 * @param {number[][][]} user ユーザーの筆画 [[[x,y],...], ...](書いた順)
 * @param {Array} template お手本の筆画(KanjiVG のフラット配列、または [[x,y],...] の配列)
 * @param {{level?: string, checkOrder?: boolean, char?: string, thresholds?: object}} opts
 * @returns {{pass: boolean, reasons: {stroke: number|null, text: string}[], notes: string[], assign: number[]|null, strokes: object[]}}
 */
export function judge(user, template, opts = {}) {
  const level = opts.level || DEFAULT_LEVEL;
  const th = opts.thresholds || LEVELS[level] || LEVELS[DEFAULT_LEVEL];
  const tmpl = toTemplate(template);
  const strokesIn = (user || []).filter((s) => s && s.length > 0);
  const result = { pass: false, reasons: [], notes: [], assign: null, strokes: [], level };

  if (strokesIn.length === 0) {
    result.reasons.push({ stroke: null, text: '何も書かれていません' });
    return result;
  }
  if (strokesIn.length !== tmpl.length) {
    result.reasons.push({ stroke: null, text: `画数が違います(正解 ${tmpl.length} 画 / あなた ${strokesIn.length} 画)` });
    return result;
  }

  const N = normalizePair(strokesIn, tmpl);
  const n = tmpl.length;

  // 全ペアの比較(正方向・逆方向)とコスト最小の割り当て
  let fwd, rev, best;
  const matchAll = () => {
    fwd = [];
    rev = [];
    for (let i = 0; i < n; i++) {
      fwd.push([]);
      rev.push([]);
      const ur = N.u[i].slice().reverse();
      for (let j = 0; j < n; j++) {
        fwd[i].push(compareStroke(N.u[i], N.t[j], th));
        rev[i].push(compareStroke(ur, N.t[j], th));
      }
    }
    const costs = fwd.map((row, i) => row.map((m, j) => Math.min(m.cost, rev[i][j].cost + REVERSE_BIAS)));
    best = hungarian(costs);
  };
  matchAll();

  // 字全体の傾き・ゆがみを、最小二乗のアフィン変換で 1 回だけ補正する。
  // 筆画どうしの相対的な長さ・位置(末と未、士と土の違い)は、字全体の変換では消えない。
  if (th.affine !== false) {
    const src = [], dst = [];
    for (let i = 0; i < n; i++) {
      const j = best[i];
      const useRev = rev[i][j].cost + REVERSE_BIAS < fwd[i][j].cost;
      const us = useRev ? N.u[i].slice().reverse() : N.u[i];
      for (let k = 0; k < N_POINTS; k++) { src.push(us[k]); dst.push(N.t[j][k]); }
    }
    const fit = fitAffine(src, dst);
    if (fit) {
      result.affine = fit;
      const maxRot = th.maxRot ?? 15, maxScale = th.maxScale ?? 1.3;
      const [s1, s2] = fit.scale;
      if (Math.abs(fit.rot) > maxRot) {
        result.reasons.push({ stroke: null, text: `字全体が傾いています(約 ${Math.round(Math.abs(fit.rot))}°)` });
        return result;
      }
      if (s2 <= 0 || s1 / s2 > maxScale) {
        result.reasons.push({ stroke: null, text: '字全体の形がゆがんでいます' });
        return result;
      }
      N.u = N.u.map((s) => applyAffine(s, fit.m));
      N.uRaw = N.uRaw.map((s) => applyAffine(s, fit.m));
      matchAll();
    }
  }
  const identity = Array.from({ length: n }, (_, i) => i);
  const assign = opts.checkOrder ? identity : best;
  result.assign = assign;

  const reasons = [];
  const metrics = [];
  for (let i = 0; i < n; i++) {
    const j = assign[i];
    const m = fwd[i][j];
    metrics.push({ user: i, tmpl: j, ...m, reversed: false });
    if (m.ok) continue;
    const r = rev[i][j];
    const label = j === i ? `${i + 1} 画目` : `${i + 1} 画目(お手本の ${j + 1} 画目)`;
    if (r.ok) {
      metrics[i].reversed = true;
      reasons.push({ stroke: i, text: `${label}: 書く向きが逆です` });
    } else {
      reasons.push({ stroke: i, text: `${label}: ${strokeReason(m, N.u[i], N.t[j])}` });
    }
  }

  if (opts.checkOrder && reasons.length) {
    // 書き順だけが違うのかどうか
    const alt = evalAssignment(N, best, th);
    const shapeOk = alt.every((m) => m.ok) && best.some((j, i) => j !== i);
    if (shapeOk) {
      reasons.length = 0;
      reasons.push({ stroke: null, text: '書き順が違います(形は合っています)' });
      for (let i = 0; i < n; i++) {
        if (best[i] !== i) reasons.push({ stroke: i, text: `${i + 1} 画目: お手本では ${best[i] + 1} 画目に書く筆画です` });
      }
    }
  } else if (!opts.checkOrder && reasons.length === 0 && best.some((j, i) => j !== i)) {
    result.notes.push('書き順がお手本と違うところがあります(書き順は判定していません)');
  }

  // ここから先は「形」の確認。書き順の判定の有無にかかわらず、形で割り当てた対応(best)を使う。
  const shapeRev = best.map((j, i) => rev[i][j].cost + REVERSE_BIAS < fwd[i][j].cost);
  const shapeUser = userStrokesByTemplate(N.u, best, shapeRev);

  // 平行な 2 本の長い筆画の長さの関係(末と未、士と土を分ける)
  if (th.relLen) {
    const lt = N.t.map(polyLength), lu = shapeUser.map(polyLength);
    const dirT = N.t.map((s) => angleOf(s));
    for (let j = 0; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        if (lt[j] < REL_MIN_LEN || lt[k] < REL_MIN_LEN) continue;
        let a = Math.abs(dirT[j] - dirT[k]) * (180 / Math.PI) % 180;
        if (a > 90) a = 180 - a;
        if (a > REL_MAX_ANGLE) continue;
        const rt = Math.log(lt[j] / lt[k]);
        if (Math.abs(rt) < REL_MIN_DIFF || lu[j] <= 0 || lu[k] <= 0) continue;
        const ru = Math.log(lu[j] / lu[k]);
        if (Math.abs(ru - rt) <= th.relLen) continue;
        const ij = best.indexOf(j), ik = best.indexOf(k);
        if (reasons.some((r) => r.stroke === ij || r.stroke === ik)) continue;
        const longer = rt > 0 ? ij : ik, shorter = rt > 0 ? ik : ij;
        reasons.push({
          stroke: longer,
          text: `${longer + 1} 画目と ${shorter + 1} 画目の長さの関係が違います(${longer + 1} 画目のほうを長く)`,
        });
      }
    }
  }

  // 字全体の縦横比(stretch のときのみ)。日と曰を分ける。
  // バウンディングボックスの比は、はみ出した 1 画に引きずられて 1 に寄りやすいので、
  // 対応する全点の回帰で「お手本 → ユーザー」の横・縦の倍率を求め、その比を見る。
  if (N.mode === 'stretch') {
    const dev = aspectByRegression(strokesIn, tmpl, best, shapeRev);
    result.aspect = dev;
    const aspectRule = (CHAR_RULES[opts.char] || []).find((r) => r.type === 'aspect');
    const aspectTol = aspectRule ? aspectRule.tol * th.rule : Math.log(1 + th.aspect);
    if (Math.abs(Math.log(dev)) > aspectTol) {
      reasons.push({
        stroke: null,
        text: dev > 1 ? '字の形が違います(横に広すぎます。もっと縦長に)' : '字の形が違います(縦に長すぎます。もっと横長に)',
      });
    }
  }

  // 字ごとの追加ルール
  const rules = opts.char ? CHAR_RULES[opts.char] : null;
  if (rules) {
    const hasReason = (i) => reasons.some((r) => r.stroke === i);
    for (const rule of rules) {
      if (rule.type === 'aspect') continue; // 縦横比の確認で扱う
      const i = best.indexOf(rule.p[0]);
      if (i < 0) continue;
      const vu = ruleValue(rule, shapeUser), vt = ruleValue(rule, N.t);
      if (vu === null || vt === null) continue;
      const d = vu - vt;
      if (Math.abs(d) > rule.tol * th.rule && !hasReason(i)) {
        reasons.push({ stroke: i, text: `${i + 1} 画目: ${rule.what}が違います(${d > 0 ? '低すぎます' : '高すぎます'})` });
      }
    }
  }

  // 紛らわしい字のグループ(己・已・巳)
  const group = opts.char ? groupOf(opts.char) : null;
  if (group) {
    const su = group.score(userStrokesByTemplate(N.uRaw, best, shapeRev));
    const sc = group.centers[opts.char];
    result.groupScore = su;
    const i = best.indexOf(group.stroke);
    for (const other of group.chars) {
      if (other === opts.char) continue;
      const span = group.centers[other] - sc;
      if ((su - sc) / span > th.group) {
        if (!reasons.some((r) => r.stroke === i)) {
          reasons.push({ stroke: i, text: `${i + 1} 画目: ${group.what}が違います(「${other}」に見えます)` });
        }
        break;
      }
    }
  }

  result.strokes = metrics;
  result.reasons = reasons;
  result.pass = reasons.length === 0;
  return result;
}
