#!/usr/bin/env node
/**
 * Pre-registered attribution analysis for arm B's instability — written before arm B has produced a number.
 *
 *   node src/attribution.mjs runs/<id> [--arm B]
 *
 * THE QUESTION. Arm A's seven verdict disagreements were all abstain flips and none were answer changes, so
 * on this engine the instrument moves only on the wrong/abstain seam — which is exactly where §5's
 * hallucination metric lives. Arm B has a second source of instability that arm A cannot have: a tool call
 * that fails nondeterministically makes the arm's abstains nondeterministic. If arm B's flips concentrate on
 * items whose tool path failed, that is a measured cost of the MCP path rather than an interpretation. If
 * they do not, the tool path is exonerated and the instability is the model's — which is the more
 * interesting result, and the one a team whose headline needs arm B to look competent would be tempted to
 * assume without checking.
 *
 * WHY THIS FILE EXISTS NOW. In two hours we will know whether the flips concentrate, and at that point any
 * threshold is chosen knowing which answer it produces. Everything below is decidable without a single arm B
 * number, so it is decided here.
 *
 * DEFINITIONS, fixed:
 *   flip (primary)  — the item's two repeats differ on whether the verdict is `abstain`.
 *                     Primary because the claim under discussion is about abstains. Any-verdict disagreement
 *                     is reported beside it as a secondary, never as the headline.
 *   tool-path failure — on EITHER repeat of that item: tool_errors > 0, or retries > 0, or
 *                     context_exhausted, or budget_exhausted. Declared as a set, not tuned afterwards.
 *
 * DECISION RULE: attribution is claimed only if the Wilson 95% intervals for P(flip | tool failed) and
 * P(flip | tool clean) DO NOT OVERLAP. No ratio threshold — a cutoff picked today still gets chosen by
 * whoever writes the number down once the counts are visible, and neither of us should be trusted to pick
 * 2.0 rather than 1.5 innocently. Overlapping intervals means the data does not separate the hypotheses,
 * which is a result and not a failure.
 *
 * POWER FLOOR: if either row has fewer than MIN_FLIPS_PER_ROW flipped items, the verdict is
 * UNDERPOWERED_TO_ATTRIBUTE and non-separation must NOT be reported as evidence of no effect. Arm A produced
 * 7 flips in 250 items; if arm B is similar the table has single-digit cells and the intervals overlap
 * almost regardless of the truth. That is the difference between "we looked and found nothing" and "we could
 * not have found anything".
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { scoreOne, wilson } from './normalize.mjs';

export const MIN_FLIPS_PER_ROW = 10;

const die = (m) => { console.error(`attribution: ${m}`); process.exit(1); };

function loadArm(runDir, arm) {
  const dir = join(runDir, 'transcripts', arm);
  if (!existsSync(dir)) die(`${dir} does not exist`);
  const byItem = new Map();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const t = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const id = t.question?.id ?? basename(f).replace(/\.\d+\.json$/, '');
    if (!byItem.has(id)) byItem.set(id, []);
    byItem.get(id).push(t);
  }
  return byItem;
}

/** The declared failure set, evaluated on one transcript. */
const toolPathFailed = (t) => {
  const e = t.evidence ?? {};
  return (e.tool_errors ?? 0) > 0 || (e.retries ?? 0) > 0 || !!e.context_exhausted || !!e.budget_exhausted;
};

