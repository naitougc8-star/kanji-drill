// 画面の制御: 設定(取り込み・語の一覧・判定の設定)→ 出題 → 結果

import { judge, LEVELS, DEFAULT_LEVEL } from './judge.js';
import { getStrokes } from './strokes.js';
import { Pad, drawModel } from './pad.js';
import { extractWords, segments, hasKanji, newId, loadTokenizer, kataToHira } from './words.js';
import { loadImage, preprocess, recognize, recognizeCrops } from './ocr.js';
import { Marker } from './marker.js';
import { extractTableColumns, fixKatakana, katakanaRuns } from './table.js';
import { candidates, makeScorer, guessTarget, normalizeReading, lookupBrowser, commonKanji } from './yomi.js';
import * as storage from './storage.js';

const $ = (id) => document.getElementById(id);

const state = {
  text: '',
  words: [],
  settings: { level: DEFAULT_LEVEL, checkOrder: false, vertical: false, srcMode: 'print' },
  session: null,
};

// ---------- 保存 ----------

function persist() {
  storage.save({ text: state.text, words: state.words, settings: state.settings });
}

function restore() {
  const saved = storage.load();
  if (!saved) return;
  if (typeof saved.text === 'string') state.text = saved.text;
  if (Array.isArray(saved.words)) {
    state.words = saved.words
      .filter((w) => w && typeof w.word === 'string')
      .map((w) => ({ id: w.id || newId(), word: w.word, reading: w.reading || '', before: w.before || '', after: w.after || '', enabled: w.enabled !== false, manual: !!w.manual }));
  }
  if (saved.settings) {
    if (LEVELS[saved.settings.level]) state.settings.level = saved.settings.level;
    state.settings.checkOrder = !!saved.settings.checkOrder;
    state.settings.vertical = !!saved.settings.vertical;
    if (saved.settings.srcMode === 'text') state.settings.srcMode = 'text';
  }
}

// ---------- メッセージ ----------

function showMessage(text, kind = 'error') {
  $('message-text').textContent = text;
  $('message').className = 'message' + (kind === 'info' ? ' info' : '');
  $('message').hidden = false;
}

function hideMessage() {
  $('message').hidden = true;
}

function showScreen(name) {
  for (const s of ['setup', 'drill', 'result']) $('screen-' + s).hidden = s !== name;
  globalThis.scrollTo?.(0, 0);
}

// ---------- 1. 取り込み(写真) ----------

let ocrCanvas = null;
let photoImg = null;
let marker = null;

function setSrcMode(mode) {
  state.settings.srcMode = mode;
  $('mode-print').hidden = mode !== 'print';
  $('mode-text').hidden = mode !== 'text';
  for (const r of document.querySelectorAll('input[name="src-mode"]')) r.checked = r.value === mode;
  if (mode === 'print' && marker && marker.src) marker.layout();
  persist();
}

async function onPhotoSelected(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  hideMessage();
  $('btn-ocr').disabled = true;
  $('photo-status').textContent = '画像を準備しています…';
  try {
    const img = await loadImage(file);
    if (photoImg) URL.revokeObjectURL(photoImg.src);
    photoImg = img;
    // 問題プリント: なぞる画面に表示する
    $('marker-box').hidden = false;
    $('marker-tools').hidden = false;
    marker.setImage(img);
    // 文章: 画像全体の OCR 用に前処理しておく
    ocrCanvas = preprocess(img);
    $('ocr-preview').src = ocrCanvas.toDataURL('image/jpeg', 0.7);
    $('ocr-preview').hidden = false;
    $('ocr-status').textContent = '「文字を読み取る」を押してください。';
    $('btn-ocr').disabled = false;
    $('photo-status').textContent = `画像を読み込みました(${img.naturalWidth}×${img.naturalHeight})。`;
  } catch (err) {
    ocrCanvas = null;
    $('photo-status').textContent = '';
    showMessage(`${err.message}。文章を直接入力するか、貼り付けて続けられます。`);
  }
}

// ---------- 1a. 問題プリント: なぞった問題を読み取り、答えを選ぶ ----------

