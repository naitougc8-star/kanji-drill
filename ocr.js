// 写真から文章を読み取る(Tesseract.js v5)。ライブラリ・ワーカー・コア・言語データはすべて同じオリジンの vendor/ に置く。

import { loadScript, cleanText, cleanLine } from './words.js';

const MAX_SIDE = 2400;

/**
 * 画像ファイルを読み込む。Image で読み込んで canvas に描くことで、EXIF の向きはブラウザが反映する。
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした(対応していない形式かもしれません)'));
    };
    img.src = url;
  });
}

/**
 * 縮小(長辺 2400px まで)・グレースケール化・コントラスト補正をした canvas を返す。
 * 大きな写真(12MP 以上)でも canvas のメモリ制限に引っかからないよう、最初の描画で縮小する。
 */
export function preprocess(img, maxSide = MAX_SIDE) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) throw new Error('画像の大きさが取得できませんでした');
  const s = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * s)), h = Math.max(1, Math.round(h0 * s));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const im = ctx.getImageData(0, 0, w, h);
  const d = im.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = g;
    hist[d[i]]++;
  }
  // 1% と 99% の明るさを 0〜255 に伸ばす
  const n = w * h;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.01) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range));
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  return canvas;
}

const STATUS = {
  'loading tesseract core': 'OCR エンジンを読み込んでいます',
  'initializing tesseract': 'OCR エンジンを準備しています',
  'loading language traineddata': '日本語のデータを読み込んでいます',
  'initializing api': '準備しています',
  'recognizing text': '文字を読み取っています',
};

/** 同じオリジンの vendor/ を使う Tesseract のワーカーを作る */
async function createWorker(lang, progress) {
  await loadScript('vendor/tesseract/tesseract.min.js');
  const T = globalThis.Tesseract;
  if (!T) throw new Error('Tesseract.js を読み込めませんでした');
  const base = new URL('vendor/tesseract/', document.baseURI).href;
  return T.createWorker(lang, 1, {
    workerPath: base + 'worker.min.js',
    corePath: base + 'core/', // ディレクトリを渡す(simd / 非 simd を自動で選ぶ)
    langPath: base + 'lang',
    gzip: true, // 言語データは .traineddata.gz に統一
    logger: (m) => {
      if (!progress) return;
      const label = STATUS[m.status] || m.status;
      progress(`${label}… ${m.progress ? Math.round(m.progress * 100) + '%' : ''}`);
    },
    errorHandler: () => {},
  });
}

/**
 * 画像全体の OCR を実行する。
 * @param {HTMLCanvasElement} canvas preprocess() の結果
 * @param {{vertical?: boolean, onProgress?: (text: string) => void}} opts
 */
export async function recognize(canvas, opts = {}) {
  const progress = opts.onProgress || (() => {});
  progress('OCR の準備をしています…');
  let worker;
  try {
    worker = await createWorker(opts.vertical ? 'jpn_vert' : 'jpn', progress);
    if (opts.vertical) await worker.setParameters({ tessedit_pageseg_mode: '5' }); // 縦書きの 1 ブロック
    const { data } = await worker.recognize(canvas);
    return cleanText(data.text);
  } finally {
    if (worker) await worker.terminate().catch(() => {});
  }
}

/**
 * なぞって切り出した画像を 1 行ずつ読み取る。縦書きは jpn_vert(1 ブロック)、横書きは jpn(1 行)。
 * @param {{canvas: HTMLCanvasElement, vertical: boolean}[]} crops
 * @param {{onProgress?: (text: string) => void}} opts
 * @returns {Promise<string[]>} 行ごとの結果(記号などを取り除いたもの)
 */
export async function recognizeCrops(crops, opts = {}) {
  const progress = opts.onProgress || (() => {});
  const workers = {};
  try {
    const out = [];
    for (let i = 0; i < crops.length; i++) {
      const { canvas, vertical } = crops[i];
      const lang = vertical ? 'jpn_vert' : 'jpn';
      if (!workers[lang]) {
        progress(`OCR の準備をしています…(${vertical ? '縦書き' : '横書き'})`);
        workers[lang] = await createWorker(lang, null);
        await workers[lang].setParameters({ tessedit_pageseg_mode: vertical ? '5' : '7' });
      }
      progress(`読み取っています… ${i + 1} / ${crops.length} 問`);
      const { data } = await workers[lang].recognize(canvas);
      out.push(cleanLine(data.text));
    }
    return out;
  } finally {
    for (const w of Object.values(workers)) await w.terminate().catch(() => {});
  }
}
