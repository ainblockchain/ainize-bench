#!/usr/bin/env node
// The four-arm runner.
//
//   node src/run.mjs --run r1 --arms A,B,C,D --patch <knowledge-id> [--limit N] [--repeats 2] [--offline]
//
// It needs the GPU (the model at :8002) and, for arms B/D, network. Everything it writes is re-scorable
// without either: the transcripts carry every request, every response, every tool result in full, and the
// usage and timing of each turn. `src/score.mjs` never talks to a model.
//
// Design decisions that are load-bearing, and where they come from:
//
// * All four arms go through src/vllm.mjs, not through the node's POST /api/chat. §2 demands identical
//   sampling; Market.chat() does not forward `sampling`, so arms run through it would carry
//   DEFAULT_CHAT_SAMPLING's stop sequences and repetition guard while the tool arms would not. The paired
//   property the node gave us for free is reconstructed here at CHUNK granularity: for each chunk of 8 items
//   the table is put into one state, the chunk is asked, then the other state, then asked again. Drift inside
//   a chunk is minutes, not the overnight gap §2 was written to prevent, and the table state is asserted
//   against the node before and after every chunk (§4) rather than assumed.
// * Item order is shuffled once with a fixed seed and reused for every arm.
// * Two repeats per item per arm; an item whose two arm-A answers disagree is `unstable` and the scorer
//   reports the headline on the stable subset with a sensitivity row over all items.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { VLLM } from './vllm.mjs';
import { NodeClient } from './node.mjs';
import { SubgraphMCP } from './mcp.mjs';
import { runToolLoop, BUDGET } from './toolloop.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, '..');
const CHUNK = 8;

/**
 * What is actually serving :8002, read from the host rather than from anyone's intent.
 *
 * Today's failure mode was not an engine crash: a container kept its name while its flags changed under it
 * (8192 → 32768, --max-num-seqs 8 → 1), and a message describing a configuration did not match the process
 * that was running. So the run records the Cmd string and the restart counter at the start and re-reads both
 * at the end. An INCREMENT means it was restarted in place with the same flags — the engine died and came
 * back. A RESET TO 0 means the container was recreated and the flags may have changed mid-run. A Cmd DIFF
 * catches the case where both counters look innocent. Best-effort: a host without docker records nulls
 * rather than failing the run.
 */
function engineSnapshot(apiBase) {
  const port = (() => { try { return new URL(apiBase).port || '80'; } catch { return null; } })();
  const sh = (cmd) => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch { return null; } };
  const name = port && sh(`docker ps --filter publish=${port} --format '{{.Names}}' | head -1`);
  if (!name) return { container: null, cmd: null, restart_count: null, started_at: null };
  return {
    container: name,
    cmd: sh(`docker inspect ${name} --format '{{join .Config.Cmd " "}}'`),
    restart_count: Number(sh(`docker inspect ${name} --format '{{.RestartCount}}'`) ?? NaN),
    started_at: sh(`docker inspect ${name} --format '{{.State.StartedAt}}'`),
  };
}

/**
 * Is anything else using the serving engine right now?
 *
 * vLLM exposes `vllm:num_requests_running` and `vllm:num_requests_waiting` on /metrics. With
 * --max-num-seqs 1 the engine serves ONE sequence at a time, so a second client does not slow us a little —
 * it queues in front of us, and the wait lands inside our own per-item latency where it is indistinguishable
 * from the model being slow. A run that cannot tell it was sharing the machine is the same class of defect
 * this study has caught all day: a confident number measured under conditions that did not hold. Latency is
 * a headline result here (§6), so this is not hygiene, it is the measurement's precondition.
 */