/** 読み取った問題 { text, sel: Set<文字の位置>, crop: dataURL, vertical, answers: Map<読み範囲, 答え>, cands: Map } */
let printItems = [];
let scorerPromise = null;

function updateMarkStatus() {
  if (!marker || !marker.src) {
    $('btn-read-marks').disabled = true;
    return;
  }
  if (marker.tool === 'box') {
    $('mark-status').textContent = marker.box
      ? '表の範囲を囲みました。「読み取る」を押してください。'
      : '問題の並んだ表を四角く囲んでください(囲まずに読み取ると、写真全体を表として読みます)。';
    $('btn-read-marks').disabled = false;
    return;
  }
  const n = marker.marks.length;
  $('mark-status').textContent = n ? `${n} 問をなぞりました。` : '読み取りたい問題を 1 問ずつなぞってください。';
  $('btn-read-marks').disabled = n === 0;
}

/** kuromoji による文の自然さ(候補の並べ替え)。辞書が読めなくても候補は出す */
function getScorer() {
  if (!scorerPromise) {
    scorerPromise = loadTokenizer()
      .then((t) => makeScorer(t))
      .catch(() => {
        scorerPromise = null;
        return null;
      });
  }
  return scorerPromise;
}

let commonPromise = null;
function getCommon() {
  if (!commonPromise) commonPromise = commonKanji().catch(() => ((commonPromise = null), null));
  return commonPromise;
}

async function onReadMarks() {
  if (!marker || !marker.src) return;
  const table = marker.tool === 'box';
  if (!table && !marker.marks.length) return;
  hideMessage();
  const btn = $('btn-read-marks');
  btn.disabled = true;
  getScorer(); // 辞書の読み込みを並行して始める
  try {
    let crops;
    if (table) {
      // 表: 罫線から 1 列ずつ切り出す(囲んでいなければ写真全体)
      $('mark-status').textContent = '表の罫線を探しています…';
      await new Promise((r) => setTimeout(r, 30)); // 表示を更新してから重い処理をする
      const rect = marker.box || { x: 0, y: 0, w: marker.src.width, h: marker.src.height };
      crops = extractTableColumns(marker.src, rect).crops;
      if (crops.length < 2) {
        showMessage('表の罫線(縦の線)が見つかりませんでした。表だけを囲み直すか、「1 問ずつなぞる」で読み取ってください。');
      }
    } else {
      crops = marker.crops();
    }
    const raw = await recognizeCrops(crops, { onProgress: (t) => ($('mark-status').textContent = t) });
    // カタカナに混ざった、形の似た字の読み違いを直す(力→カ、工→エ など)
    const lines = raw.map((l) => fixKatakana(l));
    const items = [];
    for (let i = 0; i < crops.length; i++) {
      const item = {
        id: newId(),
        text: lines[i],
        crop: crops[i].canvas.toDataURL('image/png'),
        vertical: crops[i].vertical,
        table, // 表の形式(書き取る部分がカタカナ)
        sel: new Set(),
        answers: new Map(),
        cands: new Map(),
      };
      await guessSelection(item);
      items.push(item);
    }
    printItems = items;
    $('mark-status').textContent = `${items.length} 問を読み取りました。書き取る部分(カタカナ・ひらがな)が選ばれているか、答えの漢字が正しいかを確かめてください。`;
    renderPrintItems();
  } catch (err) {
    $('mark-status').textContent = '';
    showMessage(`読み取れませんでした(${err.message || err})。下の「文章」に切り替えるか、語を手で追加して続けられます。`);
  } finally {
    btn.disabled = false;
  }
}

async function guessSelection(item) {
  item.sel = new Set();
  // 表の形式(書き取る部分がカタカナ)では、カタカナの並びをすべて選ぶ
  const runs = item.table ? katakanaRuns(item.text) : [];
  if (runs.length) {
    for (const [a, b] of runs) for (let k = a; k < b; k++) item.sel.add(k);
    return;
  }
  try {
    const range = await guessTarget(item.text, lookupBrowser);
    if (range) for (let k = range[0]; k < range[1]; k++) item.sel.add(k);
  } catch {
    /* 辞書が読めなくても、手で選べる */
  }
}

