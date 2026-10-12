// しきい値の検証: 模擬の手書きで、合格率と、紛らわしい字の誤合格率を測って表にする。
//   node scripts/calibrate.mjs [試行回数=20]
import { judge, LEVELS } from '../judge.js';
import { simulate, rng, NOISE, loadTemplate, GRADE12, CONFUSABLE_SAME, CONFUSABLE_COUNT } from '../tests/simulate.js';

const TRIALS = Number(process.argv[2] || 20);
const pct = (x) => (x * 100).toFixed(1) + '%';
const levels = Object.keys(LEVELS);

function passRate(chars, level, noise, trials, seed) {
  const r = rng(seed);
  let pass = 0, total = 0;
  for (const ch of chars) {
    const t = loadTemplate(ch);
    for (let k = 0; k < trials; k++) {
      total++;
      if (judge(simulate(t, noise, r), t, { level, char: ch }).pass) pass++;
    }
  }
  return pass / total;
}

function falsePass(a, b, level, trials, seed = 7) {
  const r = rng(seed);
  const ta = loadTemplate(a), tb = loadTemplate(b);
  let pass = 0;
  for (let k = 0; k < trials; k++) if (judge(simulate(ta, NOISE.normal, r), tb, { level, char: b }).pass) pass++;
  return pass / trials;
}

const out = [];
out.push(`教育漢字 1・2 年の ${GRADE12.length} 字 × 各 ${TRIALS} 回(正しい字の合格率)`);
out.push('');
out.push(`| ゆらぎ | ${levels.map((l) => LEVELS[l].label).join(' | ')} |`);
out.push(`|---|${levels.map(() => '---:').join('|')}|`);
for (const nz of Object.keys(NOISE)) {
  out.push(`| ${NOISE[nz].label} | ${levels.map((l) => pct(passRate([...GRADE12], l, NOISE[nz], TRIALS, 1))).join(' | ')} |`);
}
out.push('');
out.push('紛らわしいペアの誤合格率(左の字を「ふつう」のゆらぎで書いて、右の字として判定。各 200 回)');
out.push('');
out.push(`| 書いた字 → 判定する字 | ${levels.map((l) => LEVELS[l].label).join(' | ')} |`);
out.push(`|---|${levels.map(() => '---:').join('|')}|`);
for (const [a, b] of CONFUSABLE_SAME) {
  for (const [x, y] of [[a, b], [b, a]]) {
    out.push(`| ${x} → ${y} | ${levels.map((l) => pct(falsePass(x, y, l, 200))).join(' | ')} |`);
  }
}
let countFail = 0, countTotal = 0;
for (const [a, b] of CONFUSABLE_COUNT) for (const [x, y] of [[a, b], [b, a]]) for (const l of levels) {
  countTotal++;
  if (falsePass(x, y, l, 50, 3) > 0) countFail++;
}
out.push(`| 画数が違うペア(${CONFUSABLE_COUNT.map((p) => p.join('↔')).join('、')}) | ${countFail === 0 ? '全て 0%' : '誤合格あり'} | | |`);
out.push('');
out.push('字ごとのルールがある字の、正しく書いたときの合格率(ふつう、各 200 回)');
out.push('');
out.push(`| 字 | ${levels.map((l) => LEVELS[l].label).join(' | ')} |`);
out.push(`|---|${levels.map(() => '---:').join('|')}|`);
for (const ch of ['日', '曰', '午', '牛', '刀', '力', '己', '已', '巳', '末', '未', '士', '土']) {
  out.push(`| ${ch} | ${levels.map((l) => pct(passRate([ch], l, NOISE.normal, 200, 5))).join(' | ')} |`);
}
console.log(out.join('\n'));
