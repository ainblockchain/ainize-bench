#!/usr/bin/env node
/**
 * THE LOCALITY SET AND ITS RUNNER — does applying this patch break anything it did not promise to change?
 *
 *   node src/locality.mjs build                       regenerate locality/prompts.jsonl from its two halves
 *   node src/locality.mjs check                       the overlap assertion, offline, exit 1 on any collision
 *   node src/locality.mjs run --patch <rows.npz>      the live capture: reference → apply → post-apply → restore
 *   node src/locality.mjs score --in runs/locality-x  re-score a captured run without a GPU
 *
 * WHY IT EXISTS. What Ainize measures today is whether a patch teaches what it promised. What nobody measures
 * is whether it breaks anything else. A PLE patch writes rows into an embedding table addressed by content,
 * so the collateral damage to look for is not in a far-off domain: it is at the addresses NEXT TO the ones the
 * patch trained. This set is 50 prompts — 20 in the trained neighbourhood, 30 far from it — asked twice
 * before the patch and twice after, on ONE engine instance.
 *
 * THE ORDERING IS STRUCTURAL, NOT A CONVENTION. `run` is a single invocation that captures the reference and
 * the post-apply run itself. There is no flag that scores a post-apply run against a reference captured
 * earlier, because a reference recorded before a restart inherits exactly the confounder the four-arm study
 * spends 40 bridge items ruling out. The container is read (Cmd / RestartCount / StartedAt, the way
 * src/run.mjs does) before the reference, between the halves and after, and a comparison across a container
 * that changed underneath is REFUSED — transcripts are kept, no report is written.
 *
 * WHAT IT CANNOT SEE — read locality/README.md before quoting any of its numbers. In short: 50 items over one
 * model at one temperature cannot prove a patch is safe. A green report means "no damage was detected at this
 * resolution", and the resolution is stated in the report itself (the per-stratum noise floor and its 95%
 * upper bound). With 10 items in a stratum a single changed answer is inside the floor's interval and this
 * instrument cannot call it damage; that is a property of n, not a clean bill of health.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scoreOne, wilson, mcnemar, normalize } from './normalize.mjs';
import { DECLINE, normText, buildTrainsetGuard, assertNoOverlap, scoreControl, pairItem } from './locality-control.mjs';
import { resolveJsonPath } from './locality-near.mjs';
import { VLLM } from './vllm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BENCH = join(HERE, '..');
export const LOCALITY = join(BENCH, 'locality');
export const R1 = join(BENCH, 'data', 'r1');
export const PROMPTS_PATH = join(LOCALITY, 'prompts.jsonl');
export const NEAR_PATH = join(LOCALITY, 'near.jsonl');
export const CONTROL_PATH = join(LOCALITY, 'control.jsonl');
export const SYSTEM_PATH = join(LOCALITY, 'system.txt');

/** Where the reference implementation of the apply/remove path lives, and the mailbox it writes into. */
export const QWEN_HOME = process.env.LOCALITY_QWEN_HOME ?? '/mnt/newdata/qwen3.8';
export const PATCH_DIR = process.env.LOCALITY_PATCH_DIR ?? '/mnt/newdata/qwen3.8/ple_patch_e2e';

/** Declared composition. Six strata, 50 items; `loadPromptSet` refuses a file that does not match. */
export const STRATA = { 'adjacent-entity': 10, 'near-domain': 10, 'far-domain': 12, korean: 8, format: 6, calibration: 4 };
export const MODES = new Set(['exact-normalised', 'numeric', 'contains', 'json-shape', 'refusal']);

/** The source stratum name in each half's file → the name this set uses. Kept so provenance is traceable. */
const STRATUM_MAP = {
  'adjacent-entity': 'adjacent-entity',
  'near-domain-conceptual': 'near-domain',
  far_domain: 'far-domain',
  korean: 'korean',
  format: 'format',
  calibration: 'calibration',
};

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const shortHash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

// ---------------------------------------------------------------------------------------------------------
// The two re-selections, and why they are in the code rather than in a hand-edited file
// ---------------------------------------------------------------------------------------------------------

/**
 * `near.jsonl` was certified against the trainset as it stood at commit 8cfddf6. The trainset was then
 * REGENERATED (911ccf3, "the study was 80% one relation, so the sampler now stratifies by relation too") and
 * began training 13 `vault_fee_pct` rows whose answers are 2.5, 10 and 0. Two near items — loc-adj-05 (truth
 * 2.5) and loc-adj-06 (truth 10) — therefore now have a ground truth that IS a trained answer, and the near
 * half's own selection rule rejects exactly that: a bleed towards the nearest trained answer would be
 * indistinguishable from a correct answer, which is why a pool holding WETH was rejected during selection.
 *
 * So this set re-selects those two items by the same rule, out of the same committed pull, and keeps
 * everything else. The replacements are declared as fact ids, not as prose: `buildPromptSet` reads the fact,
 * renders the relation's own P template, and re-reads the truth out of BOTH committed pulls. And the override
 * is self-invalidating: if `superseded_truth` is no longer a trained answer atom, the build THROWS rather than
 * carrying a silent fork of the near half's file — a justification that cannot expire is not a justification.
 */
export const RESELECTED = {
  'loc-adj-05': {
    superseded_truth: '2.5',
    fact_id: 'vault_fee_pct:a45d207e93eb',
    adjacency: {
      kind: 'array_slot',
      slot_distance: 1,
      file: 'arrakis-finance.vaults.p0.json',
      nearest_trained_fact_id: 'vault_address:be9b65eabc8f',
      nearest_trained_subject: 'RAKIS-13',
      nearest_trained_answer: '0x4cf66acaf7341e6fcc06ce50f2e314f82ae28ce5',
      same_subgraph: 'arrakis-finance',
      same_relation: false,
    },
    bleed_targets: ['2.5', '10', '0', '0x4cf66acaf7341e6fcc06ce50f2e314f82ae28ce5'],
    why_this_one:
      'The performance fee of an Arrakis vault one array slot from a trained one, whose value (9.5) is unique in '
      + 'the 12,619-fact universe and is not one of the three fee values the patch now trains. That is the point: '
      + 'the trained fee answers are 2.5, 10 and 0, so a table that bled here answers one of THOSE and the miss is '
      + 'legible instead of being indistinguishable from the truth. Its neighbour at slot 88 is trained in the '
      + 'reverse direction (RAKIS-13 -> address), so the item also probes whether teaching a reverse lookup damaged '
      + 'a forward one next door.',
  },
  'loc-adj-06': {
    superseded_truth: '10',
    fact_id: 'vault_fee_pct:33dcf124c09c',
    adjacency: {
      kind: 'array_slot',
      slot_distance: 1,
      file: 'badgerdao.vaults.p0.json',
      nearest_trained_fact_id: 'vault_asset:4ccad9d55098',
      nearest_trained_subject: '0x26b8efa69603537ac8ab55768b6740b67664d518',
      nearest_trained_answer: '0x48c59199da51b7e30ea200a74ea07974e62c4ba7',
      same_subgraph: 'badgerdao',
      same_relation: false,
    },
    bleed_targets: ['2.5', '10', '0', '0x48c59199da51b7e30ea200a74ea07974e62c4ba7'],
    why_this_one:
      'The second never-trained-value fee probe, in a different protocol, one slot the OTHER side of the same '
      + 'trained Badger vault the superseded item sat beside (vault_asset:4ccad9d55098 at slot 38). Its truth is 20, '
      + "which is Badger's modal fee — a deliberate trade the superseded item did not have to make: every Badger "
      + 'vault adjacent to a trained one now answers 10, 2.5 or 20, and 10 and 2.5 are trained answers. A guessable '
      + 'truth costs some of the item\'s power (a hit may come from a protocol prior rather than from the table) '
      + 'and buys back the only property that matters here — that a bleed is distinguishable from the truth.',
  },
};

// ---------------------------------------------------------------------------------------------------------
// Building the 50
// ---------------------------------------------------------------------------------------------------------

/** Which of the five scoring modes an item wants, derived from the half it came from and its declared type. */
export function modeFor(item, half) {
  if (half === 'near') {
    if (item.answer_type === 'prose') return { mode: 'contains', match: 'substring', delegate: 'locality.rubric' };
    if (item.answer_type === 'decimal' || item.answer_type === 'integer') return { mode: 'numeric', delegate: 'normalize.scoreOne' };
    return { mode: 'exact-normalised', delegate: 'normalize.scoreOne' };
  }
  if (item.answer_type === 'integer') return { mode: 'numeric', delegate: 'normalize.scoreOne' };
  if (item.answer_type === 'text') return { mode: 'contains', match: 'word', delegate: 'locality-control.scoreControl' };
  if (item.answer_type === 'refusal') return { mode: 'refusal', delegate: 'locality-control.scoreControl' };
  if (item.answer_type === 'format') {
    if (item.format?.kind === 'json_keys') return { mode: 'json-shape', delegate: 'locality-control.scoreControl' };
    if (item.format?.kind === 'number_only') return { mode: 'numeric', delegate: 'locality-control.scoreControl' };
    return { mode: 'exact-normalised', delegate: 'locality-control.scoreControl' };
  }
  throw new Error(`locality: ${item.id} has answer_type ${item.answer_type}, which no scoring mode covers`);
}

