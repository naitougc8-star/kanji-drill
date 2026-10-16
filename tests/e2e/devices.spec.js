// iPad・iPhone のシミュレーション(Playwright の WebKit + 機種ごとの画面の大きさ・Retina・タッチ・Safari のブラウザ情報)。
// 本物の iPadOS / iOS の Safari ではない(Windows・Linux の WebKit)。Apple Pencil・日本語入力・写真の選択画面は再現できない。
//   npx playwright test tests/e2e/devices.spec.js --project=webkit
// スクリーンショットは test-results/devices/<機種>/ に保存する。

import { test, expect, devices } from '@playwright/test';
import fs from 'node:fs';
import { POEMS } from '../../hyakunin.js';

const DEVICES = ['iPad (gen 11)', 'iPad (gen 11) landscape', 'iPad Pro 11', 'iPad Mini', 'iPhone 15', 'iPhone 15 landscape'];

/** 書き取り・読み・百人一首を 1 語ずつ入れたバックアップ(ほかの端末で書き出したファイルの代わり) */
function backupFile() {
  const now = Date.now();
  const base = { before: '', after: '', enabled: true, manual: true, result: null, misses: 0, passedAt: null, setId: 'set-1', photo: 1, updatedAt: now };
  const p = POEMS[11]; // 天つ風
  const data = {
    app: 'kanji-kakitori-drill',
    version: 1,
    exportedAt: new Date(now).toISOString(),
    sets: [{ id: 'set-1', name: '2学期中間確認テスト', updatedAt: now }],
    words: [
      { ...base, id: 'w-kaki', word: '満員', reading: 'まんいん', after: 'の電車' },
      { ...base, id: 'w-yomi', word: '苛まれる', reading: 'さいなまれる', kind: 'yomi' },
      { ...base, id: 'w-hyaku', word: p.text, reading: p.kana, before: '天つ風', kind: 'hyakunin', no: 12, photo: 2 },
    ],
  };
  return { name: 'kanji-drill-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) };
}

/** お手本の筆画(109×109)を、同じオリジンの data/ から取る */
async function templateOf(page, ch) {
  return page.evaluate(async (c) => {
    const cp = c.codePointAt(0);
    const r = await fetch(`data/k${(cp >> 8).toString(16)}.json`);
    return (await r.json())[cp.toString(16)];
  }, ch);
}

/** マスに、お手本どおりに書く(Apple Pencil の代わりにマウスのイベントでなぞる) */
async function writeCells(page) {
  const cells = page.locator('#cells .cell');
  const n = await cells.count();
  for (let i = 0; i < n; i++) {
    const cell = cells.nth(i);
    await cell.scrollIntoViewIfNeeded();
    const t = await templateOf(page, await cell.getAttribute('data-char'));
    const box = await cell.locator('canvas.pad').boundingBox();
    const k = (box.width * 0.86) / 109;
    const ox = box.x + box.width * 0.07, oy = box.y + box.height * 0.07;
    for (const flat of t) {
      const pts = [];
      for (let j = 0; j + 1 < flat.length; j += 2) pts.push([ox + flat[j] * k, oy + flat[j + 1] * k]);
      await page.mouse.move(pts[0][0], pts[0][1]);
      await page.mouse.down();
      for (let j = 1; j < pts.length; j++) await page.mouse.move(pts[j][0], pts[j][1], { steps: 4 });
      await page.mouse.up();
    }
  }
}

/** 横にはみ出していないか(横スクロールが出ないか) */
async function expectNoHorizontalScroll(page, where) {
  const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(sw, `${where}: 横にはみ出している(幅 ${w}px に対して ${sw}px)`).toBeLessThanOrEqual(w + 1);
}

for (const name of DEVICES) {
  test(`${name}: 取り込み → 開け閉め → 書き取り・読み・百人一首 → 参考 → 結果`, async ({ browser, browserName, baseURL }) => {
    test.skip(browserName !== 'webkit', 'iPad・iPhone の Safari に近い WebKit だけで動かす');
    const dir = `test-results/devices/${name.replace(/[^\w]+/g, '-')}`;
    fs.mkdirSync(dir, { recursive: true });
    const shot = (page, file) => page.screenshot({ path: `${dir}/${file}.png`, fullPage: true });

    const context = await browser.newContext({ ...devices[name], locale: 'ja-JP', baseURL });
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && problems.push(`console.error: ${m.text()}`));
    // 「参考」の外部ページは、通信しないで代わりのページを返す
    await page.route('https://www.karuta.or.jp/**', (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><h1 id="karuta">一日一首(代わりのページ)</h1>' }),
    );

    await page.goto('./');
    await expect(page.locator('h1')).toHaveText('漢字書き取りドリル');
    const info = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, touch: navigator.maxTouchPoints, ua: navigator.userAgent }));
    console.log(`${name}: ${info.w}×${info.h} @${info.dpr}x タッチ ${info.touch} 点 / ${info.ua.match(/\(([^)]+)\)/)?.[1]}`);
    await expectNoHorizontalScroll(page, '設定画面');

    // バックアップを読み込む(ほかの端末から送ったファイル)
    page.on('dialog', (d) => d.accept());
    await expect(page.locator('#fold-backup')).toHaveAttribute('open', ''); // 初めは開いている
    await page.setInputFiles('#import-replace', backupFile());
    await expect(page.locator('#backup-status')).toContainText('置き換えました');
    await expect(page.locator('#btn-start')).toHaveText('全問出題する(3 語)');

    // 1・2・4 の開け閉め(タップ)と、写真ごとのまとまりの開け閉め
    await page.locator('#fold-import summary').tap();
    await expect(page.locator('#fold-import')).not.toHaveAttribute('open', '');
    await page.locator('#fold-backup summary').tap();
    await expect(page.locator('#fold-backup')).not.toHaveAttribute('open', '');
    await page.locator('.group-head[data-group="2"] .gfold').tap();
    await expect(page.locator('#word-list ul[data-group="2"]')).toBeHidden();
    await expect(page.locator('.group-head[data-group="2"] .gfold')).toHaveAttribute('aria-expanded', 'false');
    for (const id of ['btn-start', 'btn-start-wrong', 'btn-start-miss3', 'btn-start-new']) {
      const b = await page.locator(`#${id}`).boundingBox();
      expect(b.height, `${id} の高さ(指で押せる大きさ)`).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalScroll(page, '設定画面(読み込み後)');
    await shot(page, '1-settings');

    // 出題(順番はばらばら)
    await page.locator('#btn-start').tap();
    for (let q = 0; q < 3; q++) {
      await expect(page.locator('#screen-drill')).toBeVisible();
      const kind = await page.locator('#screen-drill').getAttribute('data-kind');
      await expectNoHorizontalScroll(page, `出題画面(${kind})`);
      if (kind === 'hyakunin') {
        await expect(page.locator('#reading-kana')).toHaveText('あまつかぜ …');
        await shot(page, `2-question-${kind}`);
        // わざと 2 字(ぢ→じ、を→お)間違える
        await page.locator('#kana-input').fill('くものかよひぢ ふきとじよ おとめのすがた しばしとどめむ');
        await page.locator('#btn-judge').tap();
        await expect(page.locator('#verdict-title')).toHaveText('× 不合格');
        await expect(page.locator('#answer .miss')).toHaveText(['ぢ', 'を']);
        await expectNoHorizontalScroll(page, '百人一首の答え');
        await shot(page, `3-answer-${kind}`);
        // 参考: 解説の窓が画面に収まって開き、閉じられる
        await page.locator('#btn-sanko').tap();
        const dlg = page.locator('#sanko');
        await expect(dlg).toBeVisible();
        await expect(page.locator('#sanko-title')).toHaveText('12 番 僧正遍昭');
        await expect(page.frameLocator('#sanko-frame').locator('#karuta')).toBeVisible();
        const db = await dlg.boundingBox();
        expect(db.x).toBeGreaterThanOrEqual(0);
        expect(db.x + db.width).toBeLessThanOrEqual(info.w + 1);
        expect(db.y + db.height).toBeLessThanOrEqual(info.h + 1);
        await page.screenshot({ path: `${dir}/4-sanko.png` });
        await page.locator('#sanko-close').tap();
        await expect(dlg).toBeHidden();
      } else {
        await page.locator('#cells .cell').first().waitFor();
        // マスが画面の幅に収まっている(読みの問題は折り返してもよい)
        const boxes = await page.locator('#cells .cell canvas.pad').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
        for (const r of boxes) expect(r, `${kind}: マスが画面の外`).toBeLessThanOrEqual(info.w + 1);
        await shot(page, `2-question-${kind}`);
        await writeCells(page);
        await page.locator('#btn-judge').tap();
        await expect(page.locator('#verdict-title')).toHaveText('○ 合格');
        await shot(page, `3-answer-${kind}`);
      }
      await page.locator('#btn-next').tap();
    }

    // 結果
    await expect(page.locator('#screen-result')).toBeVisible();
    await expect(page.locator('#score')).toHaveText('3 問中 2 問正解');
    await expectNoHorizontalScroll(page, '結果画面');
    await shot(page, '5-result');

    // 再読み込みしても、成績と開け閉めが残っている
    await page.reload();
    await expect(page.locator('#fold-import')).not.toHaveAttribute('open', '');
    await expect(page.locator('#word-list ul[data-group="2"]')).toBeHidden();
    await expect(page.locator('#btn-start-wrong')).toHaveText('不合格の語だけ出題する(1 語)');

    expect(problems, problems.join('\n')).toEqual([]);
    await context.close();
  });
}
