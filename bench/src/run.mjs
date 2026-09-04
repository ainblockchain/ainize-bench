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
import { VLLM } from './vllm.mjs';
import { NodeClient } from './node.mjs';
import { SubgraphMCP } from './mcp.mjs';
import { runToolLoop, BUDGET } from './toolloop.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, '..');
const CHUNK = 8;

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
const outDir = join(BENCH, 'runs', offline ? `${runId}-offline` : runId);

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

function systemPrompts() {
  const read = (f) => readFileSync(join(BENCH, 'system-prompts', f), 'utf8');
  const plain = read('plain.txt');
  const toolsTemplate = read('tools.txt');
  const sources = JSON.parse(readFileSync(join(BENCH, 'pipeline', 'sources.json'), 'utf8')).sources ?? [];
  const list = sources.map((s) => `- ${s.protocol} (${s.schema}, ${s.network}): ${s.deployment_id}`).join('\n');
  // B-assisted (headline, §3): the deployment ids and the worked example a competent engineer would ship.
  const assisted = toolsTemplate.replace('{{DEPLOYMENTS}}', list);
  // B-cold: the same file with the domain paragraph, the id list and the worked example removed. Derived by
  // truncation at a marker rather than maintained as a second file, so the two can never drift apart.
  const coldCut = toolsTemplate.indexOf('The domain of these questions');
  if (coldCut < 0) die('system-prompts/tools.txt no longer contains the domain paragraph B-cold is cut at');
  const cold = toolsTemplate.slice(0, coldCut).trimEnd() + '\n';
  return { plain, assisted, cold };
}

const armUsesTools = (arm) => arm === 'B' || arm === 'D';
const armUsesPatch = (arm) => arm === 'C' || arm === 'D';

async function main() {
  mkdirSync(outDir, { recursive: true });
  const questions = shuffle(loadQuestions()).slice(0, argv.limit ? Number(argv.limit) : undefined);
  const prompts = systemPrompts();

  const vllm = new VLLM();
  const { model, maxModelLen } = await vllm.ready();

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
    run_id: runId, offline, started_at: new Date().toISOString(), finished_at: null,
    model, max_model_len: maxModelLen, model_api: vllm.base,
    sampling: { temperature: 0, top_p: 1, max_tokens: vllm.maxTokens, thinking: false, stop: null, guard: false,
      note: 'uniform in every arm; run.mjs drives the model directly because POST /api/chat cannot forward sampling' },
    budget: BUDGET, chunk: CHUNK, repeats, arms, questions: questions.length,
    patch: provenancePatch,
    mcp: offline ? { mode: 'fault-injection 503' } : { server: mcp?.serverInfo ?? null, protocol: mcp?.protocolVersion ?? null, authenticated: mcp?.authenticated ?? null, tools: mcp?.toolSchemas?.map((t) => t.function.name) ?? [] },
    graph_api_key_present: !!process.env.GRAPH_API_KEY,
    git_commit: (() => { try { return execSync('git rev-parse HEAD', { cwd: BENCH }).toString().trim(); } catch { return null; } })(),
    restarts_detected: 0, chunks_rerun: 0,
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
      if (node) await node.setApplied(patchId, wantApplied);

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
              payload = { arm, repeat: rep, question: q, system, final: r.error ? null : r.content, error: r.error ?? null, latency_ms: Date.now() - t0, model_ms: r.ms, turns: r.error ? [] : [{ turn: 0, request: r.request, response: r.response, ms: r.ms, usage: r.usage, finish_reason: r.finishReason }], evidence: { tool_calls: 0, retries, offline } };
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
      console.error(`  ${arm}: ${Math.min(start + CHUNK, questions.length)}/${questions.length}`);
    }
  }

  await mcp?.close?.();
  provenance.finished_at = new Date().toISOString();

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
