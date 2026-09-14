/**
 * The metric the plain error rate hides: a wrong address that SHARES A PREFIX with the right one.
 *
 * A refusal is safe and useless. A random-looking wrong address is caught by whoever pastes it. An address
 * whose first ten characters are correct is the one that gets sent to — every wallet UI in existence shows
 * `0x6c3ea903…3753`, and that is precisely the part the model got right.
 */
import { readFileSync } from 'node:fs';
const rows = JSON.parse(readFileSync(process.argv[2] ?? 'out/arm_a.json', 'utf8'));
const wrong = rows.filter((r) => r.verdict === 'hallucinated' || r.verdict === 'cross_chain');
const pre = (a, b) => { let n = 0; while (n < a.length && a[n] === b[n]) n++; return n; };

const buckets = { '2-5': 0, '6-9': 0, '10-17': 0, '18+': 0 };
const scored = wrong.map((r) => ({ ...r, prefix: pre(r.answer ?? '', r.address) }));
for (const r of scored) {
  if (r.prefix >= 18) buckets['18+']++; else if (r.prefix >= 10) buckets['10-17']++;
  else if (r.prefix >= 6) buckets['6-9']++; else buckets['2-5']++;
}
const n = rows.length;
const pct = (x) => `${(x / n * 100).toFixed(1)}%`;
console.log(`\n=== 오답의 '그럴듯함' 분석  (전체 n=${n}, 오답 ${wrong.length}건) ===`);
console.log(`  일치 접두 길이   건수   전체 대비   의미`);
console.log(`  ${'2-5자'.padEnd(12)} ${String(buckets['2-5']).padStart(5)}  ${pct(buckets['2-5']).padStart(8)}   딱 봐도 다름`);
console.log(`  ${'6-9자'.padEnd(12)} ${String(buckets['6-9']).padStart(5)}  ${pct(buckets['6-9']).padStart(8)}   흘려보면 놓침`);
console.log(`  ${'10-17자'.padEnd(11)} ${String(buckets['10-17']).padStart(5)}  ${pct(buckets['10-17']).padStart(8)}   지갑 UI 축약형과 구분 불가`);
console.log(`  ${'18자+'.padEnd(12)} ${String(buckets['18+']).padStart(5)}  ${pct(buckets['18+']).padStart(8)}   사실상 식별 불가`);
const danger = buckets['10-17'] + buckets['18+'];
console.log(`\n  ▶ 지갑 축약형(앞 10자)으로 검증 불가능한 오답: ${danger}건 = 전체의 ${pct(danger)}`);
console.log(`  ▶ 오답 중 비율: ${(danger / (wrong.length || 1) * 100).toFixed(1)}%`);

console.log(`\n  최악 사례 (접두 일치 긴 순):`);
for (const r of scored.sort((a, b) => b.prefix - a.prefix).slice(0, 10))
  console.log(`    ${String(r.prefix).padStart(2)}자  ${r.symbol.padEnd(8)} ${r.chain.padEnd(9)} 답 ${r.answer}\n${' '.repeat(28)}정답 ${r.address}`);
