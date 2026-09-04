#!/usr/bin/env node
// Re-score a completed run from its committed transcripts.
//
//   node src/score.mjs runs/<id> [--pricing pricing.json] [--out runs/<id>]
//
// No GPU, no API key, no network, no LLM judge (§5). Everything below is a pure function of
// runs/<id>/transcripts/**, runs/<id>/provenance.json and pricing.json. Delete every number in this
// directory and re-run this file: the tables come back byte-identical. That is the whole claim of §7.5 —
// re-scoring is meant to be cheaper than trusting us.
//
// It writes, into the run directory:
//   results.json      one row per (arm, item, repeat) — verdict, partial, timings, tokens, cost, miss channel
//   per-question.csv  the same rows, flat (§8)
//   summary.json      per arm × per bucket, the falsifier verdicts, the miss decomposition, the break-even
//   summary.md        the tables §6 asks for, with §7's threats printed above them rather than buried
//
// THE THREE RULES THIS FILE EXISTS TO NOT GET WRONG
//
// 1. An item that ran out of window and answered nothing is a MISS, never an `error` and never an
//    `abstain`. §3 says so in terms: "Running out of window is a MISS, never an `error`" — because §5
//    excludes errors from the accuracy denominator, and scoring the overflow as an error would delete arm
//    B's most characteristic failure from the measurement and pay the arm for overflowing. `abstain` needs a
//    POSITIVE refusal (normalize.mjs's narrow ABSTAIN regex), which an empty string can never satisfy, and
//    this file never hands an empty string to the abstain test at all. score.test.mjs pins both against a
//    fixture shaped like a real overflowed transcript so a later refactor cannot walk it back.
// 2. `wrong_subgraph` is decided over the item's `source_ids[]` — every deployment a fair query could have
//    targeted — not over the single deployment the answer fact was read from. For a hop-2 join, querying
//    either operand's subgraph is legitimate work, and scoring against the answer fact's deployment alone
//    would manufacture misses in exactly the bucket where arm B is weakest. Rows that predate `source_ids`
//    fall back to `[source.deployment_id]`.
// 3. Every miss in a tool arm lands in exactly ONE channel and the channels sum to the miss count. The
//    assignment is a first-match-wins ladder (§6's eight rules, none invented, none dropped) ordered from
//    the least self-serving diagnosis to the most: an item is only credited to `had_it_and_still_wrong` —
//    the channel that flatters our thesis — after every "the loop never got there" explanation has been
//    ruled out. `ignored_result` is the residual, and its §6 rule is exactly the complement of the one above
//    it, which is why the ladder is total.
//
// The comparison rules themselves are NOT here. Every verdict comes from normalize.mjs's `scoreOne`, which
// has its own 22-case self-test; this file decides only what to feed it and what to do with a transcript
// that never produced an answer to feed.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreOne, wilson, mcnemar, normalize, DECIMAL_REL_TOL } from './normalize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BENCH = join(HERE, '..');
export const SCORER_VERSION = '1.0.0';

/** Arms that are handed tool schemas. The miss decomposition (§6) is defined for these and only these. */
export const TOOL_ARMS = new Set(['B', 'D']);
export const ARM_ORDER = ['A', 'B', 'C', 'D'];

/** §1's pre-registered per-bucket expectation, quoted so the reader compares prediction to result cell by cell. */
export const PREREG = {
  headline: { label: 'Held-out phrasing, taught facts (E1) — headline', A: 'floor', B: 'mid — loses through §6 channels', C: 'high', D: 'high' },
  korean:   { label: 'Held-out phrasing, Korean (E2)',                  A: 'floor', B: 'mid', C: 'high, some transfer loss', D: 'high' },
  ceiling:  { label: 'Trained phrasing (P) — memorisation ceiling',     A: 'floor', B: 'mid', C: 'ceiling', D: 'ceiling' },
  tripwire: { label: 'Held-out facts — tripwire',                       A: 'floor', B: 'high — B\'s bucket', C: '≈ floor, by construction', D: 'high' },
  multihop: { label: 'Multi-hop (2 facts)',                             A: 'floor', B: 'low — several queries in one budget', C: 'mid', D: 'high' },
};
export const BUCKETS = ['headline', 'korean', 'ceiling', 'tripwire', 'multihop'];

/**
 * Which pre-registered bucket an item belongs to. This MUST agree with pipeline/questions.mjs's sampler
 * (`buckets` in that file), because split.json's `buckets_declared` was frozen before any model ran and the
 * summary is checked against it. The order matters: multi-hop items are taught and carry forms P/E1/E2, and
 * tripwire items are the untaught hop-1 ones regardless of form, so hop and `taught` are tested before form.
 */
export function bucketOf(item) {
  if (item.hop === 2) return 'multihop';
  if (!item.taught) return 'tripwire';
  if (item.form === 'P') return 'ceiling';
  if (item.form === 'E2') return 'korean';
  if (item.form === 'E1') return 'headline';
  return 'unclassified';
}

/** The deployments a fair query could have targeted (rule 2 above). */
export function sourceIdsOf(item) {
  if (Array.isArray(item.source_ids) && item.source_ids.length) return item.source_ids;
  const one = item.source?.deployment_id;
  return one ? [one] : [];
}

/** §6: prompt/completion tokens are SUMMED OVER ALL TURNS from vLLM's own `usage`. Nothing is pre-aggregated. */
export function sumTokens(turns) {
  let prompt = 0, completion = 0, withUsage = 0;
  for (const t of turns ?? []) {
    const u = t?.usage;
    if (!u) continue;
    withUsage++;
    prompt += Number(u.prompt_tokens ?? 0);
    completion += Number(u.completion_tokens ?? 0);
  }
  return { prompt_tokens: prompt, completion_tokens: completion, turns_with_usage: withUsage, turns: (turns ?? []).length };
}

/**
 * The parts an item's wall clock is made of, for the latency picture src/chart.mjs draws (§6 asks for
 * latency "including every tool round trip" beside model_ms "so model time and network time are separable").
 * Three bands are recorded quantities and the fourth is the residual:
 *
 *   first_turn_ms   the FIRST model turn's wall time. The runner does not stream, so no time-to-first-token
 *                   exists anywhere in the transcripts; this is the closest quantity that WAS measured, and
 *                   the chart labels it as what it is (prefill + the first generation), never as TTFT.
 *   tool_ms         the MCP round trips the loop actually waited on, summed from evidence.tool_results[].ms.
 *   model_ms        already on the transcript; generation after the first turn is model_ms - first_turn_ms.
 *   the residual    latency_ms - model_ms - tool_ms: scheduling, JSON, the loop's own overhead. The chart
 *                   clamps it at zero and says so on the face of the chart rather than hiding the clamp.
 */
export function timingParts(t) {
  const ev = t.evidence ?? {};
  const first = (t.turns ?? []).find((x) => typeof x?.ms === 'number');
  const tool_ms = (ev.tool_results ?? []).reduce((a, r) => a + (Number(r?.ms) || 0), 0);
  return { first_turn_ms: first ? first.ms : null, tool_ms };
}

/** A tool call that costs a gateway query. pricing.json: "the MCP server issues one per executeQuery". */
export const isExecutedQuery = (name) => /^execute_query/i.test(String(name ?? ''));

/**
 * cost_usd = prompt × P_in + completion × P_out + gateway_queries × P_query, every price read from
 * pricing.json (§6). A missing price is NOT defaulted to zero and NOT typed in here: the cost comes back
 * null with a reason, and the summary says the column could not be priced. No cost number is ever written
 * into this file or into a table.
 */
export function costOf({ prompt_tokens, completion_tokens, gateway_queries }, pricing) {
  const pin = pricing?.model?.usd_per_1m_input_tokens;
  const pout = pricing?.model?.usd_per_1m_output_tokens;
  const pq = pricing?.graph?.usd_per_query;
  const missing = [];
  if (typeof pin !== 'number') missing.push('model.usd_per_1m_input_tokens');
  if (typeof pout !== 'number') missing.push('model.usd_per_1m_output_tokens');
  if (gateway_queries > 0 && typeof pq !== 'number') missing.push('graph.usd_per_query');
  if (missing.length) return { cost_usd: null, reason: `pricing.json is missing ${missing.join(', ')}` };
  return {
    cost_usd: (prompt_tokens * pin) / 1e6 + (completion_tokens * pout) / 1e6 + gateway_queries * (pq ?? 0),
    reason: null,
  };
}

/**
 * Does the item's truth VALUE occur anywhere in this text?
 *
 * Used ONLY to assign a miss channel — never to produce a verdict. Every comparison goes through
 * normalize.mjs's normaliser for the item's declared answer_type, including `decimal`'s ±1% tolerance, so
 * "the value was on screen" means the same thing here as "this IS the answer" does in the scorer. The
 * consequence is disclosed in the summary: on `decimal` items a large JSON body can contain an unrelated
 * number within 1% of the truth, which would push a miss into `had_it_and_still_wrong`. That is the channel
 * that flatters our thesis, so the ladder in `missChannel` rules out every other explanation first and the
 * summary prints how many of those assignments rest on a tolerant numeric match.
 */
export function occursIn(text, type, truthValue) {
  const s = String(text ?? '');
  if (!s) return false;
  const norm = normalize[type];
  if (!norm) return false;
  const want = norm(String(truthValue));
  if (!want) return false;
  const eq = type === 'decimal'
    ? (a) => (want.value === 0 ? a === 0 : Math.abs(a - want.value) / Math.abs(want.value) <= DECIMAL_REL_TOL)
    : (a) => a === want.value;
  // address / integer / decimal collect every occurrence in the whole string.
  const whole = norm(s);
  if (whole && whole.candidates.some(eq)) return true;
  // symbol / enum collapse the WHOLE string into one token, and date returns only the first match, so those
  // need a per-token pass. Splitting is a search decision; the comparison is still normalize.mjs's.
  for (const tok of s.split(/[^A-Za-z0-9.:+_-]+/)) {
    if (!tok) continue;
    const g = norm(tok);
    if (g && g.candidates.some(eq)) return true;
  }
  return false;
}

