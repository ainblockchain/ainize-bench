#!/usr/bin/env node
/**
 * The bridge control's threshold instrument (§2), written before the data it will be pointed at exists.
 *
 *   node src/noise-floor.mjs runs/<id>            # compute d from arm A's two repeats
 *   node src/noise-floor.mjs runs/<id> --bridge runs/<id>-bridge   # test a bridge against the committed d
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE SCORER. §2 pre-registers the bridge control's pass condition as
 * "at or below the upper bound of the Wilson 95% interval on d", where d is arm A's own two-repeat
 * disagreement rate. A threshold computed after the delta is known is not a threshold, so this is authored
 * and committed while arm A is still running and d does not yet exist. The number it produces is committed
 * to the repository before the bridge is ever executed; the running order guarantees that, because arm A
 * finishes hours before the training window opens.
 *
 * WHAT COUNTS AS A DISAGREEMENT. The verdict, not the string. Scoring is on verdicts, so two answers that
 * differ in wording but score identically are not instability the study cares about; two that score
 * differently are, even if they look similar. The raw-string rate is reported beside it as a diagnostic,
 * because a large gap between them says the model is verbose rather than unstable — but only the verdict
 * rate is the threshold.
 *
 * `temperature 0` is not bit-deterministic under vLLM continuous batching; this repo already knew that (the
 * teach-mode locality check asks each prompt twice for the same reason). d measures exactly that floor: the
 * same question, the same engine instance, the same table state, asked twice.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { scoreOne, wilson } from './normalize.mjs';

const die = (m) => { console.error(`noise-floor: ${m}`); process.exit(1); };

/** Every (item, repeat) transcript for one arm, grouped by item id. */
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

/**
 * d = the fraction of items whose two repeats disagree on verdict.
 *
 * Items without exactly two repeats are EXCLUDED and counted, rather than being compared against themselves
 * or silently dropped — a partial run must not quietly shrink the denominator that a threshold is derived
 * from. The same defect class as every other silent-failure we hit: it would print a confident number.
 */
