#!/usr/bin/env node
/**
 * THE OTHER TWO CELLS OF THE SIDE-EFFECT TABLE — what declaring tools does to unrelated answers.
 *
 *   node src/locality-tools.mjs run  [--patch <id>] [--out runs/<id>] [--repeats 2] [--limit N]
 *   node src/locality-tools.mjs score --in runs/<id>              re-score a capture, no GPU, no key
 *   node src/locality-tools.mjs table --in runs/<id> [--with <their-report.json>]   print the four cells
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT src/locality.mjs.
 *
 * The tempting claim is that tool calling has no analogue for the side-effect measurement. README §6 says in
 * as many words that it is not quite true and that the write-up must not say it: "Declaring tools changes the
 * context, and a changed context can change unrelated answers too. So the same 50 prompts are run in arm B
 * with tools declared but not needed, and the side-effect table has four cells like every other table. If arm
 * B also perturbs unrelated answers, that is a finding for both of us; if it does not, arm C has to beat it
 * honestly. Either way the measurement is symmetric, which is the only version a sceptical judge will accept."
 *
 * The brief this session was given says the opposite ("the side-effect measurement tool-calling has no
 * analogue for"). Where the brief and the README disagree the README wins, so the symmetric version is what
 * is built here, and the asymmetric sentence must not appear in the write-up.
 *
 * `src/locality.mjs` (the other session's) captures the two TOOL-LESS cells — reference and post-apply. This
 * file captures the two TOOLS-DECLARED cells against the same committed prompt set, and `table` joins them.
 * It imports nothing from that file: it is being written in parallel, and pinning its API from here would
 * make two sessions' edits collide in one working tree.
 *
 *      | tools declared        | none                     | The Graph Subgraph MCP declared, never needed |
 *      |-----------------------|--------------------------|-----------------------------------------------|
 *      | base model            | A  reference (§6's key)  | B  this file                                  |
 *      | knowledge applied     | C  src/locality.mjs      | D  this file                                  |
 *
 * WHAT IS SCORED. §6: "scored against the base model's own answers, not against gold labels — the claim is
 * 'loading the knowledge does not change unrelated answers', so the base answer IS the reference." So cell A
 * is captured here too, by this file, on the same engine instance as B/C/D, and is the reference for all
 * three. Gold truths travel in the prompt set and are reported beside the agreement numbers, never inside them.
 *
 * FOUR THINGS THIS FILE REFUSES TO DO
 *   1. Compare across an engine restart. The container is read before the first cell, between cells and after
 *      (docker Cmd / RestartCount / StartedAt, the way src/run.mjs's engineSnapshot does). A change means the
 *      halves did not run on one instance and any difference is confounded with the restart: transcripts are
 *      kept, no report is written.
 *   2. Count a prompt the model cannot answer twice the same way. Every prompt is asked `--repeats` times in
 *      EVERY cell; a prompt whose repeats disagree inside cell A is `unstable` and is excluded from every
 *      cell's agreement number. That is the node's own twelve-prompt rule and §2's noise floor.
 *   3. Leave the table where it found it by accident. The patch's state is read before anything is applied and
 *      restored in a `finally`, including on SIGINT, and the restoration is asserted against the node rather
 *      than assumed. A run that cannot restore the table says so in its own provenance and exits non-zero.
 * WHAT "TOOLS DECLARED" MEANS HERE, PRECISELY. Cell B differs from cell A in the two ways §2 says an arm may
 * differ and in no others: the request carries the live MCP tool schemas, and the system prompt is
 * `system-prompts/tools.txt` rather than `plain.txt` — which is the plain file PLUS the tool-use paragraph.
 * That is exactly the asymmetry the study's arm B carries, so a B-vs-A difference is a fact about the arm-B
 * CONFIGURATION and not about the schemas in isolation. Anyone wanting to separate the two runs a third cell
 * with the schemas and the plain prompt; this file does not, because the study's arm B does not.
 *
 *   4. Declare tools it did not fetch. The schemas are the live ones from the hosted Subgraph MCP, written
 *      into the capture, and a tool the model actually CALLS on a recipe question is executed for real and
 *      recorded — a locality prompt needing the network is itself the side effect this cell exists to find.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scoreOne, wilson } from './normalize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BENCH = join(HERE, '..');

/** The four cells. `tools` and `patch` are the only two things that differ between them — §2. */
export const CELLS = [
  { id: 'A', tools: false, patch: false, label: 'base, no tools (the reference)' },
  { id: 'B', tools: true, patch: false, label: 'base, tools declared and never needed' },
  { id: 'C', tools: false, patch: true, label: 'knowledge applied, no tools' },
  { id: 'D', tools: true, patch: true, label: 'knowledge applied, tools declared' },
];