async function serverLoad(apiBase) {
  try {
    const r = await fetch(`${apiBase}/metrics`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const text = await r.text();
    const num = (k) => { const m = text.match(new RegExp(`^vllm:${k}\\{[^}]*\\}\\s+([0-9.]+)$`, 'm')); return m ? Number(m[1]) : null; };
    const running = num('num_requests_running'), waiting = num('num_requests_waiting');
    if (running === null && waiting === null) return null;
    // The CUMULATIVE counters are what make an idle check exact. The gauges above are instantaneous and miss
    // intermittent traffic between samples: measured today, eight consecutive gauge samples all read zero
    // while the engine served 34 chat completions in the same minute. A monotone token counter cannot miss a
    // request that happened between two reads — it either grew or it did not.
    return { running: running ?? 0, waiting: waiting ?? 0, prompt_tokens_total: num('prompt_tokens_total'), generation_tokens_total: num('generation_tokens_total') };
  } catch { return null; }
}

/** Sample the engine while WE have nothing in flight: anything seen is somebody else. */
async function requireQuiet(apiBase, { windowMs = 12_000, samples = 5, allowBusy = false } = {}) {
  const first = await serverLoad(apiBase);
  if (first === null) return { checked: false, note: '/metrics unavailable — competing load could not be measured' };
  const seen = [first];
  const gap = Math.max(500, Math.floor(windowMs / Math.max(1, samples - 1)));
  for (let i = 1; i < samples; i++) { await new Promise((r) => setTimeout(r, gap)); seen.push(await serverLoad(apiBase)); }
  const last = seen[seen.length - 1];
  const gauge = seen.filter((l) => l && (l.running > 0 || l.waiting > 0)).length;
  // Exact: over a window in which WE issued nothing, any growth in the cumulative counters is someone else.
  const grew = (first.prompt_tokens_total !== null && last.prompt_tokens_total > first.prompt_tokens_total)
            || (first.generation_tokens_total !== null && last.generation_tokens_total > first.generation_tokens_total);
  const result = {
    checked: true, window_ms: windowMs, gauge_busy_samples: gauge, counters_grew: grew,
    prompt_tokens_delta: first.prompt_tokens_total === null ? null : last.prompt_tokens_total - first.prompt_tokens_total,
    generation_tokens_delta: first.generation_tokens_total === null ? null : last.generation_tokens_total - first.generation_tokens_total,
    samples: seen,
  };
  if ((grew || gauge) && !allowBusy) {
    die(`the serving engine is not idle over a ${windowMs} ms window — gauge busy in ${gauge}/${samples} samples, ` +
        `prompt tokens +${result.prompt_tokens_delta}, generation tokens +${result.generation_tokens_delta}. ` +
        `At --max-num-seqs 1 another client queues in front of every request and its wait lands inside our per-item latency. ` +
        `Stop the other clients, or pass --allow-busy to measure anyway and have it recorded as contaminated.`);
  }
  result.contaminated_at_start = grew || gauge > 0;
  return result;
}

const argv = (() => {
  const a = {}; const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (!v[i].startsWith('--')) continue;
    const k = v[i].slice(2);
    a[k] = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true;
  }
  return a;
})();

const die = (msg) => { console.error(`run.mjs: ${msg}`); process.exit(1); };
const runId = argv.run ?? die('--run <id> is required');
const arms = String(argv.arms ?? 'A,B,C,D').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const repeats = Number(argv.repeats ?? 2);
const offline = !!argv.offline;
const outDir = join(BENCH, 'runs', `${runId}${argv.bridge ? '-bridge' : ''}${offline ? '-offline' : ''}`);

/**
 * Which of §1's five buckets an item belongs to. Derived from the row, never stored, so it cannot drift from
 * the generator's own definition.
 */
const bucketOf = (q) => (q.hop === 2 ? 'multihop' : !q.taught ? 'tripwire' : q.form === 'E1' ? 'headline' : q.form === 'E2' ? 'korean' : 'ceiling');

/**
 * The BRIDGE CONTROL (§2): the 40 items re-run after an engine restart to test whether arm A reproduces
 * across it. Two properties are pre-registered here rather than chosen when the delta is known.
 *
 * STRATIFIED, not the first forty of the file. Taking the head of a shuffled file would have loaded the
 * bridge with headline items — 120 of the 250 — and told us nothing about the tripwires, which are where a
 * restart would show up first if it showed up anywhere: an arm-C tripwire is supposed to FAIL, so a restart
 * that quietly changed behaviour there would be invisible in the bucket we looked at. Allocation is by
 * largest remainder over the declared bucket sizes: headline 19, korean 7, ceiling 6, tripwire 5, multihop 3.
 *
 * SEEDED and written to disk BEFORE the run, so which forty were chosen is auditable rather than asserted.
 */
