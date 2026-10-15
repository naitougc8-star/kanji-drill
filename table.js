// 表の形式の漢字テスト(縦書き・番号付きの列・罫線で区切られたマス)から、問題を 1 列ずつ切り出す。
// 計算の部分(グレースケールの配列を受け取る関数)は DOM に依存しないので、Node でテストできる。

import { removeLines } from './marker.js';

/**
 * 局所しきい値で黒い画素を求める(写真の明るさのむら・影に強い)。
 * @returns {Uint8Array} 1 = 黒
 */
export function adaptiveDark(gray, W, H, win = 31, c = 14) {
  // 積分画像で、まわり win×win の平均を出す
  const S = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += gray[y * W + x];
      S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
    }
  }
  const r = win >> 1;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const sum = S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      out[y * W + x] = gray[y * W + x] < mean - c ? 1 : 0;
    }
  }
  return out;
}

/** 傾き t(= tan θ)で縦方向に足し合わせた、横位置ごとの黒い画素の数 */
function verticalProfile(dark, W, H, t) {
  const P = new Float64Array(W);
  const cy = H / 2;
  for (let y = 0; y < H; y++) {
    const shift = (y - cy) * t;
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (!dark[row + x]) continue;
      const px = Math.round(x - shift);
      if (px >= 0 && px < W) P[px]++;
    }
  }
  return P;
}

/**
 * 縦の罫線がいちばんまっすぐに揃う傾き(度)を求める。
 * 正の値は、下に行くほど右にずれている(時計回りに傾いている)ことを表す。
 */
export function estimateSkew(dark, W, H, range = 6, step = 0.2) {
  let best = 0, bestScore = -1;
  for (let a = -range; a <= range + 1e-9; a += step) {
    const P = verticalProfile(dark, W, H, Math.tan((a * Math.PI) / 180));
    let s = 0;
    for (let i = 0; i < W; i++) s += P[i] * P[i];
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  return Math.round(best * 100) / 100;
}

/** 足し合わせた数がしきい値を超える位置を、線の中心の位置としてまとめる */
function peaks(P, minValue, mergeDist) {
  const out = [];
  let start = -1, wsum = 0, psum = 0;
  for (let i = 0; i <= P.length; i++) {
    const on = i < P.length && P[i] >= minValue;
    if (on) {
      if (start < 0) start = i;
      wsum += P[i] * i;
      psum += P[i];
    } else if (start >= 0) {
      out.push(wsum / psum);
      start = -1;
      wsum = psum = 0;
    }
  }
  // 近すぎる線(太い線や二重線)は 1 本にまとめる
  const merged = [];
  for (const p of out) {
    if (merged.length && p - merged[merged.length - 1] < mergeDist) merged[merged.length - 1] = (merged[merged.length - 1] + p) / 2;
    else merged.push(p);
  }
  return merged;
}

// 罫線を探すときの設定
const LINE_SPREAD = 2; // 線の太さ方向に ±2px の幅で黒を見る(点線・少し曲がった線も 1 本の線として数える)
const LINE_MIN = 0.4; // 線とみなす割合(範囲の幅・高さに対して)。点線は 0.5 前後、字の並びは 0.25 以下
const TOPHAT_MIN = 0.3; // まわり(線から離れた所)より、これだけ多いこと(字の列は幅が広いので、まわりとの差は 0.25 以下)
const BAND_RATIO = 0.7; // 問題の段 = いちばん背の高い段の 0.7 倍以上の段(番号の段・答えの段は低い)

/** 線の太さ方向に spread だけ広げて数えた、横位置ごとの黒の割合(y0〜y1 の範囲で) */
function columnFraction(dark, W, y0, y1, spread = LINE_SPREAD) {
  const P = new Float64Array(W);
  const n = Math.max(1, y1 - y0);
  for (let y = Math.max(0, Math.floor(y0)); y < Math.ceil(y1); y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      for (let d = -spread; d <= spread; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < W && dark[row + xx]) {
          P[x]++;
          break;
        }
      }
    }
  }
  for (let x = 0; x < W; x++) P[x] /= n;
  return P;
}

/** 線の太さ方向に spread だけ広げて数えた、縦位置ごとの黒の割合 */
function rowFraction(dark, W, H, spread = LINE_SPREAD) {
  const P = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = 0; x < W; x++) {
      for (let d = -spread; d <= spread; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < H && dark[yy * W + x]) {
          s++;
          break;
        }
      }
    }
    P[y] = s / W;
  }
  return P;
}

/**
 * 細い山(罫線)の位置。まわり(a〜b px 離れた所)の最大より TOPHAT_MIN 以上高く、LINE_MIN 以上の所。
 * 字の列は幅が広く、まわりも黒いので選ばれない。
 */
