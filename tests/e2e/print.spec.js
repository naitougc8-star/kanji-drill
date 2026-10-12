// 問題プリント: 写真の上で問題をなぞる → なぞった部分だけを読み取る → 書き取る部分と答えを選ぶ → 一覧に追加 → 出題
import { test, expect } from '@playwright/test';
import fs from 'node:fs';

function watch(page, baseURL) {
  const problems = [];
  const origin = new URL(baseURL).origin;
  page.on('console', (m) => m.type() === 'error' && problems.push(`console.error: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()}: ${r.url()}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:')) problems.push(`external request: ${u}`);
  });
  return problems;
}

/** 問題の文字の部分を、マウスでなぞる(Apple Pencil の代わり) */
async function traceItems(page, spec) {
  const canvas = page.locator('#marker-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  const k = box.width / spec.width;
  for (const it of spec.items) {
    const [x, y, w, h] = it.box;
    let pts;
    if (spec.vertical) {
      const cx = box.x + (x + w * (it.bracket ? 0.65 : 0.5)) * k; // 括弧の問題は、右のふりがなも帯に入れる
      pts = [[cx, box.y + (y + 4) * k], [cx, box.y + (y + h - 4) * k]];
    } else {
      const cy = box.y + (y + h * 0.5) * k;
      pts = [[box.x + (x + 4) * k, cy], [box.x + (x + w - 4) * k, cy]];
    }
    await page.mouse.move(pts[0][0], pts[0][1]);
    await page.mouse.down();
    await page.mouse.move(pts[1][0], pts[1][1], { steps: 20 });
    await page.mouse.up();
  }
}

/**
 * 書き取る部分(target)だけが選ばれた状態にする。
 * 読み取りが間違っていたら、ユーザーと同じように文字欄を直す(直したら true を返す)。
 */
async function selectTarget(page, li, it) {
  const { target } = it;
  let text = await li.locator('input.pline').inputValue();
  let fixed = false;
  if (!text.includes(target)) {
    const line = li.locator('input.pline');
    await line.fill(it.before + target + it.after);
    await line.press('Enter');
    await line.blur();
    await expect(li.locator('input.pline')).toHaveValue(it.before + target + it.after);
    text = it.before + target + it.after;
    fixed = true;
  }
  const start = text.indexOf(target);
  const want = new Set([...Array(target.length).keys()].map((i) => start + i));
  const n = [...text].length;
  for (let i = 0; i < n; i++) {
    const chip = li.locator('.chip').nth(i);
    const on = (await chip.getAttribute('aria-pressed')) === 'true';
    if (on !== want.has(i)) await chip.click();
  }
  return fixed;
}

test('問題プリントをなぞって読み取り、答えを選んで出題する', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const problems = watch(page, baseURL);
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
  await expect(page.locator('#mode-print')).toBeVisible(); // 初期値は「問題プリント」

  const expected = [];
  let fixes = 0, total = 0;
  for (const name of ['print-sideline', 'print-bracket', 'print-horizontal']) {
    const spec = JSON.parse(fs.readFileSync(`tests/fixtures/${name}.json`, 'utf8'));
    await page.setInputFiles('#photo', `tests/fixtures/${name}.png`);
    await expect(page.locator('#marker-canvas')).toBeVisible();
    await page.locator('label', { hasText: '1 問ずつなぞる' }).click();
    if (name === 'print-bracket') await page.locator('label', { hasText: '太' }).click();
    await traceItems(page, spec);
    await expect(page.locator('#mark-status')).toHaveText(`${spec.items.length} 問をなぞりました。`);

    await page.click('#btn-read-marks');
    await expect(page.locator('#mark-status')).toContainText('問を読み取りました', { timeout: 120_000 });
    const items = page.locator('#print-items > li');
    await expect(items).toHaveCount(spec.items.length);

    for (let i = 0; i < spec.items.length; i++) {
      const it = spec.items[i];
      const li = items.nth(i);
      console.log(`${name} ${i + 1}: 「${await li.locator('input.pline').inputValue()}」`);
      total++;
      if (await selectTarget(page, li, it)) {
        fixes++;
        console.log(`  読み違いを手で直した: ${it.before}${it.target}${it.after}`);
      }
      const ans = li.locator(`.answer[data-reading="${it.target}"]`);
      await expect(ans).toHaveCount(1);
      // 正解が候補に出ていること(1 位かどうかも記録する)
      const cand = ans.locator('.cand', { hasText: new RegExp(`^${it.answer}$`) });
      await expect(cand).toBeVisible({ timeout: 60_000 });
      const first = await ans.locator('.cand').first().textContent();
      console.log(`  ${it.target} → 候補 ${(await ans.locator('.cand').allTextContents()).join(' ')}${first === it.answer ? '(1 位)' : ''}`);
      await cand.click();
      await expect(items.nth(i).locator(`.answer[data-reading="${it.target}"] input.ans`)).toHaveValue(it.answer);
      expected.push(it);
    }
    await page.click('#btn-add-print');
    await expect(page.locator('#print-add-status')).toContainText(`${spec.items.length} 語を語の一覧に追加しました`);
    await page.click('#btn-mark-clear');
    await expect(page.locator('#btn-read-marks')).toBeDisabled();
  }

  console.log(`読み違いを直した問題: ${fixes} / ${total}`);
  expect(fixes).toBeLessThanOrEqual(2);

  // 語の一覧に、答えと読みが入っている
  for (const it of expected) {
    const row = page.locator(`#word-list li[data-word="${it.answer}"]`);
    await expect(row).toHaveCount(1);
    await expect(row.locator('input.r')).toHaveValue(it.target);
  }

  // 「天井」だけ出題する
  await page.click('#btn-none');
  await page.locator('#word-list li[data-word="天井"] .on input').check();
  await page.click('#btn-start');
  await expect(page.locator('#reading')).toHaveText('てんじょう');
  await expect(page.locator('#context')).toContainText('の高い家');
  await expect(page.locator('#cells .cell')).toHaveCount(2);

  expect(problems, problems.join('\n')).toEqual([]);
});