/** 選んだ文字の位置から、連続した範囲を取り出す */
function runsOf(item) {
  const chars = [...item.text];
  const idx = [...item.sel].filter((k) => k < chars.length).sort((a, b) => a - b);
  const runs = [];
  for (const k of idx) {
    const last = runs[runs.length - 1];
    if (last && last.end === k) last.end = k + 1;
    else runs.push({ start: k, end: k + 1 });
  }
  return runs.map((r) => ({
    ...r,
    key: `${r.start}-${r.end}`,
    reading: normalizeReading(chars.slice(r.start, r.end).join('')),
    before: chars.slice(0, r.start).join(''),
    after: chars.slice(r.end).join(''),
  }));
}

async function loadCandidates(item, run) {
  if (item.cands.has(run.key)) return;
  item.cands.set(run.key, null); // 読み込み中
  let list = [];
  try {
    const [score, common] = await Promise.all([getScorer(), getCommon()]);
    list = await candidates(run.reading, {
      lookup: lookupBrowser,
      score: score || undefined,
      common: common || undefined,
      // 読み取りの誤りが混ざりやすいので、文脈は前後 6 字までにする
      before: run.before.slice(-6),
      after: run.after.slice(0, 6),
    });
  } catch (err) {
    showMessage(`漢字の候補を出せませんでした(${err.message || err})。答えを手で入力してください。`);
  }
  item.cands.set(run.key, list);
  if (!item.answers.has(run.key) && list.length) item.answers.set(run.key, list[0]);
  renderPrintItems();
}

function renderPrintItems() {
  const ol = $('print-items');
  ol.textContent = '';
  printItems.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'pitem';
    li.dataset.id = item.id;

    const cropBox = document.createElement('div');
    cropBox.className = 'crop-box';
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = `${idx + 1}`;
    const img = document.createElement('img');
    img.className = 'crop' + (item.vertical ? '' : ' wide');
    img.src = item.crop;
    img.alt = `${idx + 1} 問目の切り出し画像`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn small';
    del.textContent = '削除';
    del.addEventListener('click', () => {
      printItems = printItems.filter((x) => x !== item);
      renderPrintItems();
    });
    cropBox.append(num, img, del);

    // 読み取った文(直せる)
    const lineRow = document.createElement('div');
    lineRow.className = 'pline-row';
    const line = document.createElement('input');
    line.className = 'pline';
    line.value = item.text;
    line.setAttribute('aria-label', `${idx + 1} 問目の読み取り結果`);
    line.addEventListener('change', async () => {
      item.text = line.value.replace(/\s+/g, '');
      item.answers.clear();
      item.cands.clear();
      await guessSelection(item);
      renderPrintItems();
    });
    lineRow.append(line);

    // 1 文字ずつのボタン(タップで書き取る部分を選ぶ)
    const chips = document.createElement('div');
    chips.className = 'chips';
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', '書き取る部分を選ぶ');
    [...item.text].forEach((ch, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (item.sel.has(k) ? ' on' : '');
      b.textContent = ch;
      b.setAttribute('aria-pressed', item.sel.has(k) ? 'true' : 'false');
      b.addEventListener('click', () => {
        if (item.sel.has(k)) item.sel.delete(k);
        else item.sel.add(k);
        renderPrintItems();
      });
      chips.appendChild(b);
    });

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = '書き取る部分(カタカナ・ひらがな)をタップして選んでください。';

    // 選んだ部分ごとの答え
    const answers = document.createElement('div');
    answers.className = 'answers';
    for (const run of runsOf(item)) {
      const box = document.createElement('div');
      box.className = 'answer';
      box.dataset.reading = run.reading;
      const rd = document.createElement('span');
      rd.className = 'rd';
      rd.textContent = `読み: ${run.reading || '(ひらがなを選んでください)'}`;
      box.appendChild(rd);
      if (run.reading) {
        const cands = item.cands.get(run.key);
        if (cands === undefined) loadCandidates(item, run);
        const cbox = document.createElement('div');
        cbox.className = 'cands';
        if (!cands) {
          cbox.textContent = '候補を探しています…';
        } else if (!cands.length) {
          cbox.textContent = '辞書に候補がありません。答えを入力してください。';
        }
        for (const c of cands || []) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn cand' + (item.answers.get(run.key) === c ? ' on' : '');
          b.textContent = c;
          b.addEventListener('click', () => {
            item.answers.set(run.key, c);
            renderPrintItems();
          });
          cbox.appendChild(b);
        }
        const ans = document.createElement('input');
        ans.className = 'ans';
        ans.value = item.answers.get(run.key) || '';
        ans.placeholder = '答えの漢字';
        ans.setAttribute('aria-label', `「${run.reading}」の答え`);
        ans.addEventListener('change', () => {
          item.answers.set(run.key, ans.value.trim());
          renderPrintItems();
        });
        box.append(cbox, ans);
        const a = item.answers.get(run.key);
        if (a && !hasKanji(a)) {
          const w = document.createElement('div');
          w.className = 'warn';
          w.textContent = '答えに漢字が入っていません';
          box.appendChild(w);
        }
      }
      answers.appendChild(box);
    }

    li.append(cropBox, lineRow, chips, hint, answers);
    ol.appendChild(li);
  });
  $('print-add-row').hidden = printItems.length === 0;
}