export function attribute(byItem) {
  const rows = [];
  let incomplete = 0;
  for (const [id, ts] of byItem) {
    if (ts.length !== 2) { incomplete++; continue; }         // never compared against itself, never dropped silently
    const [a, b] = ts.sort((x, y) => x.repeat - y.repeat);
    const va = scoreOne(a.final, a.question).verdict;
    const vb = scoreOne(b.final, b.question).verdict;
    rows.push({
      id,
      abstainFlip: (va === 'abstain') !== (vb === 'abstain'),
      anyFlip: va !== vb,
      ambiguous: va === 'ambiguous' || vb === 'ambiguous',
      failed: toolPathFailed(a) || toolPathFailed(b),
    });
  }
  const cell = (failed, flip) => rows.filter((r) => r.failed === failed && r.abstainFlip === flip).length;
  const table = { failed_flip: cell(true, true), failed_clean: cell(true, false), ok_flip: cell(false, true), ok_clean: cell(false, false) };
  const nFailed = table.failed_flip + table.failed_clean;
  const nOk = table.ok_flip + table.ok_clean;
  const [fLo, fHi] = wilson(table.failed_flip, nFailed);
  const [oLo, oHi] = wilson(table.ok_flip, nOk);
  if (nFailed && !Number.isFinite(fHi)) throw new Error('wilson gave a non-finite bound for the tool-failed row');
  if (nOk && !Number.isFinite(oHi)) throw new Error('wilson gave a non-finite bound for the tool-clean row');

  const underpowered = table.failed_flip < MIN_FLIPS_PER_ROW || table.ok_flip < MIN_FLIPS_PER_ROW;
  const separated = nFailed > 0 && nOk > 0 && (fLo > oHi || oLo > fHi);
  const verdict = underpowered ? 'UNDERPOWERED_TO_ATTRIBUTE' : separated ? 'ATTRIBUTED_TO_TOOL_PATH' : 'NOT_SEPARATED';

  const ambiguous = rows.filter((r) => r.ambiguous).length;
  const ambiguousAndFlipped = rows.filter((r) => r.ambiguous && r.abstainFlip).length;

  return {
    n: rows.length, incomplete,
    table,
    p_flip_given_tool_failed: { hits: table.failed_flip, n: nFailed, rate: nFailed ? table.failed_flip / nFailed : null, wilson: { lo: fLo, hi: fHi } },
    p_flip_given_tool_clean: { hits: table.ok_flip, n: nOk, rate: nOk ? table.ok_flip / nOk : null, wilson: { lo: oLo, hi: oHi } },
    verdict, underpowered, separated, min_flips_per_row: MIN_FLIPS_PER_ROW,
    any_flip_secondary: rows.filter((r) => r.anyFlip).length,
    ambiguity: { ambiguous, flipped: rows.filter((r) => r.abstainFlip).length, joint: ambiguousAndFlipped, interpretable: ambiguousAndFlipped >= MIN_FLIPS_PER_ROW },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runDir = process.argv[2] ?? die('usage: node src/attribution.mjs runs/<id> [--arm B]');
  const ai = process.argv.indexOf('--arm');
  const arm = ai > 0 ? process.argv[ai + 1] : 'B';
  const r = attribute(loadArm(runDir, arm));
  if (r.incomplete) console.error(`  !! ${r.incomplete} items lacked two repeats and were excluded`);
  console.log(`arm ${arm}, ${r.n} items with two repeats`);
  console.log('                       flipped   not flipped');
  console.log(`  tool path failed   ${String(r.table.failed_flip).padStart(7)}   ${String(r.table.failed_clean).padStart(11)}`);
  console.log(`  tool path clean    ${String(r.table.ok_flip).padStart(7)}   ${String(r.table.ok_clean).padStart(11)}`);
  const fmt = (x) => (x.rate === null ? 'n/a' : `${x.rate.toFixed(4)}  [${x.wilson.lo.toFixed(4)}, ${x.wilson.hi.toFixed(4)}]  n=${x.n}`);
  console.log(`  P(flip | tool failed)  ${fmt(r.p_flip_given_tool_failed)}`);
  console.log(`  P(flip | tool clean)   ${fmt(r.p_flip_given_tool_clean)}`);
  console.log(`  VERDICT: ${r.verdict}`);
  if (r.underpowered) console.log(`    fewer than ${MIN_FLIPS_PER_ROW} flipped items in a row — non-separation here is a statement about sample size, NOT about tool paths`);
  console.log(`  any-verdict flips (secondary): ${r.any_flip_secondary}`);
  console.log(`  ambiguity: ambiguous ${r.ambiguity.ambiguous}, flipped ${r.ambiguity.flipped}, joint ${r.ambiguity.joint}${r.ambiguity.interpretable ? '' : '  — below the power floor, report the count and do not interpret it'}`);
  const path = join(runDir, `attribution-${arm}.json`);
  writeFileSync(path, JSON.stringify({ arm, computed_at: new Date().toISOString(), ...r }, null, 2));
  console.log(`\nwrote ${path}`);
}
