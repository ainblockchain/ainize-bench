#!/usr/bin/env node
/**
 * ADVERSARIAL VERIFICATION of src/score.mjs — written to reject the scorer, not to confirm it.
 *
 *   node src/score.adversarial.test.mjs          run every attack
 *   node src/score.adversarial.test.mjs --keep   leave the planted run on disk and print its path
 *
 * No GPU, no API key, no network, no model. Everything below is built from SYNTHETIC transcripts written by
 * this file, in a temp directory that is deleted at the end, with `provenance.fixture: true` so that a copy
 * that ever escaped into runs/ would be stamped "FIXTURE — SYNTHETIC TRANSCRIPTS, NOT A RUN" on every table
 * and every chart.
 *
 * The difference between this file and score.test.mjs is the direction of the check. score.test.mjs pins the
 * rules one at a time. This file PLANTS a whole run whose every number is chosen in advance — the verdict of
 * each (arm, item, repeat), the channel each arm-B miss must land in, the tokens on each turn, the latency of
 * each unit, the gateway queries each unit pays for — and then demands that the scorer hand back exactly
 * those numbers and nothing else. Anything the scorer derives that the plan did not intend is a bug, and the
 * plan is written by hand above the builder so a reader can check the arithmetic without running anything.
 *
 * The five attacks, in the order the brief names them:
 *
 *   1. PLANTED RUN — recover verdicts, channels, tokens, latencies, costs, accuracies, McNemar and N* exactly.
 *      Including a planted arm-C hit on held-out facts, which must VOID the run loudly rather than be
 *      averaged into a headline that still looks good.
 *   2. THE CHANNEL TABLE — every miss that could plausibly land in two channels lands in exactly one,
 *      deterministically (order of tool_results must not matter, re-scoring must be byte-identical), the
 *      channels sum to the miss count on every fixture, and `ignored_result` / `had_it_and_still_wrong` are
 *      decided against `tool_results[].full` — the server's own bytes — never against the truncated copy the
 *      model was shown. The verdict does not move when the truncation flag does.
 *   3. THE HONESTY RAILS — no LLM judge in a headline path; no price constant outside pricing.json; error
 *      units leave the accuracy denominator and context_exhausted units do NOT; `ambiguous` is never a hit.
 *   4. ISOLATION — re-score a clean checkout (transcripts + provenance only) in a child process with
 *      GRAPH_API_KEY unset, every service URL pointed at a closed port, and fetch/http/https/net/dns
 *      replaced by functions that throw. Identical output proves no GPU, no key and no network.
 *   5. §5/§6 LINE BY LINE — the rules the protocol states, asserted where they are implemented and listed
 *      where they are not.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  scoreRun, summarize, missChannel, verdictFor, CHANNELS, BUCKETS, isMiss, sumTokens, costOf, BENCH,
} from './score.mjs';
import { latencyTable } from './chart.mjs';
import { wilson, mcnemar } from './normalize.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};
const ok = (name, cond) => t(name, !!cond, true);
const near = (name, got, want, eps = 1e-9) => t(name, got != null && Math.abs(got - want) < eps, true);

// ── the planted world ────────────────────────────────────────────────────────────────────────────────────

const TRUTH_ADDR = '0xd930ab15c8078ebae4ac8da1098a81583603f7ce';
const OTHER_ADDR = '0x0000000000000000000000000000000000000001';
const DEP_A = 'ANz3TpZdY2syZGQvGA85ANNG7KiSWdPmv55kP4H4sRPJ';
const DEP_B = '3onEbd9MLfXTTWAfP91yqsKr7C68VCT2ZiF7EoQiQAFj';
const DEP_X = 'BchjnXAXXV5coiCBMQH4A8yCHXEFX9S88JFF6G3mfem4';

/** The item set. Buckets follow §1's frozen definitions: hop 2 ⇒ multihop, !taught ⇒ tripwire, then form. */
const ITEMS = [
  { id: 'h1.E1', form: 'E1', taught: true, hop: 1, answer_type: 'address', truth: TRUTH_ADDR, bucket: 'headline' },
  { id: 'h2.E1', form: 'E1', taught: true, hop: 1, answer_type: 'symbol', truth: 'SPURDO', bucket: 'headline' },
  { id: 'h3.E1', form: 'E1', taught: true, hop: 1, answer_type: 'decimal', truth: 20, bucket: 'headline' },
  { id: 'h4.E1', form: 'E1', taught: true, hop: 1, answer_type: 'list<symbol>', truth: ['SPURDO', 'WETH'], bucket: 'headline' },
  { id: 'k1.E2', form: 'E2', taught: true, hop: 1, answer_type: 'address', truth: TRUTH_ADDR, bucket: 'korean' },
  { id: 'p1.P', form: 'P', taught: true, hop: 1, answer_type: 'symbol', truth: 'SPURDO', bucket: 'ceiling' },
  { id: 'tw1.E1', form: 'E1', taught: false, hop: 1, answer_type: 'address', truth: TRUTH_ADDR, bucket: 'tripwire' },
  { id: 'tw2.E1', form: 'E1', taught: false, hop: 1, answer_type: 'symbol', truth: 'SPURDO', bucket: 'tripwire' },
  { id: 'tw3.E1', form: 'E1', taught: false, hop: 1, answer_type: 'decimal', truth: 20, bucket: 'tripwire' },
  { id: 'm1.E1', form: 'E1', taught: true, hop: 2, answer_type: 'decimal', truth: 20, bucket: 'multihop', two: true },
  { id: 'm2.E1', form: 'E1', taught: true, hop: 2, answer_type: 'address', truth: TRUTH_ADDR, bucket: 'multihop', two: true },
];

/**
 * THE PLAN. One entry per (arm, item): the mode the transcript is built in, and therefore the verdict and
 * the miss channel the scorer is required to come back with. Two repeats each, except where the entry is a
 * pair — `h1` in arm A is planted UNSTABLE (§2), so its two repeats disagree and the item must drop out of
 * every stable-subset denominator.
 *
 * Arm A is the floor, arm B loses through one of each of §6's channels, arm C answers the taught facts and
 * fails the held-out ones (which is §1's validity condition), arm D is C plus the tail.
 */
const PLAN = {
  A: { 'h1.E1': ['plain_abstain', 'plain_wrong'], 'h2.E1': 'plain_abstain', 'h3.E1': 'plain_wrong', 'h4.E1': 'plain_wrong',
       'k1.E2': 'plain_abstain', 'p1.P': 'plain_wrong', 'tw1.E1': 'plain_abstain', 'tw2.E1': 'plain_abstain',
       'tw3.E1': 'plain_wrong', 'm1.E1': 'plain_wrong', 'm2.E1': 'plain_ambiguous' },
  B: { 'h1.E1': 't_hit', 'h2.E1': 't_truncated', 'h3.E1': 't_had_it', 'h4.E1': 't_ignored',
       'k1.E2': 't_overflow', 'p1.P': 't_skipped_with_budget_flag', 'tw1.E1': 't_hit', 'tw2.E1': 't_hit',
       'tw3.E1': 't_query_error_with_every_other_flag', 'm1.E1': 't_wrong_subgraph_all_errored', 'm2.E1': 't_budget_with_context_flag' },
  C: { 'h1.E1': 'plain_hit', 'h2.E1': 'plain_hit', 'h3.E1': 'plain_hit', 'h4.E1': 'plain_hit',
       'k1.E2': 'plain_hit', 'p1.P': 'plain_hit', 'tw1.E1': 'plain_abstain', 'tw2.E1': 'plain_wrong',
       'tw3.E1': 'plain_wrong', 'm1.E1': 'plain_hit', 'm2.E1': 'plain_transport_error' },
  D: { 'h1.E1': 'plain_hit', 'h2.E1': 'plain_hit', 'h3.E1': 't_hit', 'h4.E1': 'plain_hit',
       'k1.E2': 'plain_hit', 'p1.P': 'plain_hit', 'tw1.E1': 't_hit', 'tw2.E1': 't_hit',
       'tw3.E1': 't_ignored', 'm1.E1': 't_hit', 'm2.E1': 't_empty_final_after_a_completed_turn' },
};
/** The leak: arm C answers every held-out fact. §1 says the run is VOID, and it must say so first. */
const LEAK = { 'tw1.E1': 'plain_hit', 'tw2.E1': 'plain_hit', 'tw3.E1': 'plain_hit' };
/** The subtler leak: arm C merely TIES arm B on held-out facts. §1's rule is C ≥ B, so this is void too. */
const LEAK_TIE = { 'tw1.E1': 'plain_hit', 'tw2.E1': 'plain_hit', 'tw3.E1': 'plain_wrong' };

