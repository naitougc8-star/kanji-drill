import { test, expect } from '@playwright/test';

/** コンソールのエラー・失敗した通信・外部への通信を集める */
function watch(page, baseURL) {
  const problems = [];
  const origin = new URL(baseURL).origin;
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:')) problems.push(`external request: ${u}`);
  });
  return problems;
}

/** 取り込み方を「文章(漢字を含む文)」にする(初期値は「問題プリント」) */
async function useTextMode(page) {
  await page.locator('label', { hasText: '文章(漢字を含む文)' }).click();
  await expect(page.locator('#mode-text')).toBeVisible();
}

/** お手本の筆画(109×109)を、同じオリジンの data/ から取る */
async function templateOf(page, ch) {
  return page.evaluate(async (c) => {
    const cp = c.codePointAt(0);
    const r = await fetch(`data/k${(cp >> 8).toString(16)}.json`);
    return (await r.json())[cp.toString(16)];
  }, ch);
}

/** マウスで筆画をなぞる(Apple Pencil の代わり) */
async function drawStrokes(page, cell, strokes) {
  const canvas = cell.locator('canvas.pad');
  const box = await canvas.boundingBox();
  const k = (box.width * 0.86) / 109;
  const ox = box.x + box.width * 0.07, oy = box.y + box.height * 0.07;
  for (const flat of strokes) {
    const pts = [];
    for (let i = 0; i + 1 < flat.length; i += 2) pts.push([ox + flat[i] * k, oy + flat[i + 1] * k]);
    await page.mouse.move(pts[0][0], pts[0][1]);
    await page.mouse.down();
    for (let i = 1; i < pts.length; i++) await page.mouse.move(pts[i][0], pts[i][1], { steps: 4 });
    await page.mouse.up();
  }
}

async function writeWord(page, { correct }) {
  const cells = page.locator('#cells .cell');
  const n = await cells.count();
  for (let i = 0; i < n; i++) {
    const cell = cells.nth(i);
    const ch = await cell.getAttribute('data-char');
    const t = await templateOf(page, ch);
    // 間違える場合は、最初の字の最後の筆画を書かない(画数が足りない)
    const strokes = !correct && i === 0 ? t.slice(0, -1) : t;
    await drawStrokes(page, cell, strokes);
  }
}

