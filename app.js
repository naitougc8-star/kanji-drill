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
import { migrate, wordsOf, photoCount, addWords, groupsOf, createSet, deleteSet } from './sets.js';
import { makeBackup, backupFileName, parseBackup, mergeBackup, dataSize, formatSize, STORAGE_LIMIT } from './backup.js';

const $ = (id) => document.getElementById(id);

const state = {
  text: '',
  words: [],
  sets: [], // テスト(出題の範囲)
  currentSet: null, // 選んでいるテスト
  settings: { level: DEFAULT_LEVEL, checkOrder: false, vertical: false, srcMode: 'print', theme: 'auto' },
  session: null,
};

// ---------- 保存 ----------

function persist() {
  const ok = storage.save({ text: state.text, words: state.words, sets: state.sets, currentSet: state.currentSet, settings: state.settings });
  if (!ok && !persist.warned) {
    persist.warned = true;
    showMessage('この端末に保存できませんでした(保存領域がいっぱいか、プライベートブラウズかもしれません)。「書き出す」でバックアップを取り、古いテストを削除してください。');
  }
  if (typeof renderStorage === 'function') renderStorage();
}

function restore() {
  restoreSaved();
  // テストがなければ「テスト 1」を作り、これまでの語をすべて入れる
  const m = migrate({ sets: state.sets, words: state.words, currentSet: state.currentSet });
  state.sets = m.sets;
  state.words = m.words;
  state.currentSet = m.currentSet;
}

