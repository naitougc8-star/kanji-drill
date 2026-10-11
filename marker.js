// 写真の上で、読み取りたい問題をなぞる(マーカーで塗る)。なぞった帯だけを切り出して OCR に渡す。
// - Apple Pencil を検出したら、Pencil でなぞり、指はスクロールに使う
// - Pencil がないときは「なぞる / 動かす」を切り替える
// - 座標は元の画像(回転後)のピクセルで持つ

import { input } from './pad.js';

const MAX_SIDE = 3200; // 元の画像を保持するときの長辺(iPad の canvas のメモリ制限に余裕を持たせる)
export const BRUSH = { thin: 14, medium: 26, thick: 40 }; // 線の太さ(画面上の px)
const COLOR = 'rgba(150, 90, 220, 0.42)';

/** 画像を、長辺 MAX_SIDE 以下・指定の回転(90° 単位)で canvas に描く */
export function toSourceCanvas(img, quarterTurns = 0) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const s = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.round(w0 * s), h = Math.round(h0 * s);
  const q = ((quarterTurns % 4) + 4) % 4;
  const c = document.createElement('canvas');
  c.width = q % 2 ? h : w;
  c.height = q % 2 ? w : h;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.translate(c.width / 2, c.height / 2);
  g.rotate((q * Math.PI) / 2);
  g.drawImage(img, -w / 2, -h / 2, w, h);
  return c;
}

