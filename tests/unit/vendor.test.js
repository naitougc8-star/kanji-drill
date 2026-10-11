// vendor/kuromoji/kuromoji.js(パッチ済み)のブラウザ用ローダーを、XMLHttpRequest のモックで確かめる。
// サーバーが Content-Encoding: gzip で配信して、ブラウザが展開済みのデータを渡してきても読めること。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'vendor/kuromoji/kuromoji.js'), 'utf8');

function loadKuromoji(decompressed) {
  const requested = [];
  class FakeXHR {
    open(method, url) {
      this.url = url;
    }
    send() {
      requested.push(this.url);
      const file = path.join(ROOT, this.url);
      let buf = fs.readFileSync(file);
      if (decompressed) buf = zlib.gunzipSync(buf); // ブラウザが Content-Encoding を展開した状態
      this.status = 200;
      this.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      setTimeout(() => this.onload.call(this), 0);
    }
  }
  const sandbox = { XMLHttpRequest: FakeXHR, window: {}, setTimeout, console, Uint8Array, ArrayBuffer, Int32Array, Uint32Array, Int16Array, Uint16Array, Int8Array };
  sandbox.self = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { kuromoji: sandbox.window.kuromoji || sandbox.kuromoji, requested };
}

function build(k, dicPath) {
  return new Promise((resolve, reject) => k.builder({ dicPath }).build((e, t) => (e ? reject(e) : resolve(t))));
}

describe('kuromoji(vendor・パッチ済み)', () => {
  it('gzip のまま届いた辞書を読める', async () => {
    const { kuromoji, requested } = loadKuromoji(false);
    const t = await build(kuromoji, 'vendor/kuromoji/dict/');
    expect(t.tokenize('漢字を覚える')[0].reading).toBe('カンジ');
    // 相対パスのまま要求している(絶対 URL を path.join に通すと https:/ に壊れる問題を避ける)
    expect(requested[0]).toMatch(/^vendor\/kuromoji\/dict\/\w+\.dat\.gz$/);
  });

  it('展開済みで届いた辞書(Content-Encoding: gzip)も読める', async () => {
    const { kuromoji } = loadKuromoji(true);
    const t = await build(kuromoji, 'vendor/kuromoji/dict/');
    expect(t.tokenize('漢字を覚える')[2].basic_form).toBe('覚える');
  });
});