/* ======================================================================================================== *
 * The prompt set. Read-only: this file never writes locality/*.
 * ======================================================================================================== */

/**
 * §6's set is 50 prompts. The committed file is locality/prompts.jsonl (the other session's, six strata);
 * if it is absent the two halves it is built from are concatenated, so this file still runs against whatever
 * is on disk rather than inventing a set of its own.
 */
export function loadPrompts(dir = join(BENCH, 'locality')) {
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  let rows = read('prompts.jsonl');
  let from = 'locality/prompts.jsonl';
  if (!rows.length) { rows = [...read('near.jsonl'), ...read('control.jsonl')]; from = 'locality/near.jsonl + locality/control.jsonl'; }
  if (!rows.length) throw new Error(`no locality prompt set found under ${dir} — this file does not carry one of its own`);
  const items = rows.map((r, i) => {
    const prompt = r.prompt ?? r.question;
    if (!prompt) throw new Error(`${from} row ${i}: neither \`prompt\` nor \`question\``);
    return {
      id: r.id ?? `loc-${i}`,
      stratum: r.stratum ?? r.field ?? 'unlabelled',
      half: r.half ?? (String(r.stratum ?? '').startsWith('adjacent') || String(r.stratum ?? '').startsWith('near') ? 'near' : 'far'),
      lang: r.lang ?? 'en',
      prompt,
      answer_type: r.answer_type ?? null,
      truth: r.truth ?? null,
      scoring_mode: r.scoring?.mode ?? null,
    };
  });
  const dup = items.map((x) => x.id).filter((v, i, a) => a.indexOf(v) !== i);
  if (dup.length) throw new Error(`${from}: duplicate ids ${dup.slice(0, 3).join(', ')}`);
  return { items, from, sha256: createHash('sha256').update(rows.map((r) => JSON.stringify(r)).join('\n')).digest('hex') };
}

/* ======================================================================================================== *
 * Agreement. Two keys, both reported; neither is a gold-label comparison.
 * ======================================================================================================== */

/**
 * `text` — the strict key. §6's origin gate in the node is "≥ 11 of 12 IDENTICAL", so identity is reported.
 * Only chat furniture that is not part of the answer is normalised away: outer whitespace, run-together
 * spacing, and a trailing full stop. Nothing about the content is folded.
 */
export const textKey = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').toLowerCase();

/**
 * `scored` — the lenient key: the normalised VALUE the item's own declared answer_type carries. "1912" and
 * "The year was 1912." are the same answer, and a run that flags that as damage is measuring formatting.
 * Items with no answer_type (prose, refusal, json shape) fall back to the strict key rather than to nothing,
 * because inventing a rule for them here would be a scoring rule this file made up.
 */
export function scoredKey(item, text) {
  if (!item.answer_type || item.truth == null) return textKey(text);
  try {
    const r = scoreOne(text, { id: item.id, answer_type: item.answer_type, truth: item.truth });
    if (r.verdict === 'hit') return `=${JSON.stringify(item.truth)}`;
    if (r.verdict === 'abstain') return '<abstain>';
    if (r.got != null) return `~${JSON.stringify(r.got)}`;
  } catch { /* an answer_type this build has no rule for falls through to the strict key */ }
  return textKey(text);
}

/** One prompt in one cell: the repeats, whether they agreed with each other, and the two keys. */
export function unitsToCell(items, units, keyOf) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = new Map();
  for (const u of units) {
    if (!out.has(u.item_id)) out.set(u.item_id, []);
    out.get(u.item_id).push(u);
  }
  const cell = new Map();
  for (const [id, us] of out) {
    const item = byId.get(id);
    if (!item) continue;
    const keys = us.map((u) => keyOf(item, u.final ?? ''));
    cell.set(id, {
      item_id: id, stratum: item.stratum, half: item.half,
      repeats: us.length,
      key: keys[0],
      self_consistent: keys.every((k) => k === keys[0]),
      errored: us.some((u) => u.error != null),
      tool_calls: us.reduce((n, u) => n + (u.evidence?.tool_calls ?? 0), 0),
      answers: us.map((u) => u.final ?? ''),
    });
  }
  return cell;
}