test('写真の OCR → 語の取り出し → 出題 → 手書き → 判定 → 間違いの再出題 → 結果', async ({ page, baseURL }) => {
  const problems = watch(page, baseURL);
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await useTextMode(page);
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');

  // 1. 写真から OCR
  await page.setInputFiles('#photo', 'tests/fixtures/sample.png');
  await expect(page.locator('#btn-ocr')).toBeEnabled();
  await expect(page.locator('#ocr-preview')).toBeVisible();
  await page.click('#btn-ocr');
  await expect(page.locator('#ocr-status')).toContainText('読み取りました', { timeout: 180_000 });
  const text = await page.inputValue('#source');
  console.log('OCR:', JSON.stringify(text));
  for (const w of ['学校', '漢字', '先生', '手紙']) expect(text).toContain(w);

  // 2. 語の取り出し
  await page.click('#btn-extract');
  await expect(page.locator('#extract-status')).toContainText('語を取り出しました', { timeout: 120_000 });
  const words = await page.locator('#word-list li input.w').evaluateAll((els) => els.map((e) => e.value));
  console.log('語:', words.join(' '));
  for (const w of ['学校', '漢字', '先生', '手紙']) expect(words).toContain(w);
  const reading = await page.locator('#word-list li[data-word="先生"]').locator('input.r').inputValue();
  expect(reading).toBe('せんせい');

  // 出題するのは「先生」と「手紙」だけにする
  await page.click('#btn-none');
  for (const w of ['先生', '手紙']) {
    await page.locator(`#word-list li[data-word="${w}"]`).locator('.on input').check();
  }
  await expect(page.locator('#word-count')).toContainText('出題する語: 2');
  await expect(page.locator('input[name="level"][value="severe"]')).toBeChecked(); // 初期値はシビア
  await page.click('#btn-start');

  // 3. 1 回目: 「手紙」は正しく、「先生」は間違えて書く
  for (let q = 0; q < 2; q++) {
    await expect(page.locator('#screen-drill')).toBeVisible();
    const word = await page.locator('#screen-drill').getAttribute('data-word');
    await expect(page.locator('#reading')).toHaveText(word === '先生' ? 'せんせい' : 'てがみ');
    await expect(page.locator('#context .blank')).toBeVisible();
    await writeWord(page, { correct: word === '手紙' });
    await page.click('#btn-judge');
    if (word === '手紙') {
      await expect(page.locator('#verdict-title')).toHaveText('○ 合格');
    } else {
      await expect(page.locator('#verdict-title')).toHaveText('× 不合格');
      await expect(page.locator('#reasons')).toContainText('画数が違います(正解 6 画 / あなた 5 画)');
      await expect(page.locator('#btn-override')).toBeVisible();
    }
    await expect(page.locator('#cells canvas.model')).toHaveCount(2); // お手本を並べて表示
    await page.click('#btn-next');
  }

  // 結果画面
  await expect(page.locator('#screen-result')).toBeVisible();
  await expect(page.locator('#score')).toHaveText('2 問中 1 問正解');
  // この回の全問が、合格は緑・不合格は赤で並ぶ
  await expect(page.locator('#round-list li.fail1')).toHaveText(/× 先生.*1 回まちがい/);
  await expect(page.locator('#round-list li.pass')).toHaveText(/○ 手紙/);
  await expect(page.locator('#history tbody tr')).toHaveCount(1);

  // 4. 間違えた語だけ再出題 → 正しく書く
  await page.click('#btn-retry');
  await expect(page.locator('#screen-drill')).toHaveAttribute('data-word', '先生');
  await expect(page.locator('#progress')).toContainText('2 回目 1 / 1 問');
  await writeWord(page, { correct: true });
  await page.click('#btn-judge');
  await expect(page.locator('#verdict-title')).toHaveText('○ 合格');
  await page.click('#btn-next');

  await expect(page.locator('#score')).toContainText('全問正解です');
  await expect(page.locator('#history tbody tr')).toHaveCount(2);
  await expect(page.locator('#history tbody tr').nth(1)).toContainText('100%');
  await expect(page.locator('#btn-retry')).toBeHidden();

  expect(problems, problems.join('\n')).toEqual([]);
});

test('貼り付けだけで使える・手で追加・自己採点・合格にする・書き順・保存', async ({ page, baseURL }) => {
  const problems = watch(page, baseURL);
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await useTextMode(page);
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');

  await page.fill('#source', '山に登る。');
  await page.click('#btn-extract');
  await expect(page.locator('#extract-status')).toContainText('語を取り出しました', { timeout: 120_000 });
  // 送り仮名つきの語(登る → 「登」のマス + 「る」)
  const words = await page.locator('#word-list li input.w').evaluateAll((els) => els.map((e) => e.value));
  expect(words).toEqual(['山', '登る']);

  // お手本データがない字(CJK 拡張 A)を手で追加 → 自己採点
  await page.fill('#add-word', '㐂');
  await page.fill('#add-reading', 'き');
  await page.click('#add-form button');
  await expect(page.locator('#word-list li')).toHaveCount(3);

  // 保存されているか(再読み込みしても残る)
  await page.reload();
  await expect(page.locator('#word-list li')).toHaveCount(3);
  await expect(page.locator('#source')).toHaveValue('山に登る。');

  // 書き順も判定する
  await page.check('#check-order');
  await page.locator('#word-list li[data-word="山"]').locator('.on input').uncheck();
  await page.click('#btn-start');

  for (let q = 0; q < 2; q++) {
    const word = await page.locator('#screen-drill').getAttribute('data-word');
    if (word === '登る') {
      await expect(page.locator('#cells .cell')).toHaveCount(1);
      await expect(page.locator('#cells .kana')).toHaveText('る');
      // 書き順を入れ替えて書く(形は合っている)
      const t = await templateOf(page, '登');
      const swapped = [t[1], t[0], ...t.slice(2)];
      await drawStrokes(page, page.locator('#cells .cell').first(), swapped);
      // 一画戻す → 書き直し
      await page.click('#btn-undo');
      await drawStrokes(page, page.locator('#cells .cell').first(), [t[t.length - 1]]);
      await page.click('#btn-judge');
      await expect(page.locator('#verdict-title')).toHaveText('× 不合格');
      await expect(page.locator('#reasons')).toContainText('書き順が違います(形は合っています)');
      // 手動で合格にする
      await page.click('#btn-override');
      await expect(page.locator('#verdict-title')).toHaveText('○ 合格(手動)');
    } else {
      expect(word).toBe('㐂');
      await expect(page.locator('#cells .note')).toHaveText('自己採点');
      await drawStrokes(page, page.locator('#cells .cell').first(), [[20, 20, 80, 80]]);
      await page.click('#btn-judge');
      await expect(page.locator('#selfcheck')).toBeVisible();
      await expect(page.locator('#btn-next')).toBeDisabled();
      await page.click('#btn-self-ok');
      await expect(page.locator('#verdict-title')).toHaveText('○ 合格');
    }
    await page.click('#btn-next');
  }
  await expect(page.locator('#score')).toContainText('全問正解です');
  await page.click('#btn-setup');
  await expect(page.locator('#screen-setup')).toBeVisible();

  expect(problems, problems.join('\n')).toEqual([]);
});

