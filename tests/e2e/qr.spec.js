// QR コードでデータを渡す: 送る端末で QR コードを出し、受け取る端末のカメラで読んで合わせる。
// 受け取る端末のカメラは、送る端末の QR コードの絵を映す「にせのカメラ」(canvas の映像)にする。
import { test, expect, devices } from '@playwright/test';
import { POEMS } from '../../hyakunin.js';

function backupFile() {
  const now = Date.now();
  const base = { before: '', after: '', enabled: true, manual: true, result: null, misses: 0, passedAt: null, setId: 'set-1', photo: 1, updatedAt: now };
  const words = [];
  for (let i = 0; i < 60; i++) words.push({ ...base, id: `w${i}`, word: `漢字${i}`, reading: `かんじ${i}`, after: i % 2 ? 'の文' : '', result: i % 3 ? null : 'pass', passedAt: i % 3 ? null : 1 });
  const p = POEMS[11];
  words.push({ ...base, id: 'w-hyaku', word: p.text, reading: p.kana, before: '天つ風', kind: 'hyakunin', no: 12, photo: 2 });
  const data = { app: 'kanji-kakitori-drill', version: 1, exportedAt: new Date(now).toISOString(), sets: [{ id: 'set-1', name: '中間テスト', updatedAt: now, groupNames: { 1: '吉野弘の詩' } }], words };
  return { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) };
}

async function confirmAsk(page) {
  await expect(page.locator('#ask')).toBeVisible();
  await page.locator('#ask-ok').click();
  await expect(page.locator('#ask')).toBeHidden();
}

test('QR コードで送って、別の端末のカメラで読んで合わせる', async ({ browser, browserName, baseURL }) => {
  // Windows・Linux の WebKit(テスト用)には、カメラ(navigator.mediaDevices)と canvas の映像(captureStream)がない。
  // 本物の iPad・iPhone の Safari にはある(https のページで)。
  test.skip(browserName === 'webkit', 'テスト用の WebKit にはカメラがない');
  // 送る端末(iPad)
  const ipad = await browser.newContext({ ...devices['iPad (gen 11)'], locale: 'ja-JP', baseURL });
  const send = await ipad.newPage();
  await send.goto('./');
  await send.setInputFiles('#import-replace', backupFile());
  await confirmAsk(send);
  await send.locator('label', { hasText: 'QR コード' }).click();
  await expect(send.locator('#sync-qr')).toBeVisible();
  await expect(send.locator('#sync-file')).toBeHidden();
  await send.click('#btn-qr-show');
  await expect(send.locator('#qr-show')).toBeVisible();
  await expect(send.locator('#qr-show-title')).toContainText('テスト 1 件・61 語');
  await send.click('#qr-pause'); // 自動の切り替えを止めて、1 枚ずつ取り出す
  const pageText = await send.locator('#qr-page').textContent();
  const total = Number(/\/ (\d+) 枚/.exec(pageText)[1]);
  expect(total).toBeGreaterThan(1);
  const images = [];
  for (let i = 0; i < total; i++) {
    images.push(await send.locator('#qr-img svg').evaluate((svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.outerHTML)));
    await send.click('#qr-next');
  }
  await send.screenshot({ path: 'test-results/qr-send.png' });
  await send.click('#qr-close');

  // 受け取る端末(iPhone): カメラの代わりに、QR コードの絵を順番に映す
  const iphone = await browser.newContext({ ...devices['iPhone 15'], locale: 'ja-JP', baseURL });
  const recv = await iphone.newPage();
  await recv.addInitScript((imgs) => {
    navigator.mediaDevices.getUserMedia = async () => {
      const c = document.createElement('canvas');
      c.width = c.height = 600;
      const g = c.getContext('2d');
      const pics = await Promise.all(imgs.map((src) => new Promise((ok) => { const im = new Image(); im.onload = () => ok(im); im.src = src; })));
      let i = 0;
      setInterval(() => {
        g.fillStyle = '#fff';
        g.fillRect(0, 0, 600, 600);
        g.drawImage(pics[i++ % pics.length], 50, 50, 500, 500);
      }, 300);
      return c.captureStream(10);
    };
  }, images);
  await recv.goto('./');
  await recv.locator('label', { hasText: 'QR コード' }).click();
  await recv.click('#btn-qr-merge');
  await expect(recv.locator('#qr-scan')).toBeVisible();
  await expect(recv.locator('#qr-progress')).toContainText(`/ ${total} 枚`, { timeout: 20_000 });
  await expect(recv.locator('#qr-scan')).toBeHidden({ timeout: 30_000 }); // 全部読めたら、窓が閉じて読み込む
  await expect(recv.locator('#backup-status')).toContainText('テスト 1 件と語 61 語を追加し');
  await expect(recv.locator('#btn-start')).toHaveText('全問出題する(61 語)');
  await expect(recv.locator('.group-head[data-group="1"] .gname')).toHaveText('吉野弘の詩');
  await expect(recv.locator('#result-summary .res.pass')).toHaveText('○ 合格 20 語');
  await ipad.close();
  await iphone.close();
});

test('カメラが使えないときは、わかるように知らせる', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ ...devices['iPad (gen 11)'], locale: 'ja-JP', baseURL });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    };
  });
  await page.goto('./');
  await page.locator('label', { hasText: 'QR コード' }).click();
  await page.click('#btn-qr-merge');
  await expect(page.locator('#message')).toContainText('カメラが使えませんでした');
  await expect(page.locator('#qr-scan')).toBeHidden();
  await ctx.close();
});