/** The same question for a whole item, including `list<T>`: every element has to be present. */
export function truthOccursIn(text, item) {
  const type = String(item.answer_type ?? '');
  if (type.startsWith('list<')) {
    const inner = type.slice(5, -1);
    const truth = Array.isArray(item.truth) ? item.truth : [item.truth];
    return truth.length > 0 && truth.every((v) => occursIn(text, inner, v));
  }
  return occursIn(text, type, item.truth);
}

/** A GraphQL answer that carried nothing: an error envelope, a null `data`, or a `data` whose every field is empty. */
export function queryFailed(result) {
  if (result?.is_error) return true;
  const text = String(result?.full ?? '');
  if (!text.trim()) return true;
  let j;
  // Not JSON at all: NOT counted as a failure. `query_error` is a channel that moves the blame off the tool
  // loop and onto The Graph, so it is only claimed when the response says so in its own envelope.
  try { j = JSON.parse(text); } catch { return false; }
  if (Array.isArray(j?.errors) && j.errors.length) return true;
  if (!('data' in j)) return false;
  const data = j.data;
  if (data === null || data === undefined) return true;
  if (typeof data === 'object') {
    const vals = Object.values(data);
    if (!vals.length) return true;
    return vals.every((v) => v === null || (Array.isArray(v) && v.length === 0));
  }
  return false;
}

/**
 * The verdict for one transcript.
 *
 * The comparison is normalize.mjs's. What is decided here is only what happens when there is no answer to
 * compare, and that decision is rule 1 at the top of this file:
 *
 *   `error`  ⟺ no answering turn ever completed (the runner recorded a transport error, or no turn came
 *              back with a response). §5 calls this "transport/timeout/empty" — an empty RESPONSE.
 *   a miss   ⟸ an answering turn completed and produced nothing. A forced final IS a completed turn (§3),
 *              so "the window filled and the model was forced to answer with what it had, and it had
 *              nothing" is a miss with `context_exhausted` as its channel, not a datum we get to drop.
 *
 * This is where the brief and README §5's one-word "empty" have to be read together: §3 is explicit that
 * running out of window is a miss and never an error, and §5's exclusion of errors from the denominator is
 * exactly why. An empty string is never handed to `scoreOne`, so it can never reach the abstain regex.
 */
export function verdictFor(t) {
  const item = t.question;
  const final = String(t.final ?? '');
  const turns = t.turns ?? [];
  const completed = turns.some((x) => x && x.response && !x.error);

  if (!final.trim()) {
    if (t.error) return { verdict: 'error', partial: 0, reason: `transport: ${String(t.error).slice(0, 200)}`, empty: true };
    if (t.evidence?.context_exhausted) {
      return { verdict: 'wrong', partial: 0, empty: true, forced_miss: 'context_exhausted',
        reason: 'context_exhausted with an empty final — §3: running out of window is a MISS, never an error' };
    }
    if (!completed) return { verdict: 'error', partial: 0, empty: true, reason: 'no answering turn completed' };
    return { verdict: 'wrong', partial: 0, empty: true, forced_miss: 'empty_final',
      reason: 'an answering turn completed and returned an empty answer — a miss, not a transport error' };
  }
  // There IS an answer. It is scored even if the runner also recorded a transport error somewhere in the
  // item — `error` deletes a unit from the accuracy denominator (§5), and a unit that produced an answer is
  // not a unit we get to delete. The flag travels on the row so the condition stays visible.
  const r = scoreOne(final, item);
  return {
    ...r, partial: r.partial ?? (r.verdict === 'hit' ? 1 : 0), empty: false,
    ...(t.error ? { transport_error_but_answered: String(t.error).slice(0, 200) } : {}),
  };
}

/**
 * Which of §6's eight channels one tool-arm miss belongs to. First match wins, and the ladder is ordered
 * from the diagnosis that costs our thesis the most to the one that costs it the least:
 *
 *   skipped → wrong_subgraph → query_error → budget_exhausted → context_exhausted → truncated
 *           → had_it_and_still_wrong → ignored_result
 *
 * `skipped` first because with zero calls the "every executed query …" rules are vacuously true. The three
 * plumbing channels (skipped, wrong_subgraph, query_error) come next: §3 already concedes that an agent that
 * cannot find its subgraph is "a fact about agent plumbing, not an argument against The Graph", so those
 * readings are taken whenever they are available rather than being upgraded to the flattering ones.
 * `truncated` outranks `had_it_and_still_wrong` and is deliberately narrow — it fires only when the truth
 * appears ONLY in results that were cut, i.e. exactly when we cannot claim the model ever saw it.
 * `ignored_result` is the residual, and §6's rule for it ("the answer's key token appears in no tool result")
 * is precisely the complement of `had_it_and_still_wrong`, so every miss lands somewhere and the table sums.
 */
export function missChannel(t) {
  const item = t.question;
  const ev = t.evidence ?? {};
  const results = ev.tool_results ?? [];
  const executed = results.filter((r) => isExecutedQuery(r.name));
  const wanted = sourceIdsOf(item);
  const note = {};

  if ((ev.tool_calls ?? 0) === 0) return { channel: 'skipped', note };

  if (!executed.length) {
    note.executed_queries = 0;
    note.detail = 'tool calls were made but no query was ever executed';
    return { channel: 'wrong_subgraph', note };
  }
  // The targeting rung needs the item to say where its answer lives. When it does not — a row that carries
  // neither `source_ids` nor `source.deployment_id` — the miss is NOT charged to `wrong_subgraph`: that
  // channel blames the agent for aiming badly, and an item with no declared deployment gives it nothing to
  // aim at. That is our metadata defect, not arm B's, so the item falls through to the channels that can
  // still be decided from the transcript and the defect is counted at the top of the summary.
  if (!wanted.length) {
    note.no_source_ids = true;
    note.detail = 'the item carries neither source_ids nor source.deployment_id — targeting could not be judged';
  } else {
    const onTarget = executed.filter((r) => wanted.includes(r.target));
    if (!onTarget.length) {
      note.executed_queries = executed.length;
      note.targets = [...new Set(executed.map((r) => r.target))];
      note.wanted = wanted;
      return { channel: 'wrong_subgraph', note };
    }
  }
  if (executed.every(queryFailed)) {
    note.executed_queries = executed.length;
    note.detail = 'every executed query returned an error envelope or empty data';
    return { channel: 'query_error', note };
  }
  if (ev.budget_exhausted) {
    note.tool_calls = ev.tool_calls;
    return { channel: 'budget_exhausted', note };
  }
  if (ev.context_exhausted) {
    note.context_evictions = ev.context_evictions ?? 0;
    note.prompt_tokens_peak = ev.prompt_tokens_peak ?? 0;
    return { channel: 'context_exhausted', note };
  }
  const carrying = results.filter((r) => truthOccursIn(r.full, item));
  if (carrying.length && carrying.every((r) => r.truncated)) {
    note.detail = 'the truth appears only inside tool results that were cut at the context wall';
    return { channel: 'truncated', note };
  }
  if (carrying.length) {
    note.results_carrying_truth = carrying.length;
    // Disclosed in the summary: on a decimal item this rests on the scorer's own ±1% tolerance.
    note.tolerant_numeric_match = String(item.answer_type) === 'decimal';
    return { channel: 'had_it_and_still_wrong', note };
  }
  note.detail = 'the truth appears in no tool result';
  return { channel: 'ignored_result', note };
}

export const CHANNELS = ['skipped', 'wrong_subgraph', 'query_error', 'budget_exhausted', 'context_exhausted', 'truncated', 'had_it_and_still_wrong', 'ignored_result'];

/**
 * §6.3's x-axis: "N* is a curve in the number of buyers, not a scalar. Cumulative cost against question
 * count for one buyer, ten, a hundred." These are buyer counts, not prices — no cost number lives here.
 */
export const BUYERS = [1, 10, 100];

/**
 * §4 discards a chunk "unwritten" when the table state was lost, so a stale transcript from a re-run is a
 * real possibility — and it would be read as an extra unit, double-counting the item into every table that
 * touches it. The identity of a unit is (arm, item, repeat), never the filename, so a second file claiming
 * the same identity stops the scoring rather than being averaged in.
 */
export function assertNoDuplicateUnits(units) {
  const seen = new Map();
  for (const u of units) {
    const k = `${u.arm}|${u.id}|${u.repeat}`;
    if (seen.has(k)) throw new Error(`two transcripts claim (arm ${u.arm}, item ${u.id}, repeat ${u.repeat}): ${seen.get(k)} and ${u.file} — one of them is stale; remove it before scoring`);
    seen.set(k, u.file);
  }
  return units.length;
}

/** A miss is any scored (non-error) unit that is not a hit: wrong + ambiguous + abstain. It is the gap. */
export const isMiss = (verdict) => verdict === 'wrong' || verdict === 'ambiguous' || verdict === 'abstain';

// ── reading a run ────────────────────────────────────────────────────────────────────────────────────────