function onAddPrintWords() {
  let added = 0;
  for (const item of printItems) {
    for (const run of runsOf(item)) {
      const word = (item.answers.get(run.key) || '').trim();
      if (!run.reading || !hasKanji(word)) continue;
      if (state.words.some((w) => w.word === word && w.reading === run.reading)) continue;
      state.words.push({ id: newId(), word, reading: run.reading, before: run.before, after: run.after, enabled: true, manual: true });
      added++;
    }
  }
  persist();
  renderWordList();
  $('print-add-status').textContent = added ? `${added} 語を語の一覧に追加しました。` : '追加できる答えがありません(書き取る部分を選び、答えの漢字を確かめてください)。';
}

async function onOcr() {
  if (!ocrCanvas) return;
  hideMessage();
  $('btn-ocr').disabled = true;
  try {
    const text = await recognize(ocrCanvas, {
      vertical: state.settings.vertical,
      onProgress: (t) => ($('ocr-status').textContent = t),
    });
    if (!text.trim()) throw new Error('文字が見つかりませんでした');
    $('source').value = text;
    state.text = text;
    persist();
    $('ocr-status').textContent = '読み取りました。間違いがあれば直してから「語を取り出す」を押してください。';
  } catch (err) {
    $('ocr-status').textContent = '';
    showMessage(`文字を読み取れませんでした(${err.message || err})。文章を直接入力するか、貼り付けて続けられます。`);
    $('source').focus();
  } finally {
    $('btn-ocr').disabled = false;
  }
}

// ---------- 2. 語の取り出しと一覧 ----------

async function onExtract() {
  hideMessage();
  const text = $('source').value;
  state.text = text;
  if (!text.trim()) {
    showMessage('文章が空です。写真から読み取るか、文章を貼り付けてください。');
    return;
  }
  const btn = $('btn-extract');
  btn.disabled = true;
  $('extract-status').textContent = '辞書を読み込んでいます…(初回は少し時間がかかります)';
  try {
    const tokenizer = await loadTokenizer();
    $('extract-status').textContent = '解析しています…';
    const words = extractWords(text, tokenizer.tokenize(text));
    const manual = state.words.filter((w) => w.manual && !words.some((x) => x.word === w.word));
    state.words = [...words, ...manual];
    persist();
    renderWordList();
    $('extract-status').textContent = `${words.length} 語を取り出しました。`;
  } catch (err) {
    $('extract-status').textContent = '';
    showMessage(`語を取り出せませんでした(${err.message || err})。下の欄から語を手で追加することもできます。`);
  } finally {
    btn.disabled = false;
  }
}

function contextHtml(w) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  if (!w.before && !w.after) return '';
  return `${esc(w.before)}<mark>${esc(w.word)}</mark>${esc(w.after)}`;
}

