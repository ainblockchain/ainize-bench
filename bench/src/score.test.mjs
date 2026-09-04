#!/usr/bin/env node
/**
 * Self-test for src/score.mjs. `node src/score.test.mjs` — no GPU, no API key, no network, no model.
 *
 * runs/ is empty: no run has been scored yet, so everything below is built from SYNTHETIC transcripts written
 * by this file and labelled as fixtures. They are shaped like the real thing — the same evidence object the
 * runner emits, `tool_results[].full` carrying the untruncated server text, per-turn vLLM `usage` — and they
 * are written into a temp directory that is deleted at the end, so no fabricated row can ever be mistaken for
 * a measurement. Every fixture run also carries `provenance.fixture: true`, which makes the scorer stamp
 * "FIXTURE — SYNTHETIC TRANSCRIPTS, NOT A RUN" across the summary if one is ever copied into runs/.
 *
 *   node src/score.test.mjs            run the cases
 *   node src/score.test.mjs --keep     leave the fixture run on disk and print its path
 *
 * The cases exist to pin the rules that are load-bearing for the claim and cheap to break in a refactor:
 * the five verdicts; `context_exhausted` + empty final is a MISS (from a transcript shaped like the real
 * overflow the runner recorded on 2026-09-04); `abstain` needs a positive refusal; `ambiguous` is a miss but
 * is reported separately; `wrong_subgraph` is decided over `source_ids[]` with the hop-1 fallback; each of
 * §6's eight channels; the channels summing to the miss count; tokens summed over turns; and a cost that
 * moves when a price in pricing.json moves.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  bucketOf, sourceIdsOf, sumTokens, costOf, occursIn, truthOccursIn, queryFailed,
  verdictFor, missChannel, isMiss, CHANNELS, scoreRun, itemOutcome, isExecutedQuery, checkIntegrity, BENCH,
} from './score.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};
const ok = (name, cond, detail = '') => t(name, !!cond || detail, true);

// ── item fixtures ────────────────────────────────────────────────────────────────────────────────────────
// Shaped exactly like a data/r1/questions.jsonl row.

const DEPLOY_A = 'ANz3TpZdY2syZGQvGA85ANNG7KiSWdPmv55kP4H4sRPJ';
const DEPLOY_B = '3onEbd9MLfXTTWAfP91yqsKr7C68VCT2ZiF7EoQiQAFj';
const DEPLOY_OTHER = 'BchjnXAXXV5coiCBMQH4A8yCHXEFX9S88JFF6G3mfem4';
const TRUTH_ADDR = '0xd930ab15c8078ebae4ac8da1098a81583603f7ce';

const item = (over = {}) => ({
  id: 'vault_address:1.E1', question: 'Where is the vLQTY-ETH30 vault deployed?', answer_type: 'address',
  truth: TRUTH_ADDR, form: 'E1', taught: true, hop: 1, fact_ids: ['vault_address:1'],
  source: { deployment_id: DEPLOY_A, query_hash: 'h', block: 25902936, json_path: 'p' },
  source_ids: [DEPLOY_A], ...over,
});

// ── 1. buckets, which must agree with pipeline/questions.mjs's frozen sampler ─────────────────────────────

t('bucket: E1 taught hop1 is the headline', bucketOf(item()), 'headline');
t('bucket: E2 taught hop1 is Korean', bucketOf(item({ form: 'E2' })), 'korean');
t('bucket: P taught hop1 is the ceiling', bucketOf(item({ form: 'P' })), 'ceiling');
t('bucket: an untaught fact is the tripwire whatever its form', bucketOf(item({ taught: false, form: 'E2' })), 'tripwire');
t('bucket: hop 2 is multi-hop even though it is taught and its form is P', bucketOf(item({ hop: 2, form: 'P' })), 'multihop');

// ── 2. the five verdicts ─────────────────────────────────────────────────────────────────────────────────

const turn = (usage = { prompt_tokens: 900, completion_tokens: 20 }) => ({ turn: 0, request: {}, response: { id: 'x' }, ms: 4000, usage, finish_reason: 'stop' });
const EV0 = { tool_calls: 0, tool_bytes_in: 0, retries: 0, context_truncated: false, context_exhausted: false, context_evictions: 0, prompt_tokens_peak: 900, budget_exhausted: false, forced_final: false, tool_errors: 0, tool_targets: [], tool_results: [], model_ms: 4000, offline: false };
const plain = (final, over = {}, it = item()) => ({ arm: 'A', repeat: 0, question: it, system: 's', final, error: null, latency_ms: 4200, model_ms: 4000, turns: [turn()], evidence: { ...EV0, ...over } });

t('verdict hit', verdictFor(plain(TRUTH_ADDR)).verdict, 'hit');
t('verdict wrong', verdictFor(plain('0x0000000000000000000000000000000000000001')).verdict, 'wrong');
t('verdict ambiguous — the shotgun answer', verdictFor(plain(`It is either 0x0000000000000000000000000000000000000001 or ${TRUTH_ADDR}`)).verdict, 'ambiguous');
t('verdict abstain — a positive refusal', verdictFor(plain('I do not know.')).verdict, 'abstain');
t('verdict error — the runner recorded a transport failure', verdictFor({ ...plain(null), error: 'transport: fetch failed', turns: [] }).verdict, 'error');
t('verdict error — no answering turn ever completed', verdictFor({ ...plain(''), turns: [{ turn: 0, error: 'http 500', ms: 10 }] }).verdict, 'error');
t('ambiguous is a MISS', isMiss('ambiguous'), true);
t('abstain is a MISS in the accuracy denominator, never a `wrong`', [isMiss('abstain'), isMiss('wrong'), isMiss('hit'), isMiss('error')], [true, true, false, false]);

// ── 3. the rule this file exists for: context_exhausted + empty final is a MISS ───────────────────────────
// Shaped like the transcript the runner actually writes when the window fills: three Messari-sized tool
// results, evictions, then vLLM's own 400 on the forced final. toolloop.mjs returns { final: '', error: null,
// context_overflow: true } for exactly this path, so `error` is null and `final` is the empty string.

const BIG_ROW = (i) => `{"id":"0x${String(i).padStart(40, '0')}","name":"pool ${i}","totalValueLockedUSD":"${1000000 + i}","inputTokens":[{"symbol":"WETH"},{"symbol":"USDC"}]}`;
const BIG_RESULT = `{"data":{"liquidityPools":[${Array.from({ length: 40 }, (_, i) => BIG_ROW(i)).join(',')}]}}`;
const RESULT_WITH_TRUTH = `{"data":{"vaults":[{"id":"${TRUTH_ADDR}","symbol":"vLQTY-ETH30"}]}}`;

const overflowed = {
  arm: 'B', repeat: 0, question: item(), system: 'tools', final: '', error: null,
  latency_ms: 61234, model_ms: 38210,
  turns: [
    { turn: 0, request: {}, response: { id: 'a' }, ms: 5100, usage: { prompt_tokens: 2812, completion_tokens: 79 }, finish_reason: 'tool_calls' },
    { turn: 1, request: {}, response: { id: 'b' }, ms: 6400, usage: { prompt_tokens: 6390, completion_tokens: 71 }, finish_reason: 'tool_calls' },
    { turn: 2, error: 'http 400: {"message":"This model\'s maximum context length is 8192 tokens..."}', ms: 120, context_overflow: true },
  ],
  evidence: {
    ...EV0, tool_calls: 2, tool_bytes_in: BIG_RESULT.length * 2, context_truncated: true, context_exhausted: true,
    context_evictions: 1, prompt_tokens_peak: 7680, forced_final: true, model_ms: 38210,
    tool_targets: [{ name: 'execute_query_by_deployment_id', target: DEPLOY_A, args: {} }, { name: 'execute_query_by_deployment_id', target: DEPLOY_A, args: {} }],
    tool_results: [
      { name: 'execute_query_by_deployment_id', target: DEPLOY_A, full: BIG_RESULT, truncated: true, rows: 40, kept_rows: 22, is_error: false, ms: 900 },
      { name: 'execute_query_by_deployment_id', target: DEPLOY_A, full: BIG_RESULT, truncated: true, rows: 40, kept_rows: 22, is_error: false, ms: 870 },
    ],
  },
};
const ov = verdictFor(overflowed);
t('context_exhausted + empty final is scored `wrong` — a MISS', ov.verdict, 'wrong');
ok('…and it is NOT an `error` (an error would leave the denominator and pay arm B for overflowing)', ov.verdict !== 'error');
ok('…and it is NOT an `abstain` (that would move it out of `wrong` and flatter the honesty metric)', ov.verdict !== 'abstain');
t('…and the reason names the rule', ov.forced_miss, 'context_exhausted');
t('…and it lands in the context_exhausted channel', missChannel(overflowed).channel, 'context_exhausted');
t('an empty final with a completed turn and no overflow is still a miss, not an error', verdictFor(plain('', { context_exhausted: false })).verdict, 'wrong');
t('…recorded as `empty_final` rather than silently merged with the overflow case', verdictFor(plain('')).forced_miss, 'empty_final');
ok('an empty answer can NEVER reach `abstain`: the abstain test is never given an empty string',
  ['', '   ', '\n'].every((x) => verdictFor(plain(x, { context_exhausted: true })).verdict === 'wrong'));
t('a hedge that still commits to a value is not an abstention (normalize.mjs owns this rule)',
  verdictFor(plain(`I am not certain, but the address is ${TRUTH_ADDR}`)).verdict, 'hit');

// ── 4. wrong_subgraph over source_ids[], with the hop-1 fallback ──────────────────────────────────────────

const JOIN = item({ id: 'join:a+b.E1', hop: 2, source_ids: [DEPLOY_A, DEPLOY_B], source: { deployment_id: DEPLOY_A } });
const LEGACY = item({ source_ids: undefined });          // a row written before source_ids existed
t('source_ids: used when present', sourceIdsOf(JOIN), [DEPLOY_A, DEPLOY_B]);
t('source_ids: falls back to [source.deployment_id] for rows that predate the field', sourceIdsOf(LEGACY), [DEPLOY_A]);

const toolMiss = (results, over = {}, it = item()) => ({
  arm: 'B', repeat: 0, question: it, system: 'tools', final: '0x0000000000000000000000000000000000000001', error: null,
  latency_ms: 30000, model_ms: 12000, turns: [turn({ prompt_tokens: 2800, completion_tokens: 40 })],
  evidence: { ...EV0, tool_calls: results.length, tool_results: results, tool_targets: results.map((r) => ({ name: r.name, target: r.target, args: {} })), ...over },
});
const q = (target, full, over = {}) => ({ name: 'execute_query_by_deployment_id', target, full, truncated: false, rows: null, kept_rows: null, is_error: false, ms: 500, ...over });

t('wrong_subgraph: no executed query touched any source id', missChannel(toolMiss([q(DEPLOY_OTHER, BIG_RESULT)])).channel, 'wrong_subgraph');
t('a hop-2 join that queried the SECOND operand is legitimate work, not wrong_subgraph',
  missChannel(toolMiss([q(DEPLOY_B, BIG_RESULT)], {}, JOIN)).channel !== 'wrong_subgraph', true);
t('the fallback deployment counts as on-target for a legacy row',
  missChannel(toolMiss([q(DEPLOY_A, BIG_RESULT)], {}, LEGACY)).channel !== 'wrong_subgraph', true);
t('tool calls that never executed a query land in wrong_subgraph with the reason recorded',
  (() => { const m = missChannel(toolMiss([{ name: 'search_subgraphs_by_keyword', target: null, full: '[]', truncated: false, is_error: false, ms: 30 }])); return [m.channel, m.note.detail]; })(),
  ['wrong_subgraph', 'tool calls were made but no query was ever executed']);
t('execute_query_* is what costs a gateway query', [isExecutedQuery('execute_query_by_deployment_id'), isExecutedQuery('get_schema_by_subgraph_id')], [true, false]);

// ── 5. every channel rule, and the ladder's order ─────────────────────────────────────────────────────────

const EMPTY_DATA = '{"data":{"vaults":[]}}';
const GQL_ERROR = '{"errors":[{"message":"Failed to decode `block.number` value"}]}';
t('queryFailed: an error envelope', queryFailed({ full: GQL_ERROR }), true);
t('queryFailed: empty data', queryFailed({ full: EMPTY_DATA }), true);
t('queryFailed: rows came back', queryFailed({ full: BIG_RESULT }), false);
t('queryFailed: a non-JSON body is NOT claimed as a query error', queryFailed({ full: 'some prose from the MCP server' }), false);

t('channel skipped: zero tool calls', missChannel(toolMiss([], { tool_calls: 0 })).channel, 'skipped');
t('channel query_error: every executed query came back empty or errored',
  missChannel(toolMiss([q(DEPLOY_A, GQL_ERROR), q(DEPLOY_A, EMPTY_DATA)])).channel, 'query_error');
t('channel budget_exhausted: the cap was hit before an answer',
  missChannel(toolMiss([q(DEPLOY_A, BIG_RESULT)], { budget_exhausted: true, tool_calls: 8 })).channel, 'budget_exhausted');
t('channel context_exhausted: the window filled with tool output',
  missChannel(toolMiss([q(DEPLOY_A, BIG_RESULT)], { context_exhausted: true, context_evictions: 2 })).channel, 'context_exhausted');
t('channel truncated: the truth appears ONLY in results that were cut',
  missChannel(toolMiss([q(DEPLOY_A, RESULT_WITH_TRUTH, { truncated: true, rows: 30, kept_rows: 9 })])).channel, 'truncated');
t('channel had_it_and_still_wrong: the truth was in an untruncated result and the answer differs',
  missChannel(toolMiss([q(DEPLOY_A, RESULT_WITH_TRUTH)])).channel, 'had_it_and_still_wrong');
t('channel ignored_result: on-target, real rows, and the truth is in none of them',
  missChannel(toolMiss([q(DEPLOY_A, BIG_RESULT)])).channel, 'ignored_result');
t('the truth being in a truncated AND an untruncated result is had_it_and_still_wrong, not truncated',
  missChannel(toolMiss([q(DEPLOY_A, RESULT_WITH_TRUTH, { truncated: true }), q(DEPLOY_A, RESULT_WITH_TRUTH)])).channel, 'had_it_and_still_wrong');
t('the ladder is conservative: an overflowed item that also had the truth on screen is context_exhausted, not had_it_and_still_wrong',
  missChannel(toolMiss([q(DEPLOY_A, RESULT_WITH_TRUTH)], { context_exhausted: true })).channel, 'context_exhausted');
t('an abstention in a tool arm is still decomposed',
  missChannel({ ...toolMiss([q(DEPLOY_A, RESULT_WITH_TRUTH)]), final: 'I do not know.' }).channel, 'had_it_and_still_wrong');
t('every §6 channel is reachable and none was invented', CHANNELS.length, 8);
t('a `decimal` had_it_and_still_wrong is flagged as resting on the ±1% tolerance, so the summary can disclose it',
  missChannel(toolMiss([q(DEPLOY_A, '{"data":{"vaults":[{"feePercentage":"20.0"}]}}')], {}, item({ answer_type: 'decimal', truth: 20 }))).note.tolerant_numeric_match, true);

// containment, which decides the last three channels
t('containment: an address inside a JSON body', occursIn(RESULT_WITH_TRUTH, 'address', TRUTH_ADDR), true);
t('containment: a symbol as a token, not as a substring of a longer ticker', [occursIn('{"symbol":"WETH"}', 'symbol', 'WETH'), occursIn('{"symbol":"WETH"}', 'symbol', 'ETH')], [true, false]);
t('containment: a decimal within the scorer\'s own ±1% tolerance', occursIn('{"feePercentage":"20.000000"}', 'decimal', 20), true);
t('containment: list<T> needs every element present',
  [truthOccursIn('{"inputTokens":[{"symbol":"SPURDO"},{"symbol":"WETH"}]}', item({ answer_type: 'list<symbol>', truth: ['SPURDO', 'WETH'] })),
   truthOccursIn('{"inputTokens":[{"symbol":"SPURDO"}]}', item({ answer_type: 'list<symbol>', truth: ['SPURDO', 'WETH'] }))], [true, false]);

// ── 6. tokens summed over turns, from vLLM's usage ────────────────────────────────────────────────────────

t('tokens are summed over ALL turns, not read off the last one', sumTokens([
  { usage: { prompt_tokens: 2812, completion_tokens: 79 } },
  { usage: { prompt_tokens: 6390, completion_tokens: 71 } },
  { usage: { prompt_tokens: 7100, completion_tokens: 24 } },
]), { prompt_tokens: 16302, completion_tokens: 174, turns_with_usage: 3, turns: 3 });
t('a turn that errored carries no usage and contributes nothing', sumTokens([{ usage: { prompt_tokens: 10, completion_tokens: 2 } }, { error: 'http 400', ms: 12 }]),
  { prompt_tokens: 10, completion_tokens: 2, turns_with_usage: 1, turns: 2 });
t('no turns at all', sumTokens([]), { prompt_tokens: 0, completion_tokens: 0, turns_with_usage: 0, turns: 0 });

// ── 7. cost comes from pricing.json and from nowhere else ────────────────────────────────────────────────

const PRICING = { model: { usd_per_1m_input_tokens: 0.2, usd_per_1m_output_tokens: 0.6 }, graph: { usd_per_query: 0.00004 }, knowledge: { price: null } };
const counts = { prompt_tokens: 100, completion_tokens: 20, gateway_queries: 2 };
t('cost: tokens × list price + gateway queries', costOf(counts, PRICING).cost_usd, 100 * 0.2e-6 + 20 * 0.6e-6 + 2 * 0.00004);
t('cost: doubling the input price moves the number', costOf(counts, { ...PRICING, model: { ...PRICING.model, usd_per_1m_input_tokens: 0.4 } }).cost_usd, 100 * 0.4e-6 + 20 * 0.6e-6 + 2 * 0.00004);
t('cost: a missing price is NOT defaulted to zero — the cell comes back unpriced with a reason',
  (() => { const r = costOf(counts, { model: {}, graph: {} }); return [r.cost_usd, /missing/.test(r.reason)]; })(), [null, true]);

// ── 8. item-level outcome ────────────────────────────────────────────────────────────────────────────────

t('an item is a hit only if every non-error repeat was a hit', itemOutcome([{ scored: true, hit: true }, { scored: true, hit: true }]).status, 'hit');
t('one wrong repeat makes the item a miss, and marks it split', (() => { const o = itemOutcome([{ scored: true, hit: true }, { scored: true, hit: false }]); return [o.status, o.split]; })(), ['miss', true]);
t('an item whose every repeat errored is neither hit nor miss — it leaves the denominator', itemOutcome([{ scored: false }, { scored: false }]).status, 'error');

// ── 9. end to end over a whole synthetic run ─────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'bench-score-fixture-'));
const keep = process.argv.includes('--keep');

function fixtureRun(root, { leak = false } = {}) {
  const items = [
    item({ id: 'q1.E1' }),
    item({ id: 'q2.E2', form: 'E2', question: 'vLQTY-ETH30 볼트는 어디에 배포되어 있습니까?' }),
    item({ id: 'q3.P', form: 'P' }),
    item({ id: 'q4.E1', taught: false }),                                    // tripwire
    item({ id: 'q5.E2', taught: false, form: 'E2' }),                        // tripwire
    item({ id: 'q6.P', hop: 2, source_ids: [DEPLOY_A, DEPLOY_B], answer_type: 'decimal', truth: 20, question: 'What fee does the vault whose share token is xOHM-USDC3 take?' }),
    item({ id: 'q7.E1', answer_type: 'list<symbol>', truth: ['SPURDO', 'WETH'], question: 'Name the assets paired in the pool.' }),
  ];
  const RIGHT = (it) => (Array.isArray(it.truth) ? it.truth.join(', ') : String(it.truth));
  const WRONG = (it) => (it.answer_type === 'address' ? '0x0000000000000000000000000000000000000001' : it.answer_type === 'decimal' ? '99' : 'USDC, DAI');

  // A scripted outcome per (arm, item). Chosen to exercise the ordering, the tripwire and every channel —
  // NOT to predict a result. These are fixtures, and the scorer is what is under test, not the arms.
  const script = {
    // arm: [per-item mode]
    A: ['abstain', 'abstain', 'wrong', 'abstain', 'abstain', 'wrong', 'wrong'],
    B: ['tool_hit', 'tool_overflow', 'tool_ignored', 'tool_hit', 'tool_hit', 'tool_wrong_subgraph', 'tool_had_it'],
    C: ['hit', 'hit', 'hit', leak ? 'hit' : 'abstain', leak ? 'hit' : 'wrong', 'hit', 'hit'],
    D: ['tool_hit', 'hit', 'wrong', 'tool_hit', 'tool_hit', 'hit', 'tool_hit'],
  };

  for (const [arm, modes] of Object.entries(script)) {
    const adir = join(root, 'transcripts', arm);
    mkdirSync(adir, { recursive: true });
    items.forEach((it, idx) => {
      for (let rep = 0; rep < 2; rep++) {
        const mode = modes[idx];
        let payload;
        const base = { arm, repeat: rep, question: it, system: arm === 'B' || arm === 'D' ? 'tools' : 'plain' };
        if (mode === 'hit' || mode === 'wrong' || mode === 'abstain') {
          const final = mode === 'hit' ? RIGHT(it) : mode === 'wrong' ? WRONG(it) : 'I do not know.';
          payload = { ...base, final, error: null, latency_ms: 4200, model_ms: 4100, turns: [turn({ prompt_tokens: 180, completion_tokens: 12 })], evidence: { ...EV0, prompt_tokens_peak: 180, model_ms: 4100 } };
        } else if (mode === 'tool_overflow') {
          payload = { ...overflowed, ...base, question: it };
        } else {
          const withTruth = `{"data":{"vaults":[{"id":"${it.answer_type === 'address' ? it.truth : TRUTH_ADDR}","symbol":"${Array.isArray(it.truth) ? it.truth.join('/') : 'vLQTY-ETH30'}","fee":"${it.answer_type === 'decimal' ? it.truth : 3}","inputTokens":[${(Array.isArray(it.truth) ? it.truth : ['WETH']).map((s) => `{"symbol":"${s}"}`).join(',')}]}]}}`;
          const onTarget = mode === 'tool_wrong_subgraph' ? DEPLOY_OTHER : DEPLOY_A;
          const results = [q(onTarget, mode === 'tool_hit' || mode === 'tool_had_it' ? withTruth : BIG_RESULT)];
          const final = mode === 'tool_hit' ? RIGHT(it) : WRONG(it);
          payload = {
            ...base, final, error: null, latency_ms: 31000, model_ms: 15000,
            turns: [turn({ prompt_tokens: 2800, completion_tokens: 70 }), turn({ prompt_tokens: 3400, completion_tokens: 25 })],
            evidence: { ...EV0, tool_calls: 1, tool_bytes_in: results[0].full.length, prompt_tokens_peak: 3400, model_ms: 15000, tool_results: results, tool_targets: [{ name: results[0].name, target: DEPLOY_A, args: {} }] },
          };
        }
        writeFileSync(join(adir, `${it.id}.${rep}.json`), JSON.stringify(payload, null, 2));
      }
    });
  }
  writeFileSync(join(root, 'provenance.json'), JSON.stringify({
    run_id: 'FIXTURE', fixture: true, offline: false, model: 'fixture-model', max_model_len: 8192,
    patch: { backend: 'stub', real_training: false, patch_id: 'fixture', patch_sha256: null },
    restarts_detected: 0, chunks_rerun: 0, git_commit: 'fixture',
  }, null, 2));
  return items;
}

const runDir = join(dir, 'FIXTURE');
mkdirSync(runDir, { recursive: true });
fixtureRun(runDir);
const pricingPath = join(dir, 'pricing.json');
writeFileSync(pricingPath, JSON.stringify({ ...PRICING, knowledge: { price: 5, currency: 'USD' } }, null, 2));

const { summary, units } = scoreRun(runDir, { pricingPath });

t('every (arm, item, repeat) produced a row', units.length, 4 * 7 * 2);
ok('the four output files exist', ['results.json', 'per-question.csv', 'summary.json', 'summary.md'].every((f) => existsSync(join(runDir, f))));
ok('a fixture run is stamped as one, loudly', summary.stamps.some((s) => /FIXTURE/.test(s)));
ok('a stub patch is stamped SIMULATED PATCH (§9)', summary.stamps.some((s) => /SIMULATED PATCH/.test(s)));
t('buckets are counted the way split.json declares them', summary.counts.by_bucket, { headline: 2, korean: 1, ceiling: 1, tripwire: 2, multihop: 1 });

// the rule, once more, through the whole pipeline
const overflowRows = units.filter((u) => u.arm === 'B' && u.context_exhausted);
ok('the overflowed item survived into results.json', overflowRows.length === 2);
t('…scored as a miss in every one of its repeats', [...new Set(overflowRows.map((r) => r.verdict))], ['wrong']);
t('…and assigned to the context_exhausted channel', [...new Set(overflowRows.map((r) => r.miss_channel))], ['context_exhausted']);
ok('…and it is INSIDE the accuracy denominator', overflowRows.every((r) => r.scored));

// ambiguous is a miss but is reported separately
const ambig = { ...plain(`Either 0x0000000000000000000000000000000000000001 or ${TRUTH_ADDR}`), arm: 'A' };
t('ambiguous never counts as a hit', verdictFor(ambig).verdict === 'hit', false);
ok('the verdict split reports every verdict in its own column', ['hit', 'wrong', 'ambiguous', 'abstain', 'error'].every((v) => v in summary.arms.A.verdicts));
t('the abstaining arm A scores 0 on the headline, and its abstentions are not counted as `wrong`',
  [summary.arms.A.buckets.headline.all_items.accuracy, summary.arms.A.verdicts.abstain > 0, summary.arms.A.verdicts.error], [0, true, 0]);

// the decomposition
for (const arm of ['B', 'D']) {
  ok(`arm ${arm}: every miss is assigned to exactly one channel`, summary.miss_channels[arm].sums);
  t(`arm ${arm}: the channels sum to the miss count`,
    Object.values(summary.miss_channels[arm].channels).reduce((a, b) => a + b, 0), summary.miss_channels[arm].misses);
}
t('arm B\'s misses land in the channels the fixture built, two repeats each',
  ['context_exhausted', 'ignored_result', 'wrong_subgraph', 'had_it_and_still_wrong'].map((c) => summary.miss_channels.B.channels[c]), [2, 2, 2, 2]);
t('arm D\'s misses are decomposed too — §6 runs the same table for D', summary.miss_channels.D.channels.skipped, 2);
t('the decomposition is broken out per bucket as well', summary.miss_channels.B.by_bucket.multihop.channels.wrong_subgraph, 2);
ok('no channel is assigned for the tool-less arms', units.filter((u) => u.arm === 'A' || u.arm === 'C').every((u) => u.miss_channel === null));

// cost moves with the price file, and with nothing else
const B = summary.arms.B;
const expect = (pin, pout, pq) => (B.tokens.prompt_total * pin / 1e6 + B.tokens.completion_total * pout / 1e6 + B.tools.gateway_queries_total * pq) / B.cost.priced_units;
ok('cost/question is exactly tokens × the price file\'s rates + gateway queries', Math.abs(B.cost.per_question_usd - expect(0.2, 0.6, 0.00004)) < 1e-12);
writeFileSync(pricingPath, JSON.stringify({ ...PRICING, model: { usd_per_1m_input_tokens: 2.0, usd_per_1m_output_tokens: 6.0 }, knowledge: { price: 5, currency: 'USD' } }, null, 2));
const again = scoreRun(runDir, { pricingPath }).summary;
ok('change a price in pricing.json and every cost cell moves with it — nothing is hard-coded',
  Math.abs(again.arms.B.cost.per_question_usd - expect(2.0, 6.0, 0.00004)) < 1e-12 && again.arms.B.cost.per_question_usd > B.cost.per_question_usd);
ok('the break-even N* is computed from the price file, not typed in', again.break_even.n_star != null && again.break_even.knowledge_price === 5);
t('N* is the price divided by the measured per-question difference',
  Math.abs(again.break_even.n_star - 5 / (again.arms.B.cost.per_question_usd - again.arms.C.cost.per_question_usd)) < 1e-9, true);
writeFileSync(pricingPath, JSON.stringify(PRICING, null, 2)); // knowledge.price: null, as it stands today
const unpriced = scoreRun(runDir, { pricingPath }).summary;
t('with no knowledge price set, N* is left uncomputed rather than invented', [unpriced.break_even.n_star, /knowledge.price/.test(unpriced.break_even.reason)], [null, true]);

// the tripwire, as a top-level field
t('the leakage tripwire passes when arm C fails the held-out facts', [summary.leakage.verdict, summary.VOID], ['pass', false]);
const leakDir = join(dir, 'FIXTURE-LEAK');
mkdirSync(leakDir, { recursive: true });
fixtureRun(leakDir, { leak: true });
const leaked = scoreRun(leakDir, { pricingPath }).summary;
t('arm C passing the held-out facts VOIDS the run, at the top level and not in a footnote',
  [leaked.leakage.verdict, leaked.VOID, leaked.void_reasons.length > 0, leaked.stamps[0]],
  ['VOID — LEAKAGE', true, true, 'RUN VOID — see the leakage tripwire']);
ok('the void also shows up as a triggered falsifier', leaked.falsifiers.some((f) => /leakage/i.test(f.name) && f.verdict === 'TRIGGERED'));

// the summary a human reads
const md = readFileSync(join(runDir, 'summary.md'), 'utf8');
ok('summary.md prints the falsifiers before the tables', md.indexOf('falsifiers, before the tables') < md.indexOf('## 1. Accuracy'));
ok('summary.md prints the miss decomposition with its sum check', /total assigned/.test(md) && /wrong_subgraph/.test(md));
ok('summary.md prints the break-even', /N\\\*/.test(md) || /break-even/i.test(md));
ok('summary.md says the three phrasing buckets are the SAME facts', /FACT-COHERENT|same 120 facts|SAME 120 facts/i.test(md) || /within-fact/i.test(md));
ok('summary.md prints §7\'s threats rather than burying them', /Threats to validity/.test(md));