/** What each mode is planted to produce. `channel` is required only where the mode is a tool-arm miss. */
const EXPECT = {
  plain_hit: { verdict: 'hit' },
  plain_wrong: { verdict: 'wrong' },
  plain_ambiguous: { verdict: 'ambiguous' },
  plain_abstain: { verdict: 'abstain' },
  plain_transport_error: { verdict: 'error' },
  t_hit: { verdict: 'hit' },
  t_truncated: { verdict: 'wrong', channel: 'truncated' },
  t_had_it: { verdict: 'wrong', channel: 'had_it_and_still_wrong' },
  t_ignored: { verdict: 'wrong', channel: 'ignored_result' },
  t_overflow: { verdict: 'wrong', channel: 'context_exhausted' },
  t_skipped_with_budget_flag: { verdict: 'wrong', channel: 'skipped' },
  t_query_error_with_every_other_flag: { verdict: 'wrong', channel: 'query_error' },
  t_wrong_subgraph_all_errored: { verdict: 'wrong', channel: 'wrong_subgraph' },
  t_budget_with_context_flag: { verdict: 'wrong', channel: 'budget_exhausted' },
  t_empty_final_after_a_completed_turn: { verdict: 'wrong', channel: 'ignored_result' },
};

/** Planted per-turn vLLM usage. The scorer must sum these, not read the last turn. */
const TOK = {
  plain: [[180, 12]],
  tool: [[2800, 70], [3400, 25]],
  overflow: [[2812, 79], [6390, 71]],       // a third turn errors and carries no usage at all
};
/** Planted wall clocks. Every one is a distinct number so a mixed-up column cannot pass by coincidence. */
const LAT = { plain: { latency_ms: 4210, model_ms: 4100 }, tool: { latency_ms: 31007, model_ms: 15003 }, overflow: { latency_ms: 61234, model_ms: 38210 } };
const TOOL_MS = 503;   // per tool result

const isTool = (mode) => mode.startsWith('t_');
const tokensFor = (mode) => (mode === 't_overflow' ? TOK.overflow : isTool(mode) ? TOK.tool : TOK.plain);
const latFor = (mode) => (mode === 't_overflow' ? LAT.overflow : isTool(mode) ? LAT.tool : LAT.plain);

const rightAnswer = (it) => (Array.isArray(it.truth) ? it.truth.join(', ') : String(it.truth));
const wrongAnswer = (it) => (it.answer_type === 'address' ? OTHER_ADDR : it.answer_type === 'decimal' ? '99' : it.answer_type === 'list<symbol>' ? 'USDC, DAI' : 'USDC');
const bodyWithTruth = (it) => {
  if (it.answer_type === 'address') return `{"data":{"vaults":[{"id":"${it.truth}","symbol":"vLQTY"}]}}`;
  if (it.answer_type === 'decimal') return `{"data":{"vaults":[{"fees":[{"feePercentage":"${it.truth}.000"}]}]}}`;
  if (it.answer_type === 'list<symbol>') return `{"data":{"pools":[{"inputTokens":[${it.truth.map((s) => `{"symbol":"${s}"}`).join(',')}]}]}}`;
  return `{"data":{"markets":[{"inputToken":{"symbol":"${it.truth}"}}]}}`;
};
const bodyWithoutTruth = () => `{"data":{"vaults":[{"id":"${OTHER_ADDR}","symbol":"NOPE","fees":[{"feePercentage":"3.5"}],"inputTokens":[{"symbol":"USDC"},{"symbol":"DAI"}]}]}}`;
const GQL_ERROR = '{"errors":[{"message":"Failed to decode `block.number` value"}]}';

const qres = (target, full, over = {}) => ({ name: 'execute_query_by_deployment_id', target, full, truncated: false, rows: 30, kept_rows: 30, is_error: false, ms: TOOL_MS, ...over });
const EV0 = { tool_calls: 0, tool_bytes_in: 0, retries: 0, context_truncated: false, context_exhausted: false, context_evictions: 0, prompt_tokens_peak: 0, budget_exhausted: false, forced_final: false, tool_errors: 0, tool_targets: [], tool_results: [], model_ms: 0, offline: false };

/**
 * The transcript for one (arm, item, repeat). Deliberately dumb: it renders the plan, it never consults
 * score.mjs. The tool MESSAGE the model was shown is written into turns[].request.messages and is NOT the
 * same string as tool_results[].full wherever a result was truncated — that asymmetry is the whole point of
 * attack 2.
 */
function transcript(arm, it, rep, mode) {
  const q = {
    id: it.id, question: `planted question for ${it.id}`, answer_type: it.answer_type, truth: it.truth,
    form: it.form, taught: it.taught, hop: it.hop, fact_ids: [it.id.split('.')[0]],
    source: { deployment_id: DEP_A, query_hash: 'h', block: 25902936, json_path: 'p' },
    source_ids: it.two ? [DEP_A, DEP_B] : [DEP_A],
  };
  const tok = tokensFor(mode), lat = latFor(mode);
  const mkTurns = (msgs) => tok.map(([p, c], i) => ({
    turn: i, request: { messages: msgs }, response: { id: `r${i}` }, ms: i === 0 ? 5100 : 6400,
    usage: { prompt_tokens: p, completion_tokens: c }, finish_reason: i === tok.length - 1 ? 'stop' : 'tool_calls',
  }));
  const base = { arm, repeat: rep, question: q, system: isTool(mode) ? 'tools' : 'plain', error: null, ...lat };
  const ev = { ...EV0, model_ms: lat.model_ms, prompt_tokens_peak: Math.max(...tok.map(([p]) => p)) };

  const withResults = (results, evOver = {}, final = wrongAnswer(it), shown = null) => ({
    ...base, final,
    turns: mkTurns([{ role: 'tool', content: shown ?? results.map((r) => r.full).join('\n') }]),
    evidence: {
      ...ev, tool_calls: results.length, tool_bytes_in: results.reduce((a, r) => a + r.full.length, 0),
      tool_results: results, tool_targets: results.map((r) => ({ name: r.name, target: r.target, args: {} })), ...evOver,
    },
  });

  switch (mode) {
    case 'plain_hit': return { ...base, final: rightAnswer(it), turns: mkTurns([]), evidence: ev };
    case 'plain_wrong': return { ...base, final: wrongAnswer(it), turns: mkTurns([]), evidence: ev };
    case 'plain_ambiguous': return { ...base, final: `It is either ${wrongAnswer(it)} or ${rightAnswer(it)}`, turns: mkTurns([]), evidence: ev };
    case 'plain_abstain': return { ...base, final: 'I do not know.', turns: mkTurns([]), evidence: ev };
    case 'plain_transport_error': return { ...base, final: null, error: 'fetch failed: ECONNREFUSED', turns: [], evidence: ev };
    case 't_hit': return withResults([qres(DEP_A, bodyWithTruth(it))], {}, rightAnswer(it));
    // The truth is in the server's bytes and NOT in the copy the model was shown. A scorer that reads the
    // message instead of `full` calls this `ignored_result`; §6 and the brief call it `truncated`.
    case 't_truncated': return withResults(
      [qres(DEP_A, bodyWithTruth(it), { truncated: true, kept_rows: 9 })], { context_truncated: true },
      wrongAnswer(it), '{"data":{"vaults":[ … truncated, 9 of 30 rows … ]}}');
    // Same asymmetry, no truncation: the model was shown a body that omits the truth, but the SERVER returned
    // it. §6 says the loop had it and answered something else.
    case 't_had_it': return withResults([qres(DEP_A, bodyWithTruth(it))], {}, wrongAnswer(it), '{"data":{"vaults":[]}}');
    case 't_ignored': return withResults([qres(DEP_A, bodyWithoutTruth())]);
    case 't_overflow': return {
      ...base, final: '',
      turns: [...mkTurns([]), { turn: 2, error: 'http 400: {"message":"This model\'s maximum context length is 8192 tokens"}', ms: 120, context_overflow: true }],
      evidence: { ...ev, tool_calls: 2, tool_bytes_in: 4000, context_truncated: true, context_exhausted: true, context_evictions: 1, forced_final: true, prompt_tokens_peak: 7680,
        tool_results: [qres(DEP_A, bodyWithTruth(it)), qres(DEP_A, bodyWithoutTruth())], tool_targets: [{ name: 'execute_query_by_deployment_id', target: DEP_A, args: {} }] },
    };
    // Two channels are plausible for each of the next four. Exactly one is correct, and it is the one the
    // ladder reaches first — the least self-serving reading available.
    case 't_skipped_with_budget_flag': return { ...base, final: wrongAnswer(it), turns: mkTurns([]), evidence: { ...ev, tool_calls: 0, budget_exhausted: true, forced_final: true } };
    case 't_query_error_with_every_other_flag': return withResults(
      [qres(DEP_A, GQL_ERROR, { is_error: true }), qres(DEP_A, '{"data":{"vaults":[]}}')],
      { budget_exhausted: true, context_exhausted: true, context_evictions: 3, tool_errors: 1 });
    case 't_wrong_subgraph_all_errored': return withResults(
      [qres(DEP_X, GQL_ERROR, { is_error: true }), qres(DEP_X, GQL_ERROR, { is_error: true })], { tool_errors: 2 });
    case 't_budget_with_context_flag': return withResults(
      [qres(DEP_A, bodyWithoutTruth()), qres(DEP_A, bodyWithoutTruth())], { budget_exhausted: true, context_exhausted: true, context_evictions: 2, forced_final: true });
    case 't_empty_final_after_a_completed_turn': return withResults([qres(DEP_A, bodyWithoutTruth())], {}, '');
    default: throw new Error(`unplanned mode ${mode}`);
  }
}