export function readTranscripts(runDir) {
  const tdir = join(runDir, 'transcripts');
  if (!existsSync(tdir)) throw new Error(`${tdir} does not exist — nothing to score`);
  const out = [];
  for (const arm of readdirSync(tdir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    for (const f of readdirSync(join(tdir, arm)).filter((f) => f.endsWith('.json')).sort()) {
      // The filename is never parsed: item ids contain dots. Identity comes from the transcript body.
      const t = JSON.parse(readFileSync(join(tdir, arm, f), 'utf8'));
      out.push({ ...t, arm: t.arm ?? arm, _file: join('transcripts', arm, f) });
    }
  }
  return out;
}

export function loadPricing(path) {
  const p = path ?? join(BENCH, 'pricing.json');
  if (!existsSync(p)) throw new Error(`${p} does not exist — cost cannot be modelled and will not be invented`);
  return { pricing: JSON.parse(readFileSync(p, 'utf8')), path: p };
}

// ── scoring ──────────────────────────────────────────────────────────────────────────────────────────────

/** One row per (arm, item, repeat) — §6's list, plus the miss channel for the tool arms. */
export function scoreUnits(transcripts, pricing) {
  return transcripts.map((t) => {
    const item = t.question;
    const ev = t.evidence ?? {};
    const v = verdictFor(t);
    const tok = sumTokens(t.turns);
    const gateway_queries = (ev.tool_results ?? []).filter((r) => isExecutedQuery(r.name)).length;
    const timing = timingParts(t);
    const { cost_usd, reason: cost_reason } = costOf({ ...tok, gateway_queries }, pricing);
    const miss = isMiss(v.verdict);
    const ch = miss && TOOL_ARMS.has(t.arm) ? missChannel(t) : { channel: null, note: null };
    return {
      arm: t.arm, id: item.id, repeat: t.repeat, bucket: bucketOf(item),
      form: item.form, taught: item.taught, hop: item.hop, answer_type: item.answer_type,
      verdict: v.verdict, verdict_reason: v.reason ?? null, partial: v.partial ?? 0,
      hit: v.verdict === 'hit', miss, scored: v.verdict !== 'error',
      final: t.final ?? null, truth: item.truth,
      answer_key: `${v.verdict}|${JSON.stringify(v.got ?? null)}`,
      latency_ms: t.latency_ms ?? null, model_ms: t.model_ms ?? ev.model_ms ?? null,
      first_turn_ms: timing.first_turn_ms, tool_ms: timing.tool_ms,
      prompt_tokens: tok.prompt_tokens, completion_tokens: tok.completion_tokens,
      turns: tok.turns, turns_with_usage: tok.turns_with_usage,
      tool_calls: ev.tool_calls ?? 0, gateway_queries, tool_bytes_in: ev.tool_bytes_in ?? 0,
      tool_errors: ev.tool_errors ?? 0, retries: ev.retries ?? 0,
      context_truncated: !!ev.context_truncated, context_exhausted: !!ev.context_exhausted,
      context_evictions: ev.context_evictions ?? 0, prompt_tokens_peak: ev.prompt_tokens_peak ?? 0,
      budget_exhausted: !!ev.budget_exhausted, forced_final: !!ev.forced_final, offline: !!ev.offline,
      cost_usd, cost_reason,
      miss_channel: ch.channel, miss_channel_note: ch.note,
      file: t._file ?? null,
    };
  });
}

/**
 * The item is the unit of every statistic (§1 sizes the Wilson interval at n = 120 ITEMS, not 240 repeats).
 * An item counts as a hit for an arm only if EVERY non-error repeat of it was a hit: at temperature 0 an
 * arm that answers correctly half the time has not answered the question, and the disagreement rate is the
 * noise floor §2 asks us to quote rather than a free half-mark.
 */
export function itemOutcome(units) {
  const scored = units.filter((u) => u.scored);
  if (!scored.length) return { status: 'error', hit: false, scored: false, split: false };
  const hits = scored.filter((u) => u.hit).length;
  return { status: hits === scored.length ? 'hit' : 'miss', hit: hits === scored.length, scored: true, split: hits > 0 && hits < scored.length };
}

const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
};

function accuracyBlock(items) {
  const scored = items.filter((i) => i.outcome.scored);
  const hits = scored.filter((i) => i.outcome.hit).length;
  const n = scored.length;
  const [lo, hi] = wilson(hits, n);
  return { n_items: items.length, n_scored: n, hits, accuracy: n ? hits / n : null, ci95: [lo, hi], errors: items.length - n };
}

/**
 * §6's offline cell, read rather than asserted. The runner writes the fault-injected run to
 * `runs/<id>-offline`; if that run has been scored, its accuracy is pulled in beside this one so the
 * four-cell table (B goes to the floor, C does not move, D degrades exactly to C) prints WITH the accuracy
 * table rather than in an appendix. Nothing is computed for it here — an unscored offline run says so.
 */
export function offlineComparison(runDir) {
  if (/-offline$/.test(runDir)) return { role: 'this directory IS the offline run', available: false };
  const p = `${runDir}-offline/summary.json`;
  if (!existsSync(p)) return { available: false, expected_at: p, note: 'the tools-unavailable run (§6) has not been scored yet — `node src/run.mjs --run <id> --offline` then re-score it' };
  const o = JSON.parse(readFileSync(p, 'utf8'));
  const by_arm = {};
  for (const [arm, blk] of Object.entries(o.arms ?? {})) by_arm[arm] = blk.headline_E1_E2?.stable_subset?.accuracy ?? null;
  return { available: true, path: p, scored_at: o.scored_at, by_arm };
}

/**
 * The transcripts carry their own copy of the questions.jsonl row, which is what makes re-scoring
 * self-contained — and also what an edited transcript would have to change. When the committed question set
 * is on disk, every embedded row is checked against it, so "the truth was edited after the run" is a
 * detected condition rather than a thing a reader has to take on trust.
 */
