// アイコン(icons/*.png)と、OCR の通しテスト用のサンプル画像(tests/fixtures/sample.png)を作る。
//   node scripts/make-assets.mjs
// Playwright の Chromium で HTML を描いてスクリーンショットを撮る。生成物はリポジトリに入れてある。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SAMPLE_TEXT = ['今日は学校で漢字を覚える。', '明日は先生に手紙を書く。'];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function icon(size, file) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">
    <div style="width:${size}px;height:${size}px;background:#8f1d14;display:flex;align-items:center;justify-content:center;">
      <div style="width:${size * 0.62}px;height:${size * 0.62}px;background:#fffdf7;border-radius:${size * 0.06}px;position:relative;
        display:flex;align-items:center;justify-content:center;font:700 ${size * 0.46}px 'Yu Mincho','YuMincho','MS Mincho',serif;color:#1d1d1f;">
        <svg width="100%" height="100%" style="position:absolute;inset:0" viewBox="0 0 100 100">
          <g stroke="#d9a59d" stroke-width="0.8" stroke-dasharray="3 3">
            <line x1="50" y1="0" x2="50" y2="100"/><line x1="0" y1="50" x2="100" y2="50"/>
          </g>
        </svg>
        <span style="position:relative">書</span>
      </div>
    </div></body></html>`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file });
  console.log(path.relative(ROOT, file));
}

await icon(192, path.join(ROOT, 'icons/icon-192.png'));
await icon(512, path.join(ROOT, 'icons/icon-512.png'));
await icon(180, path.join(ROOT, 'icons/apple-touch-icon.png'));

// 写真を模して、少し灰色がかった紙に印刷した文章
await page.setViewportSize({ width: 1400, height: 420 });
await page.setContent(`<html><body style="margin:0;background:#c9c4b8">
  <div style="width:1400px;height:420px;display:flex;flex-direction:column;justify-content:center;padding:0 70px;box-sizing:border-box;
    font:500 72px 'Yu Gothic','YuGothic','Meiryo',sans-serif;color:#2a2a2a;line-height:1.7;">
    ${SAMPLE_TEXT.map((l) => `<div>${l}</div>`).join('')}
  </div></body></html>`);
const sample = path.join(ROOT, 'tests/fixtures/sample.png');
fs.mkdirSync(path.dirname(sample), { recursive: true });
await page.screenshot({ path: sample });
console.log(path.relative(ROOT, sample));

// 書き取りプリントを模した画像(なぞって読み取る通しテスト用)。各問題の位置を JSON に書き出す。
// 文はこのプロジェクトで作ったもの。
const PRINTS = {
  // 例 1 の形: 縦書き、書き取る部分の横に傍線
  'print-sideline': {
    vertical: true,
    items: [
      { before: '', target: 'てんじょう', after: 'の高い家', answer: '天井' },
      { before: '髪を', target: 'かわかす', after: '', answer: '乾かす' },
      { before: '', target: 'しんえん', after: 'な思想', answer: '深遠' },
      { before: '道具を', target: 'あつかう', after: '', answer: '扱う' },
      { before: '体育館を', target: 'へいせつ', after: 'する', answer: '併設' },
    ],
  },
  // 例 2 の形: 縦書き、括弧の横にふりがな
  'print-bracket': {
    vertical: true,
    items: [
      { before: '色が', target: 'ちがう', after: '', answer: '違う', bracket: true },
      { before: 'それはルール', target: 'いはん', after: 'だ', answer: '違反', bracket: true },
      { before: '友達に', target: 'あやまる', after: '', answer: '謝る', bracket: true },
    ],
  },
  // 横書き、書き取る部分に下線
  'print-horizontal': {
    vertical: false,
    items: [
      { before: '飛行機が', target: 'りりく', after: 'する', answer: '離陸' },
      { before: '', target: 'ちきゅうぎ', after: 'をまわす', answer: '地球儀' },
    ],
  },
};

for (const [name, spec] of Object.entries(PRINTS)) {
  const W = spec.vertical ? 1400 : 1200, H = spec.vertical ? 1000 : 700;
  await page.setViewportSize({ width: W, height: H });
  const item = (it, i) => {
    const t = it.bracket
      ? `<span class="br">［<ruby>${'　'.repeat(it.target.length)}<rt>${it.target}</rt></ruby>］</span>`
      : `<span class="tg">${it.target}</span>`;
    return `<div class="q"><div class="n">(${i + 1})</div><div class="t"><span id="q${i}">${it.before}${t}${it.after}</span></div></div>`;
  };
  const css = spec.vertical
    ? `.wrap{display:flex;flex-direction:row-reverse;gap:46px;padding:60px 80px;}
       .q{writing-mode:vertical-rl;border-left:1px dashed #999;padding-left:14px;height:820px;}
       .n{font-size:22px;margin-bottom:12px;writing-mode:horizontal-tb;}
       .t{font-size:46px;letter-spacing:2px;}
       .tg{border-right:3px solid #333;padding-right:3px;}
       rt{font-size:20px;}`
    : `.wrap{padding:60px 80px;}
       .q{display:flex;gap:20px;align-items:baseline;margin:40px 0;}
       .n{font-size:24px;}
       .t{font-size:52px;}
       .tg{border-bottom:3px solid #333;}`;
  await page.setContent(`<html><head><style>body{margin:0;background:#f4f1ea;color:#222;font-family:'Yu Mincho','YuMincho','MS Mincho',serif;}${css}</style></head>
    <body><div class="wrap">${spec.items.map(item).join('')}</div></body></html>`);
  const boxes = await page.evaluate((n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const r = document.getElementById('q' + i).getBoundingClientRect();
      out.push([Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]);
    }
    return out;
  }, spec.items.length);
  const file = path.join(ROOT, `tests/fixtures/${name}.png`);
  await page.screenshot({ path: file });
  fs.writeFileSync(
    path.join(ROOT, `tests/fixtures/${name}.json`),
    JSON.stringify({ width: W, height: H, vertical: spec.vertical, items: spec.items.map((it, i) => ({ ...it, box: boxes[i] })) }, null, 1),
  );
  console.log(path.relative(ROOT, file));
}

await browser.close();