/**
 * The near half records two kinds of bleed target: literal values (the nearest trained answer, as a string or
 * a token list) and prose rules ("any 40-hex Ethereum address"). Only the first can be matched against an
 * answer; the second is already implemented as a mechanical sign in `bleedSigns`, so it is carried as a rule
 * rather than left in a list where it would silently never match.
 */
function splitBleed(list = []) {
  const targets = [], rules = [];
  for (const t of list) (typeof t === 'string' && /^any\b/i.test(t) ? rules : targets).push(t);
  return { targets, rules };
}

/** One merged row, with its keys in a fixed order so the file is a deterministic function of its sources. */
function row(o) {
  const order = ['id', 'stratum', 'source_stratum', 'half', 'lang', 'prompt', 'scoring', 'answer_type', 'truth',
    'accept', 'reject', 'rubric', 'format', 'refusal', 'relation', 'subject', 'fact_ids', 'source', 'adjacency',
    'bleed_targets', 'bleed_rules', 'why', 'superseded'];
  const out = {};
  for (const k of order) if (o[k] !== undefined) out[k] = o[k];
  for (const k of Object.keys(o)) if (!order.includes(k)) throw new Error(`locality: row ${o.id} carries unknown key ${k}`);
  return out;
}

/**
 * The 50 items, derived from the two halves rather than maintained as a third hand-written file. Every field
 * is carried through verbatim except the stratum name and the two re-selections; nothing is re-worded here.
 */
export function buildPromptSet({ nearPath = NEAR_PATH, controlPath = CONTROL_PATH, r1 = R1, bench = BENCH } = {}) {
  const near = readJsonl(nearPath);
  const control = readJsonl(controlPath);
  const facts = new Map(readJsonl(join(r1, 'facts.jsonl')).map((f) => [f.fact_id, f]));
  const templates = readJson(join(bench, 'questions', 'templates.json')).families;
  const trained = loadTrained({ r1, bench });

  const rows = [];
  for (const it of near) {
    const stratum = STRATUM_MAP[it.stratum];
    if (!stratum) throw new Error(`locality: near item ${it.id} has unmapped stratum ${it.stratum}`);
    const re = RESELECTED[it.id];
    if (re) { rows.push(reselect(it, re, { facts, templates, trained, r1 })); continue; }
    rows.push(row({
      id: it.id, stratum, source_stratum: it.stratum, half: 'near', lang: it.lang, prompt: it.question,
      scoring: modeFor(it, 'near'), answer_type: it.answer_type, truth: it.truth ?? null,
      rubric: it.rubric, relation: it.relation ?? null, subject: it.subject ?? null,
      fact_ids: it.fact_ids ?? [], source: it.source ?? null, adjacency: it.adjacency,
      bleed_targets: splitBleed(it.bleed_targets).targets, bleed_rules: splitBleed(it.bleed_targets).rules,
      why: it.why_this_one ?? it.near_domain_link ?? null,
    }));
  }
  for (const it of control) {
    const stratum = STRATUM_MAP[it.stratum];
    if (!stratum) throw new Error(`locality: control item ${it.id} has unmapped stratum ${it.stratum}`);
    rows.push(row({
      id: it.id, stratum, source_stratum: it.stratum, half: 'control', lang: it.lang, prompt: it.question,
      scoring: modeFor(it, 'control'), answer_type: it.answer_type, truth: it.truth ?? null,
      accept: it.accept, reject: it.reject, format: it.format, refusal: it.refusal,
      fact_ids: [], bleed_targets: [], bleed_rules: [], why: it.why ?? null,
    }));
  }
  return rows;
}

/** Rebuild one near item from the fact its override names, and refuse if the override is no longer justified. */
function reselect(original, re, { facts, templates, trained, r1 }) {
  const supersededAtoms = (Array.isArray(original.truth) ? original.truth : [original.truth]).map((v) => String(v).trim().toLowerCase());
  if (!supersededAtoms.includes(String(re.superseded_truth).toLowerCase())) {
    throw new Error(`locality: RESELECTED[${original.id}] says it supersedes truth "${re.superseded_truth}", but the item's truth is ${JSON.stringify(original.truth)}`);
  }
  if (!trained.atoms.has(String(re.superseded_truth).toLowerCase())) {
    throw new Error(`locality: RESELECTED[${original.id}] exists because "${re.superseded_truth}" became a trained answer, and it is not one any more (trainset ${trained.sha256.slice(0, 12)}). Delete the override and take the near half's item back, or state a new reason.`);
  }
  const f = facts.get(re.fact_id);
  if (!f) throw new Error(`locality: RESELECTED[${original.id}] names fact ${re.fact_id}, which is not in facts.jsonl`);
  const family = templates[f.relation];
  if (!family) throw new Error(`locality: no template family for relation ${f.relation}`);
  const truth = Array.isArray(f.object) ? f.object.map(String) : String(f.object);
  // C8, at build time: the truth is re-read from both committed pulls rather than copied out of facts.jsonl.
  const file = f.source.json_path.split('#')[0];
  const seen = ['pull', 'pull-fresh'].map((d) => resolveJsonPath(readJson(join(r1, d, file)), f.source.json_path));
  const asText = (v) => JSON.stringify(Array.isArray(v) ? v.map(String) : String(v));
  if (asText(seen[0]) !== asText(seen[1])) throw new Error(`locality: ${re.fact_id} reads ${asText(seen[0])} in pull/ and ${asText(seen[1])} in pull-fresh/ — not stable, not usable`);
  if (asText(seen[0]) !== asText(truth)) throw new Error(`locality: ${re.fact_id} is recorded as ${asText(truth)} but the pull says ${asText(seen[0])}`);
  const it = { id: original.id, answer_type: f.answer_type };
  return row({
    id: original.id, stratum: STRATUM_MAP[original.stratum], source_stratum: original.stratum, half: 'near',
    lang: 'en', prompt: family.P.replace('{subject}', f.subject),
    scoring: modeFor(it, 'near'), answer_type: f.answer_type, truth,
    relation: f.relation, subject: f.subject, fact_ids: [f.fact_id], source: f.source,
    adjacency: re.adjacency, bleed_targets: splitBleed(re.bleed_targets).targets, bleed_rules: splitBleed(re.bleed_targets).rules, why: re.why_this_one,
    superseded: { of: original.id, was_truth: original.truth, reason: `"${re.superseded_truth}" is a trained answer in trainset ${trained.sha256.slice(0, 12)}`, source_file: basename(NEAR_PATH) },
  });
}

/** One JSON object per line, in build order. Deterministic: `build` twice on the same inputs is byte-identical. */
export function serialisePromptSet(rows) { return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'; }

/**
 * Read the 50 and check that they are still what the two halves say they are. A set whose sources have moved
 * under it must be rebuilt and re-certified, not silently scored — the trainset already moved once.
 */
export function loadPromptSet({ path = PROMPTS_PATH, verifyDerivation = true, ...opts } = {}) {
  if (!existsSync(path)) throw new Error(`locality: ${path} does not exist — run \`node src/locality.mjs build\` first`);
  const raw = readFileSync(path, 'utf8');
  const rows = raw.split('\n').filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(`${path}:${i + 1} is not JSON: ${e.message}`); }
  });
  if (verifyDerivation) {
    const rebuilt = serialisePromptSet(buildPromptSet(opts));
    if (rebuilt !== raw) throw new Error(`locality: ${basename(path)} is not what near.jsonl + control.jsonl now derive to. One of its sources changed. Re-run \`node src/locality.mjs build\`, re-read the diff, and re-certify — this file is never edited by hand.`);
  }
  validatePromptSet(rows);
  return rows;
}

/** Everything that must be true of the file for a verdict computed from it to mean anything. */
export function validatePromptSet(rows) {
  const ids = new Set(); const counts = {};
  for (const it of rows) {
    if (!it.id || ids.has(it.id)) throw new Error(`locality: duplicate or missing id "${it.id}"`);
    if (!/^[A-Za-z0-9._-]+$/.test(it.id)) throw new Error(`locality ${it.id}: id must be filesystem-safe (transcripts are written as <id>.<repeat>.json)`);
    ids.add(it.id);
    if (!it.prompt?.trim()) throw new Error(`locality ${it.id}: empty prompt`);
    if (!it.lang) throw new Error(`locality ${it.id}: no lang`);
    if (!MODES.has(it.scoring?.mode)) throw new Error(`locality ${it.id}: unknown scoring mode ${it.scoring?.mode}`);
    if (!(it.stratum in STRATA)) throw new Error(`locality ${it.id}: undeclared stratum ${it.stratum}`);
    counts[it.stratum] = (counts[it.stratum] ?? 0) + 1;
    if (it.scoring.mode === 'contains') {
      const slots = containsSpec(it);
      if (!slots.all_of.length) throw new Error(`locality ${it.id}: contains mode with no required slot`);
    }
    if (it.scoring.mode === 'refusal' && !it.refusal?.refuse_re) throw new Error(`locality ${it.id}: refusal mode with no refuse_re`);
    if (it.scoring.mode === 'json-shape' && !it.format?.keys?.length) throw new Error(`locality ${it.id}: json-shape mode with no keys`);
    if (it.lang === 'ko' && !/\p{Script=Hangul}/u.test(it.prompt)) throw new Error(`locality ${it.id}: declared Korean, no Hangul in the prompt`);
  }
  for (const [s, n] of Object.entries(STRATA)) {
    if (counts[s] !== n) throw new Error(`locality: stratum ${s} has ${counts[s] ?? 0} items, declared ${n}`);
  }
  const total = Object.values(STRATA).reduce((a, b) => a + b, 0);
  if (rows.length !== total) throw new Error(`locality: ${rows.length} items, declared ${total}`);
  return true;
}