test('手書きのマス: Retina 対応・touch-action・ボタンの大きさ', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await useTextMode(page);
  await page.fill('#source', '日');
  await page.click('#btn-extract');
  await expect(page.locator('#extract-status')).toContainText('語を取り出しました', { timeout: 120_000 });
  await page.click('#btn-start');
  const info = await page.locator('#cells canvas.pad').evaluate((c) => ({
    w: c.width,
    cssW: c.getBoundingClientRect().width,
    ta: getComputedStyle(c).touchAction,
    dpr: devicePixelRatio,
  }));
  expect(info.w).toBe(Math.round(info.cssW * info.dpr));
  expect(info.ta).toBe('none');
  const heights = await page.locator('button:visible, .seg span:visible').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);

  // Apple Pencil(pen)を検出したら、以後は指(touch)を無視する
  const strokes = await page.locator('#cells canvas.pad').evaluate((c) => {
    const r = c.getBoundingClientRect();
    const fire = (type, pointerType, id, x, y) =>
      c.dispatchEvent(new PointerEvent(type, { pointerType, pointerId: id, clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, isPrimary: true }));
    // 指で 1 画(Pencil を検出する前なので書ける)
    fire('pointerdown', 'touch', 11, 20, 20);
    fire('pointermove', 'touch', 11, 60, 20);
    fire('pointerup', 'touch', 11, 60, 20);
    // Pencil で 1 画
    fire('pointerdown', 'pen', 12, 20, 60);
    fire('pointermove', 'pen', 12, 80, 60);
    fire('pointerup', 'pen', 12, 80, 60);
    // そのあとの指(手のひら)は無視される
    fire('pointerdown', 'touch', 13, 30, 100);
    fire('pointermove', 'touch', 13, 90, 100);
    fire('pointerup', 'touch', 13, 90, 100);
    return c.width; // 戻り値は使わない
  });
  expect(strokes).toBeGreaterThan(0);

  // 点(1 点だけの接触)も 1 画として数える
  const box = await page.locator('#cells canvas.pad').boundingBox();
  await page.mouse.click(box.x + 50, box.y + 150);
  await page.click('#btn-judge');
  // 指 1 画 + Pencil 1 画 + 点 1 画 = 3 画(手のひらの 1 画は数えない)
  await expect(page.locator('#reasons')).toContainText('画数が違います(正解 4 画 / あなた 3 画)');
});

test('通信の失敗は画面にメッセージを出し、手入力で続けられる', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await useTextMode(page);
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');

  // OCR ライブラリが読み込めない
  await page.route('**/vendor/tesseract/tesseract.min.js', (r) => r.abort());
  await page.setInputFiles('#photo', 'tests/fixtures/sample.png');
  await page.click('#btn-ocr');
  await expect(page.locator('#message')).toBeVisible();
  await expect(page.locator('#message-text')).toContainText('文字を読み取れませんでした');
  await expect(page.locator('#message-text')).toContainText('直接入力');
  await page.click('#message-close');

  // 辞書が読み込めない
  await page.route('**/vendor/kuromoji/dict/base.dat.gz', (r) => r.abort());
  await page.fill('#source', '山に登る。');
  await page.click('#btn-extract');
  await expect(page.locator('#message-text')).toContainText('語を取り出せませんでした');

  // 手で追加すれば出題できる
  await page.fill('#add-word', '山');
  await page.fill('#add-reading', 'やま');
  await page.click('#add-form button');
  await expect(page.locator('#btn-start')).toBeEnabled();
  await page.click('#btn-start');
  await expect(page.locator('#reading')).toHaveText('やま');
});
/** 1 回出題して、各問を正しく(または間違えて)書く。correct(word) が true なら正しく書く */
async function playRound(page, correct) {
  const n = Number((await page.locator('#progress').textContent()).match(/\/ (\d+) 問/)[1]);
  for (let q = 0; q < n; q++) {
    const word = await page.locator('#screen-drill').getAttribute('data-word');
    const t = await templateOf(page, word);
    await drawStrokes(page, page.locator('#cells .cell').first(), correct(word) ? t : t.slice(0, 1));
    await page.click('#btn-judge');
    await page.click('#btn-next');
  }
}