function linePeaks(P, a, b, mergeDist) {
  const n = P.length;
  const on = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (P[i] < LINE_MIN) continue;
    let around = 0;
    for (let k = a; k <= b; k++) {
      if (i - k >= 0) around = Math.max(around, P[i - k]);
      if (i + k < n) around = Math.max(around, P[i + k]);
    }
    if (P[i] - around >= TOPHAT_MIN) on[i] = P[i];
  }
  return peaks(on, LINE_MIN, mergeDist);
}

/**
 * 傾きを直した(罫線がまっすぐな)画像から、表の罫線を見つける。
 * 段(横の罫線の間)が何段あってもよい(1〜14 番・15〜28 番・29〜40 番のように、問題が 3 段に並ぶプリント)。
 * 列の罫線は段ごとに探す(段ごとに列の位置が違ってもよい)。罫線は実線でも点線でもよい。
 * @returns {{h: number[], bands: {y0: number, y1: number, v: number[]}[]}} h: 横の罫線、bands: 問題の段と、その段の縦の罫線
 */
export function findGrid(dark, W, H) {
  const k = Math.max(W, H) / 1600;
  const a = Math.max(6, Math.round(8 * k)), b = Math.max(a + 4, Math.round(14 * k));
  const h = linePeaks(rowFraction(dark, W, H), a, b, Math.max(4, H * 0.01));
  const ys = [0, ...h, H];
  const all = [];
  for (let i = 1; i < ys.length; i++) all.push([ys[i - 1], ys[i]]);
  const tallest = Math.max(...all.map(([y0, y1]) => y1 - y0));
  const bands = all
    .filter(([y0, y1]) => y1 - y0 >= tallest * BAND_RATIO)
    .map(([y0, y1]) => {
      // 段の上下の端(罫線の近く)は除いて数える
      const m = (y1 - y0) * 0.04;
      const v = linePeaks(columnFraction(dark, W, y0 + m, y1 - m), a, b, Math.max(4, W * 0.01));
      return { y0, y1, v };
    });
  return { h, bands };
}

/** 1 段の縦の罫線から、列の範囲 [x0, x1] を左から順に作る */
function columnsOf(v, W) {
  const xs = v.slice().sort((p, q) => p - q);
  const gaps = [];
  for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
  if (!gaps.length) return [];
  const med = gaps.slice().sort((p, q) => p - q)[gaps.length >> 1];
  const cols = [];
  for (let i = 1; i < xs.length; i++) {
    const w = xs[i] - xs[i - 1];
    if (w > med * 0.5) cols.push([xs[i - 1], xs[i]]);
  }
  // 端の、罫線の外側の列(範囲の取り方で罫線が入らなかった場合)
  if (xs[0] > med * 0.75) cols.unshift([Math.max(0, xs[0] - med), xs[0]]);
  if (W - xs[xs.length - 1] > med * 0.75) cols.push([xs[xs.length - 1], Math.min(W, xs[xs.length - 1] + med)]);
  return cols;
}

/**
 * 罫線の位置から、問題のマス(列)の範囲を決める。
 * - 段: 上の段から順に。縦の罫線が 2 本未満の段(表の外の余白など)は使わない
 * - 列: 段の中で、右から左(縦書きの問題の順)
 * 罫線が見つからないときは、範囲全体を 1 列とする。
 */
export function cellsFromGrid(grid, W, H) {
  const cells = [];
  for (const band of grid.bands) {
    if (band.v.length < 2) continue;
    for (const [x0, x1] of columnsOf(band.v, W).reverse()) cells.push({ x0, x1, y0: band.y0, y1: band.y1 });
  }
  if (!cells.length) cells.push({ x0: 0, x1: W, y0: 0, y1: H });
  return cells;
}

/**
 * 横幅いっぱいに続く横線(番号の段・答えの段との区切り)がある行を探す。
 * ページの湾曲で少し曲がっていてもよいように、上下 ±2 行の幅で連続を見る。
 * 点線の切れ目(gap px 以下)は、つながっているとみなす。
 * @returns {number[]} 横線のある y
 */
export function horizontalLineRows(dark, W, H, x0, x1, yFrom, yTo, minLen, gap = 0) {
  const rows = [];
  for (let y = Math.max(0, Math.floor(yFrom)); y < Math.min(H, yTo); y++) {
    let start = -1, last = -1, best = 0;
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
      let on = false;
      for (let dy = -2; dy <= 2 && !on; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < H) on = dark[yy * W + x] === 1;
      }
      if (!on) continue;
      if (start < 0 || x - last - 1 > gap) start = x;
      last = x;
      if (last - start + 1 > best) best = last - start + 1;
    }
    if (best >= minLen) rows.push(y);
  }
  return rows;
}