function buildRun(root, over = {}) {
  const plan = { ...PLAN, C: { ...PLAN.C, ...over } };
  for (const [arm, byItem] of Object.entries(plan)) {
    const adir = join(root, 'transcripts', arm);
    mkdirSync(adir, { recursive: true });
    for (const it of ITEMS) {
      const m = byItem[it.id];
      for (let rep = 0; rep < 2; rep++) {
        const mode = Array.isArray(m) ? m[rep] : m;
        writeFileSync(join(adir, `${it.id}.${rep}.json`), JSON.stringify(transcript(arm, it, rep, mode), null, 2));
      }
    }
  }
  writeFileSync(join(root, 'provenance.json'), JSON.stringify({
    run_id: 'PLANTED', fixture: true, offline: false, model: 'planted-model', max_model_len: 32768,
    patch: { backend: 'stub', real_training: false }, restarts_detected: 0, chunks_rerun: 0, git_commit: 'planted',
    budget: { toolCalls: 8, turns: 10, wallMs: 90000, toolResultTokens: 4000 },
  }, null, 2));
  return plan;
}

const modeOf = (plan, arm, id, rep) => { const m = plan[arm][id]; return Array.isArray(m) ? m[rep] : m; };

// ── build and score ──────────────────────────────────────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), 'bench-adversarial-'));
const keep = process.argv.includes('--keep');
const runDir = join(tmp, 'PLANTED');
mkdirSync(runDir, { recursive: true });
const plan = buildRun(runDir);

const PRICE_IN = 0.2, PRICE_OUT = 0.6, PRICE_Q = 0.00004, PRICE_K = 5;
const pricingPath = join(tmp, 'pricing.json');
writeFileSync(pricingPath, JSON.stringify({
  model: { usd_per_1m_input_tokens: PRICE_IN, usd_per_1m_output_tokens: PRICE_OUT },
  graph: { usd_per_query: PRICE_Q }, knowledge: { price: PRICE_K, currency: 'USD' },
}, null, 2));

const { summary, units } = scoreRun(runDir, { pricingPath });
const rows = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8')).rows;
const row = (arm, id, rep) => rows.find((r) => r.arm === arm && r.id === id && r.repeat === rep);

// ── ATTACK 1: does the scorer hand back exactly what was planted? ────────────────────────────────────────

t('1.1 every planted (arm, item, repeat) produced exactly one row', units.length, 4 * ITEMS.length * 2);

{
  const bad = [];
  for (const arm of ['A', 'B', 'C', 'D']) for (const it of ITEMS) for (let rep = 0; rep < 2; rep++) {
    const mode = modeOf(plan, arm, it.id, rep), want = EXPECT[mode], r = row(arm, it.id, rep);
    if (!r) { bad.push(`${arm}/${it.id}.${rep} missing`); continue; }
    if (r.verdict !== want.verdict) bad.push(`${arm}/${it.id}.${rep} verdict ${r.verdict} ≠ planted ${want.verdict} (${mode})`);
    const wantCh = want.channel ?? null;
    const isToolArm = arm === 'B' || arm === 'D';
    const expectCh = isToolArm && isMiss(want.verdict) ? wantCh : null;
    if (r.miss_channel !== expectCh) bad.push(`${arm}/${it.id}.${rep} channel ${r.miss_channel} ≠ planted ${expectCh} (${mode})`);
  }
  t('1.2 every planted verdict and channel came back exactly', bad, []);
}

{
  const bad = [];
  for (const arm of ['A', 'B', 'C', 'D']) for (const it of ITEMS) for (let rep = 0; rep < 2; rep++) {
    const mode = modeOf(plan, arm, it.id, rep), r = row(arm, it.id, rep);
    const tok = mode === 'plain_transport_error' ? [] : tokensFor(mode);
    const wp = tok.reduce((a, [p]) => a + p, 0), wc = tok.reduce((a, [, c]) => a + c, 0);
    if (r.prompt_tokens !== wp || r.completion_tokens !== wc) bad.push(`${arm}/${it.id}.${rep} tokens ${r.prompt_tokens}/${r.completion_tokens} ≠ planted ${wp}/${wc}`);
    const lat = mode === 'plain_transport_error' ? LAT.plain : latFor(mode);
    if (r.latency_ms !== lat.latency_ms || r.model_ms !== lat.model_ms) bad.push(`${arm}/${it.id}.${rep} timings ${r.latency_ms}/${r.model_ms} ≠ planted ${lat.latency_ms}/${lat.model_ms}`);
  }
  t('1.3 tokens are summed over every turn and timings are carried through unchanged', bad, []);
}

{
  // gateway queries: one per execute_query_* RESULT, per pricing.json's own note.
  const bad = [];
  for (const arm of ['B', 'D']) for (const it of ITEMS) {
    const mode = modeOf(plan, arm, it.id, 0), r = row(arm, it.id, 0);
    const want = !isTool(mode) ? 0 : mode === 't_overflow' ? 2 : mode === 't_skipped_with_budget_flag' ? 0
      : ['t_query_error_with_every_other_flag', 't_wrong_subgraph_all_errored', 't_budget_with_context_flag'].includes(mode) ? 2 : 1;
    if (r.gateway_queries !== want) bad.push(`${arm}/${it.id} gateway ${r.gateway_queries} ≠ planted ${want}`);
  }
  t('1.4 gateway queries are counted from executed queries only', bad, []);
}

{
  const bad = [];
  for (const r of rows) {
    const want = r.prompt_tokens * PRICE_IN / 1e6 + r.completion_tokens * PRICE_OUT / 1e6 + r.gateway_queries * PRICE_Q;
    if (Math.abs(r.cost_usd - want) > 1e-15) bad.push(`${r.arm}/${r.id}.${r.repeat} ${r.cost_usd} ≠ ${want}`);
  }
  t('1.5 every cost cell is tokens × the price FILE, to the last decimal', bad, []);
}