function bridgeItems(questions, n = 40, seed = 20260904) {
  // The selection is a pure function of the question file and the seed, which is exactly why it has to be
  // BOUND to that file: when the generator was re-run with a relation cap, the ids selected from the previous
  // sample still resolved to plausible-looking rows while naming items that were no longer in the study. So
  // the snapshot carries the sha256 of the questions.jsonl it was drawn from, and a mismatch is refused
  // rather than silently regenerated — a bridge control that compares superseded items is worse than none.
  void 0;
  const byBucket = new Map();
  for (const q of questions) { const b = bucketOf(q); if (!byBucket.has(b)) byBucket.set(b, []); byBucket.get(b).push(q); }
  const total = questions.length;
  const alloc = [...byBucket.entries()].map(([b, items]) => ({ b, items, exact: (items.length * n) / total }));
  alloc.forEach((a) => { a.take = Math.floor(a.exact); a.rem = a.exact - a.take; });
  let left = n - alloc.reduce((s, a) => s + a.take, 0);
  [...alloc].sort((x, y) => y.rem - x.rem || x.b.localeCompare(y.b)).forEach((a) => { if (left-- > 0) a.take++; });
  const picked = [];
  for (const a of alloc) picked.push(...shuffle(a.items, seed).slice(0, a.take));
  return { items: picked, allocation: Object.fromEntries(alloc.map((a) => [a.b, a.take])), seed };
}

/** A seeded shuffle, so "the same order in every arm" is a property of the code and not of the operator. */
function shuffle(items, seed = 20260904) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function loadQuestions() {
  const p = join(BENCH, 'data', runId, 'questions.jsonl');
  if (!existsSync(p)) die(`${p} does not exist — generate the question set first (pipeline/questions.mjs). No fixture will be invented.`);
  const rows = readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (!rows.length) die(`${p} is empty`);
  return rows;
}

/**
 * The deployment ids arm B-assisted is handed, and the pinned block they were live at.
 *
 * Only LIVE deployments are listed. Padding the headline prompt with dead ids would manufacture
 * `wrong_subgraph` misses out of our own curation and make "the generous configuration" a lie — of the 23 in
 * sources.json, 8 were dropped at the r1 pull (six stale or erroring, one unreachable, one reporting a head
 * 475 million blocks ahead of the median, i.e. not this chain). Preference order: the `live` field the pull
 * writes back into sources.json; failing that, the run's own manifest (answered AND not dropped). If neither
 * exists the runner stops rather than guessing — an unaudited deployment list is not a fair arm B.
 */
function liveDeployments() {
  const sources = JSON.parse(readFileSync(join(BENCH, 'pipeline', 'sources.json'), 'utf8')).sources ?? [];
  if (sources.some((s) => typeof s.live === 'boolean')) {
    return { list: sources.filter((s) => s.live), basis: 'sources.json live field', block: null };
  }
  const mp = join(BENCH, 'data', runId, 'pull', 'manifest.json');
  if (!existsSync(mp)) die(`neither sources.json carries a \`live\` field nor ${mp} exists — cannot tell arm B which deployments are real`);
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  const droppedIds = new Set((m.dropped ?? []).map((d) => d.deployment_id ?? d.deployment ?? d.protocol));
  const answered = new Set((m.responses ?? []).map((r) => r.deployment_id ?? r.deployment ?? r.protocol));
  const live = sources.filter((s) => {
    const keys = [s.deployment_id, s.deployment, s.protocol];
    return keys.some((k) => answered.has(k)) && !keys.some((k) => droppedIds.has(k));
  });
  return { list: live, basis: `data/${runId}/pull/manifest.json`, block: m.block ?? null };
}