test('問題プリント: 回転・ズーム・一つ戻す・指で動かす', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.setInputFiles('#photo', 'tests/fixtures/print-horizontal.png');
  const canvas = page.locator('#marker-canvas');
  await expect(canvas).toBeVisible();
  await page.locator('label', { hasText: '1 問ずつなぞる' }).click();
  const w0 = (await canvas.boundingBox()).width;
  const h0 = (await canvas.boundingBox()).height;

  const box = await canvas.boundingBox();
  const line = async (y) => {
    await page.mouse.move(box.x + 50, box.y + y);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + y, { steps: 5 });
    await page.mouse.up();
  };
  await line(60);
  await line(120);
  await expect(page.locator('#mark-status')).toHaveText('2 問をなぞりました。');
  await page.click('#btn-mark-undo');
  await expect(page.locator('#mark-status')).toHaveText('1 問をなぞりました。');

  // 指で動かすモードでは、マウスでもなぞらない
  await page.locator('label', { hasText: '指で動かす' }).click();
  await line(180);
  await expect(page.locator('#mark-status')).toHaveText('1 問をなぞりました。');
  await expect(canvas).toHaveCSS('touch-action', /pan|manipulation/);
  await page.locator('label', { hasText: '指でなぞる' }).click();
  await expect(canvas).toHaveCSS('touch-action', 'none');

  await page.click('#btn-zoom-in');
  expect((await canvas.boundingBox()).width).toBeGreaterThan(w0 * 1.4);
  await page.click('#btn-zoom-out');

  // 回転すると縦横が入れ替わり、なぞった跡は消える
  await page.click('#btn-rotate');
  const r = await canvas.boundingBox();
  expect(r.height / r.width).toBeCloseTo(w0 / h0, 1);
  await expect(page.locator('#btn-read-marks')).toBeDisabled();
});