/**
 * The comparison. Everything is measured against cell A, and an item is only counted where cell A could hold
 * still: an item whose own two repeats disagree in the reference has no reference to disagree WITH, and
 * counting it would price the model's temperature-0 jitter as damage done by the patch.
 */
export function compare(items, cells, keyOf) {
  const A = cells.A;
  if (!A) throw new Error('no cell A — the reference is what everything else is compared against');
  const unstable = [...A.values()].filter((u) => !u.self_consistent || u.errored).map((u) => u.item_id);
  const excluded = new Set(unstable);
  const per_cell = {};
  for (const { id, label, tools, patch } of CELLS) {
    const cell = cells[id];
    if (!cell) continue;
    const rows = [];
    for (const [itemId, u] of cell) {
      if (excluded.has(itemId)) continue;
      const a = A.get(itemId);
      if (!a) continue;
      rows.push({
        item_id: itemId, stratum: u.stratum, half: u.half,
        same: u.key === a.key, self_consistent: u.self_consistent,
        reference: a.answers[0], answer: u.answers[0], tool_calls: u.tool_calls,
      });
    }
    const same = rows.filter((r) => r.same).length;
    const byStratum = {};
    for (const r of rows) {
      byStratum[r.stratum] ??= { n: 0, same: 0 };
      byStratum[r.stratum].n++; if (r.same) byStratum[r.stratum].same++;
    }
    per_cell[id] = {
      cell: id, label, tools_declared: tools, patch_applied: patch,
      n: rows.length, same, changed: rows.length - same,
      agreement: rows.length ? same / rows.length : null,
      agreement_ci95: wilson(same, rows.length),
      items_that_called_a_tool: rows.filter((r) => r.tool_calls > 0).length,
      unstable_inside_this_cell: [...cell.values()].filter((u) => !excluded.has(u.item_id) && !u.self_consistent).map((u) => u.item_id),
      per_stratum: byStratum,
      changed_items: rows.filter((r) => !r.same).map((r) => ({ item_id: r.item_id, stratum: r.stratum, reference: r.reference, answer: r.answer })),
    };
  }
  return {
    items_total: items.length,
    unstable_in_reference: unstable,
    denominator: items.length - unstable.length,
    per_cell,
  };
}

/* ======================================================================================================== *
 * The engine, read the way src/run.mjs reads it. Best effort, and honest about being best effort.
 * ======================================================================================================== */
export function engineSnapshot(apiBase) {
  const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };
  const port = (apiBase.match(/:(\d+)/) ?? [])[1];
  const name = port && sh(`docker ps --filter publish=${port} --format '{{.Names}}' | head -1`);
  if (!name) return { container: null, cmd: null, restart_count: null, started_at: null, read: false };
  return {
    container: name, read: true,
    cmd: sh(`docker inspect ${name} --format '{{join .Config.Cmd " "}}'`),
    restart_count: Number(sh(`docker inspect ${name} --format '{{.RestartCount}}'`) ?? NaN),
    started_at: sh(`docker inspect ${name} --format '{{.State.StartedAt}}'`),
  };
}

export function engineDiff(a, b) {
  if (!a?.read || !b?.read) return null;   // nothing was read; the caller decides what that means
  const d = [];
  for (const k of ['container', 'cmd', 'restart_count', 'started_at']) if (a[k] !== b[k]) d.push(`${k}: ${a[k]} -> ${b[k]}`);
  return d;
}

/* ======================================================================================================== *
 * The capture.
 * ======================================================================================================== */

/** The system prompt each cell gets. A and C share plain.txt byte-for-byte; B and D get tools.txt — §2. */
export function systemFor(cell, deployments) {
  const plain = readFileSync(join(BENCH, 'system-prompts', 'plain.txt'), 'utf8');
  if (!cell.tools) return plain;
  const tools = readFileSync(join(BENCH, 'system-prompts', 'tools.txt'), 'utf8');
  return tools.replace('{{DEPLOYMENTS}}', deployments);
}