function systemPrompts() {
  const read = (f) => readFileSync(join(BENCH, 'system-prompts', f), 'utf8');
  const plain = read('plain.txt');
  const toolsTemplate = read('tools.txt');
  const { list: live, basis, block } = liveDeployments();
  if (!live.length) die(`no live deployments (basis: ${basis}) — arm B has nothing to be told about`);
  // The count and the pin are stated so a reviewer can check the curation against the committed manifest
  // instead of taking it on trust.
  // "subgraph ids", not "deployments". The whole arm-B failure was this word: sources.json's field is named
  // deployment_id but holds a subgraph id, the prompt inherited the name, and the model correctly called
  // execute_query_by_deployment_id with it and failed on every call. The list header says what these are.
  const header = `The following ${live.length} subgraph ids were live${block ? ` at block ${block}` : ''} when this run started.`;
  const listText = `${header}\n` + live.map((s) => `- ${s.protocol} (${s.schema}, ${s.network}): ${s.deployment_id}`).join('\n');
  // B-assisted (headline, §3): the deployment ids and the worked example a competent engineer would ship.
  const assisted = toolsTemplate.replace('{{DEPLOYMENTS}}', listText);
  // B-cold: the same file with the domain paragraph, the id list and the worked example removed. Derived by
  // truncation at a marker rather than maintained as a second file, so the two can never drift apart.
  const coldCut = toolsTemplate.indexOf('The domain of these questions');
  if (coldCut < 0) die('system-prompts/tools.txt no longer contains the domain paragraph B-cold is cut at');
  const cold = toolsTemplate.slice(0, coldCut).trimEnd() + '\n';
  return { plain, assisted, cold, live, basis };
}

const armUsesTools = (arm) => arm === 'B' || arm === 'D';
const armUsesPatch = (arm) => arm === 'C' || arm === 'D';