/** The `contains` spec, whichever half wrote it: a near rubric, or a control accept/reject list. */
export function containsSpec(it) {
  if (it.rubric) return { all_of: it.rubric.must_include ?? [], none_of: it.rubric.must_not_include ?? [], match: 'substring', on_forbidden: 'wrong' };
  return { all_of: it.accept?.length ? [it.accept] : [], none_of: it.reject ?? [], match: 'word', on_forbidden: 'ambiguous' };
}

// ---------------------------------------------------------------------------------------------------------
// What the patch was trained on — computed from the files, never typed out
// ---------------------------------------------------------------------------------------------------------

/**
 * Reduce the pre-registered study to the sets a locality prompt may not touch, and PROVE the reduction first.
 *
 * The proof is the whole point. Every one of the 120 `{prompt, answer}` training rows must re-derive
 * byte-for-byte from a fact in `split.study_fact_ids` through that relation's own `P` template. Only when all
 * 120 re-derive do the trained subjects, answer atoms and addresses that fall out of those facts describe what
 * was actually trained; without it they are a guess about what someone believes was trained, and the trainset
 * has already been regenerated once under a set that had been certified against the old one.
 */
export function loadTrained({ r1 = R1, bench = BENCH } = {}) {
  const trainsetPath = join(r1, 'trainset.jsonl');
  const raw = readFileSync(trainsetPath, 'utf8');
  const trainset = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const split = readJson(join(r1, 'split.json'));
  const facts = new Map(readJsonl(join(r1, 'facts.jsonl')).map((f) => [f.fact_id, f]));
  const templates = readJson(join(bench, 'questions', 'templates.json')).families;
  // Every question set in the run directory that is actually ASKED, not just the original 250: the study has
  // since grown a fresh sample and an out-of-distribution sample, and an item that is simultaneously a study
  // question and a locality control is counted twice by two instruments that are supposed to be independent.
  // `questions-pool.jsonl` is excluded on purpose — it is the 38k candidate pool, which nobody asks.
  const askedFiles = readdirSync(r1).filter((f) => /^questions(-[a-z0-9]+)?\.jsonl$/.test(f) && f !== 'questions-pool.jsonl').sort();
  const questions = askedFiles.flatMap((f) => readJsonl(join(r1, f)));

  const render = (o) => (Array.isArray(o) ? o.map(String).join(', ') : String(o));
  const study = split.study_fact_ids.map((id) => {
    const f = facts.get(id);
    if (!f) throw new Error(`locality: split.study_fact_ids names ${id}, which is not in facts.jsonl`);
    return f;
  });

  const subjects = new Set(), atoms = new Set(), addresses = new Set(), numbers = new Set();
  const prompts = new Set(), factIds = new Set(), relations = {};
  let derived = 0;
  for (const r of trainset) {
    const f = study.find((x) => templates[x.relation]?.P.replace('{subject}', x.subject) === r.prompt && render(x.object) === r.answer);
    if (!f) throw new Error(`locality: trainset row "${r.prompt.slice(0, 70)}…" does not re-derive from any fact in split.study_fact_ids through its P template. The exclusion set cannot be trusted; regenerate the study or fix the template map before running anything.`);
    derived++;
    factIds.add(f.fact_id);
    relations[f.relation] = (relations[f.relation] ?? 0) + 1;
    subjects.add(String(f.subject).toLowerCase());
    for (const o of (Array.isArray(f.object) ? f.object : [f.object])) atoms.add(String(o).trim().toLowerCase());
    prompts.add(r.prompt.trim().toLowerCase());
    for (const m of `${r.prompt} ${r.answer}`.match(/0x[0-9a-fA-F]{40}/g) ?? []) addresses.add(m.toLowerCase());
    if (/^\s*-?\d[\d,._]*\s*$/.test(String(r.answer))) numbers.add(String(r.answer).trim().replace(/,/g, ''));
  }
  if (derived !== trainset.length) throw new Error('locality: not every trainset row re-derived');

  return {
    trainsetPath, sha256: sha256(raw), rows: trainset.length, derived,
    subjects, atoms, addresses, numbers, prompts, factIds, relations,
    studyFactIds: new Set(split.study_fact_ids),
    askedFiles, askedQuestions: questions.length,
    sampleFactIds: new Set(questions.flatMap((q) => q.fact_ids ?? [])),
    studyQuestions: new Set(questions.map((q) => q.question.trim().toLowerCase())),
  };
}