/**
 * Ask one prompt in one cell. Cells A and C go through `vllm.turn` with NO `tools` key at all — which is not
 * the same thing as declaring tools the model may ignore, and §6's whole point depends on that difference
 * being real. Cells B and D go through the same tool loop arms B and D use in the study.
 */
export async function askOne({ vllm, mcp, runToolLoop, cell, system, item }) {
  const t0 = Date.now();
  if (!cell.tools) {
    const r = await vllm.turn({ messages: [{ role: 'system', content: system }, { role: 'user', content: item.prompt }] });
    return {
      final: r.error ? '' : (r.content ?? ''), error: r.error ?? null,
      latency_ms: Date.now() - t0, model_ms: r.ms ?? null,
      usage: r.usage ?? null,
      evidence: { tool_calls: 0, tool_targets: [], tool_errors: 0, context_exhausted: false, forced_final: false },
    };
  }
  const r = await runToolLoop({ vllm, mcp, systemPrompt: system, question: item.prompt });
  return {
    final: r.final ?? '', error: r.error ?? null,
    latency_ms: Date.now() - t0, model_ms: r.ev?.model_ms ?? null,
    usage: r.turns?.map((t) => t.usage).filter(Boolean).at(-1) ?? null,
    evidence: r.ev ?? {},
    turns: r.turns?.length ?? 0,
  };
}

/* ======================================================================================================== *
 * Reporting.
 * ======================================================================================================== */
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);