export class Marker {
  /**
   * @param {HTMLCanvasElement} canvas 表示用
   * @param {{onChange?: () => void}} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.onChange = opts.onChange || (() => {});
    this.img = null;
    this.src = null;
    this.turns = 0;
    this.zoom = 1;
    this.brush = 'medium';
    this.mode = 'draw'; // 'draw' | 'move'(Pencil がないときだけ使う)
    this.marks = []; // { points: [[x, y], ...], width }(元画像の px)
    this.current = null;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    globalThis.addEventListener('pointerup', (e) => this.up(e));
    this.updateTouchAction();
  }

  setImage(img) {
    this.img = img;
    this.turns = 0;
    this.zoom = 1;
    this.marks = [];
    this.src = toSourceCanvas(img, 0);
    this.layout();
    this.onChange();
  }

  rotate() {
    if (!this.img) return;
    this.turns = (this.turns + 1) % 4;
    this.src = toSourceCanvas(this.img, this.turns);
    this.marks = []; // 向きが変わるので、なぞった跡は消す
    this.layout();
    this.onChange();
  }

  setZoom(z) {
    this.zoom = Math.max(1, Math.min(4, z));
    this.layout();
  }

  setMode(mode) {
    this.mode = mode;
    this.updateTouchAction();
  }

  updateTouchAction() {
    // Pencil を使っているときは、指でスクロールできるようにする
    const fingerScrolls = input.penSeen || this.mode === 'move';
    this.canvas.style.touchAction = fingerScrolls ? 'pan-x pan-y pinch-zoom' : 'none';
  }

  /** 表示の大きさ(画面上の px)と、元画像の px への倍率 */
  layout() {
    if (!this.src) return;
    const box = this.canvas.parentElement;
    const avail = Math.max(200, (box && box.clientWidth) || 800);
    const cssW = Math.round(avail * this.zoom);
    const cssH = Math.round((cssW * this.src.height) / this.src.width);
    const dpr = Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1));
    // 大きくしすぎると iPad の canvas の上限を超えるので、描画の解像度は抑える
    const maxPx = 4096;
    const k = Math.min(dpr, maxPx / cssW, maxPx / cssH);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.canvas.width = Math.round(cssW * k);
    this.canvas.height = Math.round(cssH * k);
    this.cssW = cssW;
    this.scale = this.src.width / cssW; // 画面 px → 元画像 px
    this.redraw();
  }

  toSource(e) {
    const r = this.rect || this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * this.scale, (e.clientY - r.top) * this.scale];
  }

  down(e) {
    if (!this.src) return;
    if (e.pointerType === 'pen' && !input.penSeen) {
      input.penSeen = true;
      this.updateTouchAction();
    }
    if (e.pointerType === 'touch' && (input.penSeen || this.mode === 'move')) return; // 指はスクロール
    if (e.pointerType === 'mouse' && (e.button !== 0 || this.mode === 'move')) return;
    if (this.current) return;
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* window の pointerup で終える */
    }
    this.rect = this.canvas.getBoundingClientRect();
    this.current = { id: e.pointerId, points: [this.toSource(e)], width: BRUSH[this.brush] * this.scale };
    this.redraw();
  }

  move(e) {
    if (!this.current || e.pointerId !== this.current.id) return;
    e.preventDefault();
    let events = null;
    try {
      events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    } catch {
      events = null;
    }
    if (!events || !events.length) events = [e];
    for (const ev of events) this.current.points.push(this.toSource(ev));
    this.redraw();
  }

  up(e) {
    if (!this.current || e.pointerId !== this.current.id) return;
    const m = this.current;
    this.current = null;
    this.rect = null;
    this.marks.push({ points: m.points, width: m.width });
    this.redraw();
    this.onChange();
  }

  undo() {
    this.marks.pop();
    this.redraw();
    this.onChange();
  }

  clear() {
    this.marks = [];
    this.redraw();
    this.onChange();
  }

  redraw() {
    if (!this.src) return;
    const g = this.canvas.getContext('2d');
    const k = this.canvas.width / this.src.width;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.src, 0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(k, 0, 0, k, 0, 0);
    const all = this.current ? [...this.marks, this.current] : this.marks;
    all.forEach((m, i) => {
      g.strokeStyle = COLOR;
      g.lineWidth = m.width;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(m.points[0][0], m.points[0][1]);
      for (const p of m.points.slice(1)) g.lineTo(p[0], p[1]);
      if (m.points.length === 1) g.lineTo(m.points[0][0] + 0.1, m.points[0][1]);
      g.stroke();
      if (m === this.current) return;
      // 問題の番号
      const r = Math.max(12 * this.scale, m.width * 0.45);
      const [x, y] = m.points[0];
      g.fillStyle = '#5b2bb5';
      g.beginPath();
      g.arc(x, y - r * 1.2, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.font = `bold ${Math.round(r * 1.2)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(i + 1), x, y - r * 1.2 + 1);
    });
  }

  /** なぞった跡ごとに、OCR 用の画像を切り出す */
  crops() {
    return this.marks.map((m) => cropMark(this.src, m));
  }
}

/**
 * なぞった帯の部分だけを切り出す(帯の外は白)。小さい字は拡大し、グレースケールとコントラスト補正をする。
 * @returns {{canvas: HTMLCanvasElement, vertical: boolean}}
 */
export function cropMark(src, mark) {
  const half = mark.width * 0.65; // 帯の半分の幅(少し広めに取る)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of mark.points) {
    x0 = Math.min(x0, x - half);
    y0 = Math.min(y0, y - half);
    x1 = Math.max(x1, x + half);
    y1 = Math.max(y1, y + half);
  }
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(src.width, Math.ceil(x1));
  y1 = Math.min(src.height, Math.ceil(y1));
  const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
  const vertical = bh >= bw;
  // 帯の幅(≒ 1 行の幅)が 100px 程度になるように拡大する
  const scale = Math.max(1, Math.min(4, 100 / Math.max(1, Math.min(bw, bh))));
  const pad = Math.round(Math.min(bw, bh) * 0.3 * scale);
  const W = Math.round(bw * scale) + pad * 2, H = Math.round(bh * scale) + pad * 2;

  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const g = out.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, x0, y0, bw, bh, pad, pad, bw * scale, bh * scale);

  // なぞった帯のマスク
  const mask = document.createElement('canvas');
  mask.width = W;
  mask.height = H;
  const mg = mask.getContext('2d', { willReadFrequently: true });
  mg.strokeStyle = '#000';
  mg.lineCap = 'round';
  mg.lineJoin = 'round';
  mg.lineWidth = half * 2 * scale;
  mg.beginPath();
  const tx = (x) => (x - x0) * scale + pad, ty = (y) => (y - y0) * scale + pad;
  mg.moveTo(tx(mark.points[0][0]), ty(mark.points[0][1]));
  for (const p of mark.points.slice(1)) mg.lineTo(tx(p[0]), ty(p[1]));
  if (mark.points.length === 1) mg.lineTo(tx(mark.points[0][0]) + 0.1, ty(mark.points[0][1]));
  mg.stroke();
  const md = mg.getImageData(0, 0, W, H).data;

  const im = g.getImageData(0, 0, W, H);
  const d = im.data;
  const inside = new Uint8Array(W * H);
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
    d[i] = v;
    if (md[i + 3] >= 128) {
      inside[p] = 1;
      hist[v]++;
      n++;
    }
  }
  // 帯の中の明るさを 1%〜99% で伸ばす
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.01) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  const gray = new Uint8ClampedArray(W * H);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) gray[p] = ((d[i] - lo) * 255) / range;
  // 帯の外に大部分がはみ出している塊(帯の端にかかった問題番号・枠線など)を消してから、帯の外を白くする
  removeOutsideBlobs(gray, inside, W, H);
  for (let p = 0; p < W * H; p++) if (!inside[p]) gray[p] = 255;
  // 傍線・下線・括弧の線(字の大きさより長い直線)を消す。残すと OCR が別の行として読み、意味のない文字を作る。
  const charSize = Math.min(bw, bh) * scale * 0.75;
  removeLines(gray, W, H, vertical, Math.round(charSize * 1.2));
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    d[i] = d[i + 1] = d[i + 2] = gray[p];
    d[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return { canvas: out, vertical };
}

/**
 * 黒い画素のつながった塊のうち、帯の中にある割合が minInside 未満のものを白くする。
 * なぞった文字はほぼ帯の中に入るので残り、帯の端にかかった番号や枠線は消える。
 */
export function removeOutsideBlobs(gray, inside, W, H, minInside = 0.6, dark = 140) {
  const seen = new Uint8Array(W * H);
  const stack = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || gray[s] >= dark) continue;
    const blob = [];
    let inCount = 0;
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop();
      blob.push(p);
      inCount += inside[p];
      const x = p % W, y = (p - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (!seen[q] && gray[q] < dark) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    if (inCount < blob.length * minInside) for (const p of blob) gray[p] = 255;
  }
}

/**
 * 文字の向きに沿った長い直線を白くする(縦書きなら縦線、横書きなら横線)。
 * 写真の少しの傾きにも対応するため、線の太さ方向に ±2px の幅で連続を見る。
 * @param {Uint8ClampedArray} gray 0〜255(書き換える)
 */
export function removeLines(gray, W, H, vertical, minLen, dark = 140) {
  const along = vertical ? H : W, across = vertical ? W : H;
  const at = (a, c) => (vertical ? a * W + c : c * W + a); // a: 線の向き, c: 線と直角の向き
  const kill = new Uint8Array(W * H);
  for (let c = 0; c < across; c++) {
    let start = -1;
    for (let a = 0; a <= along; a++) {
      let on = false;
      if (a < along) {
        for (let k = Math.max(0, c - 2); k <= Math.min(across - 1, c + 2) && !on; k++) on = gray[at(a, k)] < dark;
      }
      if (on && start < 0) start = a;
      if (!on && start >= 0) {
        if (a - start >= minLen) for (let t = start; t < a; t++) if (gray[at(t, c)] < dark) kill[at(t, c)] = 1;
        start = -1;
      }
    }
  }
  // 線のにじみ(すぐ隣の薄い画素)も消す
  for (let p = 0; p < W * H; p++) {
    if (!kill[p]) continue;
    gray[p] = 255;
    const x = p % W, y = (p - x) / W;
    for (const [dx, dy] of vertical ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]]) {
      const q = (y + dy) * W + (x + dx);
      if (x + dx >= 0 && x + dx < W && y + dy >= 0 && y + dy < H && gray[q] < 200) gray[q] = 255;
    }
  }
}