// Accuracy, recomputed here from the plan by hand — item level, hit only if every non-error repeat is a hit.
const itemStatus = (arm, it) => {
  const modes = [0, 1].map((rep) => modeOf(plan, arm, it.id, rep));
  const scored = modes.filter((m) => EXPECT[m].verdict !== 'error');
  if (!scored.length) return 'error';
  return scored.every((m) => EXPECT[m].verdict === 'hit') ? 'hit' : 'miss';
};
const UNSTABLE = ITEMS.filter((it) => { const m = PLAN.A[it.id]; return Array.isArray(m) && m[0] !== m[1]; }).map((it) => it.id);
t('1.6 the planted unstable item is the one the scorer excludes (§2)', [summary.stability.unstable_items, summary.stability.unstable_ids], [1, UNSTABLE]);

const plannedAcc = (arm, pick, { stable = true } = {}) => {
  const list = ITEMS.filter(pick).filter((it) => !stable || !UNSTABLE.includes(it.id));
  const scored = list.filter((it) => itemStatus(arm, it) !== 'error');
  const hits = scored.filter((it) => itemStatus(arm, it) === 'hit').length;
  return { hits, n: scored.length, accuracy: scored.length ? hits / scored.length : null };
};
{
  const bad = [];
  for (const arm of ['A', 'B', 'C', 'D']) for (const b of BUCKETS) {
    const want = plannedAcc(arm, (it) => it.bucket === b);
    const got = summary.arms[arm].buckets[b].stable_subset;
    if (got.hits !== want.hits || got.n_scored !== want.n || got.accuracy !== want.accuracy) bad.push(`${arm}/${b}: ${got.hits}/${got.n_scored} ≠ planted ${want.hits}/${want.n}`);
    const [lo, hi] = wilson(want.hits, want.n);
    if (Math.abs(got.ci95[0] - lo) > 1e-12 || Math.abs(got.ci95[1] - hi) > 1e-12) bad.push(`${arm}/${b}: Wilson interval is not wilson(${want.hits}, ${want.n})`);
  }
  t('1.7 accuracy per arm × bucket, hits, n and the Wilson interval are exactly the planted ones', bad, []);
}
{
  const want = plannedAcc('B', (it) => it.bucket === 'headline' || it.bucket === 'korean');
  const got = summary.arms.B.headline_E1_E2.stable_subset;
  t('1.8 the E1+E2 headline block is the planted one', [got.hits, got.n_scored], [want.hits, want.n]);
}
{
  // §5: errors leave the denominator. Arm C's m2 errored in both repeats, so it is out of arm C's n and in
  // everyone else's.
  const cMulti = summary.arms.C.buckets.multihop.stable_subset;
  t('1.9 an item whose every repeat errored leaves the accuracy denominator (§5) and is counted as an error',
    [cMulti.n_scored, cMulti.errors, summary.arms.C.verdicts.error], [1, 1, 2]);
  const bMulti = summary.arms.B.buckets.multihop.stable_subset;
  t('1.10 …while the same item stays in the denominator of the arms that answered it', bMulti.n_scored, 2);
}

// The miss decomposition, counted from the plan.
{
  const bad = [];
  for (const arm of ['B', 'D']) {
    const want = Object.fromEntries(CHANNELS.map((c) => [c, 0]));
    let misses = 0;
    for (const it of ITEMS) for (let rep = 0; rep < 2; rep++) {
      const e = EXPECT[modeOf(plan, arm, it.id, rep)];
      if (!isMiss(e.verdict)) continue;
      misses++; want[e.channel]++;
    }
    const got = summary.miss_channels[arm];
    if (JSON.stringify(got.channels) !== JSON.stringify(want)) bad.push(`${arm} channels ${JSON.stringify(got.channels)} ≠ planted ${JSON.stringify(want)}`);
    if (got.misses !== misses || got.assigned !== misses || !got.sums) bad.push(`${arm} ${got.assigned} assignments for ${got.misses} misses (planted ${misses})`);
  }
  t('1.11 the planted channel counts come back cell for cell, and they sum to the miss count', bad, []);
}
t('1.12 every one of §6\'s eight channels was exercised by the plan, so none is untested',
  CHANNELS.filter((c) => (summary.miss_channels.B.channels[c] ?? 0) + (summary.miss_channels.D.channels[c] ?? 0) === 0), []);

// McNemar, computed here from the plan.
{
  const stable = ITEMS.filter((it) => !UNSTABLE.includes(it.id) && it.bucket !== 'x');
  const pairs = stable.filter((it) => itemStatus('B', it) !== 'error' && itemStatus('C', it) !== 'error')
    .map((it) => [itemStatus('B', it) === 'hit', itemStatus('C', it) === 'hit']);
  const want = mcnemar(pairs);
  const got = summary.comparisons.B_vs_C.overall;
  t('1.13 exact McNemar over the planted discordant pairs (B vs C, all items)', [got.b, got.c], [want.b, want.c]);
}

// Cost, tokens and latency per arm, recomputed from the plan.
{
  const bad = [];
  for (const arm of ['A', 'B', 'C', 'D']) {
    let p = 0, c = 0, gq = 0, lat = [], n = 0;
    for (const it of ITEMS) for (let rep = 0; rep < 2; rep++) {
      const mode = modeOf(plan, arm, it.id, rep), r = row(arm, it.id, rep);
      p += r.prompt_tokens; c += r.completion_tokens; gq += r.gateway_queries; n++;
      if (mode !== 'plain_transport_error') lat.push(r.latency_ms);
    }
    const cost = (p * PRICE_IN / 1e6 + c * PRICE_OUT / 1e6 + gq * PRICE_Q) / n;
    if (summary.arms[arm].tokens.prompt_total !== p || summary.arms[arm].tokens.completion_total !== c) bad.push(`${arm} token totals`);
    if (summary.arms[arm].tools.gateway_queries_total !== gq) bad.push(`${arm} gateway total`);
    if (Math.abs(summary.arms[arm].cost.per_question_usd - cost) > 1e-15) bad.push(`${arm} cost/question ${summary.arms[arm].cost.per_question_usd} ≠ ${cost}`);
    const mean = lat.reduce((a, x) => a + x, 0) / lat.length;
    if (Math.abs(summary.arms[arm].timing.latency_ms_mean - mean) > 1e-9) bad.push(`${arm} mean latency ${summary.arms[arm].timing.latency_ms_mean} ≠ ${mean} over the ${lat.length} units that recorded one`);
  }
  t('1.14 token totals, gateway totals, cost/question and mean latency are the planted ones', bad, []);
}
near('1.15 N* is the price file\'s knowledge price ÷ the measured per-question difference',
  summary.break_even.n_star, PRICE_K / (summary.arms.B.cost.per_question_usd - summary.arms.C.cost.per_question_usd));

// The planted leak.
t('1.16 with arm C failing the held-out facts, the tripwire passes and the run is not void', [summary.leakage.verdict, summary.VOID], ['pass', false]);
{
  const leakDir = join(tmp, 'PLANTED-LEAK');
  mkdirSync(leakDir, { recursive: true });
  buildRun(leakDir, LEAK);
  const s = scoreRun(leakDir, { pricingPath }).summary;
  t('1.17 a planted arm-C hit on the held-out facts VOIDS the run', [s.VOID, s.leakage.verdict], [true, 'VOID — LEAKAGE']);
  t('1.18 …and it is the FIRST thing stamped on the summary, not a footnote under a good headline', s.stamps[0], 'RUN VOID — see the leakage tripwire');
  ok('1.19 …and the void is a triggered falsifier, printed above the tables', s.falsifiers.some((f) => /leakage/i.test(f.name) && f.verdict === 'TRIGGERED'));
  const md = readFileSync(join(leakDir, 'summary.md'), 'utf8');
  ok('1.20 …and summary.md says RUN VOID: YES before it prints any accuracy table', /RUN VOID: YES/.test(md) && md.indexOf('RUN VOID: YES') < md.indexOf('## 1. Accuracy'));
  ok('1.21 …even though arm C\'s headline accuracy still looks excellent, which is how a leak hides', s.arms.C.headline_E1_E2.stable_subset.accuracy === 1);

  const tieDir = join(tmp, 'PLANTED-LEAK-TIE');
  mkdirSync(tieDir, { recursive: true });
  buildRun(tieDir, LEAK_TIE);
  const st = scoreRun(tieDir, { pricingPath }).summary;
  t('1.22 §1\'s rule is C ≥ B, so a TIE on the held-out facts is leakage too', [st.VOID, st.leakage.arm_B, st.leakage.arm_C], [true, 2 / 3, 2 / 3]);
}