async function main() {
  mkdirSync(outDir, { recursive: true });
  let questions = shuffle(loadQuestions()).slice(0, argv.limit ? Number(argv.limit) : undefined);
  let bridge = null;
  if (argv.bridge) {
    bridge = bridgeItems(questions);
    const qPath = join(BENCH, 'data', runId, 'questions.jsonl');
    const qSha = createHash('sha256').update(readFileSync(qPath)).digest('hex');
    const snapPath = join(BENCH, 'data', runId, 'bridge-items.json');
    if (existsSync(snapPath)) {
      const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
      if (snap.questions_sha256 !== qSha) die(`${snapPath} was drawn from a different questions.jsonl (${snap.questions_sha256.slice(0, 12)} vs ${qSha.slice(0, 12)}) — the question set was regenerated. Delete the snapshot and re-select, and commit the new forty, before running a bridge against a superseded sample.`);
      if (JSON.stringify(snap.items) !== JSON.stringify(bridge.items.map((q) => q.id))) die(`${snapPath} does not match the selection this file produces — refusing to run a bridge whose items were not the ones committed.`);
    } else {
      writeFileSync(snapPath, JSON.stringify({ questions_sha256: qSha, seed: bridge.seed, allocation: bridge.allocation, items: bridge.items.map((q) => q.id) }, null, 2));
      console.error(`wrote ${snapPath} — commit it before the run`);
    }
    bridge.questions_sha256 = qSha;
    questions = bridge.items;
    console.error(`bridge control: ${questions.length} items, stratified ${JSON.stringify(bridge.allocation)}, seed ${bridge.seed}`);
  }
  const prompts = systemPrompts();
  console.error(`arm B-assisted is handed ${prompts.live.length} live deployments (basis: ${prompts.basis})`);

  const vllm = new VLLM();
  const { model, maxModelLen } = await vllm.ready();
  const quiet = await requireQuiet(vllm.base, { allowBusy: !!argv['allow-busy'] });
  console.error(quiet.checked ? `engine idle check: gauge busy ${quiet.gauge_busy_samples}/${quiet.samples.length}, tokens +${quiet.prompt_tokens_delta}/+${quiet.generation_tokens_delta} over ${quiet.window_ms} ms` : `engine idle check: ${quiet.note}`);
  const competing = [];

  const patchId = argv.patch ?? null;
  const needPatch = arms.some(armUsesPatch);
  let node = null, provenancePatch = { backend: 'none', real_training: false, patch_id: null, patch_sha256: null };
  if (needPatch) {
    if (!patchId) die('--patch <knowledge-id> is required for arms C and D');
    node = new NodeClient();
    await node.login();
    provenancePatch = await node.provenance(patchId);
  }

  let mcp = null;
  if (arms.some(armUsesTools) && !offline) {
    mcp = new SubgraphMCP();
    await mcp.connect();
    mcp.toolSchemas = (await mcp.listTools()).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  } else if (arms.some(armUsesTools)) {
    // Offline mode still DECLARES the tools — the point is that the transport fails, not that the model was
    // never told it had tools. Schemas come from the committed copy so an offline run needs no network at all.
    const cached = join(outDir, '..', `${runId}`, 'tool-schemas.json');
    if (!existsSync(cached)) die(`--offline needs a previous online run's tool-schemas.json (${cached})`);
    mcp = { toolSchemas: JSON.parse(readFileSync(cached, 'utf8')), callTool: async () => ({ text: '', isError: true, ms: 0 }), stats: {}, close: async () => {} };
  }
  if (mcp?.toolSchemas && !offline) writeFileSync(join(outDir, 'tool-schemas.json'), JSON.stringify(mcp.toolSchemas, null, 2));

  const provenance = {
    run_id: runId, offline, bridge: bridge ? { items: bridge.items.map((q) => q.id), allocation: bridge.allocation, seed: bridge.seed, questions_sha256: bridge.questions_sha256 } : null,
    started_at: new Date().toISOString(), finished_at: null,
    model, max_model_len: maxModelLen, model_api: vllm.base,
    sampling: { temperature: 0, top_p: 1, max_tokens: vllm.maxTokens, thinking: false, stop: null, guard: false,
      note: 'uniform in every arm; run.mjs drives the model directly because POST /api/chat cannot forward sampling' },
    budget: BUDGET, chunk: CHUNK, repeats, arms, questions: questions.length,
    patch: provenancePatch,
    mcp: offline ? { mode: 'fault-injection 503' } : { server: mcp?.serverInfo ?? null, protocol: mcp?.protocolVersion ?? null, authenticated: mcp?.authenticated ?? null, tools: mcp?.toolSchemas?.map((t) => t.function.name) ?? [] },
    graph_api_key_present: !!process.env.GRAPH_API_KEY,
    deployments_offered: { count: prompts.live.length, basis: prompts.basis, ids: prompts.live.map((s) => s.deployment_id) },
    git_commit: (() => { try { return execSync('git rev-parse HEAD', { cwd: BENCH }).toString().trim(); } catch { return null; } })(),
    restarts_detected: 0, chunks_rerun: 0,
    engine_at_start: engineSnapshot(vllm.base), engine_at_end: null, engine_changed: null,
    /** Every apply/remove of the patch, timed. A per-node setup cost, never folded into per-item latency. */
    patch_state_changes: [],
    /** Was the engine ours alone? Sampled before the run and after every chunk. */
    engine_idle_check: quiet, competing_load: competing,
  };

  const write = (arm, q, rep, payload) => {
    const dir = join(outDir, 'transcripts', arm);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${q.id}.${rep}.json`), JSON.stringify(payload, null, 2));
  };

  for (const arm of arms) {
    const tools = armUsesTools(arm);
    const system = tools ? (argv.cold ? prompts.cold : prompts.assisted) : prompts.plain;
    const wantApplied = armUsesPatch(arm);
    console.error(`\n=== arm ${arm} — patch ${wantApplied ? 'APPLIED' : 'removed'}, tools ${tools ? (argv.cold ? 'B-cold' : 'B-assisted') : 'none'}${offline ? ', OFFLINE' : ''}`);

    for (let start = 0; start < questions.length; start += CHUNK) {
      const chunk = questions.slice(start, start + CHUNK);
      if (node) {
        // Applying a patch is a per-NODE cost paid once, not a per-question cost. Timed and recorded apart
        // from item latency so a reader can tell whether arm C's per-item advantage is inference or
        // amortised setup — every other cost in this study is separated that way (§6).
        const t = Date.now();
        const r = await node.setApplied(patchId, wantApplied);
        if (r.changed) provenance.patch_state_changes.push({ arm, at_item: start, to: wantApplied, ms: Date.now() - t });
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        const results = [];
        for (const q of chunk) {
          for (let rep = 0; rep < repeats; rep++) {
            const t0 = Date.now();
            let payload;
            if (tools) {
              const r = await runToolLoop({ vllm, mcp, systemPrompt: system, question: q.question, offline });
              payload = { arm, repeat: rep, question: q, system, final: r.final, error: r.error, latency_ms: Date.now() - t0, model_ms: r.ev.model_ms, turns: r.turns, evidence: r.ev };
            } else {
              let r = await vllm.turn({ messages: [{ role: 'system', content: system }, { role: 'user', content: q.question }] });
              let retries = 0;
              if (r.error) { retries = 1; r = await vllm.turn({ messages: [{ role: 'system', content: system }, { role: 'user', content: q.question }] }); }
              // The evidence object has the SAME shape in every arm, with the tool fields at their zero values.
              // A scorer that reads `context_exhausted` must get `false` for a tool-less arm, never `undefined`
              // — an absent flag and a false one are the same to `if (e.context_exhausted)` but not to a
              // table that counts them, and arms A and C would silently drop out of the channel totals.
              payload = { arm, repeat: rep, question: q, system, final: r.error ? null : r.content, error: r.error ?? null, latency_ms: Date.now() - t0, model_ms: r.ms, turns: r.error ? [] : [{ turn: 0, request: r.request, response: r.response, ms: r.ms, usage: r.usage, finish_reason: r.finishReason }], evidence: { tool_calls: 0, tool_bytes_in: 0, retries, context_truncated: false, context_exhausted: false, context_evictions: 0, prompt_tokens_peak: r.usage?.prompt_tokens ?? 0, budget_exhausted: false, forced_final: false, tool_errors: 0, tool_targets: [], tool_results: [], model_ms: r.ms, offline } };
            }
            results.push({ q, rep, payload });
          }
        }
        // §4: a vLLM restart silently reverts the table. If the state we asked for is no longer true, the whole
        // chunk is void — nothing from it is written — and it is re-run once against a re-established table.
        const stillRight = node ? (await node.isApplied(patchId)) === wantApplied : true;
        if (stillRight) { for (const r of results) write(arm, r.q, r.rep, r.payload); break; }
        provenance.restarts_detected++; provenance.chunks_rerun++;
        console.error(`  !! table state lost during items ${start}..${start + chunk.length - 1} — re-applying and re-running the chunk`);
        await node.setApplied(patchId, wantApplied);
        if (attempt === 1) die('the table state could not be re-established twice in a row — this run is void (§4)');
      }
      // Between chunks nothing of ours is in flight, so any load here is somebody else's.
      const l = await serverLoad(vllm.base);
      if (l && (l.running > 0 || l.waiting > 0)) {   // between chunks we have nothing in flight
        competing.push({ arm, at_item: start, ...l });
        console.error(`  !! competing traffic on the engine at ${arm}:${start} — running ${l.running}, waiting ${l.waiting}`);
      }
      console.error(`  ${arm}: ${Math.min(start + CHUNK, questions.length)}/${questions.length}`);
    }
  }

  await mcp?.close?.();
  provenance.finished_at = new Date().toISOString();
  provenance.engine_at_end = engineSnapshot(vllm.base);
  {
    const a = provenance.engine_at_start, b = provenance.engine_at_end;
    const changed = [];
    if (a.cmd !== b.cmd) changed.push('cmd');
    if (a.started_at !== b.started_at) changed.push('recreated_or_restarted');
    if (a.restart_count !== b.restart_count) changed.push(`restart_count ${a.restart_count}→${b.restart_count}`);
    provenance.engine_changed = changed.length ? changed : false;
    if (changed.length) console.error(`\n!! the serving engine changed under this run: ${changed.join(', ')} — the summary must say so`);
  }

  // §9, the stub rule, mechanically: a patch that is not positively identified as a real gradient run cannot
  // produce a file named results-final.*. The scorer stamps the header; the runner refuses the filename.
  const stamp = provenance.patch.real_training ? 'final' : 'DRYRUN';
  if (!provenance.patch.real_training && needPatch) {
    provenance.warning = `SIMULATED PATCH — NOT A TRAINED MODEL (backend: ${provenance.patch.backend}). No results-final.* may be written from this run.`;
    console.error(`\n!! ${provenance.warning}`);
  }
  writeFileSync(join(outDir, 'provenance.json'), JSON.stringify(provenance, null, 2));
  writeFileSync(join(outDir, `results-${stamp}.marker`), `${new Date().toISOString()} ${stamp}\n`);
  const n = readdirSync(join(outDir, 'transcripts'), { withFileTypes: true }).flatMap((d) => readdirSync(join(outDir, 'transcripts', d.name))).length;
  console.error(`\nwrote ${n} transcripts to ${outDir} (results-${stamp}.*)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