test('表のプリント: 表を囲む → 1 列ずつ自動で切り出す → カタカナを自動で選ぶ → 答えを確かめて出題', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const problems = watch(page, baseURL);
  const spec = JSON.parse(fs.readFileSync('tests/fixtures/print-table.json', 'utf8'));
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.setInputFiles('#photo', 'tests/fixtures/print-table.png');
  const canvas = page.locator('#marker-canvas');
  await expect(canvas).toBeVisible();
  await expect(page.locator('input[name="tool"][value="box"]')).toBeChecked(); // 初期値は「表を囲む」
  await expect(page.locator('#btn-read-marks')).toBeEnabled(); // 囲まなくても読み取れる

  // 表を四角く囲む(少し外側から)
  const box = await canvas.boundingBox();
  const k = box.width / spec.width;
  const [tx, ty, tw, th] = spec.table;
  await page.mouse.move(box.x + (tx - 12) * k, box.y + (ty - 12) * k);
  await page.mouse.down();
  await page.mouse.move(box.x + (tx + tw + 12) * k, box.y + (ty + th + 12) * k, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('#mark-status')).toContainText('表の範囲を囲みました');

  await page.click('#btn-read-marks');
  await expect(page.locator('#mark-status')).toContainText('問を読み取りました', { timeout: 120_000 });
  const items = page.locator('#print-items > li');
  await expect(items).toHaveCount(spec.items.length); // 10 列

  let fixes = 0, top1 = 0;
  for (let i = 0; i < spec.items.length; i++) {
    const it = spec.items[i];
    const li = items.nth(i);
    const text = await li.locator('input.pline').inputValue();
    const reading = it.target.replace(/[\u30A1-\u30F6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
    let ans = li.locator(`.answer[data-reading="${reading}"]`);
    // カタカナが自動で選ばれていること(読み違えていたら、文字欄を直す)
    if ((await ans.count()) === 0 || !text.includes(it.target)) {
      fixes++;
      console.log(`  読み違いを手で直した: 「${text}」→「${it.before}${it.target}${it.after}」`);
      const line = li.locator('input.pline');
      await line.fill(it.before + it.target + it.after);
      await line.press('Enter');
      await line.blur();
      ans = items.nth(i).locator(`.answer[data-reading="${reading}"]`);
    }
    await expect(ans).toHaveCount(1);
    const cand = ans.locator('.cand', { hasText: new RegExp(`^${it.answer}$`) });
    await expect(cand).toBeVisible({ timeout: 60_000 });
    const list = await ans.locator('.cand').allTextContents();
    if (list[0] === it.answer) top1++;
    console.log(`${i + 1}: 「${text}」 ${it.target} → ${list.slice(0, 4).join(' ')}${list[0] === it.answer ? '(1 位)' : ''}`);
    await cand.click();
  }
  console.log(`読み違いを直した問題: ${fixes} / 10、正解が候補の 1 位: ${top1} / 10`);
  expect(fixes).toBeLessThanOrEqual(1);

  await page.click('#btn-add-print');
  await expect(page.locator('#print-add-status')).toContainText('10 語を語の一覧に追加しました');
  await page.click('#btn-none');
  await page.locator('#word-list li[data-word="預ける"] .on input').check();
  await page.click('#btn-start');
  await expect(page.locator('#reading')).toHaveText('あずける');
  await expect(page.locator('#context')).toContainText('荷物を');
  await expect(page.locator('#cells .cell')).toHaveCount(1); // 「預」+「ける」
  await expect(page.locator('#cells .kana')).toHaveText('ける');

  expect(problems, problems.join('\n')).toEqual([]);
});

test('表のプリント: 囲まずに写真全体で読むと、表の外の余白は問題として出さない', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.setInputFiles('#photo', 'tests/fixtures/print-table.png');
  await page.click('#btn-read-marks');
  await expect(page.locator('#mark-status')).toContainText('10 問を読み取りました', { timeout: 120_000 });
  await expect(page.locator('#print-items > li')).toHaveCount(10);
});