/**
 * 1 列ぶんの画像を、OCR しやすい白黒に近い画像にする。
 * - 列の上の番号の段・下の答えの段を、横幅いっぱいの区切り線で見つけて除く(線が曲がっていてもよい)
 * - 局所しきい値で紙を真っ白にし、マスの外(縦の罫線を含む)を白くする
 * - 残った縦線・横線を消す
 * @param {{x0: number, x1: number, y0: number, y1: number, cellW: number}} box マスの内側の範囲と列の幅(px)
 */
export function cleanColumn(gray, W, H, box) {
  const win = Math.max(15, Math.round(box.cellW * 0.6) | 1);
  const dark = adaptiveDark(gray, W, H, win, 12);
  const ch = box.y1 - box.y0;
  let top = box.y0, bottom = box.y1;
  const across = (box.x1 - box.x0) * 0.85;
  const gap = Math.max(3, Math.round(box.cellW * 0.06)); // 点線の切れ目
  const upper = horizontalLineRows(dark, W, H, box.x0, box.x1, box.y0 - box.cellW * 0.2, box.y0 + ch * 0.3, across, gap);
  if (upper.length) top = Math.max(top, upper[upper.length - 1] + 4);
  const lower = horizontalLineRows(dark, W, H, box.x0, box.x1, box.y1 - ch * 0.15, box.y1 + box.cellW * 0.2, across, gap);
  if (lower.length) bottom = Math.min(bottom, lower[0] - 4);
  // 字の部分(黒い画素を 2px 太らせた範囲)だけ、元の濃淡を残す(輪郭のなめらかさが OCR に効く)
  const X0 = Math.max(0, Math.floor(box.x0)), X1 = Math.min(W, Math.ceil(box.x1));
  const Y0 = Math.max(0, Math.floor(top)), Y1 = Math.min(H, Math.ceil(bottom));
  const near = new Uint8Array(W * H);
  const inkVals = [], paperVals = [];
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const p = y * W + x;
      if (dark[p]) {
        inkVals.push(gray[p]);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= Y0 && yy < Y1 && xx >= X0 && xx < X1) near[yy * W + xx] = 1;
        }
      } else if ((x + y) % 3 === 0) paperVals.push(gray[p]);
    }
  }
  const pct = (a, q) => (a.length ? a.sort((m, n) => m - n)[Math.floor(a.length * q)] : 0);
  const ink = pct(inkVals, 0.2), paper = pct(paperVals, 0.5) || 255;
  const range = Math.max(20, paper - ink);
  const out = new Uint8ClampedArray(W * H).fill(255);
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const p = y * W + x;
      if (near[p]) out[p] = ((gray[p] - ink) * 255) / range;
    }
  }
  removeLines(out, W, H, true, Math.round(box.cellW * 1.3), 150);
  removeLines(out, W, H, false, Math.round(across), 150);
  return out;
}

// 形の似た字の取り違え(OCR)を、カタカナの並びの中だけ直す
const TO_KATAKANA = {
  力: 'カ', 工: 'エ', 二: 'ニ', 口: 'ロ', 八: 'ハ', 卜: 'ト', 夕: 'タ', 才: 'オ', 千: 'チ', 一: 'ー', 丨: 'ー', '|': 'ー',
  へ: 'ヘ', べ: 'ベ', ぺ: 'ペ', り: 'リ',
};
const isKata = (c) => /[ァ-ヺー]/.test(c || '');

/**
 * カタカナに挟まれた(または片側がカタカナの)紛らわしい字をカタカナに直す。
 * 例: 「ア力ギ」→「アカギ」、「コウ工ン」→「コウエン」。「ノウコウ」はそのまま。
 */
export function fixKatakana(text) {
  const c = [...text];
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < c.length; i++) {
      const to = TO_KATAKANA[c[i]];
      if (!to) continue;
      const prev = isKata(c[i - 1]), next = isKata(c[i + 1]);
      // ひらがなの「へ・べ・ぺ・り」は、両側がカタカナのときだけ直す(「〜へ」などの助詞を守る)
      const hira = /[へべぺり]/.test(c[i]);
      if (hira ? prev && next : prev || next) c[i] = to;
    }
  }
  return c
    .join('')
    // 小さい字と同じ大きい字が並んだ読み違い(コウェエン → コウエン)
    .replace(/ァ(?=ア)|ィ(?=イ)|ゥ(?=ウ)|ェ(?=エ)|ォ(?=オ)|ャ(?=ヤ)|ュ(?=ユ)|ョ(?=ヨ)/g, '')
    .replace(/(?<=ア)ァ|(?<=イ)ィ|(?<=ウ)ゥ|(?<=エ)ェ|(?<=オ)ォ|(?<=ヤ)ャ|(?<=ユ)ュ|(?<=ヨ)ョ/g, '')
    // 行の端の小さい「っ・ッ」はごみ
    .replace(/^[っッ]+|[っッ]+$/g, '');
}