// ── ATTACK 2: the channel table ──────────────────────────────────────────────────────────────────────────

const chOf = (arm, id) => row(arm, id, 0).miss_channel;
t('2.1 zero tool calls with the budget flag set is `skipped`, not `budget_exhausted`', chOf('B', 'p1.P'), 'skipped');
t('2.2 every query off-target AND every query errored is `wrong_subgraph`, not `query_error`', chOf('B', 'm1.E1'), 'wrong_subgraph');
t('2.3 on-target queries that all failed, with the budget AND context flags also set, is `query_error`', chOf('B', 'tw3.E1'), 'query_error');
t('2.4 budget and context both exhausted is `budget_exhausted` — the cap bound first', chOf('B', 'm2.E1'), 'budget_exhausted');
t('2.5 an overflow that also had the truth on screen is `context_exhausted`, not `had_it_and_still_wrong`', chOf('B', 'k1.E2'), 'context_exhausted');
t('2.6 the truth only inside a cut result is `truncated`', chOf('B', 'h2.E1'), 'truncated');
t('2.7 the truth inside an uncut result is `had_it_and_still_wrong`', chOf('B', 'h3.E1'), 'had_it_and_still_wrong');
t('2.8 on-target rows without the truth is `ignored_result`', chOf('B', 'h4.E1'), 'ignored_result');

{
  // The two channels that carry the thesis must be decided against tool_results[].full — what The Graph
  // returned — and NOT against the truncated copy that fitted in the window.
  const it = ITEMS.find((x) => x.id === 'h3.E1');
  const shownWithout = transcript('B', it, 0, 't_had_it');
  ok('2.9 the fixture really does hide the truth from the copy the model was shown',
    !JSON.stringify(shownWithout.turns).includes(String(it.truth) + '.000') && shownWithout.evidence.tool_results[0].full.includes(String(it.truth) + '.000'));
  t('2.10 …and the channel is decided against the server bytes: had_it_and_still_wrong, not ignored_result',
    missChannel(shownWithout).channel, 'had_it_and_still_wrong');

  // Flip ONLY the truncation flag. §6 moves the channel (that is its rule); the VERDICT must not move,
  // because a verdict is a function of `final` alone.
  const cut = transcript('B', ITEMS.find((x) => x.id === 'h2.E1'), 0, 't_truncated');
  const uncut = JSON.parse(JSON.stringify(cut));
  uncut.evidence.tool_results[0].truncated = false;
  uncut.evidence.context_truncated = false;
  t('2.11 flipping the truncation flag does not move the verdict', [verdictFor(cut).verdict, verdictFor(uncut).verdict], ['wrong', 'wrong']);
  t('2.12 …it moves only the channel, which is §6\'s rule for `truncated`', [missChannel(cut).channel, missChannel(uncut).channel], ['truncated', 'had_it_and_still_wrong']);

  // The inverse: a truth that exists ONLY in the shown copy and not in the server bytes must never be
  // credited. This is the shape a scorer that read the wrong field would get right and this one must not.
  const forged = JSON.parse(JSON.stringify(cut));
  forged.evidence.tool_results[0].full = bodyWithoutTruth();
  forged.evidence.tool_results[0].truncated = false;
  forged.turns[0].request.messages = [{ role: 'tool', content: `{"symbol":"${it.truth}"}` }];
  t('2.13 a truth present only in the transcript\'s message copy is NOT credited as delivered', missChannel(forged).channel, 'ignored_result');
}

{
  // Determinism: the order of the recorded results must not change the answer.
  const it = ITEMS.find((x) => x.id === 'tw3.E1');
  const a = transcript('B', it, 0, 't_query_error_with_every_other_flag');
  const b = JSON.parse(JSON.stringify(a));
  b.evidence.tool_results.reverse(); b.evidence.tool_targets.reverse();
  t('2.14 reversing the order of tool_results does not change the channel', missChannel(a).channel, missChannel(b).channel);
}
{
  // Re-scoring the same directory twice must produce byte-identical rows.
  const first = readFileSync(join(runDir, 'results.json'), 'utf8');
  scoreRun(runDir, { pricingPath });
  const second = readFileSync(join(runDir, 'results.json'), 'utf8');
  const strip = (s) => s.replace(/"scored_at": "[^"]*"/g, '');
  t('2.15 re-scoring is deterministic: results.json is byte-identical apart from the timestamp', strip(first) === strip(second), true);
}
{
  // Exhaustive-and-exclusive, asserted over every fixture in this file rather than over the ones I chose.
  const bad = [];
  for (const arm of ['B', 'D']) {
    const misses = rows.filter((r) => r.arm === arm && r.miss);
    const assigned = misses.filter((r) => CHANNELS.includes(r.miss_channel));
    if (assigned.length !== misses.length) bad.push(`${arm}: ${misses.length - assigned.length} miss(es) carry a channel that is not one of §6's eight`);
    const hits = rows.filter((r) => r.arm === arm && r.hit && r.miss_channel != null);
    if (hits.length) bad.push(`${arm}: ${hits.length} HIT(s) were given a miss channel`);
  }
  for (const arm of ['A', 'C']) {
    const withCh = rows.filter((r) => r.arm === arm && r.miss_channel != null);
    if (withCh.length) bad.push(`${arm}: a tool-less arm was given ${withCh.length} miss channel(s)`);
  }
  t('2.16 every miss in a tool arm carries exactly one of §6\'s eight channels, and nothing else carries any', bad, []);
}

// ── ATTACK 3: the honesty rails ──────────────────────────────────────────────────────────────────────────

const HERE = fileURLToPath(new URL('.', import.meta.url));
const readSrc = (f) => readFileSync(join(HERE, f), 'utf8');
{
  const src = readSrc('score.mjs') + readSrc('normalize.mjs');
  ok('3.1 no headline path calls out to a model: no fetch, no http, no child process in the scorer',
    !/\bfetch\s*\(|node:https?|node:net|node:dns|child_process|execSync|spawnSync/.test(src));
  ok('3.2 the scorer reads no environment variable at all, so no key can change a number', !/process\.env/.test(src));
  // Every number the cost formula uses must come from the price file. The formula itself may name only the
  // fields; a literal beside a price field is the thing being forbidden.
  const from = src.indexOf('export function costOf');
  const costFn = src.slice(from, src.indexOf('\n}', from));
  const literals = [...costFn.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)].map((m) => m[0]).filter((x) => x !== '1e6' && x !== '0');
  t('3.3 the cost function contains no price literal — only the 1e6 that turns per-million into per-token', literals, []);
  ok('3.4 every price is read from the pricing object, by name', /pricing\?\.model\?\.usd_per_1m_input_tokens/.test(costFn) && /pricing\?\.graph\?\.usd_per_query/.test(costFn));
}
{
  // A price change must move every cost cell and N*. If a constant were baked in anywhere, this fails.
  const p2 = join(tmp, 'pricing2.json');
  writeFileSync(p2, JSON.stringify({ model: { usd_per_1m_input_tokens: PRICE_IN * 10, usd_per_1m_output_tokens: PRICE_OUT * 10 }, graph: { usd_per_query: PRICE_Q * 10 }, knowledge: { price: PRICE_K, currency: 'USD' } }, null, 2));
  const s2 = scoreRun(runDir, { pricingPath: p2, outDir: join(tmp, 'out-10x') }).summary;
  near('3.5 ten times the price is ten times the cost per question, in every arm', s2.arms.B.cost.per_question_usd, summary.arms.B.cost.per_question_usd * 10, 1e-12);
  near('3.6 …and N* falls by the same factor, because it is a quotient of the two', s2.break_even.n_star, summary.break_even.n_star / 10, 1e-9);
  const p3 = join(tmp, 'pricing3.json');
  writeFileSync(p3, JSON.stringify({ model: {}, graph: {}, knowledge: { price: null } }, null, 2));
  const s3 = scoreRun(runDir, { pricingPath: p3, outDir: join(tmp, 'out-nopricing') }).summary;
  t('3.7 with no prices in the file, every cell comes back unpriced with a reason — never zero',
    [s3.arms.B.cost.per_question_usd, s3.arms.B.cost.priced_units, /missing/.test(s3.arms.B.cost.unpriced_reason)], [null, 0, true]);
  t('3.8 …and N* is refused rather than invented', s3.break_even.n_star, null);
}
{
  // §5's denominator rule, the one the whole study rests on.
  const ctx = rows.filter((r) => r.context_exhausted);
  ok('3.9 context_exhausted units are INSIDE the accuracy denominator (§3: a miss, never an error)', ctx.length > 0 && ctx.every((r) => r.scored && r.verdict === 'wrong'));
  const err = rows.filter((r) => r.verdict === 'error');
  ok('3.10 error units are OUTSIDE it', err.length > 0 && err.every((r) => !r.scored));
  const amb = rows.filter((r) => r.verdict === 'ambiguous');
  ok('3.11 ambiguous units are scored, counted as misses, and never as hits', amb.length > 0 && amb.every((r) => r.scored && r.miss && !r.hit));
  ok('3.12 …and ambiguous has its own column in the verdict split', 'ambiguous' in summary.arms.A.verdicts && summary.arms.A.verdicts.ambiguous === 2);
  ok('3.13 abstain is a miss in the denominator but is never counted as `wrong`',
    rows.some((r) => r.verdict === 'abstain' && r.miss && r.scored) && summary.arms.A.verdicts.abstain > 0);
}
{
  const md = readFileSync(join(runDir, 'summary.md'), 'utf8');
  ok('3.14 summary.md states the no-LLM-judge rule where a reader will see it', /no LLM judge/i.test(md));
  ok('3.15 summary.md prints §7\'s threats and the fact-coherence warning', /Threats to validity/.test(md) && /within-fact/i.test(md));
  ok('3.16 summary.md prints the miss table with its own sum check', /total assigned/.test(md) && /sums/.test(md));
}