export function checkIntegrity(transcripts, runId) {
  // Counted whether or not the committed question set is on disk: an item that declares no deployment is a
  // defect in the question set that the miss decomposition can SEE (it cannot judge targeting for that item,
  // §6's `wrong_subgraph` rule), so it is reported rather than silently absorbed.
  const orphans = [...new Set(transcripts
    .filter((t) => !sourceIdsOf(t.question ?? {}).length)
    .map((t) => t.question?.id ?? t._file))];
  const qf = join(BENCH, 'data', String(runId), 'questions.jsonl');
  if (!existsSync(qf)) return { checked: false, questions_file: qf, items_without_source_ids: orphans.length, ids_without_source_ids: orphans, note: 'no committed question set for this run id — the embedded rows could not be cross-checked' };
  const want = new Map();
  for (const line of readFileSync(qf, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(line); want.set(r.id, r); }
  const mismatches = [], unknown = [];
  for (const t of transcripts) {
    const q = t.question, w = want.get(q?.id);
    if (!w) { unknown.push(q?.id ?? t._file); continue; }
    if (JSON.stringify(w.truth) !== JSON.stringify(q.truth) || w.answer_type !== q.answer_type || w.question !== q.question) mismatches.push({ id: q.id, file: t._file });
  }
  return { checked: true, questions_file: qf, mismatches, unknown_ids: [...new Set(unknown)], items_without_source_ids: orphans.length, ids_without_source_ids: orphans, ok: !mismatches.length && !unknown.length };
}

/**
 * §9's stamps, which have to travel further than summary.md: "the scorer stamps SIMULATED PATCH — NOT A
 * TRAINED MODEL into the summary header AND EVERY CHART SUBTITLE". src/chart.mjs calls this rather than
 * re-deriving the rule, so a chart can never be less honest than the summary about what produced it. The
 * VOID and integrity stamps are added by summarize() on top of these, because they need the scored numbers.
 */
export function provenanceStamps(provenance) {
  const out = [];
  if (provenance?.fixture) out.push('FIXTURE — SYNTHETIC TRANSCRIPTS, NOT A RUN');
  if (provenance && provenance.patch && provenance.patch.real_training !== true && provenance.patch.backend !== 'none') out.push(`SIMULATED PATCH — NOT A TRAINED MODEL (backend: ${provenance.patch.backend})`);
  if (!provenance) out.push('NO provenance.json — model, patch and block are unrecorded for this scoring');
  if (provenance?.offline) out.push('OFFLINE RUN — the MCP transport was fault-injected to 503 for every call (§6)');
  if (provenance?.restarts_detected > 0) out.push(`${provenance.restarts_detected} vLLM restart(s) detected during the run; ${provenance.chunks_rerun ?? 0} chunk(s) re-run (§4)`);
  return out;
}

export function summarize({ units, transcripts, provenance, pricing, pricingPath, runDir, runId }) {
  assertNoDuplicateUnits(units);
  const arms = [...new Set(units.map((u) => u.arm))].sort((a, b) => ARM_ORDER.indexOf(a) - ARM_ORDER.indexOf(b));
  const byArm = groupBy(units, (u) => u.arm);

  // Item-level outcomes, per arm.
  const items = new Map(); // id -> { id, bucket, arm -> outcome }
  const itemMeta = new Map();
  for (const [arm, rows] of byArm) {
    for (const [id, us] of groupBy(rows, (r) => r.id)) {
      if (!items.has(id)) items.set(id, {});
      items.get(id)[arm] = { id, bucket: us[0].bucket, outcome: itemOutcome(us), units: us };
      itemMeta.set(id, { id, bucket: us[0].bucket, answer_type: us[0].answer_type, form: us[0].form, taught: us[0].taught, hop: us[0].hop });
    }
  }

  // §2: an item whose two arm-A answers disagree is `unstable`. The headline is reported on the stable
  // subset and a sensitivity row over all items is printed underneath.
  const unstable = new Set();
  const armA = byArm.get('A');
  if (armA) {
    for (const [id, us] of groupBy(armA, (r) => r.id)) {
      if (us.length < 2) continue;
      if (new Set(us.map((u) => u.answer_key)).size > 1) unstable.add(id);
    }
  }
  const stableOnly = (list) => list.filter((i) => !unstable.has(i.id));

  const armBlock = (arm, filter) => {
    const list = [...items.values()].map((byA) => byA[arm]).filter(Boolean).filter(filter ?? (() => true));
    return list;
  };

  const perArm = {};
  for (const arm of arms) {
    const all = armBlock(arm);
    const rows = byArm.get(arm) ?? [];
    const buckets = {};
    for (const b of BUCKETS) {
      const inB = all.filter((i) => i.bucket === b);
      buckets[b] = {
        stable_subset: accuracyBlock(stableOnly(inB)),
        all_items: accuracyBlock(inB),
      };
    }
    const e1e2 = all.filter((i) => i.bucket === 'headline' || i.bucket === 'korean');
    const verdicts = {};
    for (const v of ['hit', 'wrong', 'ambiguous', 'abstain', 'error']) verdicts[v] = rows.filter((r) => r.verdict === v).length;
    const sum = (f) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
    const priced = rows.filter((r) => r.cost_usd != null);
    const mean = (f, src = rows) => (src.length ? src.reduce((a, r) => a + (f(r) ?? 0), 0) / src.length : null);
    // A quantity that was never recorded is NOT a zero. Averaging a missing wall clock as 0 ms makes the arm
    // that failed look faster than the arm that did not, and src/chart.mjs has always filtered non-finite
    // values out of its own mean — so the two files would print different numbers for the same run with
    // nothing to catch it. Counts are different: a unit that made no tool call really made zero.
    const meanOf = (f) => { const xs = rows.map(f).filter((x) => typeof x === 'number' && Number.isFinite(x)); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
    const missing = (f) => rows.filter((r) => !Number.isFinite(f(r))).length;
    perArm[arm] = {
      units: rows.length,
      overall: { stable_subset: accuracyBlock(stableOnly(all)), all_items: accuracyBlock(all) },
      headline_E1_E2: { stable_subset: accuracyBlock(stableOnly(e1e2)), all_items: accuracyBlock(e1e2) },
      buckets,
      verdicts,
      unit_accuracy_all_repeats: (() => { const s = rows.filter((r) => r.scored); return s.length ? s.filter((r) => r.hit).length / s.length : null; })(),
      split_items: all.filter((i) => i.outcome.split).length,
      partial_mean_lists: (() => { const l = rows.filter((r) => String(r.answer_type).startsWith('list<') && r.scored); return l.length ? l.reduce((a, r) => a + r.partial, 0) / l.length : null; })(),
      tokens: {
        prompt_total: sum((r) => r.prompt_tokens), completion_total: sum((r) => r.completion_tokens),
        prompt_per_question: mean((r) => r.prompt_tokens), completion_per_question: mean((r) => r.completion_tokens),
        prompt_tokens_peak_max: rows.reduce((a, r) => Math.max(a, r.prompt_tokens_peak ?? 0), 0),
        turns_per_question: mean((r) => r.turns),
      },
      tools: {
        tool_calls_total: sum((r) => r.tool_calls), tool_calls_per_question: mean((r) => r.tool_calls),
        tool_calls_median: median(rows.map((r) => r.tool_calls)),
        gateway_queries_total: sum((r) => r.gateway_queries),
        tool_bytes_in_total: sum((r) => r.tool_bytes_in),
        truncated_units: rows.filter((r) => r.context_truncated).length,
        context_exhausted_units: rows.filter((r) => r.context_exhausted).length,
        budget_exhausted_units: rows.filter((r) => r.budget_exhausted).length,
        forced_final_units: rows.filter((r) => r.forced_final).length,
        retries_total: sum((r) => r.retries), tool_errors_total: sum((r) => r.tool_errors),
      },
      timing: {
        latency_ms_mean: meanOf((r) => r.latency_ms), model_ms_mean: meanOf((r) => r.model_ms),
        latency_ms_median: median(rows.map((r) => r.latency_ms)),
        units_without_latency: missing((r) => r.latency_ms), units_without_model_ms: missing((r) => r.model_ms),
        basis: 'mean and median over the units that recorded the quantity; a unit that recorded none is excluded and counted beside it, never averaged in as zero',
      },
      cost: {
        priced_units: priced.length, unpriced_units: rows.length - priced.length,
        unpriced_reason: rows.find((r) => r.cost_usd == null)?.cost_reason ?? null,
        total_usd: priced.length ? priced.reduce((a, r) => a + r.cost_usd, 0) : null,
        per_question_usd: priced.length ? priced.reduce((a, r) => a + r.cost_usd, 0) / priced.length : null,
      },
    };
  }

  // §6: the miss decomposition, for the tool arms. Unit-level, and it must sum.
  const missChannels = {};
  for (const arm of arms) {
    if (!TOOL_ARMS.has(arm)) continue;
    const rows = (byArm.get(arm) ?? []).filter((r) => r.miss);
    const counts = Object.fromEntries(CHANNELS.map((c) => [c, 0]));
    for (const r of rows) {
      // An invented channel would still make the totals agree while vanishing from the eight printed rows —
      // a table that silently does not add up. Rule 3 is exhaustive AND exclusive over §6's eight.
      if (!CHANNELS.includes(r.miss_channel)) throw new Error(`arm ${arm}: miss ${r.id}.${r.repeat} is assigned to "${r.miss_channel}", which is not one of §6's eight channels`);
      counts[r.miss_channel] = (counts[r.miss_channel] ?? 0) + 1;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    missChannels[arm] = {
      unit: '(item, repeat)',
      misses: rows.length, assigned: total, sums: total === rows.length,
      channels: counts,
      by_bucket: Object.fromEntries(BUCKETS.map((b) => {
        const inB = rows.filter((r) => r.bucket === b);
        const c = Object.fromEntries(CHANNELS.map((x) => [x, inB.filter((r) => r.miss_channel === x).length]));
        return [b, { misses: inB.length, channels: c }];
      })),
      had_it_on_tolerant_decimal_match: rows.filter((r) => r.miss_channel === 'had_it_and_still_wrong' && r.miss_channel_note?.tolerant_numeric_match).length,
    };
    if (total !== rows.length) throw new Error(`arm ${arm}: ${total} channel assignments for ${rows.length} misses — the decomposition must be exhaustive and exclusive (rule 3)`);
  }

  // Paired tests, item level, on the same items in both arms (§1: exact McNemar on the discordant pairs).
  const pairsFor = (a1, a2, filter) => {
    const out = [];
    for (const [id, byA] of items) {
      const x = byA[a1], y = byA[a2];
      if (!x || !y || !x.outcome.scored || !y.outcome.scored) continue;
      if (filter && !filter(x)) continue;
      out.push([x.outcome.hit, y.outcome.hit]);
    }
    return out;
  };
  const comparisons = {};
  const wanted = [['A', 'B'], ['B', 'C'], ['C', 'D'], ['A', 'C'], ['B', 'D'], ['A', 'D']];
  for (const [a1, a2] of wanted) {
    if (!arms.includes(a1) || !arms.includes(a2)) continue;
    const key = `${a1}_vs_${a2}`;
    comparisons[key] = { overall: mcnemar(pairsFor(a1, a2, (i) => !unstable.has(i.id))) };
    for (const b of BUCKETS) comparisons[key][b] = mcnemar(pairsFor(a1, a2, (i) => i.bucket === b && !unstable.has(i.id)));
    comparisons[key].headline_E1_E2 = mcnemar(pairsFor(a1, a2, (i) => (i.bucket === 'headline' || i.bucket === 'korean') && !unstable.has(i.id)));
  }

  // §1's tripwire, as a loud top-level field rather than a footnote.
  const acc = (arm, b) => perArm[arm]?.buckets?.[b]?.all_items?.accuracy ?? null;
  const leakage = (() => {
    const B = acc('B', 'tripwire'), C = acc('C', 'tripwire'), A = acc('A', 'tripwire');
    const rule = 'README §1 + §"What would falsify this": arm C must FAIL the held-out facts. C ≥ B on that bucket is leakage and the run is VOID.';
    if (B == null || C == null) return { rule, evaluable: false, verdict: 'NOT EVALUABLE', detail: 'the tripwire bucket needs both arm B and arm C scored', arm_A: A, arm_B: B, arm_C: C };
    const leaked = C >= B;
    return { rule, evaluable: true, verdict: leaked ? 'VOID — LEAKAGE' : 'pass', arm_A: A, arm_B: B, arm_C: C,
      margin_C_minus_B: C - B,
      note_C_vs_floor: A == null ? null : (C > (perArm.A?.buckets?.tripwire?.all_items?.ci95?.[1] ?? 1)
        ? 'arm C is above arm A\'s Wilson upper bound on facts it was never taught — inspect before quoting, even though §1\'s void rule is C ≥ B'
        : 'arm C sits at or below the floor arm A sets on facts it was never taught, which is what §1 predicts') };
  })();

  const VOID = leakage.verdict === 'VOID — LEAKAGE';
  const void_reasons = VOID ? [`arm C scored ${fmtPct(leakage.arm_C)} on the held-out-fact bucket against arm B's ${fmtPct(leakage.arm_B)} — C ≥ B is leakage (§1)`] : [];

  // The named falsifiers, evaluated rather than described (§"What would falsify this").
  const falsifiers = [];
  const push = (name, verdict, detail) => falsifiers.push({ name, verdict, detail });
  const hB = perArm.B?.headline_E1_E2?.stable_subset?.accuracy, hC = perArm.C?.headline_E1_E2?.stable_subset?.accuracy;
  const e1B = acc('B', 'headline'), e1C = acc('C', 'headline'), hD = perArm.D?.headline_E1_E2?.stable_subset?.accuracy;
  if (hB != null && hC != null) push('B ≥ C on the headline bucket ⇒ the compiled-memory claim fails on this domain', hB >= hC ? 'TRIGGERED' : 'not triggered', `E1+E2 stable subset: B ${fmtPct(hB)} vs C ${fmtPct(hC)}`);
  else push('B ≥ C on the headline bucket', 'NOT EVALUABLE', 'both arms B and C must be scored');
  if (e1B != null && e1C != null) push('B ≥ C on E1 alone (§1\'s size table names E1 the headline bucket)', e1B >= e1C ? 'TRIGGERED' : 'not triggered', `E1, all items: B ${fmtPct(e1B)} vs C ${fmtPct(e1C)}`);
  if (hB != null && hC != null && hC > hB) {
    const m = missChannels.B;
    push('B < C but the loss channels do not account for it ⇒ a defect in arm B, to be fixed and re-run',
      m && m.sums && m.misses > 0 ? 'not triggered' : 'TRIGGERED',
      m ? `every one of arm B's ${m.misses} misses is assigned to exactly one of §6's channels (${m.assigned} assignments)` : 'no miss decomposition was produced for arm B');
  }
  if (hD != null && hC != null) push('D ≤ C ⇒ "hot path + tail" is wrong; adding the tool bought nothing', hD <= hC ? 'TRIGGERED' : 'not triggered', `E1+E2 stable subset: D ${fmtPct(hD)} vs C ${fmtPct(hC)}`);
  else push('D ≤ C', 'NOT EVALUABLE', 'both arms C and D must be scored');
  push('C ≥ B on held-out facts ⇒ leakage, the run is VOID', leakage.verdict === 'VOID — LEAKAGE' ? 'TRIGGERED' : leakage.evaluable ? 'not triggered' : 'NOT EVALUABLE', `tripwire: C ${fmtPct(leakage.arm_C)} vs B ${fmtPct(leakage.arm_B)}`);
  const aAcc = perArm.A?.overall?.stable_subset?.accuracy, bAcc = perArm.B?.overall?.stable_subset?.accuracy;
  if (aAcc != null && bAcc != null) push('A close to B ⇒ the questions are too easy and the item set is regenerated (§"The four arms")', bAcc - aAcc < 0.05 ? 'TRIGGERED' : 'not triggered', `overall stable subset: A ${fmtPct(aAcc)} vs B ${fmtPct(bAcc)}`);

  // The pre-registered ordering, checked cell by cell.
  const ordering = (() => {
    const v = (arm) => perArm[arm]?.headline_E1_E2?.stable_subset?.accuracy ?? null;
    const steps = [['A', 'B', '≪'], ['B', 'C', '<'], ['C', 'D', '<']].map(([x, y, op]) => ({
      step: `${x} ${op} ${y}`, x: v(x), y: v(y),
      holds: v(x) == null || v(y) == null ? null : (op === '≪' ? v(y) - v(x) >= 0.05 : v(y) > v(x)),
      mcnemar: comparisons[`${x}_vs_${y}`]?.headline_E1_E2 ?? null,
    }));
    return { claim: 'A ≪ B < C < D', measured_on: 'E1+E2, stable subset', steps, holds: steps.every((s) => s.holds === true) };
  })();

  // §6's break-even, in the form §6 actually asks for: "N* is a curve in the number of buyers, not a
  // scalar. Cumulative cost against question count for one buyer, ten, a hundred — with the single-buyer
  // line shown even where it never crosses." The scalar alone is the flattering half of that sentence: it
  // silently assumes the one-time price is shared, and §6.2 requires the UNSHARED number to be reported
  // first and plainly. Every price still comes from pricing.json; BUYERS is an axis, not a cost.
  const cpq = (arm) => perArm[arm]?.cost?.per_question_usd ?? null;
  const kprice = pricing?.knowledge?.price;
  const breakEven = (() => {
    const b = cpq('B'), c = cpq('C');
    const training = pricing?.knowledge?.training_usd ?? null;
    const base = {
      formula: 'N*(k buyers) = (knowledge_price / k) / (cost_per_question_B − cost_per_question_C)',
      cost_per_question_B: b, cost_per_question_C: c, knowledge_price: kprice ?? null,
      currency: pricing?.knowledge?.currency ?? null, pricing_file: pricingPath, buyers_axis: BUYERS,
      training_cost_usd: training,
      training_note: training == null
        ? 'pricing.json declares no knowledge.training_usd, so the fixed cost of PRODUCING the knowledge (§6.1: the measured cold load, the baseline generations and the contrast probes, not the step time) is not priced into N* here. N* prices the catalog anchor only.'
        : 'the fixed cost of producing the knowledge, read from pricing.json (§6.1: the measured one, not the step time)',
      amortisation_note: 'Two different claims, and only one of them is ours (§6.2). For a SINGLE user training their own patch the fixed cost is not amortised at all and the break-even is genuinely poor; for a marketplace the patch is trained once and applied by every node that buys it, so the one-time price divides by the number of buyers while the per-question saving does not. The single-buyer row is printed first for that reason, and it is printed even where it never crosses.',
    };
    if (b == null || c == null) return { ...base, n_star: null, per_buyer: [], reason: 'arms B and C must both be scored and priced' };
    const delta = b - c;
    if (delta <= 0) return { ...base, delta_usd_per_question: delta, n_star: null, per_buyer: BUYERS.map((k) => ({ buyers: k, price_per_buyer: typeof kprice === 'number' ? kprice / k : null, n_star: null })), reason: 'arm B is not more expensive per question than arm C — there is no break-even to compute' };
    if (typeof kprice !== 'number') return { ...base, delta_usd_per_question: delta, n_star: null, per_buyer: BUYERS.map((k) => ({ buyers: k, price_per_buyer: null, n_star: null })), reason: 'pricing.json carries no knowledge.price' };
    return {
      ...base, delta_usd_per_question: delta, n_star: kprice / delta, reason: null,
      per_buyer: BUYERS.map((k) => ({ buyers: k, price_per_buyer: kprice / k, n_star: (kprice / k) / delta })),
    };
  })();

  // §6: "Setup is separated from inference, like every other cost here. Applying a patch takes seconds and
  // happens once per node, so arm C's apply time is recorded separately from its per-item latency." It is
  // read, never estimated: an unmeasured load says it is unmeasured. src/chart.mjs resolves it in the same
  // order, and draws an ESTIMATE band with a stamp when nothing here answers.
  const setup = (() => {
    const f = join(runDir, 'knowledge-load.json');
    const rule = 'runs/<id>/knowledge-load.json → provenance.knowledge_load_ms → provenance.patch.load_ms / apply_ms';
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      const ms = j.knowledge_load_ms ?? j.ms ?? null;
      if (typeof ms === 'number') return { knowledge_load_ms: ms, source: f, rule, note: 'measured once per node, excluded from every per-item latency' };
    }
    const ms = provenance?.knowledge_load_ms ?? provenance?.patch?.load_ms ?? provenance?.patch?.apply_ms ?? null;
    if (typeof ms === 'number') return { knowledge_load_ms: ms, source: 'provenance.json', rule, note: 'measured once per node, excluded from every per-item latency' };
    return { knowledge_load_ms: null, source: null, rule, note: 'not recorded by this run — the one-time knowledge load was not measured, and no number is invented in its place' };
  })();

  // §3: "Actual usage is recorded — if the median item uses 2 calls, the budget was not the binding
  // constraint and the summary states that." Stated, not gestured at, and the cap is read from the run's
  // own provenance rather than typed in here.
  const cap = provenance?.budget ?? null;
  const budgetAnswer = arms.filter((a) => TOOL_ARMS.has(a)).map((arm) => {
    const rows = byArm.get(arm) ?? [];
    const med = median(rows.map((r) => r.tool_calls));
    const hit = rows.filter((r) => r.budget_exhausted).length;
    const binding = cap?.toolCalls != null && med != null ? med >= cap.toolCalls : null;
    return {
      arm, median_tool_calls: med, cap_tool_calls: cap?.toolCalls ?? null, cap_turns: cap?.turns ?? null, cap_wall_ms: cap?.wallMs ?? null,
      units_that_hit_a_cap: hit, units: rows.length,
      verdict: binding == null ? 'the run recorded no budget in provenance.json, so the cap cannot be compared to the usage'
        : binding ? 'the cap WAS the binding constraint for the median item' : 'the cap was NOT the binding constraint for the median item',
    };
  });

  const stamps = provenanceStamps(provenance);
  const integrity = checkIntegrity(transcripts, runId);
  if (integrity.checked && !integrity.ok) stamps.push(`INTEGRITY: ${integrity.mismatches.length} transcript(s) carry a question row that does not match data/${runId}/questions.jsonl, and ${integrity.unknown_ids.length} id(s) are not in it`);
  if (integrity.items_without_source_ids) stamps.push(`${integrity.items_without_source_ids} item(s) declare neither \`source_ids\` nor \`source.deployment_id\`: targeting cannot be judged for them, so their misses are NOT charged to \`wrong_subgraph\` (${integrity.ids_without_source_ids.slice(0, 5).join(', ')})`);
  if (VOID) stamps.unshift('RUN VOID — see the leakage tripwire');

  const bucketCounts = Object.fromEntries(BUCKETS.map((b) => [b, [...itemMeta.values()].filter((i) => i.bucket === b).length]));
  // An item in no declared bucket would be inside `overall` and inside no bucket row, so the bucket rows
  // would quietly stop adding up to the item count. Counted, named and stamped instead.
  const unclassified = [...itemMeta.values()].filter((i) => !BUCKETS.includes(i.bucket)).map((i) => i.id).sort();
  if (unclassified.length) stamps.push(`${unclassified.length} item(s) fall in no bucket §1 declares, so the bucket rows do not add up to the item count: ${unclassified.slice(0, 5).join(', ')}`);
  // §1's comparison is PAIRED — "all arms answer the same items". An arm missing items is otherwise averaged
  // into the same table beside arms that answered everything.
  const allIds = [...items.keys()];
  const itemSetMismatch = {};
  for (const arm of arms) {
    const missing = allIds.filter((id) => !items.get(id)[arm]);
    if (missing.length) itemSetMismatch[arm] = { n_missing: missing.length, missing: missing.sort() };
  }
  if (Object.keys(itemSetMismatch).length) {
    stamps.push(`the arms did not answer the same item set — ${Object.entries(itemSetMismatch).map(([a, x]) => `${a} is missing ${x.n_missing}`).join(', ')}; §1's paired comparison holds only over the items both arms answered`);
  }

  return {
    VOID, void_reasons,
    run: runId, run_dir: runDir, scored_at: new Date().toISOString(), scorer_version: SCORER_VERSION,
    stamps,
    leakage,
    ordering,
    falsifiers,
    unit_note: 'The unit of every accuracy, interval and paired test is the ITEM (§1 sizes the Wilson interval at n = 120 items). An item counts as a hit only if every non-error repeat of it was a hit. `unit_accuracy_all_repeats` and `split_items` are the (item, repeat)-level view beside it. The miss decomposition is (item, repeat)-level and says so in its own block.',
    fact_coherence_note: 'The headline (E1), Korean (E2) and ceiling (P) buckets ask about the SAME 120 facts. Those three buckets are within-fact comparisons of PHRASING, not three independent fact sets — the P-to-E1 gap is the generalisation cost on one fact set, and reading it as a comparison across fact sets is wrong.',
    counts: {
      transcripts: transcripts.length, units: units.length, items: items.size, arms, by_bucket: bucketCounts,
      unclassified_items: unclassified.length, unclassified_ids: unclassified,
      item_set_mismatch: Object.keys(itemSetMismatch).length ? itemSetMismatch : null,
    },
    integrity,
    setup,
    budget: { cap: cap, per_arm: budgetAnswer },
    offline: offlineComparison(runDir),
    stability: { unstable_items: unstable.size, unstable_ids: [...unstable].sort(), basis: 'the two arm-A repeats of the item produced different normalised answers (§2)' },
    arms: perArm,
    miss_channels: missChannels,
    comparisons,
    break_even: breakEven,
    pricing: { file: pricingPath, model: pricing?.model ?? null, graph: pricing?.graph ?? null, knowledge: pricing?.knowledge ?? null },
    provenance: provenance ?? null,
  };
}

function median(xs) {
  const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────────────────

const fmtPct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const fmtCi = (b) => (b?.accuracy == null ? '—' : `${(b.accuracy * 100).toFixed(1)}% [${(b.ci95[0] * 100).toFixed(0)}–${(b.ci95[1] * 100).toFixed(0)}] ${b.hits}/${b.n_scored}`);
const fmtUsd = (x) => (x == null ? '—' : `$${x < 0.01 ? x.toFixed(6) : x.toFixed(4)}`);
const fmtNum = (x, d = 1) => (x == null ? '—' : Number(x).toFixed(d));
const fmtP = (m) => (m == null ? '—' : `b=${m.b} c=${m.c} p=${m.p < 0.0001 ? '<0.0001' : m.p.toFixed(4)}`);

function table(headers, rows) {
  const out = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const r of rows) out.push(`| ${r.join(' | ')} |`);
  return out.join('\n');
}

export function renderMarkdown(s) {
  const arms = s.counts.arms;
  const L = [];
  const p = (x = '') => L.push(x);

  p(`# Four-arm benchmark — results for run \`${s.run}\``);
  p();
  p(`Scored ${s.scored_at} by \`src/score.mjs\` v${s.scorer_version} from the committed transcripts alone — no GPU, no API key, no network, no LLM judge (§5). Every verdict comes from \`src/normalize.mjs\`; every price from \`${s.pricing.file}\`.`);
  p();
  for (const st of s.stamps) p(`> **${st}**`);
  if (s.stamps.length) p();

  p('## 0. The pre-registered falsifiers, before the tables');
  p();
  p('§"What would falsify this" requires these to land ahead of the numbers, so they are printed first whether they fired or not.');
  p();
  p(table(['Falsifier', 'Verdict', 'Evidence'], s.falsifiers.map((f) => [f.name, f.verdict === 'not triggered' ? 'not triggered' : `**${f.verdict}**`, f.detail])));
  p();
  p(`**Leakage tripwire (§1).** ${s.leakage.rule}`);
  p();
  p(`- arm B on held-out facts: ${fmtPct(s.leakage.arm_B)} · arm C: ${fmtPct(s.leakage.arm_C)} · arm A (floor): ${fmtPct(s.leakage.arm_A)}`);
  p(`- **verdict: ${s.leakage.verdict}**${s.leakage.note_C_vs_floor ? ` — ${s.leakage.note_C_vs_floor}` : ''}`);
  p();
  p(`**RUN VOID: ${s.VOID ? 'YES' : 'no'}**${s.void_reasons.length ? ` — ${s.void_reasons.join('; ')}` : ''}`);
  p();
  p('### The ordering under test');
  p();
  p(`Claim: **${s.ordering.claim}**, measured on ${s.ordering.measured_on}. Holds end to end: **${s.ordering.holds ? 'yes' : 'no'}**.`);
  p();
  p(table(['Step', 'left', 'right', 'holds', 'exact McNemar (items)'], s.ordering.steps.map((x) => [x.step, fmtPct(x.x), fmtPct(x.y), x.holds == null ? '—' : x.holds ? 'yes' : '**no**', fmtP(x.mcnemar)])));
  p();
  p('`A ≪ B` is read as a margin of at least 5 points; the other two steps are strict inequalities. A difference is never called a difference without its p-value and both intervals (below).');
  p();

  p('## 1. Accuracy per arm × bucket');
  p();
  p(`Unit: the item. ${s.unit_note}`);
  p();
  p(`Stable subset = items whose two arm-A repeats agreed (§2). ${s.stability.unstable_items} of ${s.counts.items} items are unstable and are excluded from the headline; the sensitivity row over all items follows.`);
  p();
  p('**Headline — stable subset, accuracy [Wilson 95%] hits/n**');
  p();
  p(table(['Bucket', ...arms, 'pre-registered (A / B / C / D)'], [
    ...BUCKETS.map((b) => [PREREG[b].label, ...arms.map((a) => fmtCi(s.arms[a].buckets[b].stable_subset)), `${PREREG[b].A} / ${PREREG[b].B} / ${PREREG[b].C} / ${PREREG[b].D}`]),
    ['**E1+E2 combined — the headline**', ...arms.map((a) => `**${fmtCi(s.arms[a].headline_E1_E2.stable_subset)}**`), 'floor / mid / high / high'],
    [`All ${s.counts.items} items`, ...arms.map((a) => fmtCi(s.arms[a].overall.stable_subset)), '—'],
  ]));
  p();
  p('**Sensitivity — the same table over ALL items, unstable ones included**');
  p();
  p(table(['Bucket', ...arms], [
    ...BUCKETS.map((b) => [PREREG[b].label, ...arms.map((a) => fmtCi(s.arms[a].buckets[b].all_items))]),
    ['E1+E2 combined', ...arms.map((a) => fmtCi(s.arms[a].headline_E1_E2.all_items))],
    ['All items', ...arms.map((a) => fmtCi(s.arms[a].overall.all_items))],
  ]));
  p();
  p(`> ${s.fact_coherence_note}`);
  p();
  p('**Offline — the capability, not a footnote (§6)**');
  p();
  if (!s.offline.available) {
    p(`Not available: ${s.offline.role ?? s.offline.note}${s.offline.expected_at ? ` (expected at \`${s.offline.expected_at}\`)` : ''}. Arm C issues no network request of any kind by construction; the cell below is the measured version of that, and it is empty until the fault-injected run is scored.`);
  } else {
    p(`Arms B and D re-run with the MCP transport returning 503 for every call — an injected outage, nothing fabricated. Read from \`${s.offline.path}\` (scored ${s.offline.scored_at}). E1+E2, stable subset.`);
    p();
    p(table(['Arm', 'tools available', 'tools unavailable', 'change'], arms.map((a) => {
      const on = s.arms[a].headline_E1_E2.stable_subset.accuracy, off = s.offline.by_arm[a] ?? null;
      return [a, fmtPct(on), fmtPct(off), on == null || off == null ? '—' : `${off - on >= 0 ? '+' : ''}${((off - on) * 100).toFixed(1)} pts`];
    })));
    p();
    p('The cell a buyer cares about is D: adding the tool costs nothing when the tool is gone, so D should degrade exactly to C while C does not move at all.');
  }
  p();
  p('**Paired tests (exact McNemar over the discordant pairs, stable subset)**');
  p();
  p(table(['Comparison', 'E1+E2', ...BUCKETS, 'all items'], Object.entries(s.comparisons).map(([k, v]) => [k.replace(/_vs_/, ' vs '), fmtP(v.headline_E1_E2), ...BUCKETS.map((b) => fmtP(v[b])), fmtP(v.overall)])));
  p();

  p('## 2. Verdict split — where the non-hits went');
  p();
  p('§5: accuracy is `hit / (all non-error items)`. `ambiguous` is counted as a MISS in the headline and reported here in its own column, because without that rule an arm can farm accuracy by shotgunning addresses. `abstain` is never counted as wrong — the difference between `wrong` and `abstain` *is* the hallucination metric. Rows are (item, repeat) units.');
  p();
  p(table(['Arm', 'units', 'hit', 'wrong', 'ambiguous', 'abstain', 'error', 'split items (repeats disagreed)'], arms.map((a) => {
    const v = s.arms[a].verdicts;
    return [a, s.arms[a].units, v.hit, v.wrong, v.ambiguous, v.abstain, v.error, s.arms[a].split_items];
  })));
  p();
  p('`list<T>` items also carry a Jaccard `partial`, which travels beside the headline and is never blended into it (§5): ' + arms.map((a) => `${a} ${fmtNum(s.arms[a].partial_mean_lists, 3)}`).join(' · ') + '.');
  p();

  p('## 3. Where arm B\'s answers are lost — the decomposition that carries the C > B claim');
  p();
  if (!Object.keys(s.miss_channels).length) {
    p('No tool arm was scored in this run, so there is no decomposition to print.');
  } else {
    p('Every miss in a tool arm is assigned to exactly ONE of §6\'s channels by a deterministic check over the recorded transcript, and the column sums to the miss count. A miss is any scored (non-error) unit that is not a hit — `wrong` + `ambiguous` + `abstain` — which is exactly the gap between the arm\'s accuracy and 100%. Unit: (item, repeat).');
    p();
    const tarms = Object.keys(s.miss_channels);
    p(table(['Channel', 'rule over the transcript', ...tarms], [
      ['`skipped`', 'zero tool calls made', ...tarms.map((a) => s.miss_channels[a].channels.skipped)],
      ['`wrong_subgraph`', 'no executed query targeted any id in the item\'s `source_ids[]`', ...tarms.map((a) => s.miss_channels[a].channels.wrong_subgraph)],
      ['`query_error`', 'every executed query returned a GraphQL error or empty `data`', ...tarms.map((a) => s.miss_channels[a].channels.query_error)],
      ['`budget_exhausted`', 'the 8-call / 10-turn / 90 s cap was hit before an answer', ...tarms.map((a) => s.miss_channels[a].channels.budget_exhausted)],
      ['`context_exhausted`', 'the window filled with tool output: an eviction, or vLLM\'s own 400', ...tarms.map((a) => s.miss_channels[a].channels.context_exhausted)],
      ['`truncated`', 'the truth appears ONLY in tool results that were cut at the context wall', ...tarms.map((a) => s.miss_channels[a].channels.truncated)],
      ['`had_it_and_still_wrong`', 'the truth IS in a tool result and the final answer differs', ...tarms.map((a) => s.miss_channels[a].channels.had_it_and_still_wrong)],
      ['`ignored_result`', 'the truth appears in NO tool result', ...tarms.map((a) => s.miss_channels[a].channels.ignored_result)],
      ['**total assigned**', '', ...tarms.map((a) => `**${s.miss_channels[a].assigned}**`)],
      ['**misses**', 'wrong + ambiguous + abstain', ...tarms.map((a) => `**${s.miss_channels[a].misses}**`)],
      ['sums', 'the decomposition is exhaustive and exclusive', ...tarms.map((a) => (s.miss_channels[a].sums ? 'yes' : '**NO — bug**'))],
    ]));
    p();
    p('The ladder is first-match-wins and ordered from the diagnosis that costs our thesis the most to the one that costs it the least: `skipped` → `wrong_subgraph` → `query_error` → `budget_exhausted` → `context_exhausted` → `truncated` → `had_it_and_still_wrong` → `ignored_result`. An item is credited to `had_it_and_still_wrong` — the channel that flatters the compiled-memory claim — only after every "the loop never got there" explanation has been ruled out, and `truncated` is deliberately narrow so that any doubt about whether the model could see the value moves the item OUT of that channel.');
    p();
    for (const a of tarms) {
      if (s.miss_channels[a].had_it_on_tolerant_decimal_match) {
        p(`Disclosure, arm ${a}: ${s.miss_channels[a].had_it_on_tolerant_decimal_match} of the \`had_it_and_still_wrong\` assignments are \`decimal\` items, where "the truth is in the result" is decided with the scorer's own ±1% tolerance and a large JSON body can contain an unrelated number inside it.`);
        p();
      }
      p(`**Arm ${a}, by bucket**`);
      p();
      p(table(['Bucket', 'misses', ...CHANNELS.map((c) => `\`${c}\``)], BUCKETS.map((b) => {
        const x = s.miss_channels[a].by_bucket[b];
        return [b, x.misses, ...CHANNELS.map((c) => x.channels[c])];
      })));
      p();
    }
  }

  p('## 4. What each arm spent');
  p();
  p('Tokens are summed over ALL turns from vLLM\'s own `usage` (§6) and are host-independent; latency is not. `model_ms` is the sum of vLLM latencies, so model time and network time are separable and nobody can claim the gap is just The Graph\'s servers being far away.');
  p();
  p(table(['Arm', 'prompt tok/q', 'completion tok/q', 'peak prompt tok', 'turns/q', 'tool calls/q (median)', 'gateway queries', 'tool bytes in', 'latency ms (mean/median)', 'model ms (mean)', 'cost/question'],
    arms.map((a) => {
      const x = s.arms[a];
      return [a, fmtNum(x.tokens.prompt_per_question, 0), fmtNum(x.tokens.completion_per_question, 0), x.tokens.prompt_tokens_peak_max || '—',
        fmtNum(x.tokens.turns_per_question, 2), `${fmtNum(x.tools.tool_calls_per_question, 2)} (${fmtNum(x.tools.tool_calls_median, 1)})`,
        x.tools.gateway_queries_total, x.tools.tool_bytes_in_total, `${fmtNum(x.timing.latency_ms_mean, 0)} / ${fmtNum(x.timing.latency_ms_median, 0)}`,
        fmtNum(x.timing.model_ms_mean, 0), fmtUsd(x.cost.per_question_usd)];
    })));
  p();
  p(table(['Arm', 'truncated units', 'context_exhausted units', 'budget_exhausted units', 'forced finals', 'retries', 'tool errors'],
    arms.map((a) => { const t = s.arms[a].tools; return [a, t.truncated_units, t.context_exhausted_units, t.budget_exhausted_units, t.forced_final_units, t.retries_total, t.tool_errors_total]; })));
  p();
  p('**Setup is separated from inference (§6)** — applying a patch happens once per node, so it is never folded into a per-item latency.');
  p();
  p(table(['', 'value', 'source'], [
    ['one-time knowledge load (arms C and D)', s.setup.knowledge_load_ms == null ? '**not recorded**' : `${fmtNum(s.setup.knowledge_load_ms, 0)} ms`, s.setup.source ?? s.setup.note],
    ['resolution order', s.setup.rule, 'the same order `src/chart.mjs` uses'],
  ]));
  p();
  p('**The budget question, answered (§3)** — "if the median item uses 2 calls, the budget was not the binding constraint and the summary states that". The cap is read from this run\'s own `provenance.json`.');
  p();
  if (!s.budget.per_arm.length) p('No tool arm was scored in this run, so no budget was in force.');
  else {
    p(table(['Arm', 'median tool calls', 'cap (calls / turns / wall)', 'units that hit a cap', 'verdict'], s.budget.per_arm.map((b) => [
      b.arm, fmtNum(b.median_tool_calls, 1),
      b.cap_tool_calls == null ? '—' : `${b.cap_tool_calls} / ${b.cap_turns} / ${fmtNum((b.cap_wall_ms ?? 0) / 1000, 0)} s`,
      `${b.units_that_hit_a_cap} / ${b.units}`, `**${b.verdict}**`,
    ])));
  }
  p();

  p('## 5. Break-even — how many questions before buying the knowledge is cheaper');
  p();
  const be = s.break_even;
  p(`\`${be.formula}\``);
  p();
  p(table(['term', 'value', 'source'], [
    ['cost_per_question_B', fmtUsd(be.cost_per_question_B), 'measured tokens × list price'],
    ['cost_per_question_C', fmtUsd(be.cost_per_question_C), 'measured tokens × list price'],
    ['difference', be.delta_usd_per_question == null ? '—' : fmtUsd(be.delta_usd_per_question), 'per question, B − C'],
    ['knowledge_price', be.knowledge_price == null ? '**not set**' : `${be.knowledge_price} ${be.currency ?? ''}`, `${be.pricing_file} → knowledge.price`],
    ['**N\\***', be.n_star == null ? '**not computed**' : `**${Math.ceil(be.n_star)} questions**`, be.reason ?? 'price ÷ difference'],
  ]));
  p();
  if (be.n_star == null) p(`N\\* is left uncomputed because ${be.reason}. Nothing is assumed in its place: §6 allows no cost number that was not read from \`${be.pricing_file}\`.`);
  else p(`After **${Math.ceil(be.n_star)} questions**, one buyer paying the whole price once is cheaper than querying every time at these list prices. Change a price in \`${be.pricing_file}\` and re-run \`node src/score.mjs\`: this number and every cost cell above move with it.`);
  p();
  p('### N\\* is a curve in the number of buyers, not a scalar (§6.3)');
  p();
  p(be.amortisation_note);
  p();
  p(table(['buyers sharing the one-time price', 'price each pays', 'N\\* — questions before buying beats querying'], (be.per_buyer ?? []).map((x) => [
    x.buyers === 1 ? '**1 — a single user training their own patch**' : `${x.buyers}`,
    x.price_per_buyer == null ? '**not set**' : `${x.price_per_buyer} ${be.currency ?? ''}`,
    x.n_star == null ? '**not computed**' : `${Math.ceil(x.n_star)}`,
  ])));
  p();
  p(`The single-buyer row is printed first and is printed even where it never crosses, because §6.2 requires the unflattering claim to carry the flattering one: for one user training their own patch, the GPU hours §6.1 measures are not a trade anyone makes to answer this many questions faster, and the marketplace number is only credible standing next to that. ${be.training_note}`);
  p();
  p(`Prices used: input ${s.pricing.model?.usd_per_1m_input_tokens ?? '—'} / 1M, output ${s.pricing.model?.usd_per_1m_output_tokens ?? '—'} / 1M, gateway ${s.pricing.graph?.usd_per_query ?? '—'} per query. ${s.pricing.model?.source ?? ''}`);
  p();

  p('The same numbers are drawn by `node src/chart.mjs runs/<id>` into `runs/<id>/charts/`: the break-even crossing, the latency decomposition and the cumulative latency including arm C\'s one-time knowledge load, accuracy by arm × bucket with the tripwire held apart, and the miss decomposition above. Those charts read `results.json`, cross-check themselves against this file, and stamp any disagreement on their own face.');
  p();
  p('## 6. Noise floor and run integrity');
  p();
  p(table(['', 'value'], [
    ['items', s.counts.items], ['(arm, item, repeat) units', s.counts.units], ['arms scored', arms.join(', ')],
    ['unstable items (arm A\'s two repeats disagreed)', `${s.stability.unstable_items} / ${s.counts.items}`],
    ...arms.map((a) => [`arm ${a}: items whose repeats disagreed`, s.arms[a].split_items]),
    ...BUCKETS.map((b) => [`bucket ${b}`, s.counts.by_bucket[b]]),
    ['vLLM restarts during the run (§4)', s.provenance?.restarts_detected ?? '—'],
    ['chunks re-run (§4)', s.provenance?.chunks_rerun ?? '—'],
    ['model', s.provenance?.model ?? '—'],
    ['max_model_len', s.provenance?.max_model_len ?? '—'],
    ['patch backend / real training', s.provenance ? `${s.provenance.patch?.backend ?? '—'} / ${s.provenance.patch?.real_training ?? '—'}` : '—'],
    ['git commit', s.provenance?.git_commit ?? '—'],
    ['the 50-prompt side-effect table (§6), all four cells', existsSync(join(s.run_dir, 'locality.json')) ? `present at \`runs/${s.run}/locality.json\`` : `**absent** — produced by \`src/locality.mjs\` and \`src/locality-tools.mjs\`, not by this scorer, and not present for this run`],
    ['items in no declared bucket', s.counts.unclassified_items ? `**${s.counts.unclassified_items}** — ${s.counts.unclassified_ids.slice(0, 5).join(', ')}` : '0'],
    ['arms answering different item sets (§1 is paired)', s.counts.item_set_mismatch ? `**${Object.entries(s.counts.item_set_mismatch).map(([a, x]) => `${a}: ${x.n_missing} missing`).join(', ')}**` : 'no — every arm answered every item'],
    ['embedded question rows checked against the committed set', s.integrity.checked ? (s.integrity.ok ? 'yes — all match' : `**${s.integrity.mismatches.length} mismatch(es), ${s.integrity.unknown_ids.length} unknown id(s)**`) : 'not checked (no committed question set for this run id)'],
  ]));
  p();

  p('## 7. Threats to validity (§7, printed here rather than buried in the protocol)');
  p();
  p('1. **The patch is trained on facts pulled from these very subgraphs.** The mitigations are the held-out phrasings (the headline bucket is never a trained string), the held-out facts (arm C must fail them and arm B should win them), the multi-hop items (truth computed by the generator, never a training row), and the decomposition in §3 above, which requires any C > B gap to be explained by a named loss channel rather than by coverage.');
  p(`2. **${s.provenance?.max_model_len ?? 'The'}-token context** is this deployment's limit and it constrains the tool arms more than the others. Tokens are reported next to accuracy precisely so the reader can re-judge on a larger host; the peak prompt size per arm is in §4.`);
  p('3. **One model, one domain, one host, one run window.** The two-repeat disagreement rate above is the noise floor.');
  p('4. **Modelled costs, not invoices.** Every price is a published list price with a URL in `pricing.json`; nothing here was billed to us.');
  p('5. **Whoever ran it wanted a particular answer.** The counter is not a promise: the pinned block, the raw gateway responses, the transcripts and this scorer with its passing self-test (`node src/score.test.mjs`) are all committed, so re-scoring is cheaper than trusting us.');
  p();
  p('### How this scorer read the protocol where it had to choose');
  p();
  p('- **An empty answer after a completed turn is a miss, not an `error`.** §5 lists "empty" under `error` and §3 says running out of window is "a MISS, never an `error`". They are reconciled the only way that does not pay an arm for failing: `error` means no answering turn ever completed (a transport failure), and a forced final is a completed turn. An item with `context_exhausted` and an empty `final` is therefore scored `wrong` with the `context_exhausted` channel, and an empty string is never handed to the abstain regex.');
  p('- **`wrong_subgraph` is judged over `source_ids[]`**, every deployment a fair query could have targeted, falling back to `[source.deployment_id]` for rows that predate that field. For a hop-2 join, querying either operand\'s subgraph is legitimate work.');
  p('- **The item, not the repeat, is the statistical unit**, and an item counts as a hit only if every non-error repeat was a hit. §1 sizes its intervals at n = 120 items.');
  p('- **`ambiguous` is a miss** in every accuracy cell and appears separately in §2.');
  p('- **An answer that exists is scored, even when the runner also recorded a transport error.** `error` deletes a unit from the accuracy denominator (§5), and a unit that produced an answer is not a unit the scorer gets to delete; the condition travels on the row instead.');
  p('- **A missing wall clock is not a zero.** Latency and model time are averaged over the units that recorded them, and the units that did not are counted beside the mean (§4) rather than pulling it down.');
  p('- **An item that declares no deployment is not charged to `wrong_subgraph`.** That channel blames the agent for aiming badly, and an item carrying neither `source_ids` nor `source.deployment_id` gives it nothing to aim at; the count is stamped at the top of this file instead.');
  p('- **`guard_verdict` is listed in §6\'s per-unit field list and no transcript carries one.** The runner declares `sampling.guard: false` (`provenance.json`), so no guard ran and there is no verdict to report; the field is absent rather than filled with a default. If a guard is ever enabled, this scorer must be extended before the column can be quoted.');
  p();
  return L.join('\n');
}

export function renderCsv(units) {
  const cols = ['arm', 'id', 'repeat', 'bucket', 'form', 'taught', 'hop', 'answer_type', 'verdict', 'partial', 'hit', 'scored',
    'latency_ms', 'model_ms', 'first_turn_ms', 'tool_ms', 'prompt_tokens', 'completion_tokens', 'turns', 'tool_calls', 'gateway_queries', 'tool_bytes_in',
    'tool_errors', 'retries', 'context_truncated', 'context_exhausted', 'context_evictions', 'prompt_tokens_peak',
    'budget_exhausted', 'forced_final', 'cost_usd', 'miss_channel', 'verdict_reason', 'final', 'truth'];
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...units.map((u) => cols.map((c) => esc(u[c])).join(','))].join('\n') + '\n';
}

// ── entry point ──────────────────────────────────────────────────────────────────────────────────────────

export function scoreRun(runDir, { pricingPath = null, outDir = null } = {}) {
  const dir = resolve(runDir);
  const transcripts = readTranscripts(dir);
  if (!transcripts.length) throw new Error(`${dir}/transcripts holds no transcript files`);
  const { pricing, path: ppath } = loadPricing(pricingPath);
  const provFile = join(dir, 'provenance.json');
  const provenance = existsSync(provFile) ? JSON.parse(readFileSync(provFile, 'utf8')) : null;
  const units = scoreUnits(transcripts, pricing);
  const runId = provenance?.run_id ?? dir.split('/').filter(Boolean).pop();
  const summary = summarize({ units, transcripts, provenance, pricing, pricingPath: ppath, runDir: dir, runId });
  const out = resolve(outDir ?? dir);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'results.json'), JSON.stringify({ run: runId, scorer_version: SCORER_VERSION, scored_at: summary.scored_at, unit: '(arm, item, repeat)', rows: units }, null, 2));
  writeFileSync(join(out, 'per-question.csv'), renderCsv(units));
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(out, 'summary.md'), renderMarkdown(summary) + '\n');
  return { summary, units, out };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const flags = {}; const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
    else positional.push(args[i]);
  }
  const flag = (name) => (typeof flags[name] === 'string' ? flags[name] : null);
  const runDir = positional[0];
  if (!runDir) { console.error('usage: node src/score.mjs runs/<id> [--pricing pricing.json] [--out <dir>]'); process.exit(1); }
  try {
    const { summary, units, out } = scoreRun(runDir, { pricingPath: flag('pricing'), outDir: flag('out') });
    for (const st of summary.stamps) console.error(`!! ${st}`);
    console.error(`scored ${units.length} units over ${summary.counts.items} items in arms ${summary.counts.arms.join(',')}`);
    for (const a of summary.counts.arms) console.error(`  ${a}: E1+E2 ${fmtCi(summary.arms[a].headline_E1_E2.stable_subset)}  cost/q ${fmtUsd(summary.arms[a].cost.per_question_usd)}`);
    console.error(`leakage tripwire: ${summary.leakage.verdict}   RUN VOID: ${summary.VOID ? 'YES' : 'no'}`);
    console.error(`wrote results.json, per-question.csv, summary.json, summary.md to ${out}`);
  } catch (e) { console.error(`score.mjs: ${e.message}`); process.exit(1); }
}