/** Everything an item counts as its own answer: the truth, plus every surface form scored as correct. */
export function truthAtoms(it) {
  const out = [];
  if (it.scoring?.mode === 'refusal') return out;
  if (Array.isArray(it.truth)) out.push(...it.truth.map(String));
  else if (it.truth != null && it.answer_type !== 'format') out.push(String(it.truth));
  out.push(...(it.accept ?? []));
  out.push(...(it.format?.items ?? []));
  out.push(...Object.values(it.format?.values ?? {}).map(String));
  if (it.format?.token) out.push(it.format.token);
  return out.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * THE ASSERTION THE RUNNER MAKES BEFORE ITS FIRST REQUEST. Throws on the first collision; there is no
 * degraded mode worth continuing into, because an item that touches a trained fact cannot tell a bleed from a
 * lesson and the report would be a green light welded on.
 *
 * Five rules run over all 50, and a sixth over the 30 control items only:
 *
 *   T1 fact identity      an item's fact_id is a study fact, or one of the fact_ids the 250-item sample asks
 *   T2 subject identity   an item asks about a trained subject
 *   T3 prompt containment a trained subject or a trained address appears anywhere in the prompt
 *   T4 answer disjointness an item's ground truth (or an accepted surface form) IS a trained answer atom
 *   T5 prompt novelty     the prompt is verbatim a trainset prompt or one of the 250 study questions
 *   T6 control strictness the far/Korean/format/calibration items additionally carry NO trained entity token
 *
 * T3 is a substring check against trained SUBJECTS (addresses and vault/market names — never English) and not
 * a token check against trained ANSWERS, on purpose: trained tickers include ordinary English words (INDEX and
 * REVERSE today; VAULT, LOVE and ten others before the trainset was regenerated) and a token check would have
 * to carve them out and then defend the carve-out. The near half's prompts share the study's template
 * vocabulary BY DESIGN — that is what makes them near — so the ambiguity is resolved where it costs something:
 * on the answer, as whole-atom equality (T4).
 */
export function assertNoTrainsetOverlap(items, trained, { controlGuard = null, controlStrata = ['far-domain', 'korean', 'format', 'calibration'] } = {}) {
  const report = [];
  for (const it of items) {
    // Every rule an item breaks is reported, not just the first: a prompt lifted verbatim out of the trainset
    // breaks T3 and T5 at once, and a message naming one of them would leave the reader believing the other
    // rule had been checked and passed.
    const bad = [];
    for (const f of it.fact_ids ?? []) {
      if (trained.studyFactIds.has(f)) bad.push(`T1 fact ${f} is one of the ${trained.rows} the patch is trained on`);
      if (trained.sampleFactIds.has(f)) bad.push(`T1 fact ${f} is asked by the study's own 250-item sample`);
    }
    if (it.subject && trained.subjects.has(String(it.subject).toLowerCase())) bad.push(`T2 its subject ${it.subject} is a trained subject`);
    const hay = String(it.prompt).toLowerCase();
    for (const s of trained.subjects) if (hay.includes(s)) bad.push(`T3 the prompt contains the trained subject "${s}"`);
    for (const a of trained.addresses) if (hay.includes(a)) bad.push(`T3 the prompt contains the trained address ${a}`);
    for (const a of truthAtoms(it)) {
      if (trained.atoms.has(a)) bad.push(`T4 its answer "${a}" is a trained answer atom`);
      if (trained.numbers.has(a.replace(/,/g, ''))) bad.push(`T4 its answer "${a}" is a trained numeric answer`);
    }
    if (trained.prompts.has(hay.trim())) bad.push('T5 the prompt is verbatim a trainset prompt');
    if (trained.studyQuestions.has(hay.trim())) bad.push("T5 the prompt is verbatim one of the study's 250 questions");
    if (bad.length) throw new Error(`locality overlap: ${it.id}: ${[...new Set(bad)].join('; ')}`);
    report.push({ id: it.id, stratum: it.stratum, rules: ['T1', 'T2', 'T3', 'T4', 'T5'] });
  }
  const controls = items.filter((it) => controlStrata.includes(it.stratum));
  if (controlGuard) {
    // The control half's own guard, unchanged: those items share NO vocabulary with the trainset, not even
    // the template words the near half is allowed to reuse. Delegated rather than re-implemented so the two
    // halves cannot drift into two different definitions of "clean".
    assertNoOverlap(controls.map((it) => ({ ...it, question: it.prompt })), controlGuard);
    for (const r of report) if (controlStrata.includes(items.find((i) => i.id === r.id).stratum)) r.rules.push('T6');
  }
  return { report, rules_run: controlGuard ? 6 : 5, control_items: controls.length, trainset_sha256: trained.sha256 };
}

// ---------------------------------------------------------------------------------------------------------
// Scoring — five modes, four of which are the repo's existing rules
// ---------------------------------------------------------------------------------------------------------

const HANGUL = /\p{Script=Hangul}/u;
export const ADDRESS_ANYWHERE = /0x[0-9a-fA-F]{40}/g;

/** Case-insensitive containment on the raw answer. Deliberately NOT word-bounded: rubric slots are stems. */
const holds = (raw, form) => String(raw).normalize('NFC').toLowerCase().includes(String(form).normalize('NFC').toLowerCase());

/**
 * The one scoring rule this file adds: a prose answer against a rubric of concept slots.
 *
 * Each slot is a list of accepted surface forms; ALL slots must be satisfied. No LLM judge, no partial credit
 * folded into the headline — `slots` travels alongside the verdict the way score.mjs's `partial` does. The
 * study has no use for this type, which is why it lives here rather than in questions/schema.json: these
 * items are not lookups and there is no value to normalise.
 */
export function scoreRubric(raw, item) {
  const spec = containsSpec(item);
  const matched = spec.all_of.map((slot) => slot.find((f) => holds(raw, f)) ?? null);
  const forbidden = spec.none_of.filter((f) => holds(raw, f));
  const n = spec.all_of.length, got = matched.filter(Boolean).length;
  const key = matched.map((m, i) => (m ? i : '')).filter((x) => x !== '').join(',');
  if (forbidden.length) return { verdict: 'wrong', reason: 'contradiction', forbidden, slots: `${got}/${n}`, partial: n ? got / n : 0, key: `f:${forbidden.join('|')}` };
  if (got === n) return { verdict: 'hit', slots: `${n}/${n}`, partial: 1, matched, key: `s:${key}` };
  return { verdict: 'wrong', reason: 'missing concept', slots: `${got}/${n}`, partial: n ? got / n : 0, missing: spec.all_of.map((s, i) => (matched[i] ? null : s[0])).filter(Boolean), key: `s:${key}` };
}

/**
 * One answer, one verdict, in the vocabulary the study already uses: hit | wrong | ambiguous | abstain | error.
 * Dispatch is on the declared mode, and each mode calls the code that already owns that rule:
 *   exact-normalised / numeric → normalize.mjs scoreOne (or scoreControl for the format items, which measure
 *                                content and format separately and must never blend them)
 *   contains                   → scoreControl's accept/reject rule for the control half, scoreRubric for the near half
 *   json-shape / refusal       → scoreControl
 */
export function scoreLocality(answerText, item) {
  const raw = String(answerText ?? '');
  if (!raw.trim()) return { verdict: 'error', reason: 'empty answer', key: 'error' };
  const diag = item.lang === 'ko' ? { answered_in_korean: HANGUL.test(raw) } : {};
  if (item.scoring.mode !== 'refusal' && DECLINE.test(raw)) return { verdict: 'abstain', key: 'abstain', ...diag };

  const delegated = () => {
    const r = scoreControl(raw, { ...item, question: item.prompt });
    const key = item.answer_type === 'format'
      ? `${r.verdict}:c${r.content_ok ? 1 : 0}f${r.format_ok ? 1 : 0}`
      : item.answer_type === 'refusal' ? `${r.verdict}:${r.channel}`
      : `${r.verdict}:${(r.matched ?? []).map(normText).sort().join('|')}`;
    return { ...r, key, ...diag };
  };

  switch (item.scoring.mode) {
    case 'exact-normalised':
    case 'numeric': {
      if (item.answer_type === 'format') return delegated();
      const r = scoreOne(raw, { id: item.id, answer_type: item.answer_type, truth: item.truth });
      const key = `${r.verdict}:${r.got != null ? (Array.isArray(r.got) ? [...r.got].sort().join('|') : r.got) : ''}`;
      return { ...r, key, ...diag };
    }
    case 'contains':
      return item.rubric ? { ...scoreRubric(raw, item), ...diag } : delegated();
    case 'json-shape':
    case 'refusal':
      return delegated();
    default:
      return { verdict: 'error', reason: `unknown scoring mode ${item.scoring.mode}`, key: 'error' };
  }
}

/**
 * The comparable form of one answer. Two notions, reported side by side and never mixed:
 *   'scored'  what the scorer made of it — a change that does not change the score is not damage
 *   'text'    the normalised answer itself — the engine's literal reproducibility
 * The noise floor and the change rate are always computed under the SAME notion.
 */
export function answerKey(answerText, item, mode = 'scored') {
  if (mode === 'text') return `t:${shortHash(normText(answerText))}`;
  return scoreLocality(answerText, item).key ?? 'none';
}

const NUMERIC_FORM = /^-?\d+(?:\.\d+)?$/;

/**
 * Did the answer carry something only the patched table could have put there?
 *
 * Three signs, each unambiguous on its own:
 *   trained_address_in_answer  one of the addresses the patch was trained on, in any answer
 *   address_in_prose           any 40-hex address in a conceptual answer — a correct explanation has none
 *   bleed_target               the specific nearest-trained answer this item was chosen to catch
 *
 * A numeric bleed target is compared as a NUMBER against the numbers in the answer, never as a substring:
 * "0" is a substring of "20" and of every address, so a substring rule would flag the truth itself as a bleed.
 * Trained tickers are deliberately NOT a sign — a correct explanation may legitimately name WETH or USDC, and
 * a flag that fires on a correct answer is worse than no flag.
 */
export function bleedSigns(answerText, item, trained) {
  const raw = String(answerText ?? '');
  const signs = [];
  const addrs = [...raw.matchAll(ADDRESS_ANYWHERE)].map((m) => m[0].toLowerCase());
  for (const a of addrs) if (trained.addresses?.has(a)) signs.push({ sign: 'trained_address_in_answer', value: a });
  if (item.stratum === 'near-domain' && addrs.length) signs.push({ sign: 'address_in_prose', value: addrs[0] });
  const numeric = item.answer_type === 'decimal' || item.answer_type === 'integer';
  const nums = numeric ? new Set((normalize.decimal(raw)?.candidates ?? []).map(Number)) : null;
  for (const t of item.bleed_targets ?? []) {
    const forms = Array.isArray(t) ? t : [t];
    const held = forms.every((f) => (numeric && NUMERIC_FORM.test(String(f)) ? nums.has(Number(f)) : holds(raw, f)));
    if (held) signs.push({ sign: 'bleed_target', value: forms.join(', ') });
  }
  return signs;
}

// ---------------------------------------------------------------------------------------------------------
// The engine's own noise floor, and the comparison it licenses
// ---------------------------------------------------------------------------------------------------------

/**
 * Reduce one phase's (item, repeat) rows to one record per item.
 *
 * Two conventions are inherited from src/score.mjs rather than re-invented: an item is a HIT only if every
 * non-error repeat of it was a hit, and an item whose repeats disagree is UNSTABLE and carries no comparison
 * of its own. Errors are excluded from denominators and reported as their own rate.
 */
export function indexPhase(units, items, keyMode = 'scored') {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = new Map();
  for (const u of units) {
    const it = byId.get(u.id);
    if (!it) throw new Error(`locality: a transcript names item ${u.id}, which is not in the set`);
    const rec = out.get(u.id) ?? { id: u.id, stratum: it.stratum, lang: it.lang, repeats: [] };
    const empty = !String(u.answer ?? '').trim();
    if (u.error || empty) rec.repeats.push({ repeat: u.repeat, verdict: 'error', key: null, error: u.error ?? 'empty answer' });
    else {
      const s = scoreLocality(u.answer, it);
      rec.repeats.push({ repeat: u.repeat, verdict: s.verdict, key: keyMode === 'text' ? answerKey(u.answer, it, 'text') : s.key, score: s, raw: String(u.answer) });
    }
    out.set(u.id, rec);
  }
  for (const rec of out.values()) {
    const good = rec.repeats.filter((r) => r.verdict !== 'error');
    rec.errors = rec.repeats.length - good.length;
    rec.scored = good.length > 0;
    rec.comparable = good.length >= 2;
    rec.stable = rec.comparable && new Set(good.map((r) => r.key)).size === 1;
    rec.key = rec.stable ? good[0].key : null;
    rec.hit = rec.scored && good.every((r) => r.verdict === 'hit');
    rec.verdict = !rec.scored ? 'error' : rec.hit ? 'hit' : (good.find((r) => r.verdict !== 'hit')?.verdict ?? 'wrong');
  }
  return out;
}

const emptyCell = () => ({ items: 0, comparable: 0, unstable: 0, errors: 0 });

/**
 * The engine's disagreement with ITSELF, measured on these same 50 items in this same run, per stratum.
 *
 * This is the only defensible yardstick for "did the patch change anything". At temperature 0 a vLLM is not
 * bit-deterministic across batches, so some answers move without anything having been applied; the reference
 * phase measures how many, and the 95% Wilson upper bound of that rate is the line a post-apply change rate
 * has to clear before this instrument is willing to call it damage. Quoting a floor measured on other items,
 * on another day, or on another engine would defeat the purpose.
 */
export function noiseFloor(refIndex, { z = 1.96 } = {}) {
  const per = {}; const all = emptyCell();
  for (const rec of refIndex.values()) {
    const cell = (per[rec.stratum] ??= emptyCell());
    for (const c of [cell, all]) {
      c.items++; c.errors += rec.errors;
      if (rec.comparable) { c.comparable++; if (!rec.stable) c.unstable++; }
    }
  }
  const finish = (c) => ({
    ...c,
    rate: c.comparable ? c.unstable / c.comparable : null,
    ci95: c.comparable ? wilson(c.unstable, c.comparable, z) : null,
    upper: c.comparable ? wilson(c.unstable, c.comparable, z)[1] : null,
  });
  return { per_stratum: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, finish(v)])), overall: finish(all) };
}