test('間違えた回数で色分け(黄・オレンジ・赤)、何回目で合格したかの記録、不合格の語だけ出題・全問出題', async ({ page, baseURL }) => {
  const problems = watch(page, baseURL);
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
  for (const [w, r] of [['山', 'やま'], ['川', 'かわ'], ['空', 'そら']]) {
    await page.fill('#add-word', w);
    await page.fill('#add-reading', r);
    await page.click('#add-form button');
  }
  const row = (w) => page.locator(`#word-list li[data-word="${w}"]`);
  // 最初はすべて未出題。不合格がないので「不合格の語だけ」は押せない
  await expect(page.locator('#word-list li[data-result="none"]')).toHaveCount(3);
  await expect(page.locator('#btn-start')).toHaveText('全問出題する(3 語)');
  await expect(page.locator('#btn-start-wrong')).toBeDisabled();

  // 1 回目: 「山」だけ正しく書く → 山は 1 回目で合格、川・空は 1 回まちがい(黄)
  await page.click('#btn-start');
  await playRound(page, (w) => w === '山');
  await expect(page.locator('#round-list li.fail1')).toHaveCount(2);
  await expect(page.locator('#round-list li.pass')).toHaveText(/○ 山.*1 回目で合格/);
  await expect(page.locator('#round-list li').first()).toHaveClass(/fail1/); // まちがいが先に並ぶ
  await page.click('#btn-setup');
  await expect(row('山')).toHaveClass(/res-pass/);
  await expect(row('山').locator('.res')).toHaveText('○ 1 回目で合格');
  await expect(row('川')).toHaveClass(/res-fail1/);
  await expect(row('川').locator('.res')).toHaveText('× 1 回まちがい');
  await expect(page.locator('#result-summary')).toHaveText(/○ 合格 1 語.*× 1 回まちがい 2 語.*未出題 0 語/);
  await expect(page.locator('#btn-start-wrong')).toHaveText('不合格の語だけ出題する(2 語)');

  // 2 回目(不合格の語だけ): 2 問。「空」だけ正しく書く → 空は 2 回目で合格、川は 2 回まちがい(オレンジ)
  await page.click('#btn-start-wrong');
  await expect(page.locator('#progress')).toContainText('1 / 2 問');
  await playRound(page, (w) => w === '空');
  await page.click('#btn-setup');
  await expect(row('空').locator('.res')).toHaveText('○ 2 回目で合格');
  await expect(row('川')).toHaveClass(/res-fail2/);
  await expect(row('川').locator('.res')).toHaveText('× 2 回まちがい');

  // 3 回目: 川をまた間違える → 赤
  await page.click('#btn-start-wrong');
  await expect(page.locator('#progress')).toContainText('1 / 1 問');
  await playRound(page, () => false);
  await expect(page.locator('#round-list li.fail3')).toHaveText(/× 川.*3 回まちがい/);
  await page.click('#btn-setup');
  await expect(row('川')).toHaveClass(/res-fail3/);
  await expect(row('川').locator('.res')).toHaveText('× 3 回まちがい');

  // 再読み込みしても残る
  await page.reload();
  await expect(row('川')).toHaveClass(/res-fail3/);
  await expect(row('空').locator('.res')).toHaveText('○ 2 回目で合格');

  // 4 回目で合格 → 緑で「4 回目で合格」。不合格がなくなる
  await page.click('#btn-start-wrong');
  await playRound(page, () => true);
  await expect(page.locator('#round-list li.pass')).toHaveText(/○ 川.*4 回目で合格/);
  await page.click('#btn-setup');
  await expect(row('川').locator('.res')).toHaveText('○ 4 回目で合格');
  await expect(page.locator('#word-list li.res-pass')).toHaveCount(3);
  await expect(page.locator('#btn-start-wrong')).toBeDisabled();

  // 全問出題する → 3 問。合格のまま再び合格しても、最初に合格した回目は残る
  await page.click('#btn-start');
  await expect(page.locator('#progress')).toContainText('1 / 3 問');
  await playRound(page, () => true);
  await page.click('#btn-setup');
  await expect(row('川').locator('.res')).toHaveText('○ 4 回目で合格');

  // 合格したあとで間違えたら、1 回まちがい(黄)から数え直す
  await page.click('#btn-start');
  await playRound(page, (w) => w !== '山');
  await page.click('#btn-setup');
  await expect(row('山')).toHaveClass(/res-fail1/);

  // 成績をリセット
  page.once('dialog', (d) => d.accept());
  await page.click('#btn-reset-results');
  await expect(page.locator('#word-list li[data-result="none"]')).toHaveCount(3);

  expect(problems, problems.join('\n')).toEqual([]);
});