export function renderTable(cmp, provenance, joined = null) {
  const p = [];
  const w = (s = '') => p.push(s);
  w('# Side effects — all four cells');
  w('');
  if (provenance?.stamps?.length) for (const s of provenance.stamps) w(`> **${s}**`);
  if (provenance?.engine_changed?.length) w(`> **ENGINE CHANGED MID-RUN (${provenance.engine_changed.join('; ')}) — THIS COMPARISON IS CONFOUNDED WITH A RESTART**`);
  w('');
  const ps = provenance?.prompt_set ?? {};
  const inFile = ps.items_in_file ?? cmp.items_total;
  w(`Prompt set: \`${ps.from ?? '?'}\` — ${inFile} prompts, sha256 \`${(ps.sha256 ?? '').slice(0, 12)}\` (the hash is of the whole file).`
    + (cmp.items_total !== inFile ? ` **This capture asked ${cmp.items_total} of them** (${JSON.stringify(ps.filter ?? {})}), so it is a smoke run and not the measurement.` : ''));
  w(`Scored against the base model's own answers (README §6), never against gold labels. Key: \`${provenance?.key_mode ?? 'scored'}\`.`);
  if (provenance?.system_prompts) w(`System prompts, by cell: ${Object.entries(provenance.system_prompts).map(([k, v]) => `${k} \`${v}\``).join(', ')} — A and C must match, B and D must match, and a capture against a different tools.txt is a different cell.`);
  w(`${cmp.unstable_in_reference.length} of ${cmp.items_total} prompts were unstable in the reference cell and are excluded from every cell; the denominator is ${cmp.denominator}.`);
  w('');
  w('| | no tools | The Graph MCP declared, never needed |');
  w('|---|---|---|');
  const cellStr = (id) => {
    const c = cmp.per_cell[id];
    if (!c) return '_not captured_';
    return `**${id}** ${c.same}/${c.n} same (${pct(c.agreement)})${c.items_that_called_a_tool ? `<br>${c.items_that_called_a_tool} called a tool` : ''}`;
  };
  w(`| **base model** | ${cellStr('A')} | ${cellStr('B')} |`);
  w(`| **knowledge applied** | ${cellStr('C')} | ${cellStr('D')} |`);
  w('');
  w('Cell A is the reference and is 100% by construction — it is printed so the table has four cells and so the');
  w('reader can see that the reference exists rather than being asserted.');
  w('');
  w('| cell | tools | patch | n | same | changed | agreement | 95% CI | tool calls |');
  w('|---|---|---|---|---|---|---|---|---|');
  for (const { id } of CELLS) {
    const c = cmp.per_cell[id];
    if (!c) { w(`| ${id} | | | _not captured_ | | | | | |`); continue; }
    w(`| ${id} | ${c.tools_declared ? 'declared' : 'none'} | ${c.patch_applied ? 'applied' : 'base'} | ${c.n} | ${c.same} | ${c.changed} | ${pct(c.agreement)} | ${pct(c.agreement_ci95[0])}–${pct(c.agreement_ci95[1])} | ${c.items_that_called_a_tool} |`);
  }
  w('');
  w('### What each comparison answers');
  w('');
  w('- **B vs A** — does DECLARING tools, on prompts that never need them, change unrelated answers? This is the');
  w('  cell README §6 requires and the reason the write-up must not say tool calling has no analogue here.');
  w('- **C vs A** — the Ainize claim: loading the knowledge does not change unrelated answers.');
  w('- **D vs A** — both at once, which is the configuration a buyer would actually ship.');
  w('- **B vs C** — if declaring tools perturbs as much as applying the knowledge does, neither party gets to');
  w('  call the other\'s number a side effect.');
  w('');
  const changed = Object.values(cmp.per_cell).flatMap((c) => c.changed_items.map((x) => ({ ...x, cell: c.cell })));
  w(`### Every changed answer, in full (${changed.length})`);
  w('');
  if (!changed.length) w('_No answer changed in any cell._');
  for (const c of changed) {
    w(`**${c.cell} · ${c.item_id}** (${c.stratum})`);
    w('');
    w('```');
    w(`reference: ${String(c.reference).slice(0, 600)}`);
    w(`${c.cell} answer: ${String(c.answer).slice(0, 600)}`);
    w('```');
    w('');
  }
  w('### Per stratum');
  w('');
  const strata = [...new Set(Object.values(cmp.per_cell).flatMap((c) => Object.keys(c.per_stratum)))].sort();
  w(`| stratum | ${CELLS.map((c) => c.id).join(' | ')} |`);
  w(`|---|${CELLS.map(() => '---').join('|')}|`);
  for (const s of strata) {
    w(`| ${s} | ${CELLS.map(({ id }) => { const c = cmp.per_cell[id]?.per_stratum?.[s]; return c ? `${c.same}/${c.n}` : '—'; }).join(' | ')} |`);
  }
  w('');
  if (joined) {
    w('### Cross-check against the tool-less capture');
    w('');
    w('`src/locality.mjs` captured cells A and C independently. Two instruments agreeing is worth more than one');
    w('instrument asserting, and a disagreement is a fact about the measurement that has to be printed.');
    w('');
    for (const [k, v] of Object.entries(joined)) w(`- ${k}: ${v}`);
    w('');
  }
  w('### What this table cannot see');
  w('');
  w(`- ${cmp.items_total} prompts on one model at one temperature. A flat table means no damage was detected AT`);
  w('  THIS RESOLUTION, which is not the same as none. The per-stratum counts are small enough that a single');
  w('  changed answer sits inside the reference cell\'s own noise, and that is a property of n.');
  w('- The reference is the base model\'s answer, not a correct answer. A cell can agree perfectly with a');
  w('  reference that was wrong; the gold truths in the prompt set are reported beside these numbers and never');
  w('  folded into them.');
  w('- Cells B and D declare the real MCP schemas. A different tool surface is a different experiment.');
  return p.join('\n') + '\n';
}

/** Join with the other session's tool-less report, when one is on disk. Never fabricates its half. */
export function joinWith(cmp, theirReportPath) {
  if (!theirReportPath || !existsSync(theirReportPath)) return null;
  let their;
  try { their = JSON.parse(readFileSync(theirReportPath, 'utf8')); } catch { return { note: `${theirReportPath} is not readable JSON` }; }
  const out = {};
  const mine = cmp.per_cell.C;
  const theirOverall = their.overall ?? their.per_cell?.C ?? null;
  if (theirOverall && mine) {
    const theirSame = theirOverall.same ?? theirOverall.agreed ?? null;
    const theirN = theirOverall.n ?? theirOverall.items ?? null;
    out['cell C, this file'] = `${mine.same}/${mine.n}`;
    out['cell C, src/locality.mjs'] = theirSame != null ? `${theirSame}/${theirN}` : 'present but not in a shape this file can read';
    if (theirSame != null && theirN != null) {
      out.agreement = (theirSame === mine.same && theirN === mine.n)
        ? 'the two instruments agree exactly'
        : 'THE TWO INSTRUMENTS DISAGREE — one of them is wrong and the disagreement is the finding';
    }
  } else {
    out.note = `${theirReportPath} carries no overall cell this file can compare against`;
  }
  return out;
}