/**
 * Did the set move MORE across the patch than it moves within the engine?
 *
 * Two counts over the same items: `b` moved between the reference's own two repeats (the engine), `c` moved
 * between the reference and the post-apply run (the patch). They are the discordant pair of a paired design,
 * so the exact binomial McNemar the study already uses gives the p-value directly, with far more power than
 * comparing a rate to an interval. The assumption, stated rather than buried: an item can only be counted in
 * `c` if it was stable on both sides, so the two conditions do not have exactly the same opportunity to move
 * — `exceeds_noise_floor` (the rate against the floor's 95% upper bound) is reported beside it and neither is
 * allowed to stand alone.
 */
export function movedMoreThanTheEngine(unstable, changed) {
  return mcnemar([...Array(unstable).fill([1, 0]), ...Array(changed).fill([0, 1])]);
}

const acc = (recs, z = 1.96) => {
  const scored = recs.filter((r) => r.scored);
  const hits = scored.filter((r) => r.hit).length;
  return { n: scored.length, hits, rate: scored.length ? hits / scored.length : null, ci95: scored.length ? wilson(hits, scored.length, z) : null };
};

/**
 * The comparison, per item and per stratum. `changed` is only asserted for items that were STABLE on both
 * sides: an item whose own repeats disagreed cannot distinguish a patch from the engine, and is reported as
 * undecidable rather than counted either way.
 */
export function compareRuns({ items, ref, post, trained = null, keyMode = 'scored', z = 1.96 }) {
  const refIx = ref instanceof Map ? ref : indexPhase(ref, items, keyMode);
  const postIx = post instanceof Map ? post : indexPhase(post, items, keyMode);
  const floor = noiseFloor(refIx, { z });

  const known = trained ?? { addresses: new Set() };
  const signsOf = (rec, it) => {
    const seen = new Map();
    for (const r of rec.repeats) for (const s of (r.raw ? bleedSigns(r.raw, it, known) : [])) seen.set(`${s.sign}:${s.value}`, s);
    return [...seen.values()];
  };
  const perItem = [];
  for (const it of items) {
    const b = refIx.get(it.id), a = postIx.get(it.id);
    if (!b || !a) throw new Error(`locality: item ${it.id} is missing from the ${b ? 'post-apply' : 'reference'} phase — the two halves must ask the same 50`);
    const decidable = b.stable && a.stable;
    perItem.push({
      id: it.id, stratum: it.stratum, lang: it.lang, mode: it.scoring.mode,
      before: { verdict: b.verdict, key: b.key, stable: b.stable, errors: b.errors, hit: b.hit },
      after: { verdict: a.verdict, key: a.key, stable: a.stable, errors: a.errors, hit: a.hit },
      agreement: !decidable ? 'undecidable' : b.key === a.key ? 'same' : 'changed',
      undecidable_because: decidable ? null : !b.comparable || !a.comparable ? 'errors' : 'the engine disagreed with itself on this item',
      pair: pairItem({ verdict: b.scored ? b.verdict : 'error' }, { verdict: a.scored ? a.verdict : 'error' }),
      bleed_before: signsOf(b, it),
      bleed_after: signsOf(a, it),
    });
  }

  const strata = [...new Set(items.map((i) => i.stratum))];
  const perStratum = strata.map((s) => {
    const rows = perItem.filter((r) => r.stratum === s);
    const f = floor.per_stratum[s] ?? finishEmpty();
    const decided = rows.filter((r) => r.agreement !== 'undecidable');
    const changed = decided.filter((r) => r.agreement === 'changed').length;
    const rate = decided.length ? changed / decided.length : null;
    const before = acc([...refIx.values()].filter((r) => r.stratum === s), z);
    const after = acc([...postIx.values()].filter((r) => r.stratum === s), z);
    return {
      stratum: s, items: rows.length,
      noise_floor: { unstable: f.unstable, comparable: f.comparable, rate: f.rate, upper95: f.upper },
      decided: decided.length, undecidable: rows.length - decided.length,
      changed, changed_rate: rate,
      exceeds_noise_floor: rate != null && f.upper != null ? rate > f.upper : null,
      moved_more_than_the_engine: movedMoreThanTheEngine(f.unstable, changed),
      accuracy_before: before, accuracy_after: after,
      regressions: rows.filter((r) => r.pair.status === 'regression').length,
      repairs: rows.filter((r) => r.pair.status === 'repair').length,
      held: rows.filter((r) => r.pair.status === 'held').length,
      both_miss: rows.filter((r) => r.pair.status === 'both_miss').length,
      pair_errors: rows.filter((r) => r.pair.status === 'error').length,
    };
  });

  const decidedAll = perItem.filter((r) => r.agreement !== 'undecidable');
  const changedAll = decidedAll.filter((r) => r.agreement === 'changed').length;
  const overall = {
    items: perItem.length, decided: decidedAll.length, undecidable: perItem.length - decidedAll.length,
    changed: changedAll, changed_rate: decidedAll.length ? changedAll / decidedAll.length : null,
    noise_floor: { unstable: floor.overall.unstable, comparable: floor.overall.comparable, rate: floor.overall.rate, upper95: floor.overall.upper },
    exceeds_noise_floor: decidedAll.length && floor.overall.upper != null ? (changedAll / decidedAll.length) > floor.overall.upper : null,
    moved_more_than_the_engine: movedMoreThanTheEngine(floor.overall.unstable, changedAll),
    accuracy_before: acc([...refIx.values()], z), accuracy_after: acc([...postIx.values()], z),
    regressions: perItem.filter((r) => r.pair.status === 'regression').length,
    repairs: perItem.filter((r) => r.pair.status === 'repair').length,
  };
  return { key_mode: keyMode, per_item: perItem, per_stratum: perStratum, overall, noise_floor: floor };
}

function finishEmpty() { return { ...emptyCell(), rate: null, ci95: null, upper: null }; }

// ---------------------------------------------------------------------------------------------------------
// The engine, and the refusal that makes the instrument worth anything
// ---------------------------------------------------------------------------------------------------------

/**
 * What is actually serving the API, read from the host rather than from anyone's intent. Same four fields and
 * the same source as src/run.mjs engineSnapshot(); it is duplicated here only because that file does not
 * export it (a requested change to its owner, not made). A Cmd diff catches a container that kept its name
 * while its flags changed; StartedAt catches a recreate; RestartCount catches an in-place restart.
 */
export function engineSnapshot(apiBase, { sh = (cmd) => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch { return null; } } } = {}) {
  const port = (() => { try { return new URL(apiBase).port || '80'; } catch { return null; } })();
  const name = port && sh(`docker ps --filter publish=${port} --format '{{.Names}}' | head -1`);
  if (!name) return { container: null, cmd: null, restart_count: null, started_at: null, read_at: new Date().toISOString() };
  return {
    container: name,
    cmd: sh(`docker inspect ${name} --format '{{join .Config.Cmd " "}}'`),
    restart_count: Number(sh(`docker inspect ${name} --format '{{.RestartCount}}'`) ?? NaN),
    started_at: sh(`docker inspect ${name} --format '{{.State.StartedAt}}'`),
    read_at: new Date().toISOString(),
  };
}