test('未出題の語だけ出題する・判定の厳しさ 4 段階・画面のライト/ダーク切り替え', async ({ page, baseURL }) => {
  const problems = watch(page, baseURL);
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');

  // 厳しさは 4 段階(超シビアはない)。初期値はシビア
  await expect(page.locator('input[name="level"]')).toHaveCount(4);
  expect(await page.locator('input[name="level"]').evaluateAll((els) => els.map((e) => e.value))).toEqual(['superLenient', 'lenient', 'standard', 'severe']);
  await expect(page.locator('input[name="level"][value="severe"]')).toBeChecked();
  await page.locator('label', { hasText: '超甘い' }).click();
  await expect(page.locator('input[name="level"][value="superLenient"]')).toBeChecked();

  // 未出題の語だけ出題する
  for (const [w, r] of [['山', 'やま'], ['川', 'かわ'], ['空', 'そら']]) {
    await page.fill('#add-word', w);
    await page.fill('#add-reading', r);
    await page.click('#add-form button');
  }
  await expect(page.locator('#btn-start-new')).toHaveText('未出題の語だけ出題する(3 語)');
  await page.click('#btn-start-new');
  await expect(page.locator('#progress')).toContainText('1 / 3 問');
  const first = await page.locator('#screen-drill').getAttribute('data-word');
  await drawStrokes(page, page.locator('#cells .cell').first(), await templateOf(page, first));
  await page.click('#btn-judge');
  await page.click('#btn-next');
  await page.click('#btn-quit'); // 1 問だけ答えてやめる
  await expect(page.locator(`#word-list li[data-word="${first}"]`)).toHaveClass(/res-pass/);
  await expect(page.locator('#btn-start-new')).toHaveText('未出題の語だけ出題する(2 語)');
  await page.click('#btn-start-new');
  await expect(page.locator('#progress')).toContainText('1 / 2 問');
  expect(await page.locator('#screen-drill').getAttribute('data-word')).not.toBe(first);
  await page.click('#btn-quit');

  // 画面の表示: 自動 → ダーク → ライト。再読み込みしても残る(描画の前に当たる)
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('input[name="theme"][value="auto"]')).toBeChecked();
  const lightBg = await bg();
  await page.locator('label', { hasText: 'ダーク' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const darkBg = await bg();
  expect(darkBg).not.toBe(lightBg);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bg()).toBe(darkBg);
  // 端末がダークでも、ライトを選べばライト
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('label', { hasText: 'ライト' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await bg()).toBe(lightBg);
  // 自動に戻すと、端末の設定(ダーク)に合わせる
  await page.locator('label', { hasText: '自動' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  expect(await bg()).toBe(darkBg);

  expect(problems, problems.join('\n')).toEqual([]);
});

test('テスト(出題の範囲)ごとに語をまとめる: 作る・名前を変える・切り替える・写真ごとのまとまり・削除・以前のデータ', async ({ page, baseURL }) => {
  const problems = watch(page, baseURL);
  // 以前の形式のデータ(テストなし)は「テスト 1」の「以前に取り込んだ語」になる
  await page.goto('./');
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('kakitori-drill.v1', JSON.stringify({ words: [{ id: 'old1', word: '海', reading: 'うみ', enabled: true, result: 'pass', passedAt: 2 }] }));
  });
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
  await expect(page.locator('#set-select option')).toHaveText(['テスト 1(1 語)']);
  await expect(page.locator('.group-head .gname')).toHaveText(['以前に取り込んだ語']);
  await expect(page.locator('#word-list li[data-word="海"] .res')).toHaveText('○ 2 回目で合格');

  // 名前を変える
  page.once('dialog', (d) => d.accept('1 学期 中間テスト'));
  await page.click('#btn-set-rename');
  await expect(page.locator('#set-select option')).toHaveText(['1 学期 中間テスト(1 語)']);
  await expect(page.locator('#set-name-inline')).toHaveText('「1 学期 中間テスト」');

  // 文章から取り込むと「写真 1」、手で追加すると「手で追加した語」
  await useTextMode(page);
  await page.fill('#source', '山に登る。');
  await page.click('#btn-extract');
  await expect(page.locator('#extract-status')).toContainText('「1 学期 中間テスト」に 2 語を追加しました', { timeout: 120_000 });
  await page.fill('#add-word', '川');
  await page.fill('#add-reading', 'かわ');
  await page.click('#add-form button');
  await expect(page.locator('.group-head .gname')).toHaveText(['以前に取り込んだ語', '写真 1', '手で追加した語']);
  await expect(page.locator('#set-info')).toContainText('4 語(写真 1 枚)');

  // 新しいテストを作ると、そちらに切り替わり、語の一覧は空
  page.once('dialog', (d) => d.accept('1 学期 期末テスト'));
  await page.click('#btn-set-new');
  await expect(page.locator('#set-select')).toHaveValue(/.+/);
  await expect(page.locator('#set-select option:checked')).toHaveText('1 学期 期末テスト(0 語)');
  await expect(page.locator('#word-list li')).toHaveCount(0);
  await expect(page.locator('#btn-start')).toBeDisabled();
  await page.fill('#add-word', '空');
  await page.fill('#add-reading', 'そら');
  await page.click('#add-form button');
  // 出題は、選んでいるテストの中からだけ
  await page.click('#btn-start');
  await expect(page.locator('#progress')).toContainText('「1 学期 期末テスト」');
  await expect(page.locator('#progress')).toContainText('1 / 1 問');
  await expect(page.locator('#screen-drill')).toHaveAttribute('data-word', '空');
  await page.click('#btn-quit');

  // 中間テストに戻すと、中間テストの語だけ
  await page.locator('#set-select').selectOption({ label: '1 学期 中間テスト(4 語)' });
  expect(await page.locator('#word-list li input.w').evaluateAll((els) => els.map((e) => e.value))).toEqual(['海', '山', '登る', '川']);
  await expect(page.locator('#btn-start')).toHaveText('全問出題する(4 語)');
  // 写真のまとまりごとに、出題する・しないを切り替える
  await page.locator('.group-head[data-group="1"] input[type="checkbox"]').uncheck();
  await expect(page.locator('#btn-start')).toHaveText('全問出題する(2 語)');

  // 再読み込みしても、選んでいるテストと語は残る
  await page.reload();
  await expect(page.locator('#set-select option:checked')).toHaveText('1 学期 中間テスト(4 語)');
  await expect(page.locator('#btn-start')).toHaveText('全問出題する(2 語)');

  // 期末テストを削除すると、その語も消える
  await page.locator('#set-select').selectOption({ label: '1 学期 期末テスト(1 語)' });
  page.once('dialog', (d) => d.accept());
  await page.click('#btn-set-delete');
  await expect(page.locator('#set-select option')).toHaveText(['1 学期 中間テスト(4 語)']);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('kakitori-drill.v1')).words.map((w) => w.word));
  expect(stored).not.toContain('空');

  expect(problems, problems.join('\n')).toEqual([]);
});