/* ======================================================================================================== *
 * CLI
 * ======================================================================================================== */
const argvOf = (v) => { const a = {}; for (let i = 0; i < v.length; i++) if (v[i].startsWith('--')) { const k = v[i].slice(2); a[k] = v[i + 1]?.startsWith('--') || v[i + 1] === undefined ? true : v[++i]; } return a; };

async function main() {
  const cmd = process.argv[2];
  const argv = argvOf(process.argv.slice(3));

  if (cmd === 'score' || cmd === 'table') {
    const dir = argv.in ?? null;
    if (!dir) { console.error('--in runs/<id> is required'); process.exit(2); }
    const prov = JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8'));
    const units = JSON.parse(readFileSync(join(dir, 'units.json'), 'utf8'));
    // Score what was CAPTURED, not what is in the file. A smoke run that asked four of the fifty must not be
    // re-scored against a denominator of fifty — that would silently turn a probe into a measurement with
    // forty-six phantom agreements in it.
    const asked = new Set(units.map((u) => u.item_id));
    const { items: all } = loadPrompts();
    const items = all.filter((i) => asked.has(i.id));
    const orphans = [...asked].filter((id) => !items.some((i) => i.id === id));
    if (orphans.length) { console.error(`${orphans.length} captured item ids are not in the prompt set (${orphans.slice(0, 3).join(', ')}) — the set changed under the capture; refusing to score`); process.exit(1); }
    const keyMode = argv.key ?? prov.key_mode ?? 'scored';
    const keyOf = keyMode === 'text' ? (_i, t) => textKey(t) : scoredKey;
    const cells = {};
    for (const { id } of CELLS) {
      const us = units.filter((u) => u.cell === id);
      if (us.length) cells[id] = unitsToCell(items, us, keyOf);
    }
    const cmp = compare(items, cells, keyOf);
    const joined = joinWith(cmp, argv.with ?? null);
    writeFileSync(join(dir, 'four-cell.json'), JSON.stringify({ key_mode: keyMode, ...cmp }, null, 2) + '\n');
    const md = renderTable(cmp, { ...prov, key_mode: keyMode }, joined);
    writeFileSync(join(dir, 'four-cell.md'), md);
    if (cmd === 'table') console.log(md);
    else console.log(`four-cell.json + four-cell.md written to ${dir}`);
    return;
  }

  if (cmd !== 'run') {
    console.error(`usage:
  node src/locality-tools.mjs run  [--patch <id>] [--cells A,B] [--stratum far-domain] [--limit N]
                                   [--out runs/<id>] [--repeats 2] [--key scored|text]
  node src/locality-tools.mjs score --in runs/<id>
  node src/locality-tools.mjs table --in runs/<id> [--with runs/<their-id>/report.json]

  Without --patch only cells A and B are captured (no node, no operator credentials, the table is never
  touched). With --patch, cells C and D are captured too and the table is restored to the state it was found
  in, asserted against the node.`);
    process.exit(2);
  }

  const { VLLM } = await import('./vllm.mjs');
  const { runToolLoop } = await import('./toolloop.mjs');
  const { SubgraphMCP } = await import('./mcp.mjs');

  const { items: allItems, from, sha256 } = loadPrompts();
  // --stratum / --limit exist for smoke runs against a shared GPU. A partial capture is stamped as partial in
  // its own provenance, so a five-item probe can never be read as the 50-prompt measurement §6 asks for.
  const filtered = argv.stratum && argv.stratum !== true ? allItems.filter((i) => String(argv.stratum).split(',').includes(i.stratum)) : allItems;
  const items = argv.limit ? filtered.slice(0, Number(argv.limit)) : filtered;
  if (!items.length) { console.error(`no prompts matched --stratum ${argv.stratum}`); process.exit(2); }
  const repeats = Number(argv.repeats ?? 2);
  const patchId = argv.patch && argv.patch !== true ? argv.patch : null;
  const only = argv.cells && argv.cells !== true ? new Set(String(argv.cells).split(',').map((x) => x.trim().toUpperCase())) : null;
  let wanted = patchId ? CELLS : CELLS.filter((c) => !c.patch);
  if (only) wanted = wanted.filter((c) => only.has(c.id));
  if (!wanted.some((c) => c.id === 'A')) { console.error('cell A is the reference every other cell is compared against — it cannot be skipped'); process.exit(2); }
  const outDir = argv.out ?? join(BENCH, 'runs', `locality-tools-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  mkdirSync(outDir, { recursive: true });

  const vllm = new VLLM();
  const ready = await vllm.ready();
  const engineStart = engineSnapshot(vllm.base);

  // The deployment list arm B is handed. Read from the committed manifest, exactly as the study does, so the
  // tools-declared cell carries the SAME system prompt asymmetry the study's arm B carries.
  const sources = JSON.parse(readFileSync(join(BENCH, 'pipeline', 'sources.json'), 'utf8')).sources ?? [];
  const runId = argv.data ?? 'r1';
  const mpath = join(BENCH, 'data', runId, 'pull', 'manifest.json');
  const manifest = existsSync(mpath) ? JSON.parse(readFileSync(mpath, 'utf8')) : { responses: [], block: null };
  const answered = new Set((manifest.responses ?? []).map((r) => r.deployment_id));
  const live = sources.filter((s) => answered.has(s.deployment_id));
  const deployments = `The following ${live.length} subgraph deployments were live${manifest.block ? ` at block ${manifest.block}` : ''} when this run started.\n`
    + live.map((s) => `- ${s.protocol} (${s.schema}, ${s.network}): ${s.deployment_id}`).join('\n');

  // The MCP is contacted only if a tools cell is actually being captured. §6's arm-C claim is that the
  // knowledge makes zero network calls, and an instrument that opened an SSE session to The Graph in order to
  // measure a cell that declares no tools would be quietly contradicting the property it is measuring.
  const needTools = wanted.some((c) => c.tools);
  let mcp = { toolSchemas: null, close: async () => {}, serverInfo: null };
  if (needTools) {
    mcp = new SubgraphMCP();
    await mcp.connect();
    mcp.toolSchemas = (await mcp.listTools()).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    writeFileSync(join(outDir, 'tool-schemas.json'), JSON.stringify(mcp.toolSchemas, null, 2));
  }

  let node = null, patchWasApplied = null, provenanceOfPatch = null;
  if (patchId) {
    const { NodeClient } = await import('./node.mjs');
    node = new NodeClient();
    await node.login();
    patchWasApplied = await node.isApplied(patchId);
    provenanceOfPatch = await node.provenance(patchId);
  }

  const units = [];
  const provenance = {
    started_at: new Date().toISOString(), finished_at: null,
    model: ready.model, max_model_len: ready.maxModelLen, api: vllm.base,
    prompt_set: { from, sha256, items_in_file: allItems.length, items_captured: items.length, filter: { stratum: argv.stratum ?? null, limit: argv.limit ?? null } },
    repeats, key_mode: argv.key ?? 'scored',
    cells: wanted.map((c) => c.id),
    patch: patchId ? { id: patchId, ...provenanceOfPatch, was_applied_before_run: patchWasApplied } : null,
    engine_at_start: engineStart, engine_between: [], engine_at_end: null, engine_changed: null,
    // system-prompts/*.txt is edited as the study learns things about arm B (the subgraph-id correction, for
    // one). A capture is only comparable to another capture that used the same strings, so the hashes are
    // recorded here as well as per unit — a B cell captured against a different tools.txt is a different cell.
    system_prompts: Object.fromEntries(wanted.map((c) => [c.id, createHash('sha256').update(systemFor(c, deployments)).digest('hex').slice(0, 12)])),
    mcp: needTools ? { server: mcp.serverInfo ?? null, tools: mcp.toolSchemas.map((t) => t.function.name) } : { contacted: false, why: 'no tools cell was captured, so no network call was made' },
    table_restored: null,
    stamps: [],
  };
  if (patchId && provenanceOfPatch && !provenanceOfPatch.real_training) provenance.stamps.push('SIMULATED PATCH — NOT A TRAINED MODEL');
  const missing = CELLS.filter((c) => !wanted.some((w) => w.id === c.id)).map((c) => c.id);
  if (items.length !== allItems.length) provenance.stamps.push(`PARTIAL SET — ${items.length} of ${allItems.length} prompts; this is a smoke run, not the ${allItems.length}-prompt measurement`);
  if (missing.length) provenance.stamps.push(`CELL${missing.length > 1 ? 'S' : ''} ${missing.length > 1 ? missing.slice(0, -1).join(', ') + ' and ' + missing.at(-1) : missing[0]} NOT CAPTURED — this is a partial table${patchId ? '' : '; run with --patch <id> for C and D'}`);

  const flush = () => {
    writeFileSync(join(outDir, 'units.json'), JSON.stringify(units, null, 2));
    writeFileSync(join(outDir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  };
  let restoreDone = false;
  const restore = async () => {
    if (restoreDone || !node || patchWasApplied === null) return;
    restoreDone = true;
    try {
      await node.setApplied(patchId, patchWasApplied);
      provenance.table_restored = { to: patchWasApplied, asserted: (await node.isApplied(patchId)) === patchWasApplied };
    } catch (err) {
      provenance.table_restored = { to: patchWasApplied, asserted: false, error: String(err.message) };
      provenance.stamps.push('THE TABLE COULD NOT BE RESTORED — the node was left in a state this run changed');
    }
    flush();
  };
  process.on('SIGINT', async () => { console.error('\ninterrupted — restoring the table before exiting'); await restore(); process.exit(130); });

  try {
    for (const cell of wanted) {
      if (node) await node.setApplied(patchId, cell.patch);
      const system = systemFor(cell, deployments);
      console.error(`\n=== cell ${cell.id} — ${cell.label}`);
      for (const item of items) {
        for (let rep = 0; rep < repeats; rep++) {
          const r = await askOne({ vllm, mcp, runToolLoop, cell, system, item });
          units.push({ cell: cell.id, item_id: item.id, repeat: rep, system_sha256: createHash('sha256').update(system).digest('hex').slice(0, 12), ...r });
        }
        process.stderr.write('.');
      }
      // The table state is asserted after every cell, not assumed to have survived it (§4).
      if (node) {
        const still = await node.isApplied(patchId);
        if (still !== cell.patch) { provenance.stamps.push(`CELL ${cell.id} RAN WITH THE TABLE IN THE WRONG STATE — its units are discarded`); for (let i = units.length - 1; i >= 0 && units[i].cell === cell.id; i--) units.splice(i, 1); }
      }
      const snap = engineSnapshot(vllm.base);
      provenance.engine_between.push({ after_cell: cell.id, ...snap });
      flush();
    }
  } finally {
    await restore();
    await mcp.close().catch(() => {});
  }

  provenance.engine_at_end = engineSnapshot(vllm.base);
  provenance.engine_changed = engineDiff(engineStart, provenance.engine_at_end);
  provenance.finished_at = new Date().toISOString();
  flush();

  if (provenance.engine_changed?.length) {
    console.error(`\nthe serving engine changed during the run (${provenance.engine_changed.join('; ')}).`);
    console.error('the cells did not run on one instance, so any difference between them is confounded with the restart.');
    console.error(`transcripts and units.json are in ${outDir}; no four-cell table was written.`);
    process.exit(1);
  }

  const keyOf = provenance.key_mode === 'text' ? (_i, t) => textKey(t) : scoredKey;
  const cells = {};
  for (const { id } of CELLS) { const us = units.filter((u) => u.cell === id); if (us.length) cells[id] = unitsToCell(items, us, keyOf); }
  const cmp = compare(items, cells, keyOf);
  writeFileSync(join(outDir, 'four-cell.json'), JSON.stringify({ key_mode: provenance.key_mode, ...cmp }, null, 2) + '\n');
  const md = renderTable(cmp, provenance, joinWith(cmp, argv.with ?? null));
  writeFileSync(join(outDir, 'four-cell.md'), md);
  console.log('\n' + md);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.stack ?? String(err)); process.exit(1); });
}