export function noiseFloor(byItem) {
  let n = 0, verdictDisagree = 0, stringDisagree = 0, incomplete = 0, abstainFlip = 0, answerChange = 0;
  const examples = [];
  for (const [id, ts] of byItem) {
    if (ts.length !== 2) { incomplete++; continue; }
    const [a, b] = ts.sort((x, y) => x.repeat - y.repeat);
    const va = scoreOne(a.final, a.question).verdict;
    const vb = scoreOne(b.final, b.question).verdict;
    const sa = String(a.final ?? '').trim();
    const sb = String(b.final ?? '').trim();
    n++;
    if (sa !== sb) stringDisagree++;
    if (va !== vb) {
      verdictDisagree++;
      // Split the disagreements by WHICH SEAM they cross. Measured on arm A: 6 of 7 were abstain flips, so
      // this engine's instability at temperature 0 is almost entirely about whether the model commits at all,
      // not about which answer it gives. That matters because §5's hallucination metric IS the wrong/abstain
      // split — the instrument is least stable on precisely the axis that number is measured along, and a
      // difference smaller than this rate is not resolvable however tight the sampling interval looks.
      // Computed PER ARM from that arm's own repeats: arm B narrates and declines differently from arm C, so
      // importing arm A's rate would be assuming the thing worth measuring.
      if ((va === 'abstain') !== (vb === 'abstain')) abstainFlip++; else answerChange++;
      if (examples.length < 8) examples.push({ id, a: va, b: vb, seam: (va === 'abstain') !== (vb === 'abstain') ? 'abstain' : 'answer' });
    }
  }
  const d = n ? verdictDisagree / n : 0;
  // wilson() returns a TUPLE [lo, hi], not an object. Reading `.hi` off it yields undefined, and
  // `rate <= undefined` is false — so the bridge would have reported a confident FAIL against a threshold
  // that did not exist. Destructured here, and asserted finite below, because a threshold that is silently
  // undefined is the same species as every other silent failure this study has hit today.
  const [lo, hi] = wilson(verdictDisagree, n);
  if (!Number.isFinite(hi)) throw new Error(`wilson() gave a non-finite upper bound for ${verdictDisagree}/${n} — refusing to derive a threshold from it`);
  return {
    n, incomplete, verdict_disagreements: verdictDisagree, d, wilson: { lo, hi },
    string_disagreement_rate: n ? stringDisagree / n : 0,
    abstain_flips: abstainFlip, abstain_flip_rate: n ? abstainFlip / n : 0,
    answer_changes: answerChange, answer_change_rate: n ? answerChange / n : 0,
    examples,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runDir = process.argv[2] ?? die('usage: node src/noise-floor.mjs runs/<id> [--bridge runs/<id>-bridge]');
  const base = noiseFloor(loadArm(runDir, 'A'));
  if (base.incomplete) console.error(`  !! ${base.incomplete} items did not have exactly two repeats and were excluded`);
  console.log(`arm A, ${base.n} items with two repeats`);
  console.log(`  verdict disagreements  ${base.verdict_disagreements}`);
  console.log(`  d                      ${base.d.toFixed(4)}`);
  console.log(`  Wilson 95%             [${base.wilson.lo.toFixed(4)}, ${base.wilson.hi.toFixed(4)}]  <- the bridge passes at or below ${base.wilson.hi.toFixed(4)}`);
  console.log(`  abstain flips          ${base.abstain_flips}  rate ${base.abstain_flip_rate.toFixed(4)}  <- the floor under any wrong/abstain claim`);
  console.log(`  answer changes         ${base.answer_changes}  rate ${base.answer_change_rate.toFixed(4)}`);
  console.log(`  raw-string disagreement ${base.string_disagreement_rate.toFixed(4)}  (diagnostic only — verbosity, not instability)`);
  for (const e of base.examples) console.log(`    e.g. [${e.seam}] ${e.id}: ${e.a} vs ${e.b}`);

  // Every arm that ran gets its own instrument floor. §5's hallucination metric is a wrong/abstain split, and
  // each arm's stability on that seam is a property of that arm — arm B narrates its tool use and declines in
  // its own way. Arm A's rate is the bridge threshold; it is NOT the other arms' floor.
  out_per_arm: {
    const perArm = {};
    for (const arm of ['A', 'B', 'C', 'D']) {
      if (!existsSync(join(runDir, 'transcripts', arm))) continue;
      const r = noiseFloor(loadArm(runDir, arm));
      perArm[arm] = { n: r.n, d: r.d, abstain_flip_rate: r.abstain_flip_rate, answer_change_rate: r.answer_change_rate };
      console.log(`  arm ${arm}: n=${r.n} d=${r.d.toFixed(4)} abstain-flip=${r.abstain_flip_rate.toFixed(4)} answer-change=${r.answer_change_rate.toFixed(4)}`);
    }
    globalThis.__perArm = perArm;
  }

  const bi = process.argv.indexOf('--bridge');
  const out = { arm_a: base, per_arm: globalThis.__perArm ?? null, threshold: base.wilson.hi, computed_at: new Date().toISOString(), bridge: null };

  if (bi > 0 && process.argv[bi + 1]) {
    // The bridge compares the SAME items across an engine restart: pre-window arm A against post-restart arm A.
    const post = loadArm(process.argv[bi + 1], 'A');
    const pre = loadArm(runDir, 'A');
    let n = 0, disagree = 0, missing = 0;
    const diffs = [];
    for (const [id, ts] of post) {
      const before = pre.get(id);
      if (!before) { missing++; continue; }
      for (const t of ts) {
        const b = before.find((x) => x.repeat === t.repeat);
        if (!b) { missing++; continue; }
        n++;
        const va = scoreOne(b.final, b.question).verdict;
        const vb = scoreOne(t.final, t.question).verdict;
        if (va !== vb) { disagree++; if (diffs.length < 10) diffs.push({ id, repeat: t.repeat, pre: va, post: vb }); }
      }
    }
    if (!n) die('the bridge run shares no items with the pre-window run — refusing to report a rate over zero comparisons');
    if (missing) console.error(`  !! ${missing} bridge observations had no pre-window counterpart and were excluded`);
    const rate = disagree / n;
    const pass = rate <= base.wilson.hi;
    out.bridge = { n, disagreements: disagree, rate, threshold: base.wilson.hi, pass, missing, diffs };
    console.log(`\nbridge control, ${n} paired observations across the restart`);
    console.log(`  disagreement rate      ${rate.toFixed(4)}`);
    console.log(`  threshold (pre-registered, Wilson hi on d)  ${base.wilson.hi.toFixed(4)}`);
    console.log(`  ${pass ? 'PASS — the restart is within arm A\'s own noise floor' : 'FAIL — arm A must be re-run in full beside C and D'}`);
    for (const d of diffs) console.log(`    ${d.id} rep${d.repeat}: ${d.pre} -> ${d.post}`);
  }

  const path = join(runDir, 'noise-floor.json');
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${path}`);
}