// ── the defects this adversarial pass went looking for ───────────────────────────────────────────────────
// Everything from here down failed against the scorer as it stood at the start of this session. Each one is
// a way a table could be wrong without any test noticing, so each is pinned before it is fixed.

{
  // A quantity that was never recorded must not be averaged as if it were zero — that makes an arm with
  // failures look FASTER than one without, and it makes src/score.mjs and src/chart.mjs (whose own `mean`
  // filters non-finite values) print different numbers for the same run with no cross-check between them.
  const dir = join(tmp, 'NO-MODEL-TIME');
  mkdirSync(dir, { recursive: true });
  buildRun(dir);
  const f = join(dir, 'transcripts', 'A', 'h2.E1.0.json');
  const doc = JSON.parse(readFileSync(f, 'utf8'));
  doc.model_ms = null; doc.latency_ms = null;      // the runner crashed before it could time this unit
  delete doc.evidence.model_ms;
  writeFileSync(f, JSON.stringify(doc, null, 2));
  const s = scoreRun(dir, { pricingPath }).summary;
  const rs = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')).rows.filter((r) => r.arm === 'A');
  const withValue = rs.filter((r) => Number.isFinite(r.model_ms)).map((r) => r.model_ms);
  const want = withValue.reduce((a, x) => a + x, 0) / withValue.length;
  near('6.1 a unit whose model time was never recorded is EXCLUDED from the mean, not counted as 0 ms', s.arms.A.timing.model_ms_mean, want, 1e-9);
  near('6.2 …the same for end-to-end latency', s.arms.A.timing.latency_ms_mean,
    rs.filter((r) => Number.isFinite(r.latency_ms)).reduce((a, r) => a + r.latency_ms, 0) / rs.filter((r) => Number.isFinite(r.latency_ms)).length, 1e-9);
  near('6.3 …and score.mjs now agrees with chart.mjs, which has always filtered them',
    s.arms.A.timing.latency_ms_mean, latencyTable(JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')).rows).byArm.A.mean_ms, 1e-9);
  ok('6.4 …and the count of units that carried no timing is reported rather than hidden', s.arms.A.timing.units_without_latency === 1 && s.arms.A.timing.units_without_model_ms === 1);
}

{
  // §5 excludes `error` from the denominator, so anything scored `error` is a datum deleted from the study.
  // A transcript that HAS an answer must never be deleted, whatever else the runner also recorded.
  const it = ITEMS[0];
  const withBoth = { ...transcript('A', it, 0, 'plain_hit'), error: 'fetch failed on a later retry' };
  t('6.5 an answer that exists is scored even when the runner also recorded a transport error', verdictFor(withBoth).verdict, 'hit');
  const noAnswer = { ...transcript('A', it, 0, 'plain_transport_error') };
  t('6.6 …and a transport error with no answer at all is still an `error`', verdictFor(noAnswer).verdict, 'error');
}

{
  // An item that declares no deployment is OUR metadata defect. Charging it to `wrong_subgraph` blames arm B
  // for a query it had no way to aim, and `wrong_subgraph` is the channel §3 concedes is "a fact about agent
  // plumbing" — i.e. the one that reads worst for the tool arm.
  const orphan = { ...ITEMS[2], id: 'orphan.E1' };
  const tr = transcript('B', orphan, 0, 't_had_it');
  tr.question.source_ids = []; delete tr.question.source;
  const m = missChannel(tr);
  t('6.7 an item with no declared deployment does not manufacture a `wrong_subgraph` miss', m.channel, 'had_it_and_still_wrong');
  ok('6.8 …the missing metadata is recorded on the assignment instead', m.note.no_source_ids === true);
  const dir = join(tmp, 'ORPHAN');
  mkdirSync(dir, { recursive: true });
  buildRun(dir);
  for (const rep of [0, 1]) {
    const f = join(dir, 'transcripts', 'B', `h3.E1.${rep}.json`);
    const doc = JSON.parse(readFileSync(f, 'utf8'));
    doc.question.source_ids = []; delete doc.question.source;
    writeFileSync(f, JSON.stringify(doc, null, 2));
  }
  const s = scoreRun(dir, { pricingPath }).summary;
  ok('6.9 …and the run is stamped, because a question set that cannot say where its answer came from is a defect',
    s.stamps.some((x) => /source_ids|deployment/i.test(x)) && s.integrity.items_without_source_ids === 1);
}

{
  // The sum check must be a check. A channel outside §6's eight would still sum, and would then be missing
  // from the eight printed rows — a table that silently does not add up.
  const bRows = rows.filter((r) => r.arm === 'B');
  const firstMiss = bRows.findIndex((r) => r.miss);
  const doctored = bRows.map((r, i) => (i === firstMiss ? { ...r, miss_channel: 'invented_channel' } : r));
  let threw = null;
  try { summarize({ units: doctored, transcripts: [], provenance: null, pricing: {}, pricingPath: 'x', runDir: join(tmp, 'nope'), runId: 'nope' }); }
  catch (e) { threw = e.message; }
  ok(`6.10 a miss assigned to a channel that is not one of §6's eight fails the run loudly`, threw != null && /invented_channel/.test(threw));
}

{
  // §6.3, in as many words: "So N* is a curve in the number of buyers, not a scalar. Cumulative cost against
  // question count for one buyer, ten, a hundred — with the single-buyer line shown even where it never
  // crosses." The scalar alone is the flattering half of that sentence.
  const be = summary.break_even;
  ok('6.11 §6.3: the break-even is a curve in the number of buyers, not a scalar', Array.isArray(be.per_buyer) && be.per_buyer.length >= 3);
  const one = be.per_buyer?.find((x) => x.buyers === 1), hundred = be.per_buyer?.find((x) => x.buyers === 100);
  near('6.12 …the single-buyer point is the whole price over the measured difference', one?.n_star, PRICE_K / be.delta_usd_per_question);
  near('6.13 …and a hundred buyers divide the one-time price, not the per-question saving', hundred?.n_star, (PRICE_K / 100) / be.delta_usd_per_question);
  const md = readFileSync(join(runDir, 'summary.md'), 'utf8');
  ok('6.14 …the unflattering single-buyer number is printed first, as §6.2 requires', /single (buyer|user)/i.test(md));
  ok('6.15 …and the curve is in the summary a reader actually reads', /1 buyer|one buyer|buyers/i.test(md) && /100/.test(md));
}

{
  // §6: "Setup is separated from inference, like every other cost here. Applying a patch takes seconds and
  // happens once per node, so arm C's apply time is recorded separately from its per-item latency."
  const dir = join(tmp, 'WITH-LOAD');
  mkdirSync(dir, { recursive: true });
  buildRun(dir);
  const prov = JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8'));
  prov.knowledge_load_ms = 2431;
  writeFileSync(join(dir, 'provenance.json'), JSON.stringify(prov, null, 2));
  const s = scoreRun(dir, { pricingPath }).summary;
  t('6.16 §6: the one-time knowledge load is reported separately from per-item latency', s.setup?.knowledge_load_ms, 2431);
  ok('6.17 …and the measured number itself is in the summary a reader reads, labelled as setup',
    /2431 ms/.test(readFileSync(join(dir, 'summary.md'), 'utf8')) && /Setup is separated from inference/.test(readFileSync(join(dir, 'summary.md'), 'utf8')));
  ok('6.18 …while a run that never measured it says so instead of printing a number', summary.setup?.knowledge_load_ms == null && /not recorded|not measured/i.test(summary.setup?.note ?? ''));
}

{
  const noCap = join(tmp, 'NO-CAP');
  mkdirSync(noCap, { recursive: true });
  buildRun(noCap);
  const prov = JSON.parse(readFileSync(join(noCap, 'provenance.json'), 'utf8'));
  delete prov.budget;
  writeFileSync(join(noCap, 'provenance.json'), JSON.stringify(prov, null, 2));

  const md = readFileSync(join(runDir, 'summary.md'), 'utf8');
  ok('6.19 §3: the budget question is ANSWERED from the median, not gestured at with a column',
    /The budget question, answered/.test(md) && /was NOT the binding constraint for the median item/.test(md));
  t('6.19b …from the run\'s own recorded cap, and the median the units actually used',
    summary.budget.per_arm.map((b) => [b.arm, b.median_tool_calls, b.cap_tool_calls]), [['B', 1, 8], ['D', 1, 8]]);
  ok('6.19c …and a run whose provenance recorded no cap says that instead of guessing one',
    /cannot be compared/.test(JSON.stringify(scoreRun(join(tmp, 'NO-CAP'), { pricingPath }).summary.budget)));
  ok('6.20 §6 lists `guard_verdict` among the measured fields and no transcript carries one — the summary says so rather than dropping it silently',
    /guard_verdict/.test(md));
}


{
  // A stale transcript from a re-run is the quietest way to corrupt a table: §4 discards a chunk "unwritten"
  // when the table state was lost, so a file left behind under a slightly different name would be read as an
  // extra unit and silently double-count an item.
  const dir = join(tmp, 'DUPLICATE');
  mkdirSync(dir, { recursive: true });
  buildRun(dir);
  const f = join(dir, 'transcripts', 'A', 'h1.E1.0.json');
  cpSync(f, join(dir, 'transcripts', 'A', 'h1.E1.0.rerun.json'));
  let threw = null;
  try { scoreRun(dir, { pricingPath }); } catch (e) { threw = e.message; }
  ok('6.21 two transcripts for the same (arm, item, repeat) fail the run instead of double-counting it',
    threw != null && /h1\.E1/.test(threw) && /rerun/.test(threw));
}

{
  // An item whose form the sampler never declared would be counted in `overall` and in no bucket at all, so
  // the bucket rows would not add up to the item count and nobody would see it.
  const dir = join(tmp, 'UNCLASSIFIED');
  mkdirSync(dir, { recursive: true });
  buildRun(dir);
  for (const arm of ['A', 'B', 'C', 'D']) for (const rep of [0, 1]) {
    const f = join(dir, 'transcripts', arm, `h4.E1.${rep}.json`);
    const doc = JSON.parse(readFileSync(f, 'utf8'));
    doc.question.form = 'E3';
    writeFileSync(f, JSON.stringify(doc, null, 2));
  }
  const s = scoreRun(dir, { pricingPath }).summary;
  t('6.22 an item in no declared bucket is counted and named, not silently dropped from every bucket table',
    [s.counts.unclassified_items, s.counts.unclassified_ids], [1, ['h4.E1']]);
  ok('6.23 …and the run is stamped, because the bucket rows no longer add up to the item count',
    s.stamps.some((x) => /bucket/i.test(x) && /h4\.E1/.test(x)));
}

{
  // §1's whole design is that "all arms answer the same items, so the comparison is paired". An arm that is
  // missing items is still averaged into the same table beside the others unless somebody checks.
  const dir = join(tmp, 'RAGGED');
  mkdirSync(dir, { recursive: true });
  buildRun(dir);
  rmSync(join(dir, 'transcripts', 'C', 'h2.E1.0.json'));
  rmSync(join(dir, 'transcripts', 'C', 'h2.E1.1.json'));
  const s = scoreRun(dir, { pricingPath }).summary;
  ok('6.24 an arm that did not answer every item is stamped, because §1\'s comparison is paired',
    s.stamps.some((x) => /same items|item set/i.test(x) && /C/.test(x)) && s.counts.item_set_mismatch?.C?.missing?.includes('h2.E1'));
}

{
  // §2's definition of `unstable`, pinned: it is a disagreement in the NORMALISED answer, not in the text.
  const dir = join(tmp, 'ABSTAIN-WORDING');
  mkdirSync(dir, { recursive: true });
  buildRun(dir);
  const f = join(dir, 'transcripts', 'A', 'h2.E1.1.json');
  const doc = JSON.parse(readFileSync(f, 'utf8'));
  doc.final = 'I cannot determine that from what I know.';   // a different sentence, the same verdict
  writeFileSync(f, JSON.stringify(doc, null, 2));
  const s = scoreRun(dir, { pricingPath }).summary;
  t('6.25 two differently worded refusals are the SAME answer — the item is not called unstable for wording',
    s.stability.unstable_ids, ['h1.E1']);
}

{
  // §6's side-effect table is produced by another instrument. The summary must say whether it exists for
  // this run rather than leaving a reader to assume it was done.
  const md = readFileSync(join(runDir, 'summary.md'), 'utf8');
  ok('6.26 §6: the summary says whether the 50-prompt side-effect table exists for this run', /locality/i.test(md));
  // A table with a row of the wrong width renders as a broken table, which is how a number gets read off the
  // wrong column. Every table in the document must be rectangular.
  const ragged = [];
  let head = null, sep = false, nrow = 0;
  for (const line of md.split('\n')) {
    if (!/^\|.*\|\s*$/.test(line)) { head = null; sep = false; continue; }
    const cells = line.split('|').length;
    if (head == null) { head = cells; sep = false; nrow = 0; continue; }
    if (!sep) { sep = true; if (cells !== head) ragged.push(`separator ${cells} != ${head}`); continue; }
    nrow++;
    if (cells !== head) ragged.push(`row ${nrow} has ${cells - 2} cells, header has ${head - 2}: ${line.slice(0, 60)}`);
  }
  t('6.27 every table in summary.md is rectangular — no row can be read off the wrong column', ragged, []);
}

{
  // §6's four-cell table compares this run's arms against the same arms with the MCP transport failing. It
  // is only a comparison if the two runs answered the same items under the same rules; a sibling scored over
  // a different question set would produce four cells that look like a result and are not one.
  const off = join(tmp, 'PLANTED-offline');
  mkdirSync(off, { recursive: true });
  buildRun(off);
  rmSync(join(off, 'transcripts', 'A', 'm2.E1.0.json'));
  rmSync(join(off, 'transcripts', 'A', 'm2.E1.1.json'));
  for (const arm of ['B', 'C', 'D']) for (const rep of [0, 1]) rmSync(join(off, 'transcripts', arm, `m2.E1.${rep}.json`));
  const prov = JSON.parse(readFileSync(join(off, 'provenance.json'), 'utf8'));
  prov.offline = true;
  writeFileSync(join(off, 'provenance.json'), JSON.stringify(prov, null, 2));
  scoreRun(off, { pricingPath });
  const s = scoreRun(runDir, { pricingPath }).summary;
  ok('6.28 §6: an offline sibling scored over a different item set is stamped NOT comparable, not printed as four cells',
    s.offline.available && s.offline.comparable === false && /NOT comparable/.test(s.stamps.join(' ')));
  rmSync(off, { recursive: true, force: true });
  const s2 = scoreRun(runDir, { pricingPath }).summary;
  ok('6.29 …and with no offline run at all, the table says so rather than inventing a cell', s2.offline.available === false);
}

// ── ATTACK 4: a clean checkout, no GPU, no key, no network ───────────────────────────────────────────────

{
  // A clean checkout is what a stranger clones: transcripts and provenance, nothing derived.
  const clean = join(tmp, 'CLEAN');
  mkdirSync(clean, { recursive: true });
  cpSync(join(runDir, 'transcripts'), join(clean, 'transcripts'), { recursive: true });
  cpSync(join(runDir, 'provenance.json'), join(clean, 'provenance.json'));
  t('4.1 the clean checkout carries no scored output at all',
    readdirSync(clean).filter((f) => /^(results|summary|per-question)/.test(f)), []);

  const probe = join(tmp, 'isolated.mjs');
  writeFileSync(probe, `
    // Every route to the network is replaced by something that throws before the scorer is even imported.
    const boom = (what) => () => { throw new Error('NETWORK ACCESS ATTEMPTED: ' + what); };
    globalThis.fetch = boom('fetch');
    globalThis.XMLHttpRequest = boom('xhr');
    for (const [mod, keys] of [['node:http', ['request', 'get']], ['node:https', ['request', 'get']], ['node:net', ['connect', 'createConnection']], ['node:dns', ['lookup', 'resolve']]]) {
      const m = await import(mod);
      for (const k of keys) { try { m.default[k] = boom(mod + '.' + k); } catch {} }
    }
    if (process.env.GRAPH_API_KEY) { console.error('GRAPH_API_KEY IS SET'); process.exit(3); }
    const { scoreRun } = await import(${JSON.stringify(join(HERE, 'score.mjs'))});
    const { summary } = scoreRun(process.argv[2], { pricingPath: process.argv[3], outDir: process.argv[4] });
    console.log(JSON.stringify({ void: summary.VOID, arms: Object.fromEntries(Object.entries(summary.arms).map(([a, x]) => [a, x.headline_E1_E2.stable_subset.accuracy])) }));
  `);
  const cleanOut = join(tmp, 'CLEAN-OUT');
  let isolated = null, isoErr = null;
  try {
    isolated = execFileSync(process.execPath, [probe, clean, pricingPath, cleanOut], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: '',
        // pointed at a closed port, so anything that tried to reach a service would fail loudly
        VLLM_URL: 'http://127.0.0.1:1', AINIZE_NODE: 'http://127.0.0.1:1', GRAPH_MCP_URL: 'http://127.0.0.1:1' },
    });
  } catch (e) { isoErr = String(e.stderr ?? e.message); }
  ok(`4.2 a clean checkout re-scores with GRAPH_API_KEY unset, services at a closed port and the network stubbed out${isoErr ? ` — ${isoErr.slice(0, 300)}` : ''}`, isolated != null);
  if (isolated) {
    const got = JSON.parse(isolated);
    t('4.3 …and it recovers the same headline accuracies as the first scoring',
      got.arms, Object.fromEntries(Object.keys(summary.arms).map((a) => [a, summary.arms[a].headline_E1_E2.stable_subset.accuracy])));
    const strip = (s) => JSON.parse(s.replace(/"scored_at": "[^"]*"/g, '"scored_at": ""')).rows;
    t('4.4 …with byte-identical rows, so re-scoring is genuinely cheaper than trusting us (§7.5)',
      JSON.stringify(strip(readFileSync(join(cleanOut, 'results.json'), 'utf8'))) === JSON.stringify(strip(readFileSync(join(runDir, 'results.json'), 'utf8'))), true);
  }
}

// ── ATTACK 5: §5 and §6, line by line ────────────────────────────────────────────────────────────────────

{
  // §5's per-type rules, exercised through the scorer rather than through normalize.mjs's own test.
  const it = (over) => ({ id: 'x', answer_type: 'address', truth: TRUTH_ADDR, form: 'E1', taught: true, hop: 1, source_ids: [DEP_A], ...over });
  const v = (final, over) => verdictFor({ arm: 'A', repeat: 0, question: it(over), final, error: null, turns: [{ turn: 0, response: {}, ms: 1, usage: { prompt_tokens: 1, completion_tokens: 1 } }], evidence: EV0 }).verdict;
  t('5.1 address: compared lowercase, EIP-55 casing is not part of the claim', v(TRUTH_ADDR.toUpperCase().replace('0X', '0x')), 'hit');
  t('5.2 symbol: upper-cased, non-alphanumerics dropped', v('  weth-x ', { answer_type: 'symbol', truth: 'WETHX' }), 'hit');
  t('5.3 integer: thousands separators and units dropped', v('1,234 pools', { answer_type: 'integer', truth: 1234 }), 'hit');
  t('5.4 decimal: ±1% relative, and 1.5% out is wrong', [v('20.1', { answer_type: 'decimal', truth: 20 }), v('20.4', { answer_type: 'decimal', truth: 20 })], ['hit', 'wrong']);
  t('5.5 date: ISO, exact to the day', [v('2026-09-04', { answer_type: 'date', truth: '2026-09-04' }), v('2026-09-05', { answer_type: 'date', truth: '2026-09-04' })], ['hit', 'wrong']);
  t('5.6 list<T>: the headline is exact set equality, not overlap',
    [v('SPURDO, WETH', { answer_type: 'list<symbol>', truth: ['SPURDO', 'WETH'] }), v('SPURDO', { answer_type: 'list<symbol>', truth: ['SPURDO', 'WETH'] })], ['hit', 'wrong']);
  t('5.7 …and the Jaccard partial travels beside it without ever being blended in',
    summary.arms.C.partial_mean_lists != null && summary.arms.C.buckets.headline.stable_subset.accuracy <= 1, true);
}
{
  // §6's per-unit field list.
  const r = row('B', 'h3.E1', 0);
  const wanted = ['verdict', 'partial', 'latency_ms', 'model_ms', 'prompt_tokens', 'completion_tokens', 'tool_calls', 'tool_bytes_in', 'context_truncated', 'retries', 'cost_usd'];
  t('5.8 every field §6 asks to be written per (arm, item, repeat) is in results.json', wanted.filter((k) => !(k in r)), []);
  const csv = readFileSync(join(runDir, 'per-question.csv'), 'utf8').split('\n');
  t('5.9 per-question.csv carries one row per (arm, item, repeat) plus a header', csv.length, rows.length + 2);
  ok('5.10 …and names the miss channel in it', csv[0].includes('miss_channel'));
}
{
  const md = readFileSync(join(runDir, 'summary.md'), 'utf8');
  ok('5.11 §6: latency and tokens are reported as results, with model time separable from network time', /model_ms|model ms/.test(md) && /latency/i.test(md));
  ok('5.11b §6: "it is reported first" — the cost of retrieval is printed BEFORE the accuracy tables',
    md.indexOf('What retrieval cost') > 0 && md.indexOf('What retrieval cost') < md.indexOf('## 1. Accuracy'));
  const asserted = summary.falsifiers.filter((f) => /≥|≤|within/.test(f.name) && f.verdict !== 'NOT EVALUABLE');
  t('5.11c §1: no comparison is asserted without its exact-McNemar p and both Wilson intervals beside it',
    asserted.filter((f) => !(/McNemar/.test(f.detail) && (f.detail.match(/\[\d+–\d+\]/g) ?? []).length === 2)).map((f) => f.name), []);
  ok('5.11d …and there is at least one such comparison to check', asserted.length >= 4);
  ok('5.12 §6: the break-even is printed with its formula and its source file', /N\*/.test(md) && /pricing\.json/.test(md));
  ok('5.13 §1: every bucket is printed separately with its own McNemar', BUCKETS.every((b) => md.includes(b)) && /McNemar/.test(md));
  ok('5.14 §1: the pre-registered per-bucket expectation is printed beside the result', /pre-registered/.test(md));
  ok('5.15 §9: a stub patch is stamped SIMULATED PATCH — NOT A TRAINED MODEL', /SIMULATED PATCH/.test(md));
}

if (keep) console.error(`planted run kept at ${runDir} (leak variants beside it)`);
else rmSync(tmp, { recursive: true, force: true });

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
