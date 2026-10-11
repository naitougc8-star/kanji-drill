// 手書きのマス(<canvas> + Pointer Events)。
// - Apple Pencil(pointerType === 'pen')を一度検出したら、以後は指のタッチを無視する(手のひら対策)
// - setPointerCapture と getCoalescedEvents を使う(使えない環境では通常のイベント)
// - 1 点だけの短い接触も「点」の筆画として残す
// - devicePixelRatio に合わせて Retina でもくっきり描く

export const input = { penSeen: false };

const INK = '#1d1d1f';
const RED = '#d70015';
const GUIDE = 'rgba(200, 80, 60, 0.35)';
const PAPER = '#fffdf7';

function setupCanvas(canvas, size) {
  const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** マスの背景(十字と斜めの補助線。薄い破線) */
export function drawGrid(ctx, size) {
  ctx.save();
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = GUIDE;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 5]);
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2);
  ctx.lineTo(size, size / 2);
  ctx.moveTo(0, 0);
  ctx.lineTo(size, size);
  ctx.moveTo(size, 0);
  ctx.lineTo(0, size);
  ctx.stroke();
  ctx.restore();
}

function drawPolyline(ctx, pts, width, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], width * 0.7, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

function drawLabel(ctx, x, y, text, color, r) {
  ctx.save();
  ctx.font = `bold ${Math.round(r * 1.25)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(text, x, y + 1);
  ctx.restore();
}

/** 筆画の始点から少し離した、ラベルを置く位置 */
function labelPos(pts, size, r) {
  const [x0, y0] = pts[0];
  const [x1, y1] = pts[Math.min(pts.length - 1, 3)];
  let dx = x0 - x1, dy = y0 - y1;
  const L = Math.hypot(dx, dy) || 1;
  dx /= L;
  dy /= L;
  const x = Math.min(size - r, Math.max(r, x0 + dx * r * 1.4 - dy * r * 0.4));
  const y = Math.min(size - r, Math.max(r, y0 + dy * r * 1.4 + dx * r * 0.4));
  return [x, y];
}

/**
 * お手本を描く(筆画番号付き)。
 * @param {HTMLCanvasElement} canvas
 * @param {number[][]} strokes KanjiVG のフラット配列の配列(109×109)
 */
export function drawModel(canvas, strokes, size) {
  const ctx = setupCanvas(canvas, size);
  drawGrid(ctx, size);
  const k = size / 109;
  const lines = strokes.map((flat) => {
    const pts = [];
    for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i] * k, flat[i + 1] * k]);
    return pts;
  });
  for (const pts of lines) drawPolyline(ctx, pts, Math.max(2, size / 36), '#333');
  const r = Math.max(7, size / (strokes.length > 8 ? 28 : 22));
  lines.forEach((pts, i) => {
    const [x, y] = labelPos(pts, size, r);
    drawLabel(ctx, x, y, String(i + 1), '#0a5bd8', r);
  });
}

export class Pad {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{size: number, onStroke?: (pad: Pad) => void}} opts
   */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.size = opts.size;
    this.onStroke = opts.onStroke || (() => {});
    this.strokes = [];
    this.current = null;
    this.locked = false;
    this.marks = null; // 判定後の赤い表示 { bad: Map<筆画番号, 番号ラベル> }
    this.ctx = setupCanvas(canvas, this.size);
    canvas.style.touchAction = 'none';
    this.handlers = {
      down: (e) => this.down(e),
      move: (e) => this.move(e),
      up: (e) => this.up(e),
    };
    canvas.addEventListener('pointerdown', this.handlers.down);
    canvas.addEventListener('pointermove', this.handlers.move);
    canvas.addEventListener('pointerup', this.handlers.up);
    canvas.addEventListener('pointercancel', this.handlers.up);
    // setPointerCapture が効かない環境で、マスの外で指を離した場合の保険
    globalThis.addEventListener('pointerup', this.handlers.up);
    globalThis.addEventListener('pointercancel', this.handlers.up);
    // iPadOS の Safari で、長押しの拡大鏡や選択が出ないように
    canvas.addEventListener('touchstart', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    this.redraw();
  }

  destroy() {
    globalThis.removeEventListener('pointerup', this.handlers.up);
    globalThis.removeEventListener('pointercancel', this.handlers.up);
  }

  resize(size) {
    this.size = size;
    this.ctx = setupCanvas(this.canvas, size);
    this.redraw();
  }

  point(e) {
    const rect = this.rect || this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  down(e) {
    if (this.locked) return;
    if (e.pointerType === 'pen') input.penSeen = true;
    if (input.penSeen && e.pointerType === 'touch') return; // Pencil 使用中は指を無視
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.current) return; // すでに別のポインターで書いている
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 使えない環境では、window の pointerup で終わらせる */
    }
    this.rect = this.canvas.getBoundingClientRect();
    this.current = { id: e.pointerId, pts: [this.point(e)] };
    this.drawCurrent();
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
    if (!events || events.length === 0) events = [e];
    const pts = this.current.pts;
    for (const ev of events) {
      const p = this.point(ev);
      const last = pts[pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 0.5) pts.push(p);
    }
    this.drawCurrent();
  }

  up(e) {
    if (!this.current || e.pointerId !== this.current.id) return;
    const s = this.current.pts;
    this.current = null;
    this.rect = null;
    this.strokes.push(s);
    this.marks = null;
    this.redraw();
    this.onStroke(this);
  }

  drawCurrent() {
    // 書いている筆画だけを上に描き足す
    const pts = this.current.pts;
    drawPolyline(this.ctx, pts.slice(-3), this.lineWidth(), INK);
    if (pts.length === 1) drawPolyline(this.ctx, pts, this.lineWidth(), INK);
  }

  lineWidth() {
    return Math.max(3, this.size / 30);
  }

  undo() {
    if (this.locked || !this.strokes.length) return false;
    this.strokes.pop();
    this.marks = null;
    this.redraw();
    return true;
  }

  clear() {
    if (this.locked) return;
    this.strokes = [];
    this.marks = null;
    this.redraw();
  }

  /** 判定の結果を表示する。bad: 不合格の筆画番号(書いた順、0 始まり)の集合 */
  showMarks(bad) {
    this.marks = { bad: new Set(bad) };
    this.redraw();
  }

  redraw() {
    const { ctx, size } = this;
    drawGrid(ctx, size);
    const bad = this.marks ? this.marks.bad : new Set();
    this.strokes.forEach((pts, i) => drawPolyline(ctx, pts, this.lineWidth(), bad.has(i) ? RED : INK));
    if (this.marks) {
      const r = Math.max(8, size / 20);
      this.strokes.forEach((pts, i) => {
        if (!bad.has(i)) return;
        const [x, y] = labelPos(pts, size, r);
        drawLabel(ctx, x, y, String(i + 1), RED, r);
      });
    }
  }
}