/** 文の中のカタカナの並び(書き取る部分)。[開始, 終了) の配列 */
export function katakanaRuns(text) {
  const c = [...text];
  const runs = [];
  for (let i = 0; i < c.length; i++) {
    if (!isKata(c[i]) || c[i] === 'ー') continue;
    let j = i + 1;
    while (j < c.length && isKata(c[j])) j++;
    runs.push([i, j]);
    i = j - 1;
  }
  return runs;
}

// ---------- ブラウザ用: 画像から列を切り出す ----------

function grayOf(canvas) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
  const out = new Uint8ClampedArray(canvas.width * canvas.height);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) out[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  return out;
}

/** 元画像の rect の部分を、傾き deg だけ戻して(回転して)描いた canvas */
function straightened(src, rect, deg, scale) {
  const W = Math.round(rect.w * scale), H = Math.round(rect.h * scale);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.translate(W / 2, H / 2);
  g.rotate((deg * Math.PI) / 180); // 下に行くほど右にずれている(deg > 0)なら、時計回りに戻す
  g.scale(scale, scale);
  g.drawImage(src, -(rect.x + rect.w / 2), -(rect.y + rect.h / 2));
  return c;
}

/**
 * 写真の、四角で囲んだ範囲(表)から、問題の列を切り出す。
 * @param {HTMLCanvasElement} src 元の画像
 * @param {{x: number, y: number, w: number, h: number}} rect 囲んだ範囲(元画像の px)
 * @returns {{crops: {canvas: HTMLCanvasElement, vertical: boolean}[], skew: number, cells: object[]}}
 */
export function extractTableColumns(src, rect) {
  // 1. 傾きを求める(処理を軽くするため、幅 1200px 程度に縮める)
  const s1 = Math.min(1, 1200 / rect.w);
  const small = straightened(src, rect, 0, s1);
  const W1 = small.width, H1 = small.height;
  const win = Math.max(15, Math.round(Math.min(W1, H1) / 25) | 1);
  const skew = estimateSkew(adaptiveDark(grayOf(small), W1, H1, win), W1, H1);

  // 2. 傾きを戻して、罫線を見つける
  const s2 = Math.min(2, 1600 / rect.w);
  const img = straightened(src, rect, skew, s2);
  const W = img.width, H = img.height;
  const gray = grayOf(img);
  const dark = adaptiveDark(gray, W, H, Math.max(15, Math.round(Math.min(W, H) / 25) | 1));
  const cells = cellsFromGrid(findGrid(dark, W, H), W, H);

  // 3. 列ごとに切り出す
  const crops = cells.map((cell) => {
    const cw = cell.x1 - cell.x0, ch = cell.y1 - cell.y0;
    // 列の幅が 140px 程度になるように拡大する
    const k = Math.max(1, Math.min(4, 140 / cw));
    const pad = Math.round(cw * 0.15);
    const x0 = Math.max(0, Math.round(cell.x0 - pad)), x1 = Math.min(W, Math.round(cell.x1 + pad));
    const y0 = Math.max(0, Math.round(cell.y0 - pad)), y1 = Math.min(H, Math.round(cell.y1 + pad));
    const cw2 = x1 - x0, ch2 = y1 - y0;
    const out = document.createElement('canvas');
    out.width = Math.round(cw2 * k);
    out.height = Math.round(ch2 * k);
    const og = out.getContext('2d', { willReadFrequently: true });
    og.imageSmoothingQuality = 'high';
    og.drawImage(img, x0, y0, cw2, ch2, 0, 0, out.width, out.height);
    const OW = out.width, OH = out.height;
    const g = cleanColumn(grayOf(out), OW, OH, {
      x0: (cell.x0 - x0 + cw * 0.08) * k,
      x1: (cell.x1 - x0 - cw * 0.08) * k,
      y0: (cell.y0 - y0) * k,
      y1: (cell.y1 - y0) * k,
      cellW: cw * k,
    });
    const id = og.getImageData(0, 0, OW, OH);
    for (let p = 0, i = 0; p < OW * OH; p++, i += 4) {
      id.data[i] = id.data[i + 1] = id.data[i + 2] = g[p];
      id.data[i + 3] = 255;
    }
    og.putImageData(id, 0, 0);
    return { canvas: out, vertical: true };
  });
  return { crops, skew, cells };
}
