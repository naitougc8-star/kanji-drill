// iPad・iPhone のシミュレーション(Playwright の WebKit + 機種ごとの画面の大きさ・Retina・タッチ・Safari のブラウザ情報)。
// 本物の iPadOS / iOS の Safari ではない(Windows・Linux の WebKit)。Apple Pencil・日本語入力・写真の選択画面は再現できない。
//   npx playwright test tests/e2e/devices.spec.js --project=webkit
// スクリーンショットは test-results/devices/<機種>/ に保存する。

import { test, expect, devices } from '@playwright/test';
import fs from 'node:fs';
import { POEMS } from '../../hyakunin.js';

const DEVICES = ['iPad (gen 11)', 'iPad (gen 11) landscape', 'iPad Pro 11', 'iPad Mini', 'iPhone 15', 'iPhone 15 landscape'];


/** アプリの確認の窓に答える(文字を渡すと、名前の入力欄に入れてから OK) */
async function confirmAsk(page, text = null) {
  await expect(page.locator('#ask')).toBeVisible();
  if (text !== null) await page.locator('#ask-input').fill(text);
  await page.locator('#ask-ok').click();
  await expect(page.locator('#ask')).toBeHidden();
}

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
    await expect(page.locator('#fold-backup')).toHaveAttribute('open', ''); // 初めは開いている
    await page.setInputFiles('#import-replace', backupFile());
    await confirmAsk(page);
    await expect(page.locator('#backup-status')).toContainText('置き換えました');
    await expect(page.locator('#btn-start')).toHaveText('全問出題する(3 語)');

    // 1・2・4 の開け閉め(タップ)と、写真ごとのまとまりの開け閉め
    await page.locator('#fold-import summary').tap();
    await expect(page.locator('#fold-import')).not.toHaveAttribute('open', '');
    await page.locator('#fold-backup summary').tap();
    await expect(page.locator('#fold-backup')).not.toHaveAttribute('open', '');
    // 問題の文を直す(文の中に語が入っていないと止める)
    const kakiRow = page.locator('#word-list li[data-word="満員"]');
    await kakiRow.locator('.ctx-edit').tap();
    await confirmAsk(page, 'こんでいるバス');
    await expect(page.locator('#message')).toContainText('「満員」が入っていません');
    await kakiRow.locator('.ctx-edit').tap();
    await confirmAsk(page, '朝の満員のバス');
    await expect(kakiRow.locator('.ctx')).toHaveText('朝の満員のバス');
    // 読みの問題にも文を足せる
    const yomiRow = page.locator('#word-list li[data-word="苛まれる"]');
    await expect(yomiRow.locator('.ctx-edit')).toHaveText('文を足す');
    await yomiRow.locator('.ctx-edit').tap();
    await confirmAsk(page, '不安に苛まれる');
    await expect(yomiRow.locator('.ctx')).toHaveText('不安に苛まれる');
    // 語を消すときは確認する(キャンセルすれば消えない)
    await kakiRow.locator('.del').tap();
    await expect(page.locator('#ask-text')).toContainText('「満員」(まんいん)を一覧から消しますか');
    await page.locator('#ask-cancel').tap();
    await expect(kakiRow).toHaveCount(1);
    // テストをフォルダーに入れる → フォルダーのチェックで、中のテストをまとめて出題する・しない
    // フォルダーがないうちは、入れられない
    await page.locator('#btn-set-folder').tap();
    await expect(page.locator('#message')).toContainText('先に「フォルダーを作る」で');
    await page.locator('#btn-folder-new').tap();
    await confirmAsk(page, '2学期');
    await expect(page.locator('#set-tree .tree-folder[data-folder="2学期"] .tree-count')).toHaveText('(テスト 0 件・0 語)');
    await page.locator('#btn-set-folder').tap();
    await expect(page.locator('#ask-select')).toBeVisible();
    await page.locator('#ask-select').selectOption('2学期');
    await page.locator('#ask-ok').tap();
    await expect(page.locator('#ask')).toBeHidden();
    const folder = page.locator('#set-tree .tree-folder[data-folder="2学期"]');
    await expect(folder.locator('.tree-folder-name')).toHaveText('📁 2学期');
    await expect(folder.locator('.tree-count').first()).toHaveText('(テスト 1 件・3 語)');
    await expect(folder.locator('.tree-set .tree-name')).toHaveText('2学期中間確認テスト');
    await folder.locator('.tree-row .tree-check').first().uncheck();
    await expect(page.locator('#btn-start')).toBeDisabled();
    await folder.locator('.tree-row .tree-check').first().check();
    await expect(page.locator('#btn-start')).toHaveText('全問出題する(3 語)');
    await shot(page, '0-folder');
    // フォルダーの名前を変える
    await folder.locator('.tree-folder-name').tap();
    await confirmAsk(page, '2学期のテスト');
    await expect(page.locator('#set-tree .tree-folder-name')).toHaveText('📁 2学期のテスト');
    // チェックの連動(タップで): 写真を全部外すとテストも外れ、テストに入れると写真にも全部入る
    const t1 = page.locator('#set-tree .tree-set').first();
    for (const g of ['1', '2']) await t1.locator(`.tree-group[data-group="${g}"] input`).tap();
    await expect(t1.locator('.tree-row .tree-check')).not.toBeChecked();
    await expect(page.locator('#btn-start')).toBeDisabled();
    await t1.locator('.tree-row .tree-check').tap();
    expect(await t1.locator('.tree-group input').evaluateAll((els) => els.map((e) => e.checked))).toEqual([true, true]);
    await expect(page.locator('#btn-start')).toHaveText('全問出題する(3 語)');
    await shot(page, '0-tree');
    // 消したいものにチェックがないと、削除しない
    await t1.locator('.tree-row .tree-check').tap();
    await page.locator('#btn-set-delete').tap();
    await expect(page.locator('#message')).toContainText('削除するテスト(またはフォルダー)にチェックを入れてください');
    await t1.locator('.tree-row .tree-check').tap();
    // 写真のまとまりの名前を変える(12 文字まで)。数は「問」
    const g1 = page.locator('.group-head[data-group="1"]');
    await expect(g1.locator('.gcount')).toHaveText('2 問');
    await g1.locator('.gname').tap();
    await confirmAsk(page, '十三文字の長い名前を付けてみる');
    await expect(page.locator('#message')).toContainText('12 文字までです');
    await g1.locator('.gname').tap();
    await confirmAsk(page, '吉野弘の詩');
    await expect(g1.locator('.gname')).toHaveText('吉野弘の詩');
    await expect(g1.locator('.stats-pct.none')).toHaveText('100%'); // まだ出題していない(2 問とも未出題)
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
    // スキップ: 判定しないで、この回の最後に回す
    const skipped = await page.locator('#screen-drill').getAttribute('data-word');
    await page.locator('#btn-skip').tap();
    await expect(page.locator('#screen-drill')).not.toHaveAttribute('data-word', skipped);
    await expect(page.locator('#progress')).toContainText('1 / 3 問');
    for (let q = 0; q < 3; q++) {
      if (q === 2) {
        // スキップした問題が最後に出る。最後の 1 問はスキップできない
        await expect(page.locator('#screen-drill')).toHaveAttribute('data-word', skipped);
        await page.locator('#btn-skip').tap();
        await expect(page.locator('#message')).toContainText('残りはこの問題だけです');
        await expect(page.locator('#screen-drill')).toHaveAttribute('data-word', skipped);
      }
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
        // 合格したマスは、うすい緑の紙になる
        const paper = await page.locator('#cells .cell canvas.pad').first().evaluate((c) => [...c.getContext('2d').getImageData(4, c.height / 2 + 7, 1, 1).data]);
        expect(paper[1], `マスの紙の色 ${paper}`).toBeGreaterThan(paper[0] + 10);
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
    await shot(page, '6-stats');
    // 割合の分母: 全体は「出題する」にチェックの入っている語(3 語)、写真ごとはそのまとまりの語
    await expect(page.locator('#result-summary .stats-pct.pass')).toHaveText('67%');
    await expect(page.locator('#result-summary .stats-pct.fail1')).toHaveText('33%');
    await expect(page.locator('#result-summary .stats-pct.none')).toHaveText('0%');
    await expect(page.locator('.group-head[data-group="1"] .stats-pct.pass')).toHaveText('100%');
    // グラフの原点(棒の左の端)は、写真ごとのまとまりでそろっている
    const x0 = await page.locator('.group-head .cyl-track').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    if (info.w >= 768) expect(new Set(x0).size, `棒の左の端 ${x0}`).toBe(1);
    // 横向きの iPad では、写真ごとの見出しが 1 行に収まる(開け閉めのボタンが右端の同じ行)
    if (info.w >= 900) {
      const head = await page.locator('.group-head[data-group="1"]').boundingBox();
      const fold = await page.locator('.group-head[data-group="1"] .gfold').boundingBox();
      expect(fold.y + fold.height, '開け閉めのボタンが 2 行目にある').toBeLessThanOrEqual(head.y + head.height / 2 + fold.height);
      expect(head.height).toBeLessThan(110);
    }
    await expect(page.locator('.group-head[data-group="1"] .gname')).toHaveText('吉野弘の詩');
    await expect(page.locator('#result-summary .cyl.pass')).toHaveCount(1);
    // 写真のまとまりごとに成績をリセット
    await page.locator('.group-head[data-group="1"] .greset').tap();
    await confirmAsk(page);
    await expect(page.locator('.group-head[data-group="1"] .stats-pct.none')).toHaveText('100%');
    await expect(page.locator('#result-summary .stats-pct.pass')).toHaveText('0%');
    // 「出題する」のチェックを外すと、全体の分母が変わる(3 語 → 1 語)
    await page.locator('.group-head[data-group="1"] input[type="checkbox"]').uncheck();
    await expect(page.locator('#result-summary .stats-pct.fail1')).toHaveText('100%');
    await expect(page.locator('#word-list ul[data-group="2"]')).toBeHidden();
    await expect(page.locator('#btn-start-wrong')).toHaveText('不合格の語だけ出題する(1 語)');

    expect(problems, problems.join('\n')).toEqual([]);
    await context.close();
  });
}
