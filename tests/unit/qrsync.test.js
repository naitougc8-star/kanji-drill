import { describe, it, expect } from 'vitest';
import qrcode from '../../vendor/qrcode/qrcode.mjs';
import { packBackup, unpackBackup, splitPayload, QrAssembler, compactBackup, expandBackup, CHUNK_SIZE } from '../../qrsync.js';
import { makeBackup, parseBackup } from '../../backup.js';
import { addWords } from '../../sets.js';

import jsQR from 'jsqr'; // vendor/jsqr/jsQR.js と同じファイル(node_modules/jsqr/dist/jsQR.js)

/** テスト 2 件・語 100 語ほどのバックアップ(成績や文のある語・ない語をまぜる) */
function sampleBackup() {
  const sets = [{ id: 's1', name: '2学期中間', updatedAt: 1, groupNames: { 1: '吉野弘の詩' } }, { id: 's2', name: '期末', updatedAt: 2 }];
  const words = [];
  for (let i = 0; i < 100; i++) {
    addWords(words, i % 2 ? 's1' : 's2', [{ word: `漢字${i}`, reading: `かんじ${i}`, before: i % 3 ? '' : '前の文', after: i % 4 ? '' : 'の後', kind: i % 5 ? undefined : 'yomi' }], 'photo');
  }
  words[3].result = 'fail';
  words[3].misses = 2;
  words[4].result = 'pass';
  words[4].passedAt = 1;
  words[5].enabled = false;
  return makeBackup(sets, words, new Date(0));
}

/** QR コードの文字を、白黒の絵(RGBA)にする */
function render(text, scale = 4) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount(), margin = 4, size = (n + margin * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.isDark(r, c)) continue;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const p = (((r + margin) * scale + y) * size + (c + margin) * scale + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = 0;
    }
  }
  return { data, width: size, height: size };
}

describe('QR コードでデータを渡す', () => {
  it('初期値の項目を除いても、元に戻せる', () => {
    const b = sampleBackup();
    const c = compactBackup(b);
    expect(JSON.stringify(c).length).toBeLessThan(JSON.stringify(b).length);
    expect(expandBackup(c)).toEqual(b);
  });

  it('縮めて分けた文字を、ばらばらの順番・重なりありで集めても、元のバックアップに戻る', async () => {
    const b = sampleBackup();
    const payload = await packBackup(b);
    expect(payload[0]).toBe('Z'); // Node でも deflate が使える
    const chunks = splitPayload(payload, 'abc123');
    expect(chunks.length).toBe(Math.ceil(payload.length / CHUNK_SIZE));
    const asm = new QrAssembler();
    for (const i of [2, 0, 2, ...chunks.keys()].reverse()) asm.add(chunks[i]);
    expect(asm.done).toBe(true);
    const back = parseBackup(await unpackBackup(asm.payload));
    expect(back.sets).toEqual(b.sets);
    expect(back.words).toEqual(b.words);
  });

  it('ほかの QR コードは無視し、別の送りの QR コードを読んだら、そちらに切り替える', () => {
    const asm = new QrAssembler();
    expect(asm.add('https://example.com').ok).toBe(false);
    expect(asm.add('KD1:aaa:1/2:xx').ok).toBe(true);
    expect(asm.have).toBe(1);
    asm.add('KD1:bbb:1/3:yy');
    expect(asm.id).toBe('bbb');
    expect(asm.have).toBe(1);
    expect(asm.done).toBe(false);
  });

  it('作った QR コードの絵を読んで(jsQR)、元のバックアップに戻る', async () => {
    const b = sampleBackup();
    const chunks = splitPayload(await packBackup(b));
    expect(chunks.length).toBeGreaterThan(1);
    const asm = new QrAssembler();
    for (const text of chunks) {
      const img = render(text);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      expect(code && code.data).toBe(text);
      asm.add(code.data);
    }
    const back = parseBackup(await unpackBackup(asm.payload));
    expect(back.words.length).toBe(100);
    expect(back.sets[0].groupNames).toEqual({ 1: '吉野弘の詩' });
  });

  it('このアプリの QR コードでなければ、わかるように止める', async () => {
    await expect(unpackBackup('Xabc')).rejects.toThrow('このアプリの QR コードではありません');
  });
});