function restoreSaved() {
  const saved = storage.load();
  if (!saved) return;
  if (typeof saved.text === 'string') state.text = saved.text;
  if (Array.isArray(saved.words)) {
    state.words = saved.words
      .filter((w) => w && typeof w.word === 'string')
      .map((w) => ({
        id: w.id || newId(),
        word: w.word,
        reading: w.reading || '',
        before: w.before || '',
        after: w.after || '',
        enabled: w.enabled !== false,
        manual: !!w.manual,
        result: w.result === 'pass' || w.result === 'fail' ? w.result : null, // 最後に出題したときの結果
        misses: Number.isInteger(w.misses) ? w.misses : w.result === 'fail' ? 1 : 0, // 続けて間違えた回数
        passedAt: Number.isInteger(w.passedAt) ? w.passedAt : null, // 何回目で合格したか
        setId: w.setId, // どのテストか
        updatedAt: Number(w.updatedAt) || 0, // 最後に変更した時刻(ほかの端末のデータと合わせるときに使う)
        photo: Number.isInteger(w.photo) ? w.photo : w.photo === null ? null : undefined, // テストの中の何枚目の写真か
      }));
  }
  if (Array.isArray(saved.sets)) state.sets = saved.sets;
  if (typeof saved.currentSet === 'string') state.currentSet = saved.currentSet;
  if (saved.settings) {
    if (LEVELS[saved.settings.level]) state.settings.level = saved.settings.level;
    else if (saved.settings.level === 'extreme') state.settings.level = 'severe'; // 超シビアはなくなったので、シビアにする
    if (['auto', 'light', 'dark'].includes(saved.settings.theme)) state.settings.theme = saved.settings.theme;
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
  const entries = [];
  for (const item of printItems) {
    for (const run of runsOf(item)) {
      const word = (item.answers.get(run.key) || '').trim();
      if (!run.reading || !hasKanji(word)) continue;
      entries.push({ word, reading: run.reading, before: run.before, after: run.after });
    }
  }
  // 写真 1 枚分として、選んでいるテストに入れる
  const added = entries.length ? addWords(state.words, state.currentSet, entries, 'photo') : 0;
  persist();
  renderWordList();
  $('print-add-status').textContent = added ? `${added} 語を語の一覧に追加しました(「${currentSetName()}」)。` : '追加できる答えがありません(書き取る部分を選び、答えの漢字を確かめてください)。';
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
    const added = addWords(state.words, state.currentSet, words, 'photo');
    persist();
    renderWordList();
    $('extract-status').textContent = `${words.length} 語を取り出しました。${addedText(added)}`;
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

/** 選んでいるテストの語を、写真ごとのまとまりに分けて表示する */
function renderWordList() {
  renderSets();
  const box = $('word-list');
  box.textContent = '';
  for (const g of groupsOf(state.words, state.currentSet)) {
    box.append(groupHead(g));
    const ul = document.createElement('ul');
    ul.dataset.group = g.key;
    for (const w of g.words) ul.appendChild(wordRow(w));
    box.appendChild(ul);
  }
  updateCount();
}

/** 写真ごとのまとまりの見出し(まとめて出題する・しない、まとめて削除) */
function groupHead(g) {
  const head = document.createElement('div');
  head.className = 'group-head';
  head.dataset.group = g.key;
  const name = document.createElement('span');
  name.className = 'gname';
  name.textContent = g.label;
  const count = document.createElement('span');
  count.className = 'gcount';
  count.textContent = `${g.words.length} 語`;
  const on = document.createElement('label');
  on.className = 'check';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = g.words.every((w) => w.enabled);
  cb.indeterminate = !cb.checked && g.words.some((w) => w.enabled);
  cb.setAttribute('aria-label', `${g.label}の語をまとめて出題する`);
  cb.addEventListener('change', () => {
    for (const w of g.words) {
      w.enabled = cb.checked;
      w.updatedAt = Date.now();
    }
    persist();
    renderWordList();
  });
  const t = document.createElement('span');
  t.textContent = '出題する';
  on.append(cb, t);
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn small';
  del.textContent = 'まとめて削除';
  del.addEventListener('click', () => {
    if (!globalThis.confirm(`${g.label}の ${g.words.length} 語を、このテストから削除しますか?`)) return;
    const ids = new Set(g.words.map((w) => w.id));
    state.words = state.words.filter((w) => !ids.has(w.id));
    persist();
    renderWordList();
  });
  head.append(name, count, on, del);
  return head;
}

function rowClass(w) {
  return [w.enabled ? '' : 'off', `res-${statusOf(w)}`].join(' ').trim();
}

function wordRow(w) {
  const li = document.createElement('li');
  li.className = rowClass(w);
  li.dataset.id = w.id;
  li.dataset.word = w.word;
  li.dataset.result = statusOf(w);

  const on = document.createElement('label');
  on.className = 'on';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = w.enabled;
  cb.setAttribute('aria-label', `「${w.word}」を出題する`);
  cb.addEventListener('change', () => {
    w.enabled = cb.checked;
    w.updatedAt = Date.now();
    li.className = rowClass(w);
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
    w.updatedAt = Date.now();
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
    w.updatedAt = Date.now();
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
  // 2 行目: 合格・不合格の印と、文脈
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.appendChild(resultBadge(w));
  const ctx = contextHtml(w);
  if (ctx) {
    const c = document.createElement('span');
    c.className = 'ctx';
    c.innerHTML = ctx;
    meta.appendChild(c);
  }
  li.appendChild(meta);
  if (!hasKanji(w.word)) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent = '漢字を含まないので出題しません';
    li.appendChild(warn);
  }
  return li;
}

// 色分けの区分: 合格(緑)・1 回まちがい(黄)・2 回まちがい(オレンジ)・3 回以上まちがい(赤)・未出題(灰)
const STATUS_ORDER = ['pass', 'fail1', 'fail2', 'fail3', 'none'];
// 集計の表記(語の一覧の印は statusText で「× 2 回まちがい」「○ 3 回目で合格」のように出す)
const STATUS_LABEL = { pass: '○ 合格', fail1: '× 1 回まちがい', fail2: '× 2 回まちがい', fail3: '× 3 回以上', none: '未出題' };

/** 語の区分。まだ合格していない語は、続けて間違えた回数で分ける */
function statusOf(w) {
  if (w.result === 'pass') return 'pass';
  if (w.result === 'fail') return w.misses >= 3 ? 'fail3' : w.misses === 2 ? 'fail2' : 'fail1';
  return 'none';
}

/** 語の区分の説明(例:「○ 3 回目で合格」「× 2 回まちがい」) */
function statusText(w) {
  const s = statusOf(w);
  if (s === 'pass') return w.passedAt ? `○ ${w.passedAt} 回目で合格` : '○ 合格';
  if (s === 'none') return '未出題';
  return `× ${w.misses || 1} 回まちがい`;
}

function resultBadge(w) {
  const b = document.createElement('span');
  b.className = `res ${statusOf(w)}`;
  b.textContent = statusText(w);
  return b;
}

/** 出題の結果を語に記録する(保存される) */
function recordResult(w, pass) {
  w.updatedAt = Date.now();
  if (pass) {
    // 合格した回目(続けて間違えた回数 + 1)。合格のまま再び合格したときは、最初に合格した回目を残す
    if (w.result !== 'pass') w.passedAt = (w.misses || 0) + 1;
    w.misses = 0;
    w.result = 'pass';
  } else {
    w.misses = (w.result === 'fail' ? w.misses || 1 : 0) + 1;
    w.result = 'fail';
  }
}

/** 出題できる語(チェックが入っていて、漢字を含む) */
/** 選んでいるテストの語 */
function setWords() {
  return wordsOf(state.words, state.currentSet);
}

/** 出題できる語(選んでいるテストの中で、チェックが入っていて、漢字を含む) */
function playable() {
  return setWords().filter((w) => w.enabled && hasKanji(w.word));
}

function currentSetName() {
  const set = state.sets.find((x) => x.id === state.currentSet);
  return set ? set.name : '';
}

/** 追加した結果の文(どのテストの、何枚目の写真か) */
function addedText(added) {
  if (!added) return 'このテストに新しく追加する語はありませんでした(同じ語がもう入っています)。';
  return `「${currentSetName()}」に ${added} 語を追加しました。`;
}

/** テストの選択欄と、テストの情報を表示する */
function renderSets() {
  const sel = $('set-select');
  sel.textContent = '';
  for (const set of state.sets) {
    const o = document.createElement('option');
    o.value = set.id;
    o.textContent = `${set.name}(${wordsOf(state.words, set.id).length} 語)`;
    sel.appendChild(o);
  }
  sel.value = state.currentSet;
  const n = setWords().length, photos = photoCount(state.words, state.currentSet);
  $('set-info').textContent = `「${currentSetName()}」: ${n} 語(写真 ${photos} 枚)`;
  $('set-name-inline').textContent = `「${currentSetName()}」`;
  $('btn-set-delete').disabled = false;
  renderStorage();
}

function onSetChange() {
  state.currentSet = $('set-select').value;
  printItems = [];
  renderPrintItems();
  persist();
  renderWordList();
}

function onSetNew() {
  const name = globalThis.prompt('新しいテストの名前(例: 1 学期 中間テスト)', `テスト ${state.sets.length + 1}`);
  if (name === null) return;
  const set = createSet(state.sets, name);
  state.currentSet = set.id;
  printItems = [];
  renderPrintItems();
  persist();
  renderWordList();
}

function onSetRename() {
  const set = state.sets.find((x) => x.id === state.currentSet);
  const name = globalThis.prompt('テストの名前', set.name);
  if (name === null || !name.trim()) return;
  set.name = name.trim();
  set.updatedAt = Date.now();
  persist();
  renderWordList();
}

function onSetDelete() {
  const n = setWords().length;
  if (!globalThis.confirm(`「${currentSetName()}」と、その中の ${n} 語(成績も)を削除しますか? 元に戻せません。`)) return;
  const r = deleteSet(state.sets, state.words, state.currentSet);
  state.sets = r.sets;
  state.words = r.words;
  state.currentSet = r.currentSet;
  printItems = [];
  renderPrintItems();
  persist();
  renderWordList();
}

function updateCount() {
  const list = playable();
  const n = list.length;
  const wrong = list.filter((w) => w.result === 'fail').length;
  $('word-count').textContent = `出題する語: ${n} / ${setWords().length}`;
  $('btn-start').disabled = n === 0;
  $('btn-start').textContent = `全問出題する(${n} 語)`;
  $('btn-start-wrong').disabled = wrong === 0;
  $('btn-start-wrong').textContent = `不合格の語だけ出題する(${wrong} 語)`;
  const fresh = list.filter((w) => !w.result).length;
  $('btn-start-new').disabled = fresh === 0;
  $('btn-start-new').textContent = `未出題の語だけ出題する(${fresh} 語)`;
  // 区分ごとの集計(すべての語)
  const count = Object.fromEntries(STATUS_ORDER.map((k) => [k, 0]));
  for (const w of setWords()) if (hasKanji(w.word)) count[statusOf(w)]++;
  const sum = $('result-summary');
  sum.textContent = '';
  for (const key of STATUS_ORDER) {
    if (key.startsWith('fail') && count[key] === 0) continue; // 0 語のまちがいの区分は出さない
    const b = document.createElement('span');
    b.className = `res ${key}`;
    b.dataset.status = key;
    b.textContent = `${STATUS_LABEL[key]} ${count[key]} 語`;
    sum.appendChild(b);
  }
  $('btn-reset-results').disabled = count.none === setWords().filter((w) => hasKanji(w.word)).length;
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
  if (!addWords(state.words, state.currentSet, [{ word, reading }], 'manual')) {
    showMessage('この語は、このテストにもう入っています。', 'info');
  }
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

/**
 * 出題を始める。
 * @param {'all' | 'wrong' | 'new'} which 全問 / 前回不合格だった語だけ / まだ出題していない語だけ
 */
function startSession(which = 'all') {
  hideMessage();
  const ids = playable()
    .filter((w) => (which === 'wrong' ? w.result === 'fail' : which === 'new' ? !w.result : true))
    .map((w) => w.id);
  if (!ids.length) {
    showMessage({ wrong: '不合格の語はありません。', new: '未出題の語はありません。' }[which] || '出題する語がありません。');
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

  $('progress').textContent = `「${currentSetName()}」 ${s.round} 回目 ${s.index + 1} / ${s.queue.length} 問`;
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
  const pass = wordPassed();
  s.results.push({ id: current.word.id, pass });
  recordResult(current.word, pass); // 語の一覧の色分けに使う(保存する)
  persist();
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
  // この回の全問を、合格は緑・不合格は赤で並べる(不合格を先に)
  const ul = $('round-list');
  ul.textContent = '';
  const ordered = [...s.results.filter((r) => !r.pass), ...s.results.filter((r) => r.pass)];
  for (const r of ordered) {
    const w = wordById(r.id);
    const li = document.createElement('li');
    li.className = statusOf(w);
    li.dataset.word = w.word;
    li.textContent = `${r.pass ? '○' : '×'} ${w.word}`;
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = statusText(w).replace(/^[○×] /, '');
    li.appendChild(st);
    const rd = document.createElement('span');
    rd.className = 'rd';
    rd.textContent = w.reading;
    li.appendChild(rd);
    ul.appendChild(li);
  }
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

// ---------- 4. バックアップ・ほかの端末と共有 ----------

function setBackupStatus(text) {
  $('backup-status').textContent = text;
}

/** 保存しているデータの量を表示する(多くなったら知らせる) */
function renderStorage() {
  const size = dataSize({ sets: state.sets, words: state.words });
  const pct = Math.round((size / STORAGE_LIMIT) * 100);
  const el = $('storage-info');
  el.textContent =
    `この端末に保存しているデータ: ${formatSize(size)}(テスト ${state.sets.length} 件・${state.words.length} 語。保存できる量の目安 約 5 MB の ${pct}%)。` +
    (pct >= 60 ? '多くなってきました。書き出してから、使い終わったテストを削除すると軽くなります。' : '');
  el.classList.toggle('warn-text', pct >= 60);
}

/** すべてのテストをファイルに書き出す(iPad / iPhone では共有メニューから AirDrop や「ファイル」に保存できる) */
async function onExport() {
  hideMessage();
  const name = backupFileName();
  const file = new File([JSON.stringify(makeBackup(state.sets, state.words))], name, { type: 'application/json' });
  const summary = `テスト ${state.sets.length} 件・${state.words.length} 語`;
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: '漢字書き取りドリルのバックアップ' });
      setBackupStatus(`${name} を書き出しました(${summary})。`);
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      setBackupStatus('書き出しをやめました。');
      return;
    }
    // 共有できなかったときは、ファイルとして保存する
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setBackupStatus(`${name} を保存しました(${summary})。`);
}

/** バックアップのファイルを読み込む。mode: 'merge'(合わせる)| 'replace'(置き換える) */
async function onImport(e, mode) {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = ''; // 同じファイルをもう一度選べるように
  if (!file) return;
  hideMessage();
  try {
    const inc = parseBackup(await file.text());
    let message;
    if (mode === 'replace') {
      const ok = globalThis.confirm(
        `この端末のテストと語(テスト ${state.sets.length} 件・${state.words.length} 語)を、` +
          `ファイルの内容(テスト ${inc.sets.length} 件・${inc.words.length} 語)に置き換えますか? 元に戻せません。`,
      );
      if (!ok) return;
      applyData(inc.sets, inc.words);
      message = `置き換えました(テスト ${inc.sets.length} 件・${inc.words.length} 語)。`;
    } else {
      // はじめて使う端末の、空の「テスト 1」だけなら、ファイルのテストに入れ替える
      const fresh = state.sets.length === 1 && state.words.length === 0;
      const base = fresh ? { sets: [], words: [] } : { sets: state.sets, words: state.words };
      const r = mergeBackup(base, inc);
      applyData(r.sets, r.words);
      message = `合わせました: テスト ${r.addedSets} 件と語 ${r.addedWords} 語を追加し、${r.updatedWords} 語を新しい方の成績に更新しました。`;
    }
    persist();
    renderWordList();
    setBackupStatus(message);
  } catch (err) {
    setBackupStatus('');
    showMessage(`読み込めませんでした(${err.message || err})。`);
  }
}

function applyData(sets, words) {
  const m = migrate({ sets, words, currentSet: state.currentSet });
  state.sets = m.sets;
  state.words = m.words;
  state.currentSet = m.currentSet;
  printItems = [];
  renderPrintItems();
}

// ---------- 初期化 ----------

/** 画面の表示(自動 / ライト / ダーク)を当てる */
function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

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
  for (const r of document.querySelectorAll('input[name="theme"]')) {
    r.checked = r.value === state.settings.theme;
    r.addEventListener('change', () => {
      if (!r.checked) return;
      state.settings.theme = r.value;
      applyTheme();
      persist();
    });
  }
  applyTheme();
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
    for (const w of setWords()) {
      w.enabled = true;
      w.updatedAt = Date.now();
    }
    persist();
    renderWordList();
  });
  $('btn-none').addEventListener('click', () => {
    for (const w of setWords()) {
      w.enabled = false;
      w.updatedAt = Date.now();
    }
    persist();
    renderWordList();
  });
  $('add-form').addEventListener('submit', onAddWord);
  $('set-select').addEventListener('change', onSetChange);
  $('btn-set-new').addEventListener('click', onSetNew);
  $('btn-set-rename').addEventListener('click', onSetRename);
  $('btn-set-delete').addEventListener('click', onSetDelete);
  $('btn-export').addEventListener('click', onExport);
  $('import-merge').addEventListener('change', (e) => onImport(e, 'merge'));
  $('import-replace').addEventListener('change', (e) => onImport(e, 'replace'));
  $('btn-start').addEventListener('click', () => startSession('all'));
  $('btn-start-wrong').addEventListener('click', () => startSession('wrong'));
  $('btn-start-new').addEventListener('click', () => startSession('new'));
  $('btn-reset-results').addEventListener('click', () => {
    if (!globalThis.confirm(`「${currentSetName()}」の合格・不合格の記録をすべて消しますか?`)) return;
    for (const w of setWords()) {
      w.result = null;
      w.misses = 0;
      w.passedAt = null;
      w.updatedAt = Date.now();
    }
    persist();
    renderWordList();
  });

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
    renderWordList(); // 途中までの合格・不合格を一覧に反映する
    showScreen('setup');
  });

  $('btn-retry').addEventListener('click', () => startRound(state.session.wrong));
  $('btn-restart').addEventListener('click', () => startSession('all'));
  $('btn-setup').addEventListener('click', () => {
    renderWordList();
    showScreen('setup');
  });

  document.body.dataset.ready = '1';
}

init();
