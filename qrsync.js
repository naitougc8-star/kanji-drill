// QR コードで、ほかの端末にデータ(バックアップ)を送る・受け取る。
// データは 1 枚の QR コードには入らないので、縮めてから何枚かに分け、受け取る側で 1 枚ずつ読んで元に戻す。
// DOM に依存しない(Node でテストできる)。QR コードの絵を作る・読む部分は app.js(vendor/qrcode, vendor/jsqr)。
//
// 1 枚の QR コードの文字: KD1:<送るごとの id>:<何枚目>/<全部の枚数>:<データの一部>
// データ: バックアップの JSON(初期値の項目を除く)を deflate で縮めて base64url にしたもの(先頭 Z)。
//         deflate が使えないブラウザでは、縮めずに base64url にする(先頭 J)。

export const QR_PREFIX = 'KD1';
export const CHUNK_SIZE = 450; // 1 枚あたりのデータの文字数(画面に出した QR コードを、カメラで読みやすい細かさ。多いと細かくなって読みにくい)

// 語の項目の初期値(送るときは省き、受け取ったときに戻す)
const WORD_DEFAULTS = { before: '', after: '', enabled: true, manual: false, result: null, misses: 0, passedAt: null };

/** 初期値の項目を除いて、送るデータを小さくする */
export function compactBackup(backup) {
  return {
    ...backup,
    words: backup.words.map((w) => {
      const o = {};
      for (const [k, v] of Object.entries(w)) if (!(k in WORD_DEFAULTS) || WORD_DEFAULTS[k] !== v) o[k] = v;
      return o;
    }),
  };
}

/** 除いた初期値の項目を戻す */
export function expandBackup(backup) {
  return { ...backup, words: (backup.words || []).map((w) => ({ ...WORD_DEFAULTS, ...w })) };
}

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function streamBytes(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** バックアップを、QR コードで送る文字にする */
export async function packBackup(backup) {
  const bytes = new TextEncoder().encode(JSON.stringify(compactBackup(backup)));
  if (typeof CompressionStream === 'function') {
    return 'Z' + toBase64Url(await streamBytes(bytes, new CompressionStream('deflate-raw')));
  }
  return 'J' + toBase64Url(bytes);
}

/** QR コードで受け取った文字を、バックアップ(JSON の文字)に戻す */
export async function unpackBackup(payload) {
  const kind = payload[0];
  let bytes = fromBase64Url(payload.slice(1));
  if (kind === 'Z') {
    if (typeof DecompressionStream !== 'function') throw new Error('このブラウザでは、縮めたデータを戻せません(iPad を新しくしてください)');
    bytes = await streamBytes(bytes, new DecompressionStream('deflate-raw'));
  } else if (kind !== 'J') {
    throw new Error('このアプリの QR コードではありません');
  }
  return JSON.stringify(expandBackup(JSON.parse(new TextDecoder().decode(bytes))));
}

/** 送る文字を、QR コード 1 枚ずつの文字に分ける */
export function splitPayload(payload, id = Math.random().toString(36).slice(2, 8), size = CHUNK_SIZE) {
  const n = Math.max(1, Math.ceil(payload.length / size));
  return Array.from({ length: n }, (_, i) => `${QR_PREFIX}:${id}:${i + 1}/${n}:${payload.slice(i * size, (i + 1) * size)}`);
}

/**
 * 読んだ QR コードを集めて、元の文字に戻す。どの順番で読んでもよく、同じ QR コードを何回読んでもよい。
 * 別の送り(id が違う)の QR コードを読んだら、そちらに切り替える。
 */
export class QrAssembler {
  constructor() {
    this.reset();
  }

  reset() {
    this.id = null;
    this.total = 0;
    this.parts = new Map();
  }

  /** 読んだ数(何枚目を読んだか) */
  get have() {
    return this.parts.size;
  }

  get done() {
    return this.total > 0 && this.parts.size === this.total;
  }

  /** 送る文字の全体(全部そろったとき) */
  get payload() {
    return this.done ? Array.from({ length: this.total }, (_, i) => this.parts.get(i + 1)).join('') : null;
  }

  /**
   * 読んだ QR コードの文字を足す。
   * @returns {{ok: boolean, index?: number, total?: number, isNew?: boolean}} ok: このアプリの QR コードか
   */
  add(text) {
    const m = /^KD1:([0-9a-z]+):(\d+)\/(\d+):(.*)$/s.exec(text || '');
    if (!m) return { ok: false };
    const [, id, i, n, data] = m;
    const index = Number(i), total = Number(n);
    if (!total || index < 1 || index > total) return { ok: false };
    if (id !== this.id || total !== this.total) {
      this.reset();
      this.id = id;
      this.total = total;
    }
    const isNew = !this.parts.has(index);
    this.parts.set(index, data);
    return { ok: true, index, total, isNew };
  }
}
