// 語の取り出しと読みの付与(kuromoji.js)。
// extractWords などの純粋な関数は DOM に依存しないので、Node でテストできる。

const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々〆〇]/;
const SKIP_POS = new Set(['助詞', '助動詞', '記号']);
const SENTENCE_END = /[。！？!?\n]/;
const CONTEXT_MAX = 24;

export function isKanji(ch) {
  return KANJI_RE.test(ch);
}

export function hasKanji(s) {
  return KANJI_RE.test(s);
}

/** カタカナ → ひらがな */
export function kataToHira(s) {
  return (s || '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** 語を「漢字 1 字ずつ」と「仮名などのかたまり」に分ける。覚える → [覚][える] */
export function segments(word) {
  const out = [];
  for (const ch of word) {
    if (isKanji(ch)) out.push({ kanji: true, text: ch });
    else if (out.length && !out[out.length - 1].kanji) out[out.length - 1].text += ch;
    else out.push({ kanji: false, text: ch });
  }
  return out;
}

/** 文の範囲 [start, end) */
function sentenceRange(text, pos) {
  let s = pos;
  while (s > 0 && !SENTENCE_END.test(text[s - 1])) s--;
  let e = pos;
  while (e < text.length && !SENTENCE_END.test(text[e])) e++;
  if (e < text.length && text[e] !== '\n') e++; // 句点は文に含める
  return [s, e];
}

let seq = 0;
export function newId() {
  seq = (seq + 1) % 1e6;
  return Date.now().toString(36) + '-' + seq.toString(36);
}

/**
 * 形態素解析の結果から、漢字を含む語を取り出す。
 * @param {string} text 元の文章
 * @param {Array} tokens kuromoji のトークン(surface_form, pos, reading, word_position)
 * @returns {{id: string, word: string, reading: string, before: string, after: string, enabled: boolean}[]}
 */
export function extractWords(text, tokens) {
  const seen = new Set();
  const words = [];
  let cursor = 0;
  for (const t of tokens) {
    const surface = t.surface_form;
    // word_position は 1 始まり。無い場合は先頭から探す。
    let pos = typeof t.word_position === 'number' ? t.word_position - 1 : text.indexOf(surface, cursor);
    if (pos < 0 || text.substr(pos, surface.length) !== surface) pos = text.indexOf(surface, cursor);
    if (pos >= 0) cursor = pos + surface.length;
    if (!hasKanji(surface) || SKIP_POS.has(t.pos)) continue;
    if (seen.has(surface)) continue;
    seen.add(surface);
    let before = '', after = '';
    if (pos >= 0) {
      const [s, e] = sentenceRange(text, pos);
      before = text.slice(Math.max(s, pos - CONTEXT_MAX), pos).trim();
      after = text.slice(pos + surface.length, Math.min(e, pos + surface.length + CONTEXT_MAX)).trim();
    }
    const reading = t.reading && t.reading !== '*' ? kataToHira(t.reading) : '';
    words.push({ id: newId(), word: surface, reading, before, after, enabled: true });
  }
  return words;
}

/** OCR の結果などから、日本語の文字の間に入った余計な空白を取り除く */
export function cleanText(text) {
  return (text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/([^\x00-\x7F])[ \t　]+(?=[^\x00-\x7F])/g, '$1').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * なぞって読み取った 1 行から、日本語の文字(仮名・漢字・長音・々・句読点)だけを残す。
 * 傍線・括弧・枠線が「|」「【」「-」などとして混ざるので取り除く。
 */
export function cleanLine(text) {
  return (text || '')
    .replace(/[^ぁ-ゖァ-ヺー㐀-䶿一-鿿々〆〇、。]/g, '')
    .replace(/^[、。ー]+/, '');
}

// ---------- ブラウザ用: kuromoji の読み込み ----------

let tokenizerPromise = null;

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.dataset.src = src;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error(`${src} を読み込めませんでした(通信を確認してください)`));
    };
    document.head.appendChild(s);
  });
}

/**
 * kuromoji の辞書を読み込む。dicPath は必ず相対パスにする
 * (絶対 URL を渡すと、内部の path.join で「https:/」に壊れる)。
 */
export function loadTokenizer(dicPath = 'vendor/kuromoji/dict/') {
  if (!tokenizerPromise) {
    tokenizerPromise = loadScript('vendor/kuromoji/kuromoji.js')
      .then(
        () =>
          new Promise((resolve, reject) => {
            globalThis.kuromoji.builder({ dicPath }).build((err, tokenizer) => {
              if (err) reject(new Error('辞書を読み込めませんでした: ' + (err.message || err)));
              else resolve(tokenizer);
            });
          }),
      )
      .catch((e) => {
        tokenizerPromise = null; // 次回やり直せるように
        throw e;
      });
  }
  return tokenizerPromise;
}