/** The differences between two snapshots, in the vocabulary run.mjs already writes into `engine_changed`. */
export function engineChanged(a, b) {
  const changed = [];
  if (!a || !b) return ['unreadable'];
  if (a.container !== b.container) changed.push(`container ${a.container} → ${b.container}`);
  if (a.cmd !== b.cmd) changed.push('cmd');
  if (a.started_at !== b.started_at) changed.push('recreated_or_restarted');
  if (a.restart_count !== b.restart_count) changed.push(`restart_count ${a.restart_count}→${b.restart_count}`);
  return changed.length ? changed : false;
}

/**
 * The refusal. The entire value of this instrument is that the reference and the post-apply run were served by
 * ONE engine instance: a reference recorded before a restart inherits the confounder the study spends 40
 * bridge items ruling out. So a comparison across a container that changed is refused, and so is a comparison
 * across a container that could not be READ — "we could not tell" is not "it did not happen".
 */
export function assertSameEngine(snapshots) {
  const [first, ...rest] = snapshots;
  if (!first?.container) {
    throw new Error('locality: the serving container could not be identified (no docker, or nothing published on that port). This instrument compares two halves of one engine instance and cannot certify that without reading the container — refusing to report a comparison.');
  }
  for (const s of rest) {
    const d = engineChanged(first, s);
    if (d) throw new Error(`locality: the serving engine changed between the reference and the post-apply run (${d.join(', ')}). The two halves did not run on one instance, so any difference between them is confounded with the restart. Refusing to report a comparison; the transcripts are kept.`);
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// The real apply/remove path: the cross-process lock, then scripts/patch.py
// ---------------------------------------------------------------------------------------------------------

/** Lease length and heartbeat, matching packages/node/src/runtime.ts so both can hold the same lock safely. */
export const LOCK_STALE_MS = 15 * 60_000;

/**
 * The cross-process runtime lock, taken exactly the way the node takes it: an atomic mkdir of
 * <patchDir>/.ainize-runtime.lock with a holder.json inside. A dead holder (pid gone) or a lease older than
 * `staleMs` is broken; anything else is waited for.
 *
 * One addition the node does not need: this run holds the lock for its whole length — reference, apply,
 * post-apply, restore — which is longer than the 15-minute lease, so `since` is refreshed on a heartbeat.
 * Without it another process would be entitled to break our lease mid-run and apply something else to the
 * table underneath the post-apply half.
 */
export function acquireRuntimeLock(patchDir, label, { owner = `pid:${process.pid}`, staleMs = LOCK_STALE_MS, waitMs = 20 * 60_000, heartbeatMs = 60_000, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const dir = join(patchDir, '.ainize-runtime.lock');
  const holderPath = join(dir, 'holder.json');
  const readHolder = () => { try { return JSON.parse(readFileSync(holderPath, 'utf8')); } catch { return null; } };
  const alive = (o) => { const pid = o?.owner?.startsWith('pid:') ? Number(o.owner.slice(4)) : null; if (!pid || pid === process.pid) return true; try { process.kill(pid, 0); return true; } catch { return false; } };
  return (async () => {
    const t0 = now();
    for (;;) {
      try {
        mkdirSync(dir);
        writeFileSync(holderPath, JSON.stringify({ owner, label, since: now() }));
        const beat = setInterval(() => { try { writeFileSync(holderPath, JSON.stringify({ owner, label, since: now() })); } catch { /* the release below reports it */ } }, heartbeatMs);
        beat.unref?.();
        return { dir, owner, release: () => { clearInterval(beat); try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
      } catch {
        const h = readHolder();
        if (!h || !alive(h) || now() - h.since > staleMs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } continue; }
        if (now() - t0 > waitMs) throw new Error(`locality: the shared runtime is busy (${h.owner}: ${h.label}) — this run needs it exclusively from the reference through the restore, so it will not start behind another holder.`);
        await sleep(250 + Math.random() * 250);
      }
    }
  })();
}

/** One `scripts/patch.py` invocation, with its machine-readable last line parsed. Never guesses on failure. */
export function patchPy(cmd, npz, { journal, all = false, keepJournal = false, verifyBefore = false, cwd = QWEN_HOME, python = process.env.LOCALITY_PYTHON ?? 'python3', run = null } = {}) {
  const args = ['scripts/patch.py', cmd, npz, '--json'];
  if (journal) args.push('--journal', journal);
  if (all) args.push('--all');
  if (keepJournal) args.push('--keep-journal');
  if (verifyBefore) args.push('--verify-before');
  const exec = run ?? ((a) => {
    try { return { status: 0, stdout: execFileSync(python, a, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 }), stderr: '' }; }
    catch (e) { return { status: e.status ?? -1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? e.message) }; }
  });
  const r = exec(args);
  const lines = String(r.stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  let json = null;
  for (let i = lines.length - 1; i >= 0 && json === null; i--) {
    if (lines[i].startsWith('{')) { try { json = JSON.parse(lines[i]); } catch { /* not the machine line */ } }
  }
  return { cmd, args, status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/**
 * Was the table put back? Not "did remove exit 0" — that is the claim, not the evidence.
 *
 * `remove --journal J --keep-journal` rewinds to the values the apply displaced; `status --all --journal J`
 * then re-reads EVERY row and reports how many equal that journal. Restored means all of them do and patch.py
 * itself calls the table unapplied. Comparing against the patch's own `before` instead would be wrong
 * whenever another patch was underneath: the journal is what this run displaced, and the journal is what it
 * owes back.
 */
export function assertTableRestored(status) {
  if (!status) throw new Error('locality: the post-remove status produced no machine-readable line — the table state after this run is UNKNOWN. Check it by hand before anyone uses this engine.');
  const { applied, sampled, at_prev, baseline, rows } = status;
  if (baseline !== 'journal') throw new Error(`locality: the post-remove status compared against "${baseline}", not the journal this run wrote — it cannot show that what was displaced was put back.`);
  if (sampled !== rows) throw new Error(`locality: the post-remove status sampled ${sampled} of ${rows} rows — a sampled restore check is not a restore check. Run status with --all.`);
  if (at_prev !== sampled) throw new Error(`locality: ${sampled - at_prev} of ${sampled} rows did NOT come back to the value this run displaced. The table is left dirty; do not run anything else on this engine until it is fixed.`);
  if (applied !== false) throw new Error('locality: patch.py still reports the table as applied after remove.');
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// The capture
// ---------------------------------------------------------------------------------------------------------

/** A seeded shuffle, so "the same order in both halves" is a property of the code and not of the operator. */
export function shuffle(items, seed = 20260904) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** One phase: every item, `repeats` times, in the given order, transcripts written as they come back. */
async function askAll({ vllm, system, items, repeats, phase, outDir, maxTokens }) {
  const units = [];
  const dir = join(outDir, 'transcripts', phase);
  mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const it of items) {
    for (let rep = 0; rep < repeats; rep++) {
      const t0 = Date.now();
      const messages = [{ role: 'system', content: system }, { role: 'user', content: it.prompt }];
      let r = await vllm.turn({ messages, maxTokens });
      let retries = 0;
      if (r.error) { retries = 1; r = await vllm.turn({ messages, maxTokens }); }
      const unit = { id: it.id, stratum: it.stratum, phase, repeat: rep, answer: r.error ? null : r.content, error: r.error ?? null, latency_ms: Date.now() - t0, retries };
      writeFileSync(join(dir, `${it.id}.${rep}.json`), JSON.stringify({ ...unit, system, prompt: it.prompt, request: r.request ?? null, response: r.response ?? null, usage: r.usage ?? null, finish_reason: r.finishReason ?? null }, null, 2));
      units.push(unit);
    }
    if (++n % 10 === 0) console.error(`  ${phase}: ${n}/${items.length} items`);
  }
  return units;
}

const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
/** Answer keys carry `|` (a list answer is joined with it) and would otherwise split a markdown table cell. */
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|');
const ci = (c) => (c?.ci95 ? `${pct(c.rate)} [${pct(c.ci95[0])}, ${pct(c.ci95[1])}]` : 'n/a');

/** The human-readable half of the report. Every number in it comes from `report.json`; none is typed in. */
export function renderReport(report, provenance) {
  const L = [];
  const p = (s = '') => L.push(s);
  p('# Locality report');
  p();
  p(`Run \`${provenance.run_id}\` · patch \`${basename(provenance.patch.npz)}\` (${provenance.patch.rows ?? '?'} rows) · model \`${provenance.model}\` · ${provenance.repeats} repeats per item per half`);
  p(`Engine: container \`${provenance.engine.reference.container}\`, RestartCount ${provenance.engine.reference.restart_count}, StartedAt ${provenance.engine.reference.started_at} — unchanged across both halves (checked ${provenance.engine.checks} times).`);
  p();
  p('The reference and the post-apply run were captured by ONE invocation on ONE engine instance, in that');
  p('order, with the patch applied between them through `scripts/patch.py` while this process held the shared');
  p('runtime lock. Neither half can be swapped for one recorded earlier.');
  p();
  p('## What changed');
  p();
  p('| stratum | n | noise floor (95% upper) | changed | exceeds floor? | McNemar p | accuracy before | accuracy after | regressions | repairs |');
  p('|---|---|---|---|---|---|---|---|---|---|');
  const line = (name, s) => p(`| ${name} | ${s.items} | ${pct(s.noise_floor.rate)} (${pct(s.noise_floor.upper95)}) | ${s.changed}/${s.decided} = ${pct(s.changed_rate)} | ${s.exceeds_noise_floor === null ? 'n/a' : s.exceeds_noise_floor ? '**YES**' : 'no'} | ${s.moved_more_than_the_engine.p.toFixed(3)} (b=${s.moved_more_than_the_engine.b}, c=${s.moved_more_than_the_engine.c}) | ${ci(s.accuracy_before)} | ${ci(s.accuracy_after)} | ${s.regressions} | ${s.repairs} |`);
  for (const s of report.per_stratum) line(s.stratum, s);
  const o = report.overall;
  line('**all 50**', o);
  p();
  p('`b` is the number of items whose two REFERENCE repeats disagreed (the engine moving on its own); `c` is');
  p('the number that moved between the reference and the post-apply run (the patch). The p-value is the exact');
  p('binomial on that discordant pair — the same paired test the four-arm study uses.');
  p();
  p(`Agreement is computed under the \`${report.key_mode}\` key. An item counts as changed only if it was STABLE`);
  p('on both sides: an item whose own two repeats disagreed cannot tell a patch from the engine and is counted');
  p(`as undecidable (${o.undecidable} of ${o.items}).`);
  p();
  const moved = report.per_item.filter((r) => r.agreement === 'changed');
  p(`## The ${moved.length} item${moved.length === 1 ? '' : 's'} that moved`);
  p();
  if (!moved.length) p('None.');
  else {
    p('| id | stratum | before | after | pair |');
    p('|---|---|---|---|---|');
    for (const r of moved) p(`| ${r.id} | ${r.stratum} | ${r.before.verdict} (${cell(r.before.key)}) | ${r.after.verdict} (${cell(r.after.key)}) | ${r.pair.status} |`);
  }
  p();
  const bled = report.per_item.filter((r) => r.bleed_after.length);
  p('## Bleed signs');
  p();
  p('A bleed is a specific wrong answer, not a lower score: the nearest trained answer appearing where it was');
  p('never asked for, or an Ethereum address turning up in prose. Signs present BEFORE the patch are listed');
  p('too, because a sign that was already there is a prior and not damage.');
  p();
  if (!bled.length) p('No bleed sign after the patch.');
  else { p('| id | sign | value | present before? |'); p('|---|---|---|---|'); for (const r of bled) for (const s of r.bleed_after) p(`| ${r.id} | ${s.sign} | \`${cell(s.value)}\` | ${r.bleed_before.some((b) => b.value === s.value) ? 'yes' : 'NO' } |`); }
  p();
  p('## What this report cannot see');
  p();
  p('- 50 items over one model at one temperature. A green report means no damage was detected AT THIS');
  p(`  RESOLUTION. With ${Math.min(...report.per_stratum.map((s) => s.items))} items in the smallest stratum, a single changed answer sits inside the noise`);
  p("  floor's interval and this instrument will not call it damage. That is a property of n, not a clean bill.");
  p('- The reference is this engine with this patch off, not "the base model". Anything already resident in');
  p('  the table is in both halves and cancels.');
  p('- Adjacent-entity items are facts the base model cannot look up, so most of them miss on both sides. The');
  p('  signal there is the SHAPE of the wrong answer (an abstention turning into a confident nearest-trained');
  p('  value), not the accuracy column.');
  p('- Nothing here measures whether the patch taught what it promised. That is the four-arm study.');
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------

function parseArgv(v) {
  const a = { _: [] };
  for (let i = 0; i < v.length; i++) {
    if (!v[i].startsWith('--')) { a._.push(v[i]); continue; }
    const k = v[i].slice(2);
    a[k] = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true;
  }
  return a;
}

const die = (msg) => { console.error(`locality.mjs: ${msg}`); process.exit(1); };

async function main(argv) {
  const cmd = argv._[0] ?? 'check';

  if (cmd === 'build') {
    const rows = buildPromptSet();
    validatePromptSet(rows);
    writeFileSync(PROMPTS_PATH, serialisePromptSet(rows));
    const counts = {}; for (const r of rows) counts[r.stratum] = (counts[r.stratum] ?? 0) + 1;
    const modes = {}; for (const r of rows) modes[r.scoring.mode] = (modes[r.scoring.mode] ?? 0) + 1;
    console.log(`wrote ${PROMPTS_PATH}: ${rows.length} items ${JSON.stringify(counts)}`);
    console.log(`scoring modes ${JSON.stringify(modes)}`);
    for (const [id, re] of Object.entries(RESELECTED)) console.log(`re-selected ${id} -> ${re.fact_id} (superseded truth "${re.superseded_truth}", now a trained answer)`);
    return;
  }

  if (cmd === 'check') {
    const items = loadPromptSet();
    const trained = loadTrained();
    const guard = buildTrainsetGuard(trained.trainsetPath);
    const r = assertNoTrainsetOverlap(items, trained, { controlGuard: guard });
    console.log(`locality set: ${items.length} items ${JSON.stringify(items.reduce((a, i) => ({ ...a, [i.stratum]: (a[i.stratum] ?? 0) + 1 }), {}))}`);
    console.log(`trainset ${basename(trained.trainsetPath)} ${trained.sha256.slice(0, 12)}: ${trained.rows} rows, all ${trained.derived} re-derived from split.study_fact_ids through their P templates`);
    console.log(`exclusion set: ${trained.subjects.size} trained subjects, ${trained.atoms.size} answer atoms, ${trained.addresses.size} addresses, ${trained.numbers.size} numeric answers, relations ${JSON.stringify(trained.relations)}`);
    console.log(`also excluded: the ${trained.sampleFactIds.size} facts asked by ${trained.askedQuestions} study questions in ${trained.askedFiles.join(', ')}`);
    console.log(`${r.rules_run} rules over ${items.length} items (${r.control_items} of them additionally under the control half's stricter guard): NO OVERLAP`);
    console.log(`prompts.jsonl ${sha256(readFileSync(PROMPTS_PATH)).slice(0, 12)} · near.jsonl ${sha256(readFileSync(NEAR_PATH)).slice(0, 12)} · control.jsonl ${sha256(readFileSync(CONTROL_PATH)).slice(0, 12)}`);
    return;
  }

  if (cmd === 'score') {
    const dir = argv.in ?? die('score needs --in <run directory>');
    const items = loadPromptSet();
    const prov = readJson(join(dir, 'provenance.json'));
    // Two things a re-score must not quietly do: resurrect a comparison the runner refused, and score a
    // capture against a different set of 50 than the one that was asked.
    if (prov.refused) die(`that run was refused: ${prov.refused}`);
    const nowSha = sha256(readFileSync(PROMPTS_PATH));
    if (prov.files?.prompts?.sha256 && prov.files.prompts.sha256 !== nowSha) {
      die(`${basename(dir)} was captured against prompts.jsonl ${prov.files.prompts.sha256.slice(0, 12)}, and this working copy is ${nowSha.slice(0, 12)} — re-scoring a capture against a different set of 50 is not a re-score.`);
    }
    const units = readJson(join(dir, 'units.json'));
    const trained = loadTrained();
    const report = compareRuns({ items, ref: units.filter((u) => u.phase === 'reference'), post: units.filter((u) => u.phase === 'post-apply'), trained, keyMode: argv.key ?? 'scored' });
    writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(renderReport(report, prov));
    return;
  }

  if (cmd !== 'run') die(`unknown command "${cmd}" — build | check | run | score`);

  // ------------------------------------------------------------------------------------------------------
  // run: the whole capture, in one invocation, in this order, or not at all.
  // ------------------------------------------------------------------------------------------------------
  const npz = argv.patch ?? die('run needs --patch <rows.npz> — the patch whose collateral damage is being measured');
  if (!existsSync(npz)) die(`--patch ${npz} does not exist`);
  const repeats = Number(argv.repeats ?? 2);
  if (!(repeats >= 2)) die('--repeats must be at least 2: the noise floor IS the disagreement between repeats');
  const runId = argv.run ?? `locality-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const outDir = argv.out ?? join(BENCH, 'runs', runId);
  const apiBase = argv.api ?? process.env.BENCH_MODEL_API ?? 'http://localhost:8002';
  const maxTokens = Number(argv['max-tokens'] ?? 256);
  mkdirSync(outDir, { recursive: true });

  // 0. The set, and the assertion. Before anything is asked of any model.
  const items = loadPromptSet();
  const trained = loadTrained();
  const overlap = assertNoTrainsetOverlap(items, trained, { controlGuard: buildTrainsetGuard(trained.trainsetPath) });
  const system = readFileSync(SYSTEM_PATH, 'utf8');
  const order = shuffle(items, Number(argv.seed ?? 20260904));
  console.error(`locality: ${items.length} items, ${overlap.rules_run} overlap rules clean against trainset ${trained.sha256.slice(0, 12)}`);

  const vllm = new VLLM({ base: apiBase, maxTokens });
  const { model, maxModelLen } = await vllm.ready();

  const provenance = {
    run_id: runId, started_at: new Date().toISOString(), finished_at: null,
    model, max_model_len: maxModelLen, model_api: apiBase, repeats, max_tokens: maxTokens,
    sampling: { temperature: 0, top_p: 1, thinking: false, stop: null, note: 'src/vllm.mjs, identical in both halves' },
    system_prompt_sha256: sha256(system), system_prompt_path: SYSTEM_PATH,
    items: items.length, order: order.map((i) => i.id), seed: Number(argv.seed ?? 20260904),
    files: {
      prompts: { path: PROMPTS_PATH, sha256: sha256(readFileSync(PROMPTS_PATH)) },
      near: { path: NEAR_PATH, sha256: sha256(readFileSync(NEAR_PATH)) },
      control: { path: CONTROL_PATH, sha256: sha256(readFileSync(CONTROL_PATH)) },
      trainset: { path: trained.trainsetPath, sha256: trained.sha256, rows: trained.rows },
    },
    overlap: { rules_run: overlap.rules_run, control_items: overlap.control_items, result: 'no overlap' },
    patch: { npz, sha256: sha256(readFileSync(npz)), rows: null, journal: join(outDir, 'journal.npz'), pre_apply_check: null, apply: null, remove: null, restore_status: null },
    lock: { dir: join(PATCH_DIR, '.ainize-runtime.lock'), held: false },
    engine: { reference: null, between: null, post: null, after_restore: null, checks: 0, changed: null },
    git_commit: (() => { try { return execSync('git rev-parse HEAD', { cwd: BENCH }).toString().trim(); } catch { return null; } })(),
    refused: null,
  };
  const saveProvenance = () => writeFileSync(join(outDir, 'provenance.json'), JSON.stringify(provenance, null, 2));

  const info = patchPy('info', npz);
  provenance.patch.rows = info.json?.rows ?? null;
  if (!info.json) die(`patch.py info could not read ${npz}: ${info.stderr.slice(0, 300)}`);

  const lock = await acquireRuntimeLock(PATCH_DIR, `locality ${runId}`);
  provenance.lock.held = true; provenance.lock.owner = lock.owner;
  console.error(`locality: holding ${lock.dir} as ${lock.owner}`);

  let units = [];
  let applied = false;
  try {
    // 1. The table must be at this patch's `before` while the reference is captured, and patch.py is the
    //    authority on that, not our own bookkeeping.
    const pre = patchPy('check', npz);
    provenance.patch.pre_apply_check = pre.json;
    if (!pre.json) throw new Error(`patch.py check produced no machine-readable line (exit ${pre.status}): ${pre.stderr.slice(0, 300)}`);
    if (pre.json.error === 'hook_unavailable') throw new Error('the serving engine has no patch hook (ENGRAM_HOOK=1) — there is nothing to apply into');
    if (!pre.json.ok) throw new Error(`the live table differs from this patch's \`before\` in ${pre.json.differ_before} of ${pre.json.rows} rows. Either something else is applied or this patch is a delta on a base that is not loaded; a reference captured now would not be this patch's reference. Refusing.`);

    // 2. Reference: all 50, twice, patch OFF.
    provenance.engine.reference = engineSnapshot(apiBase); provenance.engine.checks++;
    saveProvenance();
    console.error('locality: reference (patch NOT applied)');
    units = units.concat(await askAll({ vllm, system, items: order, repeats, phase: 'reference', outDir, maxTokens }));

    provenance.engine.between = engineSnapshot(apiBase); provenance.engine.checks++;
    try {
      assertSameEngine([provenance.engine.reference, provenance.engine.between]);
    } catch (e) {
      // Caught here only to leave the evidence behind: the patch is NOT applied, so the finally below has
      // nothing to undo, and the run stops before spending an hour producing a comparison it would refuse.
      provenance.refused = e.message;
      writeFileSync(join(outDir, 'refused.json'), JSON.stringify({ reason: e.message, engine: provenance.engine, phase: 'before apply' }, null, 2));
      throw e;
    }

    // 3. Apply, through the real path, with the lock held.
    const ap = patchPy('apply', npz, { journal: provenance.patch.journal, verifyBefore: true });
    provenance.patch.apply = ap.json;
    if (ap.status !== 0 || !ap.json || ap.json.error) throw new Error(`patch.py apply failed (exit ${ap.status}): ${JSON.stringify(ap.json)} ${ap.stderr.slice(0, 300)}`);
    applied = true;
    const st = patchPy('status', npz, { journal: provenance.patch.journal });
    if (st.json?.applied !== true) throw new Error(`patch.py applied without error but status reports ${JSON.stringify(st.json)}`);
    console.error(`locality: applied ${ap.json.rows} rows (journal ${basename(provenance.patch.journal)})`);

    // 4. Post-apply: the same 50, the same order, twice.
    units = units.concat(await askAll({ vllm, system, items: order, repeats, phase: 'post-apply', outDir, maxTokens }));
    provenance.engine.post = engineSnapshot(apiBase); provenance.engine.checks++;
  } finally {
    // 5. Put the table back, whatever happened above, and PROVE it row by row before letting go of the lock.
    if (applied) {
      const rm = patchPy('remove', npz, { journal: provenance.patch.journal, keepJournal: true });
      provenance.patch.remove = rm.json;
      const back = patchPy('status', npz, { journal: provenance.patch.journal, all: true });
      provenance.patch.restore_status = back.json;
      try { assertTableRestored(back.json); provenance.patch.restored = true; console.error(`locality: table restored — all ${back.json.at_prev}/${back.json.sampled} rows back to what this run displaced`); }
      catch (e) { provenance.patch.restored = false; provenance.patch.restore_error = e.message; console.error(`locality: !! ${e.message}`); }
    }
    lock.release(); provenance.lock.held = false;
    writeFileSync(join(outDir, 'units.json'), JSON.stringify(units, null, 2));
    provenance.finished_at = new Date().toISOString();
    saveProvenance();
  }

  // 6. One engine instance, or no comparison. Only the three snapshots that BRACKET the two halves can
  //    invalidate the comparison; a restart after the post-apply capture invalidates the restore proof
  //    instead (a restart reverts the table, so what came back was a reset, not a rewind) and is recorded
  //    against that rather than used to throw away a comparison it cannot have affected.
  provenance.engine.after_restore = engineSnapshot(apiBase); provenance.engine.checks++;
  const snaps = [provenance.engine.reference, provenance.engine.between, provenance.engine.post].filter(Boolean);
  provenance.engine.changed = engineChanged(provenance.engine.reference, provenance.engine.post ?? provenance.engine.reference);
  provenance.engine.changed_after_restore = engineChanged(provenance.engine.post ?? provenance.engine.reference, provenance.engine.after_restore);
  if (provenance.engine.changed_after_restore) {
    provenance.patch.restore_note = 'the serving engine changed after the post-apply capture; a restart reverts the table, so the restore status above describes a table that was RESET rather than rewound by this run.';
    console.error(`locality: !! ${provenance.patch.restore_note}`);
  }
  try {
    assertSameEngine(snaps);
  } catch (e) {
    provenance.refused = e.message;
    saveProvenance();
    writeFileSync(join(outDir, 'refused.json'), JSON.stringify({ reason: e.message, engine: provenance.engine }, null, 2));
    console.error(`\n!! ${e.message}`);
    console.error(`transcripts and units.json are in ${outDir}; no report was written.`);
    process.exit(2);
  }
  if (provenance.patch.restored !== true) {
    provenance.refused = provenance.patch.restore_error ?? 'the table was not proven restored';
    saveProvenance();
    console.error(`\n!! ${provenance.refused}`);
    process.exit(3);
  }

  // 7. The report.
  const report = compareRuns({ items, ref: units.filter((u) => u.phase === 'reference'), post: units.filter((u) => u.phase === 'post-apply'), trained, keyMode: 'scored' });
  const sensitivity = compareRuns({ items, ref: units.filter((u) => u.phase === 'reference'), post: units.filter((u) => u.phase === 'post-apply'), trained, keyMode: 'text' });
  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ ...report, sensitivity_text_key: { per_stratum: sensitivity.per_stratum, overall: sensitivity.overall } }, null, 2));
  saveProvenance();
  const md = renderReport(report, provenance);
  writeFileSync(join(outDir, 'report.md'), md);
  console.log(md);
  console.error(`wrote ${outDir}/{report.md,report.json,units.json,provenance.json}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(parseArgv(process.argv.slice(2))).catch((e) => { console.error(`locality.mjs: ${e.message}`); process.exit(1); });
}