function renderWordList() {
  const ul = $('word-list');
  ul.textContent = '';
  for (const w of state.words) {
    const li = document.createElement('li');
    li.className = w.enabled ? '' : 'off';
    li.dataset.id = w.id;
    li.dataset.word = w.word;

    const on = document.createElement('label');
    on.className = 'on';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = w.enabled;
    cb.setAttribute('aria-label', `「${w.word}」を出題する`);
    cb.addEventListener('change', () => {
      w.enabled = cb.checked;
      li.className = w.enabled ? '' : 'off';
      persist();
      updateCount();
    });
    on.appendChild(cb);

    const wi = document.createElement('input');
    wi.className = 'w';
    wi.value = w.word;
    wi.setAttribute('aria-label', '語');
    wi.addEventListener('change', () => {
      w.word = wi.value.trim();
      persist();
      renderWordList();
    });

    const ri = document.createElement('input');
    ri.className = 'r';
    ri.value = w.reading;
    ri.placeholder = '読みを入力';
    ri.setAttribute('aria-label', `「${w.word}」の読み`);
    ri.addEventListener('change', () => {
      w.reading = kataToHira(ri.value.trim());
      ri.value = w.reading;
      persist();
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn del';
    del.textContent = '×';
    del.setAttribute('aria-label', `「${w.word}」を一覧から消す`);
    del.addEventListener('click', () => {
      state.words = state.words.filter((x) => x !== w);
      persist();
      renderWordList();
    });

    li.append(on, wi, ri, del);
    const ctx = contextHtml(w);
    if (ctx) {
      const c = document.createElement('div');
      c.className = 'ctx';
      c.innerHTML = ctx;
      li.appendChild(c);
    }
    if (!hasKanji(w.word)) {
      const warn = document.createElement('div');
      warn.className = 'warn';
      warn.textContent = '漢字を含まないので出題しません';
      li.appendChild(warn);
    }
    ul.appendChild(li);
  }
  updateCount();
}

function updateCount() {
  const n = state.words.filter((w) => w.enabled && hasKanji(w.word)).length;
  $('word-count').textContent = `出題する語: ${n} / ${state.words.length}`;
  $('btn-start').disabled = n === 0;
}

function onAddWord(e) {
  e.preventDefault();
  const word = $('add-word').value.trim();
  const reading = kataToHira($('add-reading').value.trim());
  if (!word) return;
  if (!hasKanji(word)) {
    showMessage('漢字を含む語を入力してください。');
    return;
  }
  hideMessage();
  state.words.push({ id: newId(), word, reading, before: '', after: '', enabled: true, manual: true });
  $('add-word').value = '';
  $('add-reading').value = '';
  persist();
  renderWordList();
}

// ---------- 3. 出題 ----------

function shuffle(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

function startSession() {
  hideMessage();
  const ids = state.words.filter((w) => w.enabled && hasKanji(w.word)).map((w) => w.id);
  if (!ids.length) {
    showMessage('出題する語がありません。');
    return;
  }
  state.session = { history: [], round: 0 };
  startRound(ids);
}

function startRound(ids) {
  const s = state.session;
  s.round++;
  s.queue = shuffle(ids);
  s.index = 0;
  s.results = [];
  showScreen('drill');
  renderQuestion();
}

let pads = []; // 今の問題のマス { char, pad, tmpl, wrap, result }
let strokeOrder = []; // 一画戻す用: 書いた順のマス
let activeCell = null;
let current = null; // { word, judged, autoPass, manualPass, selfPending }

function wordById(id) {
  return state.words.find((w) => w.id === id);
}

function cellSize(segs) {
  const avail = Math.min($('cells').clientWidth || 800, 900);
  const nk = segs.filter((s) => s.kanji).length;
  const kanaChars = segs.filter((s) => !s.kanji).reduce((n, s) => n + [...s.text].length, 0);
  const kanaW = kanaChars * Math.min(64, avail * 0.08);
  const size = Math.floor((avail - kanaW - 8 * segs.length) / Math.max(1, nk));
  return Math.max(110, Math.min(260, size));
}

function setActive(cell) {
  activeCell = cell;
  for (const c of pads) c.wrap.classList.toggle('active', c === cell);
}

async function renderQuestion() {
  const s = state.session;
  const w = wordById(s.queue[s.index]);
  for (const c of pads) c.pad.destroy();
  pads = [];
  strokeOrder = [];
  current = { word: w, judged: false, autoPass: false, manualPass: false, selfPending: false, selfOk: null };

  $('progress').textContent = `${s.round} 回目 ${s.index + 1} / ${s.queue.length} 問`;
  $('reading').textContent = w.reading || '(読みなし)';
  const ctx = $('context');
  ctx.textContent = '';
  if (w.before || w.after) {
    const blank = document.createElement('span');
    blank.className = 'blank';
    blank.textContent = '　'.repeat(Math.max(2, [...w.word].length));
    ctx.append(w.before, blank, w.after);
  }
  $('screen-drill').dataset.word = w.word;
  $('verdict').hidden = true;
  $('tools').hidden = false;
  $('btn-judge').disabled = false;

  const segs = segments(w.word);
  const box = $('cells');
  box.textContent = '';
  const size = cellSize(segs);
  for (const seg of segs) {
    if (!seg.kanji) {
      const k = document.createElement('span');
      k.className = 'kana';
      k.textContent = seg.text;
      k.style.fontSize = Math.round(size * 0.42) + 'px';
      k.style.lineHeight = size + 'px';
      box.appendChild(k);
      continue;
    }
    const wrap = document.createElement('div');
    wrap.className = 'cell';
    wrap.dataset.char = seg.text;
    const canvas = document.createElement('canvas');
    canvas.className = 'pad';
    canvas.setAttribute('aria-label', `${pads.length + 1} 字目を書くマス`);
    wrap.appendChild(canvas);
    box.appendChild(wrap);
    const cell = { char: seg.text, wrap, tmpl: undefined, result: null };
    cell.pad = new Pad(canvas, {
      size,
      onStroke: (p) => {
        strokeOrder.push(cell);
        setActive(cell);
      },
    });
    canvas.addEventListener('pointerdown', () => setActive(cell));
    pads.push(cell);
  }
  setActive(pads[0] || null);

  // お手本を読み込む(なければ自己採点)
  const word = w;
  await Promise.all(
    pads.map(async (cell) => {
      try {
        cell.tmpl = await getStrokes(cell.char);
      } catch (err) {
        cell.tmpl = null;
        cell.loadError = true;
        showMessage(`お手本を読み込めませんでした(${err.message})。この字は自己採点にします。`);
      }
      if (current.word !== word) return;
      if (cell.tmpl === null) {
        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = '自己採点';
        cell.wrap.appendChild(note);
      }
    }),
  );
}

function onUndo() {
  if (!current || current.judged) return;
  while (strokeOrder.length) {
    const cell = strokeOrder.pop();
    if (cell.pad.undo()) {
      setActive(cell);
      return;
    }
  }
}

function onClear() {
  if (!current || current.judged || !activeCell) return;
  activeCell.pad.clear();
  strokeOrder = strokeOrder.filter((c) => c !== activeCell);
}

function onClearAll() {
  if (!current || current.judged) return;
  for (const c of pads) c.pad.clear();
  strokeOrder = [];
}

async function onJudge() {
  if (!current || current.judged) return;
  // お手本の読み込みを待つ
  if (pads.some((c) => c.tmpl === undefined)) {
    $('btn-judge').disabled = true;
    await new Promise((r) => setTimeout(r, 200));
    $('btn-judge').disabled = false;
    if (pads.some((c) => c.tmpl === undefined)) return onJudge();
  }
  current.judged = true;
  $('tools').hidden = true;
  const reasons = [];
  let allOk = true;
  let needSelf = false;
  for (const cell of pads) {
    cell.pad.locked = true;
    if (!cell.tmpl) {
      needSelf = true;
      const ans = document.createElement('div');
      ans.className = 'note';
      ans.textContent = `正解: ${cell.char}`;
      ans.style.fontSize = '28px';
      cell.wrap.appendChild(ans);
      continue;
    }
    const res = judge(cell.pad.strokes, cell.tmpl, {
      level: state.settings.level,
      checkOrder: state.settings.checkOrder,
      char: cell.char,
    });
    cell.result = res;
    const bad = res.reasons.filter((r) => r.stroke !== null && r.stroke !== undefined).map((r) => r.stroke);
    cell.pad.showMarks(bad);
    cell.wrap.classList.add(res.pass ? 'pass' : 'fail');
    if (!res.pass) allOk = false;
    for (const r of res.reasons) reasons.push({ bad: true, text: `「${cell.char}」${r.text}` });
    for (const n of res.notes) reasons.push({ bad: false, text: `「${cell.char}」${n}` });
    // お手本(筆画番号付き)を並べる
    const label = document.createElement('div');
    label.className = 'model-label';
    label.textContent = 'お手本';
    const model = document.createElement('canvas');
    model.className = 'model';
    model.setAttribute('aria-label', `「${cell.char}」のお手本`);
    cell.wrap.append(label, model);
    drawModel(model, cell.tmpl, cell.pad.size);
  }
  current.autoPass = allOk;
  current.selfPending = needSelf;

  const ul = $('reasons');
  ul.textContent = '';
  for (const r of reasons) {
    const li = document.createElement('li');
    li.textContent = r.text;
    if (r.bad) li.className = 'bad';
    ul.appendChild(li);
  }
  $('selfcheck').hidden = !needSelf;
  $('verdict').hidden = false;
  updateVerdict();
}

function wordPassed() {
  if (current.manualPass) return true;
  if (!current.autoPass) return false;
  if (current.selfPending) return current.selfOk === true;
  return true;
}

function updateVerdict() {
  const t = $('verdict-title');
  const pending = current.autoPass && current.selfPending && current.selfOk === null && !current.manualPass;
  if (pending) {
    t.textContent = '自己採点してください';
    t.className = 'verdict-title';
  } else if (wordPassed()) {
    t.textContent = current.manualPass ? '○ 合格(手動)' : '○ 合格';
    t.className = 'verdict-title ok';
  } else {
    t.textContent = '× 不合格';
    t.className = 'verdict-title ng';
  }
  $('btn-override').hidden = wordPassed();
  $('btn-next').disabled = pending;
}

function onSelf(ok) {
  current.selfOk = ok;
  $('selfcheck').hidden = true;
  updateVerdict();
}

function onOverride() {
  current.manualPass = true;
  updateVerdict();
}

function onNext() {
  const s = state.session;
  s.results.push({ id: current.word.id, pass: wordPassed() });
  s.index++;
  if (s.index < s.queue.length) renderQuestion();
  else finishRound();
}

function finishRound() {
  const s = state.session;
  const correct = s.results.filter((r) => r.pass).length;
  s.history.push({ round: s.round, total: s.results.length, correct });
  s.wrong = s.results.filter((r) => !r.pass).map((r) => r.id);
  for (const c of pads) c.pad.destroy();
  pads = [];
  current = null;

  $('score').textContent =
    s.wrong.length === 0
      ? `全問正解です!(${correct} / ${s.results.length})`
      : `${s.results.length} 問中 ${correct} 問正解`;
  const ul = $('wrong-list');
  ul.textContent = '';
  for (const id of s.wrong) {
    const w = wordById(id);
    const li = document.createElement('li');
    li.textContent = w.word;
    const rd = document.createElement('span');
    rd.className = 'rd';
    rd.textContent = w.reading;
    li.appendChild(rd);
    ul.appendChild(li);
  }
  $('wrong-box').hidden = s.wrong.length === 0;
  $('btn-retry').hidden = s.wrong.length === 0;
  const tb = $('history').querySelector('tbody');
  tb.textContent = '';
  for (const h of s.history) {
    const tr = document.createElement('tr');
    for (const v of [`${h.round} 回目`, h.total, h.correct, `${Math.round((h.correct / h.total) * 100)}%`]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
  showScreen('result');
}

// ---------- 初期化 ----------

function bindSettings() {
  for (const r of document.querySelectorAll('input[name="level"]')) {
    r.checked = r.value === state.settings.level;
    r.addEventListener('change', () => {
      if (r.checked) state.settings.level = r.value;
      persist();
    });
  }
  for (const r of document.querySelectorAll('input[name="dir"]')) {
    r.checked = (r.value === 'v') === state.settings.vertical;
    r.addEventListener('change', () => {
      if (r.checked) state.settings.vertical = r.value === 'v';
      persist();
    });
  }
  const co = $('check-order');
  co.checked = state.settings.checkOrder;
  co.addEventListener('change', () => {
    state.settings.checkOrder = co.checked;
    persist();
  });
}

function init() {
  restore();
  $('source').value = state.text;
  $('source').addEventListener('input', () => {
    state.text = $('source').value;
    persist();
  });
  bindSettings();
  renderWordList();

  $('message-close').addEventListener('click', hideMessage);
  $('photo').addEventListener('change', onPhotoSelected);
  $('btn-ocr').addEventListener('click', onOcr);

  // 問題プリント(なぞって選ぶ)
  marker = new Marker($('marker-canvas'), { onChange: updateMarkStatus });
  for (const r of document.querySelectorAll('input[name="src-mode"]')) {
    r.addEventListener('change', () => r.checked && setSrcMode(r.value));
  }
  setSrcMode(state.settings.srcMode);
  for (const r of document.querySelectorAll('input[name="finger"]')) {
    r.addEventListener('change', () => r.checked && marker.setMode(r.value));
  }
  for (const r of document.querySelectorAll('input[name="brush"]')) {
    r.addEventListener('change', () => r.checked && (marker.brush = r.value));
  }
  $('btn-zoom-in').addEventListener('click', () => marker.setZoom(marker.zoom * 1.5));
  $('btn-zoom-out').addEventListener('click', () => marker.setZoom(marker.zoom / 1.5));
  $('btn-rotate').addEventListener('click', () => marker.rotate());
  $('btn-mark-undo').addEventListener('click', () => marker.undo());
  $('btn-mark-clear').addEventListener('click', () => marker.clear());
  for (const r of document.querySelectorAll('input[name="tool"]')) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      marker.setTool(r.value);
      $('brush-seg').hidden = r.value !== 'trace'; // 線の太さは、なぞるときだけ使う
    });
  }
  $('btn-read-marks').addEventListener('click', onReadMarks);
  $('btn-add-print').addEventListener('click', onAddPrintWords);
  let resizeTimer = null;
  globalThis.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => marker.src && !$('mode-print').hidden && marker.layout(), 200);
  });
  $('btn-extract').addEventListener('click', onExtract);
  $('btn-all').addEventListener('click', () => {
    for (const w of state.words) w.enabled = true;
    persist();
    renderWordList();
  });
  $('btn-none').addEventListener('click', () => {
    for (const w of state.words) w.enabled = false;
    persist();
    renderWordList();
  });
  $('add-form').addEventListener('submit', onAddWord);
  $('btn-start').addEventListener('click', startSession);

  $('btn-undo').addEventListener('click', onUndo);
  $('btn-clear').addEventListener('click', onClear);
  $('btn-clear-all').addEventListener('click', onClearAll);
  $('btn-judge').addEventListener('click', onJudge);
  $('btn-self-ok').addEventListener('click', () => onSelf(true));
  $('btn-self-ng').addEventListener('click', () => onSelf(false));
  $('btn-override').addEventListener('click', onOverride);
  $('btn-next').addEventListener('click', onNext);
  $('btn-quit').addEventListener('click', () => {
    for (const c of pads) c.pad.destroy();
    pads = [];
    current = null;
    showScreen('setup');
  });

  $('btn-retry').addEventListener('click', () => startRound(state.session.wrong));
  $('btn-restart').addEventListener('click', startSession);
  $('btn-setup').addEventListener('click', () => {
    renderWordList();
    showScreen('setup');
  });

  document.body.dataset.ready = '1';
}

init();
