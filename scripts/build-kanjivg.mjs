// KanjiVG の SVG から筆画データ(data/kXX.json)を作るビルドスクリプト。
//
// 使い方:
//   node scripts/build-kanjivg.mjs <KanjiVG の kanji/ ディレクトリ>
//   node scripts/build-kanjivg.mjs            (引数なしならリリース zip をダウンロードして展開)
//
// 出力: data/k4e.json … data/k9f.json, data/k30.json(ひらがなと 々〆〇)
//   { "65e5": [[x0,y0,x1,y1,...], ...], ... }  座標は 109×109 の整数
//
// KanjiVG © Ulrich Apel, CC BY-SA 3.0  https://github.com/KanjiVG/kanjivg

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data');
const RELEASE = 'r20260714';
const ZIP_URL = `https://github.com/KanjiVG/kanjivg/releases/download/${RELEASE}/kanjivg-20260714-main.zip`;
const RDP_EPS = 0.5;
const EXTRA = [0x3005, 0x3006, 0x3007]; // 々 〆 〇
const HIRAGANA = [0x3041, 0x3096]; // ぁ〜ゖ(読みの問題で、ひらがなを手書きして判定する)

// ---- SVG パス → 折れ線 ----

export function tokenize(d) {
  const re = /([MmCcSsLlHhVvZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  const out = [];
  let m;
  while ((m = re.exec(d))) out.push(m[1] ? m[1] : parseFloat(m[2]));
  return out;
}

function cubic(p0, p1, p2, p3, n, out) {
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
}

/** SVG の d 属性を折れ線(点の配列)にする。曲線は 1 セグメント 16 点でサンプリング。 */
export function pathToPolyline(d, samples = 16) {
  const tk = tokenize(d);
  const pts = [];
  let i = 0, cmd = null;
  let cur = [0, 0], start = [0, 0], lastCtrl = null;
  const num = () => tk[i++];
  while (i < tk.length) {
    if (typeof tk[i] === 'string') cmd = tk[i++];
    else if (cmd === null) throw new Error('path must start with a command: ' + d);
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cur[0] : 0, oy = rel ? cur[1] : 0;
    if (C === 'M') {
      cur = [ox + num(), oy + num()];
      start = cur;
      pts.push(cur);
      lastCtrl = null;
      cmd = rel ? 'l' : 'L'; // 続く座標は lineto
    } else if (C === 'L') {
      cur = [ox + num(), oy + num()];
      pts.push(cur);
      lastCtrl = null;
    } else if (C === 'H') {
      cur = [(rel ? cur[0] : 0) + num(), cur[1]];
      pts.push(cur);
      lastCtrl = null;
    } else if (C === 'V') {
      cur = [cur[0], (rel ? cur[1] : 0) + num()];
      pts.push(cur);
      lastCtrl = null;
    } else if (C === 'C') {
      const p1 = [ox + num(), oy + num()];
      const p2 = [ox + num(), oy + num()];
      const p3 = [ox + num(), oy + num()];
      cubic(cur, p1, p2, p3, samples, pts);
      lastCtrl = p2;
      cur = p3;
    } else if (C === 'S') {
      const p1 = lastCtrl ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur;
      const p2 = [ox + num(), oy + num()];
      const p3 = [ox + num(), oy + num()];
      cubic(cur, p1, p2, p3, samples, pts);
      lastCtrl = p2;
      cur = p3;
    } else if (C === 'Z') {
      cur = start;
      pts.push(cur);
      lastCtrl = null;
    } else {
      throw new Error('unsupported command ' + cmd);
    }
  }
  return pts;
}

function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  if (L === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / L;
}

/** Ramer-Douglas-Peucker */
export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let maxD = -1, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const dd = perpDist(pts[i], pts[0], pts[pts.length - 1]);
    if (dd > maxD) { maxD = dd; idx = i; }
  }
  if (maxD > eps) {
    const a = rdp(pts.slice(0, idx + 1), eps);
    const b = rdp(pts.slice(idx), eps);
    return a.slice(0, -1).concat(b);
  }
  return [pts[0], pts[pts.length - 1]];
}

export function strokeFromPath(d) {
  const poly = rdp(pathToPolyline(d), RDP_EPS);
  const flat = [];
  for (const [x, y] of poly) {
    const xi = Math.max(0, Math.min(109, Math.round(x)));
    const yi = Math.max(0, Math.min(109, Math.round(y)));
    // 丸めで同じ点が続いたら省く
    if (flat.length && flat[flat.length - 2] === xi && flat[flat.length - 1] === yi) continue;
    flat.push(xi, yi);
  }
  if (flat.length === 2) flat.push(flat[0], flat[1]); // 1 点だけの筆画も始点・終点を持たせる
  return flat;
}

/** SVG 文字列から、番号順の筆画の配列を取り出す */
export function parseSvg(svg, hex) {
  const re = new RegExp(`<path[^>]*\\bid="kvg:${hex}-s(\\d+)"[^>]*>`, 'g');
  const strokes = [];
  let m;
  while ((m = re.exec(svg))) {
    const dm = /\sd="([^"]+)"/.exec(m[0]);
    if (!dm) continue;
    strokes.push([parseInt(m[1], 10), strokeFromPath(dm[1])]);
  }
  strokes.sort((a, b) => a[0] - b[0]);
  return strokes.map((s) => s[1]);
}

function inTarget(cp) {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= HIRAGANA[0] && cp <= HIRAGANA[1]) || EXTRA.includes(cp);
}

async function obtainKanjiDir() {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanjivg-'));
  const zip = path.join(tmp, 'kanjivg.zip');
  console.log('downloading', ZIP_URL);
  const res = await fetch(ZIP_URL);
  if (!res.ok) throw new Error('download failed: ' + res.status);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  // Windows 10+ / macOS / Linux いずれも tar で zip を展開できる
  execFileSync('tar', ['-xf', zip, '-C', tmp]);
  return path.join(tmp, 'kanji');
}

async function main() {
  const dir = await obtainKanjiDir();
  const files = fs.readdirSync(dir).filter((f) => /^[0-9a-f]{5}\.svg$/.test(f)); // バリアント(-Kaisho など)は除外
  const buckets = new Map();
  let count = 0;
  for (const f of files) {
    const hex5 = f.slice(0, 5);
    const cp = parseInt(hex5, 16);
    if (!inTarget(cp)) continue;
    const svg = fs.readFileSync(path.join(dir, f), 'utf8');
    const strokes = parseSvg(svg, hex5);
    if (!strokes.length) continue;
    const key = cp.toString(16);
    const b = (cp >> 8).toString(16);
    if (!buckets.has(b)) buckets.set(b, {});
    buckets.get(b)[key] = strokes;
    count++;
  }
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (/^k[0-9a-f]+\.json$/.test(f)) fs.unlinkSync(path.join(OUT, f));
  let total = 0;
  const index = [];
  for (const [b, obj] of [...buckets].sort()) {
    const json = JSON.stringify(obj);
    fs.writeFileSync(path.join(OUT, `k${b}.json`), json);
    total += Buffer.byteLength(json);
    index.push(b);
  }
  fs.writeFileSync(
    path.join(OUT, 'index.json'),
    JSON.stringify({ source: `KanjiVG ${RELEASE}`, license: 'CC BY-SA 3.0', buckets: index, count }),
  );
  console.log(`${count} 字, ${index.length} ファイル, 合計 ${(total / 1024 / 1024).toFixed(2)} MB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