test('バックアップ: iPad で書き出したファイルを iPhone で読み込んで合わせ、両方の成績をまとめる', async ({ browser, baseURL }, testInfo) => {
  // 2 台の端末の代わりに、保存領域が別々の 2 つのブラウザを使う
  const open = async () => {
    const ctx = await browser.newContext({ baseURL, viewport: { width: 820, height: 1180 } });
    // 共有メニュー(navigator.share)の代わりに、ファイルとして保存する経路を通す
    await ctx.addInitScript(() => Object.defineProperty(navigator, 'canShare', { value: undefined }));
    const page = await ctx.newPage();
    const problems = watch(page, baseURL);
    await page.goto('./');
    await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
    return { ctx, page, problems };
  };
  const exportFile = async (page, name) => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
    expect(dl.suggestedFilename()).toMatch(/^kanji-drill-\d{8}-\d{4}\.json$/);
    const file = testInfo.outputPath(name);
    await dl.saveAs(file);
    await expect(page.locator('#backup-status')).toContainText('を保存しました');
    return file;
  };
  const answer = async (page, correct) => {
    const word = await page.locator('#screen-drill').getAttribute('data-word');
    const t = await templateOf(page, word);
    await drawStrokes(page, page.locator('#cells .cell').first(), correct ? t : t.slice(0, 1));
    await page.click('#btn-judge');
    await page.click('#btn-next');
  };

  // iPad: 「中間テスト」に 山・川 を入れて、山を合格にする
  const ipad = await open();
  {
    const p = ipad.page;
    p.once('dialog', (d) => d.accept('中間テスト'));
    await p.click('#btn-set-rename');
    for (const [w, r] of [['山', 'やま'], ['川', 'かわ']]) {
      await p.fill('#add-word', w);
      await p.fill('#add-reading', r);
      await p.click('#add-form button');
    }
    await p.locator('#word-list li[data-word="川"] .on input').uncheck();
    await p.click('#btn-start');
    await answer(p, true);
    await p.click('#btn-setup');
    await p.locator('#word-list li[data-word="川"] .on input').check();
    await expect(p.locator('#word-list li[data-word="山"] .res')).toHaveText('○ 1 回目で合格');
    await expect(p.locator('#storage-info')).toContainText('この端末に保存しているデータ');
  }
  const fromIpad = await exportFile(ipad.page, 'ipad.json');

  // iPhone(はじめて使う): 読み込んで合わせる → 中間テストと成績がそのまま入る(空の「テスト 1」は残らない)
  const iphone = await open();
  await iphone.page.setInputFiles('#import-merge', fromIpad);
  await expect(iphone.page.locator('#backup-status')).toContainText('テスト 1 件と語 2 語を追加し');
  await expect(iphone.page.locator('#set-select option')).toHaveText(['中間テスト(2 語)']);
  await expect(iphone.page.locator('#word-list li[data-word="山"] .res')).toHaveText('○ 1 回目で合格');

  // iPhone で 川 を間違える → 書き出す
  await iphone.page.click('#btn-start-new');
  await answer(iphone.page, false);
  await expect(iphone.page.locator('#round-list li.fail1')).toHaveCount(1);
  await iphone.page.click('#btn-setup');
  const fromIphone = await exportFile(iphone.page, 'iphone.json');

  // iPad で合わせる → 川 が iPhone の成績(1 回まちがい)になる。山の成績は残る
  await ipad.page.setInputFiles('#import-merge', fromIphone);
  await expect(ipad.page.locator('#backup-status')).toContainText('1 語を新しい方の成績に更新しました');
  await expect(ipad.page.locator('#word-list li[data-word="川"] .res')).toHaveText('× 1 回まちがい');
  await expect(ipad.page.locator('#word-list li[data-word="山"] .res')).toHaveText('○ 1 回目で合格');
  await expect(ipad.page.locator('#set-select option')).toHaveText(['中間テスト(2 語)']); // 同じテストは 1 つにまとまる

  // 置き換える(確認あり)
  ipad.page.once('dialog', (d) => d.accept());
  await ipad.page.setInputFiles('#import-replace', fromIpad);
  await expect(ipad.page.locator('#backup-status')).toContainText('置き換えました');
  await expect(ipad.page.locator('#word-list li[data-word="川"] .res')).toHaveText('未出題');

  // ほかのファイルは断る
  const bad = testInfo.outputPath('bad.json');
  (await import('node:fs')).writeFileSync(bad, '{"hello":1}');
  await ipad.page.setInputFiles('#import-merge', bad);
  await expect(ipad.page.locator('#message-text')).toContainText('このアプリのバックアップファイルではありません');

  expect(ipad.problems, ipad.problems.join('\n')).toEqual([]);
  expect(iphone.problems, iphone.problems.join('\n')).toEqual([]);
  await ipad.ctx.close();
  await iphone.ctx.close();
});