// ── 10. the §6 offline cell is read from the sibling run, not asserted ───────────────────────────────────

t('with no offline run scored, the four-cell table says so rather than inventing a cell',
  [summary.offline.available, /has not been scored yet/.test(summary.offline.note)], [false, true]);
const offDir = join(dir, 'FIXTURE-offline');
mkdirSync(offDir, { recursive: true });
fixtureRun(offDir);
writeFileSync(join(offDir, 'provenance.json'), JSON.stringify({ run_id: 'FIXTURE', fixture: true, offline: true, patch: { backend: 'stub', real_training: false } }, null, 2));
scoreRun(offDir, { pricingPath });
const withOffline = scoreRun(runDir, { pricingPath }).summary;
ok('once the fault-injected run is scored, its accuracy is pulled in beside this one', withOffline.offline.available && withOffline.offline.by_arm.B != null);
ok('…and the four-cell table prints with the accuracy table, not in an appendix', /tools unavailable/.test(readFileSync(join(runDir, 'summary.md'), 'utf8')));
ok('an offline run does not go looking for an offline run of its own', scoreRun(offDir, { pricingPath }).summary.offline.available === false);
ok('the offline run is stamped as fault-injected', scoreRun(offDir, { pricingPath }).summary.stamps.some((x) => /OFFLINE RUN/.test(x)));

// ── 11. the embedded question rows are cross-checked against the committed set ────────────────────────────

t('with no committed question set for the run id, the check reports that it did not run', withOffline.integrity.checked, false);
if (existsSync(join(BENCH, 'data', 'r1', 'questions.jsonl'))) {
  const real = JSON.parse(readFileSync(join(BENCH, 'data', 'r1', 'questions.jsonl'), 'utf8').split('\n').filter(Boolean)[0]);
  t('a transcript carrying the committed row passes', checkIntegrity([{ question: real, _file: 'f' }], 'r1').ok, true);
  t('a transcript whose truth was edited after the run is caught',
    (() => { const bad = checkIntegrity([{ question: { ...real, truth: '0x0000000000000000000000000000000000000001' }, _file: 'f' }], 'r1'); return [bad.ok, bad.mismatches.length]; })(), [false, 1]);
  t('an item id that is not in the committed set is caught too',
    checkIntegrity([{ question: { ...real, id: 'not-a-real-id' }, _file: 'f' }], 'r1').unknown_ids, ['not-a-real-id']);
}

if (keep) console.error(`fixtures kept at ${dir}`);
else rmSync(dir, { recursive: true, force: true });

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
