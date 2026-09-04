#!/usr/bin/env node
/**
 * Self-test for src/chart.mjs. `node src/chart.test.mjs` — no GPU, no API key, no network, no model, no
 * browser. `--keep` leaves the rendered SVGs on disk and prints the path, which is how you eyeball them.
 *
 * runs/ is empty, so this file writes SYNTHETIC transcripts into a temp directory, scores them with the real
 * src/score.mjs, and charts the real results.json. Every fixture run carries `provenance.fixture: true`, so
 * anything it renders is stamped "FIXTURE — SYNTHETIC TRANSCRIPTS, NOT A RUN" across the face of the chart —
 * a rendered fixture can never be mistaken for a measurement, in this repo or in a slide.
 *
 * What the cases pin, in order of how much they would cost us if they broke:
 *  - every number a chart draws is recomputed here from the results.json rows and asserted to appear in the
 *    SVG text. Nothing is "close enough": the assertion is on the exact string the chart renders.
 *  - change a price in pricing.json and the cost chart moves; unset the knowledge price and N* is not drawn
 *    at all rather than guessed.
 *  - arm C's one-time knowledge load is ALWAYS plotted, and when it is not a measurement the chart says so
 *    in a stamp — the "you hid the load cost" objection has to be answered by the picture itself.
 *  - §9's stamps are on EVERY chart, not just the summary, and a VOID run stamps every chart too.
 *  - the miss decomposition drawn is the one that sums to the arm's miss count.
 *  - the charts read results.json alone: delete summary.json and they still render the same numbers.
 *  - the SVGs are self-contained (no script, no network reference), well-formed, and carry both themes.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scoreRun, CHANNELS, isMiss } from './score.mjs';
import {
  chartRun, loadRun, CHARTS, knowledgeLoad, KNOWLEDGE_LOAD_FALLBACK, crossover, quantileRow, decompose,
  niceTicks, niceCeil, wrap, esc, mean, unstableItems, fmtUsd, fmtPct, fmtMs, fmtDur, fmtInt, fmtQ,
} from './chart.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};
const ok = (name, cond) => t(name, !!cond, true);

// ── 0. the pure bits ─────────────────────────────────────────────────────────────────────────────────────

t('crossover: a one-time cost is repaid where the per-question saving covers it', crossover(10, 3, 1), 5);
t('crossover: nothing to repay when the cheap arm is not cheaper', crossover(10, 1, 3), null);
t('crossover: an unpriced term never invents a crossing', [crossover(null, 3, 1), crossover(10, null, 1)], [null, null]);
t('quantileRow: nearest-rank, so the bar is a real item and not an interpolation',
  [0.5, 0.95, 1].map((q) => quantileRow([{ latency_ms: 10 }, { latency_ms: 20 }, { latency_ms: 30 }, { latency_ms: 400 }], q).latency_ms), [20, 400, 400]);
t('quantileRow: no timed unit, no bar', quantileRow([{ latency_ms: null }], 0.5), null);
t('decompose: the bands are parts of ONE item and add up to that item’s own total',
  (() => { const d = decompose({ latency_ms: 1000, model_ms: 600, first_turn_ms: 200, tool_ms: 300 }); return [d.first, d.gen, d.tool, d.other, d.first + d.gen + d.tool + d.other, d.total]; })(),
  [200, 400, 300, 100, 1000, 1000]);
t('decompose: a negative residual is clamped and the clamp is flagged, never silently absorbed',
  (() => { const d = decompose({ latency_ms: 500, model_ms: 600, first_turn_ms: 600, tool_ms: 300 }); return [d.other, d.clamped]; })(), [0, true]);
t('decompose: a row from before the timing fields still draws (first response falls back to model time)',
  (() => { const d = decompose({ latency_ms: 1000, model_ms: 600 }); return [d.first, d.gen, d.tool, d.other]; })(), [600, 0, 0, 400]);
t('niceTicks: round steps', niceTicks(0, 100, 5), [0, 20, 40, 60, 80, 100]);
t('niceCeil: a domain that ends on a readable number', [niceCeil(0.0031), niceCeil(4200), niceCeil(0)], [0.004, 5000, 1]);
t('esc: the text layer cannot inject markup', esc('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
t('wrap: a note breaks into lines rather than running off the page', wrap('a b c d e f', 60, 11).length > 1, true);
t('formatters: the strings the test asserts on are the strings the chart draws',
  [fmtUsd(0.0000123), fmtUsd(1.5), fmtPct(0.8333), fmtMs(450), fmtMs(4200), fmtDur(125000), fmtInt(12345), fmtQ(0.11), fmtQ(1234.2)],
  ['$0.000012', '$1.5000', '83.3%', '450 ms', '4.2 s', '2.1 min', '12,345', '0.11', '1,235']);

// ── the fixture run ──────────────────────────────────────────────────────────────────────────────────────

const DEPLOY_A = 'ANz3TpZdY2syZGQvGA85ANNG7KiSWdPmv55kP4H4sRPJ';
const DEPLOY_OTHER = 'BchjnXAXXV5coiCBMQH4A8yCHXEFX9S88JFF6G3mfem4';
const TRUTH = '0xd930ab15c8078ebae4ac8da1098a81583603f7ce';
const WRONG = '0x0000000000000000000000000000000000000001';
const PRICING = { model: { usd_per_1m_input_tokens: 0.2, usd_per_1m_output_tokens: 0.6 }, graph: { usd_per_query: 0.00004 }, knowledge: { price: null, currency: null } };

const item = (over = {}) => ({
  id: 'q.E1', question: 'Where is the vLQTY-ETH30 vault deployed?', answer_type: 'address', truth: TRUTH,
  form: 'E1', taught: true, hop: 1, source: { deployment_id: DEPLOY_A }, source_ids: [DEPLOY_A], ...over,
});
const EV0 = { tool_calls: 0, tool_bytes_in: 0, retries: 0, context_truncated: false, context_exhausted: false, context_evictions: 0, prompt_tokens_peak: 900, budget_exhausted: false, forced_final: false, tool_errors: 0, tool_targets: [], tool_results: [], model_ms: 4100, offline: false };
const BIG = `{"data":{"liquidityPools":[${Array.from({ length: 20 }, (_, i) => `{"id":"0x${String(i).padStart(40, '0')}","tvl":"${1e6 + i}"}`).join(',')}]}}`;
const HIT_BODY = `{"data":{"vaults":[{"id":"${TRUTH}","symbol":"vLQTY-ETH30"}]}}`;
const qres = (target, full, over = {}) => ({ name: 'execute_query_by_deployment_id', target, full, truncated: false, rows: 20, kept_rows: 20, is_error: false, ms: 500, ...over });

// Latencies are fixed per arm so the test can assert the exact bands the decomposition chart draws.
const PLAIN_LAT = { latency_ms: 4200, model_ms: 4100, first: 4100 };
const TOOL_LAT = { latency_ms: 31000, model_ms: 15000, first: 5000 };

function transcript(arm, it, rep, mode) {
  const tools = arm === 'B' || arm === 'D';
  if (!tools || mode === 'hit' || mode === 'wrong' || mode === 'abstain') {
    const final = mode === 'hit' ? TRUTH : mode === 'abstain' ? 'I do not know.' : WRONG;
    return {
      arm, repeat: rep, question: it, system: tools ? 'tools' : 'plain', final, error: null,
      latency_ms: PLAIN_LAT.latency_ms, model_ms: PLAIN_LAT.model_ms,
      turns: [{ turn: 0, request: {}, response: { id: 'x' }, ms: PLAIN_LAT.first, usage: { prompt_tokens: 900, completion_tokens: 20 }, finish_reason: 'stop' }],
      evidence: { ...EV0 },
    };
  }
  const map = {
    tool_hit: { results: [qres(DEPLOY_A, HIT_BODY)], final: TRUTH, ev: {} },
    tool_had_it: { results: [qres(DEPLOY_A, HIT_BODY)], final: WRONG, ev: {} },
    tool_ignored: { results: [qres(DEPLOY_A, BIG)], final: WRONG, ev: {} },
    tool_wrong_subgraph: { results: [qres(DEPLOY_OTHER, BIG)], final: WRONG, ev: {} },
    tool_skipped: { results: [], final: WRONG, ev: { tool_calls: 0 } },
    tool_overflow: { results: [qres(DEPLOY_A, BIG, { truncated: true, kept_rows: 4 }), qres(DEPLOY_A, BIG, { truncated: true, kept_rows: 4 })], final: '', ev: { context_exhausted: true, context_truncated: true, context_evictions: 1, forced_final: true } },
  }[mode];
  return {
    arm, repeat: rep, question: it, system: 'tools', final: map.final, error: null,
    latency_ms: TOOL_LAT.latency_ms, model_ms: TOOL_LAT.model_ms,
    turns: [
      { turn: 0, request: {}, response: { id: 'a' }, ms: TOOL_LAT.first, usage: { prompt_tokens: 2800, completion_tokens: 70 }, finish_reason: 'tool_calls' },
      { turn: 1, request: {}, response: { id: 'b' }, ms: TOOL_LAT.model_ms - TOOL_LAT.first, usage: { prompt_tokens: 3400, completion_tokens: 25 }, finish_reason: 'stop' },
    ],
    evidence: {
      ...EV0, tool_calls: map.results.length, tool_bytes_in: map.results.reduce((a, r) => a + r.full.length, 0),
      model_ms: TOOL_LAT.model_ms, prompt_tokens_peak: 3400, tool_results: map.results,
      tool_targets: map.results.map((r) => ({ name: r.name, target: r.target, args: {} })), ...map.ev,
    },
  };
}

function fixtureRun(root, { leak = false } = {}) {
  const items = [
    item({ id: 'q1.E1' }), item({ id: 'q2.E1' }),
    item({ id: 'q3.E2', form: 'E2' }), item({ id: 'q4.P', form: 'P' }),
    item({ id: 'q5.E1', taught: false }), item({ id: 'q6.E1', taught: false }),
    item({ id: 'q7.P', hop: 2 }),
  ];
  const script = {
    A: ['abstain', 'wrong', 'abstain', 'wrong', 'abstain', 'abstain', 'wrong'],
    B: ['tool_hit', 'tool_overflow', 'tool_ignored', 'tool_wrong_subgraph', 'tool_hit', 'tool_hit', 'tool_had_it'],
    C: ['hit', 'hit', 'hit', 'hit', leak ? 'hit' : 'wrong', leak ? 'hit' : 'abstain', 'hit'],
    D: ['tool_hit', 'hit', 'hit', 'hit', 'tool_hit', 'tool_skipped', 'tool_hit'],
  };
  for (const [arm, modes] of Object.entries(script)) {
    const adir = join(root, 'transcripts', arm);
    mkdirSync(adir, { recursive: true });
    items.forEach((it, i) => {
      for (let rep = 0; rep < 2; rep++) writeFileSync(join(adir, `${it.id}.${rep}.json`), JSON.stringify(transcript(arm, it, rep, modes[i]), null, 2));
    });
  }
  writeFileSync(join(root, 'provenance.json'), JSON.stringify({
    run_id: 'FIXTURE', fixture: true, offline: false, model: 'fixture-model', max_model_len: 32768,
    patch: { backend: 'stub', real_training: false, patch_id: 'fixture' }, restarts_detected: 0, chunks_rerun: 0,
  }, null, 2));
  return items;
}

const dir = mkdtempSync(join(tmpdir(), 'bench-chart-fixture-'));
const keep = process.argv.includes('--keep');
const runDir = join(dir, 'FIXTURE');
mkdirSync(runDir, { recursive: true });
fixtureRun(runDir);
const pricingPath = join(dir, 'pricing.json');
const writePricing = (knowledge) => writeFileSync(pricingPath, JSON.stringify({ ...PRICING, knowledge }, null, 2));
writePricing({ price: 5, currency: 'USD' });
scoreRun(runDir, { pricingPath });

const rowsOf = (d = runDir) => JSON.parse(readFileSync(join(d, 'results.json'), 'utf8')).rows;
const render = (opts = {}) => {
  const { files } = chartRun(runDir, { pricingPath, ...opts });
  const svgs = {};
  for (const f of files) svgs[f.split('/').pop()] = readFileSync(f, 'utf8');
  return svgs;
};
let svg = render();

// ── 1. the files exist and are self-contained, well-formed, two-theme SVG ────────────────────────────────

t('every chart §8 asks for is rendered', Object.keys(svg).sort(), CHARTS.map(([n]) => n).sort());
ok('…into runs/<id>/charts/', existsSync(join(runDir, 'charts', 'cost-break-even.svg')));

function wellFormed(s) {
  const stack = [];
  const body = s.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/<\/?([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const [, name, attrs, selfClose] = m;
    if (m[0].startsWith('</')) { if (stack.pop() !== name) return `close ${name}`; }
    else if (!selfClose && !attrs.endsWith('/')) stack.push(name);
  }
  return stack.length ? `unclosed ${stack.join(',')}` : null;
}
for (const [name, s] of Object.entries(svg)) {
  t(`${name}: well-formed XML`, wellFormed(s), null);
  ok(`${name}: is a standalone SVG document`, s.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && s.trimEnd().endsWith('</svg>'));
  ok(`${name}: carries a title and a description for a screen reader`, /<title>[^<]+<\/title>/.test(s) && /<desc>[^<]+<\/desc>/.test(s));
  ok(`${name}: no script, no external reference — nothing to fetch and nothing to execute`,
    !/<script/i.test(s) && !/xlink:href/i.test(s) && !/<image/i.test(s) && !/https?:\/\/(?!www\.w3\.org)/.test(s));
  ok(`${name}: readable in both themes — light values inline, dark values under prefers-color-scheme`,
    /prefers-color-scheme: dark/.test(s) && s.includes('#fcfcfb') && s.includes('#1a1a19'));
  ok(`${name}: every mark keeps its light hex as an attribute, so it survives a stripped <style>`, /fill="#[0-9a-f]{6}"/.test(s));
  ok(`${name}: no unescaped ampersand`, !/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(s));
  ok(`${name}: §9's stamps are on the FACE of the chart, not only in summary.md`, /FIXTURE — SYNTHETIC TRANSCRIPTS/.test(s) && /SIMULATED PATCH — NOT A TRAINED MODEL/.test(s));
}

// ── 2. the cost chart plots the costs and the crossing it claims ─────────────────────────────────────────

const rows = rowsOf();
const cpq = (arm) => { const r = rows.filter((x) => x.arm === arm && x.cost_usd != null); return r.reduce((a, x) => a + x.cost_usd, 0) / r.length; };
const cB = cpq('B'), cC = cpq('C'), nstar = 5 / (cB - cC);
const cost = svg['cost-break-even.svg'];
ok('cost chart: arm B’s measured cost per question is on the chart', cost.includes(fmtUsd(cB)));
ok('cost chart: arm C’s measured cost per question is on the chart', cost.includes(fmtUsd(cC)));
ok('cost chart: the difference the break-even divides by is printed', cost.includes(fmtUsd(cB - cC)));
ok('cost chart: the one-time price is read from pricing.json and shown as such', cost.includes('5 USD') && cost.includes('knowledge.price'));
ok('cost chart: N* is drawn where the two lines cross, and it is the price ÷ the measured difference', cost.includes(`N* = ${fmtQ(nstar)} questions`));
ok('cost chart: two lines, one per arm, in the arm colours', (cost.match(/class="s-arm-B"/g) ?? []).length >= 1 && (cost.match(/class="s-arm-C"/g) ?? []).length >= 1);
ok('cost chart: arm C’s zero gateway queries are stated, not left to be inferred', /arm C 0/.test(cost) || /arm C makes no network call/.test(cost));

// change a price: every cost cell must move, because none of them is typed in
writePricing({ price: 20, currency: 'USD' });
scoreRun(runDir, { pricingPath });
const cost20 = render()['cost-break-even.svg'];
const nstar20 = 20 / (cpq20('B') - cpq20('C'));
function cpq20(arm) { const r = rowsOf().filter((x) => x.arm === arm && x.cost_usd != null); return r.reduce((a, x) => a + x.cost_usd, 0) / r.length; }
ok('cost chart: raise the knowledge price in pricing.json and N* moves with it — nothing is hard-coded',
  cost20.includes(`N* = ${fmtQ(nstar20)} questions`) && !cost20.includes(`N* = ${fmtQ(nstar)} questions`) && nstar20 > nstar);
writePricing({ price: null, currency: null });
scoreRun(runDir, { pricingPath });
const costNull = render()['cost-break-even.svg'];
ok('cost chart: with no knowledge price set, no crossing is drawn and none is guessed',
  /not computed/.test(costNull) && /no crossing is marked/.test(costNull) && !/N\* = [\d,.]+ questions/.test(costNull));
ok('…and the per-question costs are still plotted, because those ARE measured', costNull.includes(fmtUsd(cB)) && costNull.includes(fmtUsd(cC)));
writePricing({ price: 5, currency: 'USD' });
scoreRun(runDir, { pricingPath });
svg = render();

// ── 3. the latency picture, including the load cost a judge will go looking for ──────────────────────────

const dec = svg['latency-decomposition.svg'];
for (const arm of ['A', 'B', 'C', 'D']) {
  const armRows = rows.filter((r) => r.arm === arm);
  const p50 = decompose(quantileRow(armRows, 0.5)), p95 = decompose(quantileRow(armRows, 0.95));
  ok(`latency decomposition: arm ${arm}’s p50 total is on the chart`, dec.includes(fmtMs(p50.total)));
  ok(`latency decomposition: arm ${arm}’s p95 total is on the chart`, dec.includes(fmtMs(p95.total)));
  ok(`latency decomposition: arm ${arm}’s bands are all written out, so no value is colour-only`,
    [p50.first, p50.tool, p50.gen, p50.other].every((v) => dec.includes(fmtMs(v))));
}
const bTool = decompose(quantileRow(rows.filter((r) => r.arm === 'B'), 0.5)).tool;
ok('latency decomposition: the tool arm’s round-trip band is summed from tool_results[].ms — 500 ms per executed query in the fixture',
  rows.filter((r) => r.arm === 'B').every((r) => r.tool_ms === 500 * r.gateway_queries) && bTool > 0 && dec.includes(fmtMs(bTool)));
ok('latency decomposition: the tool-less arms have no tool band at all', decompose(quantileRow(rows.filter((r) => r.arm === 'C'), 0.5)).tool === 0);
ok('latency decomposition: the chart says there is no TTFT in this study rather than pretending the first band is one',
  /no time-to-first-token exists/i.test(dec) && /prefill \+ first generation/.test(dec));

const cum = svg['latency-cumulative.svg'];
const meanLat = (arm) => mean(rows.filter((r) => r.arm === arm).map((r) => r.latency_ms));
ok('cumulative latency: every arm’s measured mean latency is printed', ['A', 'B', 'C', 'D'].every((a) => cum.includes(fmtMs(meanLat(a)))));
ok('cumulative latency: arm C’s ONE-TIME knowledge load is plotted, at the slow end of its band',
  cum.includes(fmtMs(KNOWLEDGE_LOAD_FALLBACK.ms_hi)) && /one-time knowledge load/.test(cum));
const xcross = crossover(KNOWLEDGE_LOAD_FALLBACK.ms_hi, meanLat('B'), meanLat('C'));
ok('cumulative latency: the crossover is marked and is the load ÷ the per-question saving', cum.includes(fmtQ(xcross)));
ok('…and when it lands before the first question, the chart says so in words', /before the FIRST question finishes/.test(cum));
ok('cumulative latency: an unmeasured load is stamped as an ESTIMATE on the face of the chart',
  /KNOWLEDGE LOAD TIME IS AN ESTIMATE, NOT A MEASUREMENT/.test(cum));

writeFileSync(join(runDir, 'knowledge-load.json'), JSON.stringify({ ms: 2450, source: 'timed apply/remove on node-u' }, null, 2));
const measured = render()['latency-cumulative.svg'];
ok('cumulative latency: a measured load is used when one is on disk, and the ESTIMATE stamp disappears',
  measured.includes(fmtMs(2450)) && !/IS AN ESTIMATE/.test(measured) && /measured — FIXTURE\/knowledge-load.json/.test(measured));
t('the load is looked for in a fixed order, and a declared one is never called measured',
  (() => { const k = knowledgeLoad({ runDir, provenance: null, cliMs: '1500' }); return [k.ms_lo, k.ms_hi, k.measured]; })(), [1500, 1500, false]);
t('provenance can carry it too', knowledgeLoad({ runDir: dir, provenance: { knowledge_load_ms: 2100 } }), { ms_lo: 2100, ms_hi: 2100, measured: true, source: 'measured — provenance.json' });
unlinkSync(join(runDir, 'knowledge-load.json'));

// ── 3b. the two charts §8 names that the brief's list left out ──────────────────────────────────────────

const cdf = svg['latency-cdf.svg'];
const quant = (arm, q) => { const xs = rows.filter((r) => r.arm === arm).map((r) => r.latency_ms).sort((a, b) => a - b); return xs[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)]; };
for (const arm of ['A', 'B', 'C', 'D']) {
  ok(`latency CDF: arm ${arm}'s p50 and p95 are read off the same rows the curve is drawn from`,
    cdf.includes(`p50 ${fmtMs(quant(arm, 0.5))} · p95 ${fmtMs(quant(arm, 0.95))}`));
}
ok('latency CDF: every unit is a step — the curve is not binned or smoothed',
  (cdf.match(/class="s-arm-B"/g) ?? []).length >= 1 && cdf.includes(fmtMs(quant('B', 1))));
ok('latency CDF: the p95 reference line is drawn, not left to be estimated', /p95<\/text>/.test(cdf));

const tok = svg['tokens-per-question.svg'];
const meanOf = (arm, f) => mean(rows.filter((r) => r.arm === arm).map(f));
for (const arm of ['A', 'B', 'C', 'D']) {
  const pr = meanOf(arm, (r) => r.prompt_tokens), co = meanOf(arm, (r) => r.completion_tokens);
  ok(`tokens: arm ${arm}'s prompt and completion means are on the chart`, tok.includes(fmtInt(pr)) && tok.includes(fmtInt(co)));
  ok(`tokens: arm ${arm}'s peak prompt — the number the window actually caps — is printed`,
    tok.includes(fmtInt(rows.filter((r) => r.arm === arm).reduce((a, r) => Math.max(a, r.prompt_tokens_peak ?? 0), 0))));
}
ok('tokens: the serving window is read from provenance.json rather than assumed', /share of the 32,768 window/.test(tok));
ok('tokens: the chart says why it exists — this comparison does not depend on the host', /does not depend on the host/.test(tok));

// ── 4. accuracy by arm × bucket, tripwire held apart ─────────────────────────────────────────────────────

const acc = svg['accuracy-by-bucket.svg'];
const model = loadRun(runDir, { pricingPath });
for (const arm of model.arms) {
  for (const b of ['headline', 'korean', 'ceiling', 'tripwire', 'multihop']) {
    const cell = model.accuracy.byArm[arm].buckets[b];
    if (cell.accuracy == null) continue;
    ok(`accuracy: arm ${arm} × ${b} is written out as ${fmtPct(cell.accuracy)} ${cell.hits}/${cell.n}`, acc.includes(`${fmtPct(cell.accuracy)} [${(cell.ci95[0] * 100).toFixed(0)}–${(cell.ci95[1] * 100).toFixed(0)}] ${cell.hits}/${cell.n}`));
  }
}
ok('accuracy: the Wilson interval is drawn, not only tabulated', (acc.match(/class="s-ink2"/g) ?? []).length >= 8);
ok('accuracy: the tripwire bucket is captioned as the tripwire and its prediction is on the chart',
  /TRIPWIRE — held-out facts/.test(acc) && /reported at full weight, never folded in/.test(acc) && /arm C is EXPECTED to fail here/.test(acc) && /VOIDS the run/.test(acc));
const panel = acc.match(/<rect x="([\d.]+)"[^>]*data-panel="tripwire"/);
ok('accuracy: the tripwire is drawn in its own panel, to the side of the four ordinary buckets — never a fifth bar group',
  panel && Number(panel[1]) > 600);
ok('accuracy: the pre-registered expectation is printed beside the measurement', /Pre-registered, headline: A floor/.test(acc));
ok('accuracy: the fact-coherence of E1/E2/P is stated where the buckets are compared', /SAME facts/.test(acc) || /same facts/i.test(acc));
ok('accuracy: the unstable items excluded by §2 are counted on the chart', new RegExp(`${model.accuracy.unstable} of ${model.items} items`).test(acc));

// ── 5. the miss decomposition sums to the miss count ────────────────────────────────────────────────────

const miss = svg['miss-channels.svg'];
for (const arm of ['B', 'D']) {
  const armRows = rows.filter((r) => r.arm === arm);
  const misses = armRows.filter((r) => r.scored && isMiss(r.verdict));
  const counts = CHANNELS.map((c) => misses.filter((r) => r.miss_channel === c).length);
  t(`miss chart: arm ${arm}’s channels sum to its miss count`, counts.reduce((a, b) => a + b, 0), misses.length);
  ok(`miss chart: arm ${arm}’s miss count is printed`, miss.includes(`${fmtInt(misses.length)} misses`));
  ok(`miss chart: every channel count for arm ${arm} is written out beside its rule`,
    CHANNELS.every((c, i) => miss.includes(`${arm}: ${counts[i]}`)));
}
ok('miss chart: the sum check is printed as a result, not assumed', /sums ✓/.test(miss) && !/DOES NOT SUM/.test(miss));
const delivered = rows.filter((r) => r.arm === 'B' && ['context_exhausted', 'truncated', 'had_it_and_still_wrong'].includes(r.miss_channel)).length;
ok('miss chart: the "The Graph delivered and the loop lost it" group is bracketed and subtotalled',
  miss.includes(`The Graph delivered — the loop lost it: ${delivered}`));
ok('miss chart: each channel carries its §6 rule so a reader never has to trust the label',
  /zero tool calls were made/.test(miss) && /the truth WAS in an untruncated result/.test(miss));

// ── 6. the charts read results.json, and say so when they disagree with the summary ──────────────────────

const before = readFileSync(join(runDir, 'charts', 'accuracy-by-bucket.svg'), 'utf8');
const savedSummary = readFileSync(join(runDir, 'summary.json'), 'utf8');
unlinkSync(join(runDir, 'summary.json'));
const noSummary = render()['accuracy-by-bucket.svg'];
ok('charts render from results.json alone — summary.json is not required', noSummary.length > 1000);
t('…and the numbers are identical, because both come from the same rows', noSummary, before);
writeFileSync(join(runDir, 'summary.json'), savedSummary);

const tampered = JSON.parse(savedSummary);
tampered.arms.C.headline_E1_E2.stable_subset.accuracy = 0.999;
writeFileSync(join(runDir, 'summary.json'), JSON.stringify(tampered));
const mismatched = render()['accuracy-by-bucket.svg'];
ok('a chart that disagrees with the summary it illustrates says so on its own face',
  /CHART\/SUMMARY MISMATCH on arm C headline accuracy/.test(mismatched));
writeFileSync(join(runDir, 'summary.json'), savedSummary);

// ── 7. a void run is stamped on every chart ──────────────────────────────────────────────────────────────

const leakDir = join(dir, 'FIXTURE-LEAK');
mkdirSync(leakDir, { recursive: true });
fixtureRun(leakDir, { leak: true });
scoreRun(leakDir, { pricingPath });
const leaked = chartRun(leakDir, { pricingPath });
ok('the leakage tripwire fired in the fixture built to trip it', leaked.model.summary.VOID);
for (const f of leaked.files) ok(`${f.split('/').pop()}: a VOID run is stamped on the chart, where it cannot be cropped off`, /RUN VOID/.test(readFileSync(f, 'utf8')));

// ── 8. a run without a tool arm still draws every chart ─────────────────────────────────────────────────
// §1 allows a short GPU window to drop buckets, and a re-score of arms A and C alone must not crash the
// charts: the miss decomposition simply has nothing to decompose and has to say so rather than throw.

const acDir = join(dir, 'FIXTURE-AC');
mkdirSync(acDir, { recursive: true });
fixtureRun(acDir);
rmSync(join(acDir, 'transcripts', 'B'), { recursive: true, force: true });
rmSync(join(acDir, 'transcripts', 'D'), { recursive: true, force: true });
scoreRun(acDir, { pricingPath });
const ac = chartRun(acDir, { pricingPath });
t('a run with no tool arm still renders every chart', ac.files.length, CHARTS.length);
ok('…and the miss decomposition says there is nothing to decompose instead of throwing',
  /No tool arm was scored in this run/.test(readFileSync(join(acDir, 'charts', 'miss-channels.svg'), 'utf8')));
ok('…and the break-even still draws arm C’s line against an arm B that is not there',
  /arm B/.test(readFileSync(join(acDir, 'charts', 'cost-break-even.svg'), 'utf8')));

// ── 9. nothing renders from thin air ─────────────────────────────────────────────────────────────────────

t('an unscored run is refused rather than drawn empty',
  (() => { try { chartRun(join(dir, 'NOPE'), { pricingPath }); return 'no throw'; } catch (e) { return /score the run first/.test(e.message); } })(), true);

if (keep) console.error(`fixtures kept at ${dir}`);
else rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
