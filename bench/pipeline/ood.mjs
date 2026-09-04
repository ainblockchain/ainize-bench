/**
 * Step 4 — the OUT-OF-DOMAIN bucket: arm D's tail. Deterministic, offline, no key, no network, no model.
 *
 *   node pipeline/ood.mjs --run <runid> [--mirror <runid>-ood]
 *
 * Writes:
 *   data/<runid>/questions-fresh.jsonl   the bucket (schema.json rows, plus an `ood_tier` label)
 *   data/<runid>/ood-report.json         every count this file decided, including the ones that came out zero
 *   data/<mirror>/questions.jsonl        a byte-identical copy, so `src/run.mjs --run <mirror>` runs the bucket
 *   data/<mirror>/pull -> ../<runid>/pull   symlink, so the mirror carries the SAME committed provenance
 *
 * ---------------------------------------------------------------------------------------------------------
 * WHY THIS BUCKET EXISTS, AND WHY IT IS NOT IN README §1's SIZE TABLE
 *
 * README §"The claim under test" makes two claims, and §1's frozen 250-item table only evidences the first.
 * The second is claim 2: "D > C — the tool is not the competitor, it is the tail. The MCP covers what was
 * never compiled: facts newer than the patch, facts deliberately held out, anything outside the trained
 * domain." §1's tripwire bucket covers the middle third of that sentence. This file covers the other two.
 *
 * It is therefore an ADDITION to §1, declared here before any model has run, reported as its own bucket, and
 * never folded into the headline. §1's five buckets and their sizes are untouched: nothing in this file
 * reads, writes or re-samples questions.jsonl, split.json or trainset.jsonl.
 *
 * ---------------------------------------------------------------------------------------------------------
 * FOUR TIERS, ORDERED BY DISTANCE FROM THE 120 FACTS THE PATCH WAS BAKED FROM
 *
 *   fresh_new          the fact did not exist at B*. Movement-dependent, and therefore however big the chain
 *                      made it — see the honesty rule below.
 *   unseen_entity      trained relation, trained deployment, an entity that is in NO study fact.
 *   unseen_deployment  a deployment id no study fact came from at all.
 *   unseen_relation    a relation `pipeline/facts.mjs` never extracts, so it is in no fact, no pool row, no
 *                      study item and no training row — asked about entities the patch DID see under a
 *                      sibling relation, so the only unseen thing is the relation itself.
 *
 * In all four, arm C provably has no row: `data/<runid>/trainset.jsonl` is exactly the P form of the 120
 * facts in `split.study_fact_ids` and nothing else, and every tier's exclusion set is computed from those
 * files rather than asserted. Arm C is expected to degrade here and arm D to win; that is the point, and it
 * is published whether or not it comes out that way.
 *
 * THE HONESTY RULE FOR `fresh_new`. If nothing moved between the two pulls, this tier is EMPTY and the report
 * says "0 facts moved between block X and block Y" — it is never topped up from another tier to reach a round
 * number, and no fact is invented to give arm D a tail. That is also why the other three tiers exist: they do
 * not depend on the chain having been kind enough to move during a thirty-minute window.
 *
 * WHAT IS DELIBERATELY *NOT* FILTERED. An out-of-domain truth is not rejected for containing a token the
 * trainset also teaches (`WETH` is in 
 * dozens of pools). Filtering those out would remove exactly the items arm
 * C might get right by accident, which flatters our own thesis. They are kept and FLAGGED
 * (`answer_atom_in_trainset`), so a reader can cut the bucket either way from the committed rows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { extract, movedSince } from './facts.mjs';
import { itemsForFact } from './questions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.AINIZE_BENCH_DATA ? path.resolve(process.env.AINIZE_BENCH_DATA) : path.resolve(HERE, '..');

/**
 * A salt of its own. The study's seed decides the 250 and the 120; re-using it here would make this bucket a
 * function of the same draw and invite the question of whether one was tuned against the other.
 */
const SEED = 'ainize-graph-bench-ood-v1';

/**
 * Declared BEFORE the selection runs, for the same reason §1's table is declared before the study runs.
 * `fresh_new: null` means "however many the chain produced" — the one tier whose size is not ours to choose.
 * A tier that cannot be filled reports the shortfall; it never borrows from another tier.
 */
export const TIER_SIZES = { fresh_new: null, unseen_entity: 20, unseen_deployment: 20, unseen_relation: 20 };

/** E1 only. The headline bucket is E1, so a phrasing-matched OOD bucket is comparable to it item for item. */
const FORM = 'E1';

/** Reverse relations name the entity in the OBJECT, not the subject. Used to canonicalise "which entity". */
const REVERSE_RELATIONS = new Set(['vault_address', 'market_address']);

/** Same id scheme as facts.mjs, so a fact this file mints and a fact facts.mjs extracts cannot collide. */
const factId = (relation, subject) => `${relation}:${createHash('sha256').update(String(subject).toLowerCase()).digest('hex').slice(0, 12)}`;

const rand01 = (...parts) => createHash('sha256').update([SEED, ...parts].join(' ')).digest().readUInt32BE(0) / 2 ** 32;
const readJsonl = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const lower = (s) => String(s ?? '').toLowerCase();

/* ------------------------------------------------------------------------------------------------------ *
 * Re-reading a truth out of the committed bytes.
 *
 * Every row this file emits has its truth READ BACK from data/<runid>/pull/<file> at the json_path it claims,
 * and an item whose truth cannot be re-derived is dropped rather than trusted. A question set whose answers
 * are only as good as the script that wrote them is not auditable; one that re-reads is.
 * ------------------------------------------------------------------------------------------------------ */

/** Walk `$.data.vaults[3].fees[performance].feePercentage` / `...inputTokens[*].symbol` over a parsed response. */
export function resolveJsonPath(root, expr) {
  const parts = String(expr).replace(/^\$\.?/, '').split('.').filter(Boolean);
  const walk = (node, i) => {
    if (i >= parts.length) return node;
    const m = parts[i].match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[([^\]]+)\])?$/);
    if (!m) return undefined;
    let cur = node?.[m[1]];
    if (m[2] === undefined) return walk(cur, i + 1);
    if (m[2] === '*') return Array.isArray(cur) ? cur.map((el) => walk(el, i + 1)) : undefined;
    if (/^\d+$/.test(m[2])) return walk(Array.isArray(cur) ? cur[Number(m[2])] : undefined, i + 1);
    // the one named index facts.mjs mints: fees[performance]
    if (m[2] === 'performance') return walk((cur ?? []).find((f) => /PERFORMANCE/i.test(f?.feeType ?? '')), i + 1);
    return undefined;
  };
  return walk(root, 0);
}

/** Re-read a fact's object from the committed pull. Returns `undefined` when the path does not resolve. */
function rereadTruth(runid, fact, { fresh = false } = {}) {
  const [file, expr] = String(fact.source.json_path).split('#');
  const p = path.join(ROOT, 'data', runid, fresh ? 'pull-fresh' : 'pull', file);
  if (!fs.existsSync(p)) return undefined;
  return resolveJsonPath(JSON.parse(fs.readFileSync(p, 'utf8')), expr);
}

/** Compare a re-read value to a fact's object under that fact's own answer_type rule. */
function sameValue(a, b, answer_type) {
  if (answer_type === 'decimal') {
    const x = Number(a), y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return y === 0 ? x === 0 : Math.abs(x - y) / Math.abs(y) <= 0.01;
  }
  const norm = (v) => (Array.isArray(v) ? v.map((e) => lower(e)) : lower(v));
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/* ------------------------------------------------------------------------------------------------------ *
 * The two relations facts.mjs never extracts.
 *
 * These are not new data — they are fields already in the committed responses that the study's extractor
 * walks straight past. That is exactly what makes them an unseen RELATION rather than an unseen entity: the
 * patch has a row for this market's asset SYMBOL and no row anywhere for its asset ADDRESS.
 *
 * Both are static by construction (a market's underlying token and a pool's pair never change), so arm B
 * querying the LIVE head is not scored against a value that has since moved. That constraint is why no
 * volatile field is used here: `src/run.mjs` does not pin a block for arm B, so a moving truth would score
 * arm B wrong for being right about now — a strawman, and one that flatters us.
 * ------------------------------------------------------------------------------------------------------ */
const EXTRA_RELATIONS = {
  market_asset_address: {
    query: 'markets',
    answer_type: 'address',
    sibling: 'market_asset_symbol',
    rows(data, base) {
      const out = [];
      (data.markets ?? []).forEach((m, i) => {
        const id = lower(m.id), tok = lower(m.inputToken?.id);
        if (!/^0x[0-9a-f]{40}$/.test(id) || !/^0x[0-9a-f]{40}$/.test(tok)) return;
        if (tok === id) return; // self-referential: the answer is printed in the question
        out.push({ subject: id, object: tok, json_path: `${base}$.data.markets[${i}].inputToken.id` });
      });
      return out;
    },
  },
  pool_token_addresses: {
    query: 'pools',
    answer_type: 'list<address>',
    sibling: 'pool_tokens',
    rows(data, base) {
      const out = [];
      (data.liquidityPools ?? []).forEach((p, i) => {
        const id = lower(p.id);
        if (!/^0x[0-9a-f]{40}$/.test(id)) return;
        const toks = (p.inputTokens ?? []).map((t) => lower(t.id));
        if (toks.length < 2 || !toks.every((t) => /^0x[0-9a-f]{40}$/.test(t))) return;
        if (toks.includes(id) || new Set(toks).size !== toks.length) return;
        out.push({ subject: id, object: toks, json_path: `${base}$.data.liquidityPools[${i}].inputTokens[*].id` });
      });
      return out;
    },
  },
};

/** Extract the never-extracted relations from the same committed manifest facts.mjs reads. */
export function extractExtra(runid) {
  const dir = path.join(ROOT, 'data', runid, 'pull');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const out = [];
  for (const resp of manifest.responses) {
    for (const [relation, spec] of Object.entries(EXTRA_RELATIONS)) {
      if (resp.query !== spec.query) continue;
      const raw = JSON.parse(fs.readFileSync(path.join(dir, resp.file), 'utf8'));
      for (const r of spec.rows(raw.data ?? {}, `${resp.file}#`)) {
        out.push({
          fact_id: factId(relation, r.subject), relation, subject: r.subject, object: r.object,
          answer_type: spec.answer_type, volatile: false,
          source: { deployment_id: resp.deployment_id, protocol: resp.protocol, query_hash: resp.query_hash, block: resp.block, json_path: r.json_path },
        });
      }
    }
  }
  // A subject that resolves two ways is ambiguous and is dropped, exactly as facts.mjs drops it.
  const seen = new Map();
  for (const f of out) {
    const prev = seen.get(f.fact_id);
    if (prev) { if (JSON.stringify(prev.object) !== JSON.stringify(f.object)) prev._conflict = true; continue; }
    seen.set(f.fact_id, f);
  }
  return [...seen.values()].filter((f) => !f._conflict);
}

/* ------------------------------------------------------------------------------------------------------ *
 * What the patch saw. Computed from the committed files, never typed out.
 * ------------------------------------------------------------------------------------------------------ */
export function loadStudy(runid) {
  const dir = path.join(ROOT, 'data', runid);
  const facts = readJsonl(path.join(dir, 'facts.jsonl'));
  const byId = new Map(facts.map((f) => [f.fact_id, f]));
  const split = JSON.parse(fs.readFileSync(path.join(dir, 'split.json'), 'utf8'));
  const questions = readJsonl(path.join(dir, 'questions.jsonl'));
  const trainset = readJsonl(path.join(dir, 'trainset.jsonl'));
  const near = readJsonl(path.join(ROOT, 'locality', 'near.jsonl'));

  const studyFactIds = new Set(split.study_fact_ids);
  const studyFacts = split.study_fact_ids.map((id) => byId.get(id)).filter(Boolean);
  if (studyFacts.length !== studyFactIds.size) {
    throw new Error(`split.json names ${studyFactIds.size} study facts but only ${studyFacts.length} resolve in facts.jsonl — the two files disagree and the exclusion set would be a guess`);
  }
  // The trainset must BE the P form of these facts. If it is not, everything downstream that calls this the
  // "trained" set is fiction, so it is checked rather than assumed.
  const tpl = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'questions', 'templates.json'), 'utf8'));
  const derivedPrompts = new Set(studyFacts.map((f) => tpl.families[f.relation]?.P.replaceAll('{subject}', String(f.subject))));
  const trainPrompts = new Set(trainset.map((r) => r.prompt));
  const unexplained = [...trainPrompts].filter((p) => !derivedPrompts.has(p));
  if (unexplained.length) {
    throw new Error(`${unexplained.length} of ${trainPrompts.size} trainset prompts do not re-derive from a split.study_fact_ids fact through its P template — e.g. ${JSON.stringify(unexplained[0])}`);
  }

  const entityOf = (f) => lower(REVERSE_RELATIONS.has(f.relation) ? f.object : f.subject);
  const askedFactIds = new Set(questions.flatMap((q) => q.fact_ids));
  const askedFacts = [...askedFactIds].map((id) => byId.get(id)).filter(Boolean);

  const answerAtoms = new Set();
  for (const r of trainset) for (const a of String(r.answer).split(',')) { const t = a.trim().toLowerCase(); if (t) answerAtoms.add(t); }

  return {
    facts, byId, split, questions, trainset, near, tpl,
    studyFactIds, studyFacts,
    trainedEntities: new Set(studyFacts.map(entityOf)),
    trainedSubjects: new Set(studyFacts.map((f) => lower(f.subject))),
    trainedRelations: new Set(studyFacts.map((f) => f.relation)),
    trainedDeployments: new Set(studyFacts.map((f) => f.source.deployment_id)),
    trainedAnswerAtoms: answerAtoms,
    trainPrompts,
    askedFactIds,
    askedEntities: new Set(askedFacts.map(entityOf)),
    studyQuestions: new Set(questions.map((q) => q.question)),
    nearFactIds: new Set(near.flatMap((n) => n.fact_ids ?? [])),
    nearSubjects: new Set(near.map((n) => lower(n.subject)).filter(Boolean)),
    entityOf,
  };
}

/* ------------------------------------------------------------------------------------------------------ *
 * Selection.
 * ------------------------------------------------------------------------------------------------------ */

/** The generator's own rule: an item whose answer is printed in its question measures string handling. */
const normText = (v) => String(v).toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
const answerInQuestion = (item) => {
  const t = Array.isArray(item.truth) ? item.truth : [item.truth];
  return t.some((x) => normText(x).length >= 2 && normText(item.question).includes(normText(x)));
};

/**
 * Round-robin across relations, seeded within each. The study's headline bucket is relation-stratified
 * (§1, `RELATION_CAP`) and its tripwire bucket is not — the committed tripwire is 24/30 `pool_tokens`,
 * i.e. 80% one relation. An unstratified OOD bucket would inherit the same 85%-`pool_tokens` skew from the
 * fact universe and would not be comparable, relation for relation, with the headline it is contrasted against.
 */
function roundRobin(candidates, n, salt) {
  const byRel = new Map();
  for (const c of candidates) {
    if (!byRel.has(c.fact.relation)) byRel.set(c.fact.relation, []);
    byRel.get(c.fact.relation).push(c);
  }
  const order = [...byRel.keys()].sort();
  for (const r of order) byRel.get(r).sort((a, b) => rand01(salt, a.fact.fact_id) - rand01(salt, b.fact.fact_id));
  const out = [];
  const taken = new Map(order.map((r) => [r, 0]));
  while (out.length < n) {
    let progressed = false;
    for (const r of order) {
      if (out.length >= n) break;
      const t = taken.get(r);
      if (t >= byRel.get(r).length) continue;
      out.push(byRel.get(r)[t]);
      taken.set(r, t + 1);
      progressed = true;
    }
    if (!progressed) break;
  }
  return out;
}

/**
 * Build one candidate: render the fact through the study's own templates, take form E1, re-read the truth
 * from the committed bytes, and attach everything a reader needs to disagree with the choice.
 */
function candidate(runid, fact, tier, study, extra = {}) {
  const rendered = itemsForFact(fact, study.tpl, false).find((x) => x.form === FORM);
  if (!rendered) return { drop: 'no template family for relation ' + fact.relation };
  if (answerInQuestion(rendered)) return { drop: 'answer_in_question' };

  const isFresh = tier === 'fresh_new';
  const seen = rereadTruth(runid, fact, { fresh: isFresh });
  if (seen === undefined) return { drop: 'json_path did not resolve in the committed pull' };
  if (!sameValue(seen, fact.object, fact.answer_type)) return { drop: `re-read disagrees with the fact (${JSON.stringify(seen)} vs ${JSON.stringify(fact.object)})` };

  // Second pull, when the fact exists in it: this is the only evidence we have that the truth holds still,
  // and arm B queries the live head, so a truth that moves is a truth that scores arm B wrong for being right.
  let stability = { checked: false, stable: null, note: 'fact is not present in the fresh pull' };
  if (!isFresh) {
    const later = rereadTruth(runid, fact, { fresh: true });
    if (later !== undefined) stability = { checked: true, stable: sameValue(later, fact.object, fact.answer_type), later: Array.isArray(later) ? later.map(lower) : lower(later), note: null };
  } else {
    stability = { checked: true, stable: true, note: 'this tier IS the second pull' };
  }
  if (stability.checked && stability.stable === false) return { drop: 'value moved between the two committed pulls' };

  const truthAtoms = (Array.isArray(rendered.truth) ? rendered.truth : [rendered.truth]).map((x) => String(x).toLowerCase());
  return {
    fact,
    item: {
      ...rendered,
      id: `ood.${rendered.id}`,
      ood_tier: tier,
      ood_stability: stability,
      answer_atom_in_trainset: truthAtoms.filter((a) => study.trainedAnswerAtoms.has(a)),
      ...extra,
    },
  };
}

export function build(runid) {
  const study = loadStudy(runid);
  const universe = extract(runid).facts;                 // everything the pull holds at B*, before the volatile cut
  const extras = extractExtra(runid);                    // the relations facts.mjs walks past
  const freshFacts = readJsonl(path.join(ROOT, 'data', runid, 'fresh.jsonl'));
  const blockStar = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', runid, 'pull', 'manifest.json'), 'utf8')).block;
  const freshManifestPath = path.join(ROOT, 'data', runid, 'pull-fresh', 'manifest.json');
  const freshBlock = fs.existsSync(freshManifestPath) ? JSON.parse(fs.readFileSync(freshManifestPath, 'utf8')).block : null;

  const drops = {};
  const dropped = (tier, why) => { const k = `${tier}:${why}`; drops[k] = (drops[k] ?? 0) + 1; };

  /* --- tier 1: fresh_new ------------------------------------------------------------------------------ */
  // The one tier that may legitimately ask about a fact the patch WAS trained on. If a trained fact's value
  // moved, the patch now holds a stale answer and the chain holds the true one — that is the purest form of
  // "facts newer than the patch" there is, and excluding it would delete the most informative item in the
  // bucket: the one where arm C is expected to be confidently, specifically wrong and arm D right. It is
  // flagged rather than dropped, and `checkDisjoint`'s D9 insists the new truth actually differs from the
  // trained one, so a "fresh" item can never be a trained item wearing a label.
  const freshCands = [];
  for (const f of freshFacts) {
    const c = candidate(runid, f, 'fresh_new', study, {
      moved: f.moved, was: f.was ?? null,
      fresh_supersedes_trained_fact: study.studyFactIds.has(f.fact_id),
      fresh_supersedes_study_item: study.askedFactIds.has(f.fact_id),
    });
    if (c.drop) { dropped('fresh_new', c.drop); continue; }
    freshCands.push(c);
  }

  /* --- tier 2: unseen_entity -------------------------------------------------------------------------- */
  const entCands = [];
  for (const f of universe) {
    if (!study.trainedRelations.has(f.relation)) { continue; }
    if (!study.trainedDeployments.has(f.source.deployment_id)) continue;   // the deployment must be a SEEN one
    if (study.studyFactIds.has(f.fact_id) || study.askedFactIds.has(f.fact_id) || study.nearFactIds.has(f.fact_id)) { dropped('unseen_entity', 'fact is in the study or the locality set'); continue; }
    const e = study.entityOf(f);
    if (study.trainedEntities.has(e) || study.askedEntities.has(e)) { dropped('unseen_entity', 'entity appears in the study'); continue; }
    if (study.trainedSubjects.has(lower(f.subject)) || study.nearSubjects.has(lower(f.subject))) { dropped('unseen_entity', 'subject appears in the study or the locality set'); continue; }
    if (f.volatile) { dropped('unseen_entity', 'volatile field — arm B queries the live head'); continue; }
    entCands.push(f);
  }
  // The re-read is the expensive check, so it runs on the seeded draw rather than on 12,000 rows: take a
  // generous over-draw, validate, and keep the first n that survive. The draw order is still a pure function
  // of the seed, so which items are considered is reproducible.
  const entPicked = pickValidated(runid, entCands, 'unseen_entity', TIER_SIZES.unseen_entity, study, dropped);

  /* --- tier 3: unseen_deployment ---------------------------------------------------------------------- */
  const depCands = [];
  for (const f of universe) {
    if (study.trainedDeployments.has(f.source.deployment_id)) continue;
    // Belt and braces. A deployment with zero study facts satisfies these trivially, so they cost nothing
    // here and they stop the tier from ever emitting a trained item if the deployment rule is later loosened.
    if (study.studyFactIds.has(f.fact_id) || study.askedFactIds.has(f.fact_id) || study.nearFactIds.has(f.fact_id)) { dropped('unseen_deployment', 'fact is in the study or the locality set'); continue; }
    if (study.trainedEntities.has(study.entityOf(f))) { dropped('unseen_deployment', 'entity appears in the study'); continue; }
    if (f.volatile) { dropped('unseen_deployment', 'volatile field — arm B queries the live head'); continue; }
    depCands.push(f);
  }
  const depPicked = pickValidated(runid, depCands, 'unseen_deployment', TIER_SIZES.unseen_deployment, study, dropped);

  /* --- tier 4: unseen_relation ------------------------------------------------------------------------ */
  // Deliberately the INVERSE entity rule: the entity IS one the patch saw, so the only unseen thing is the
  // relation. That isolates the dimension — "the patch knows this market's asset symbol and has no row
  // anywhere for its asset address" — instead of stacking two kinds of distance in one tier.
  const relCands = [];
  for (const f of extras) {
    const e = lower(f.subject);
    if (!study.trainedEntities.has(e)) continue;
    if (study.askedFactIds.has(f.fact_id) || study.nearFactIds.has(f.fact_id)) { dropped('unseen_relation', 'fact is in the study or the locality set'); continue; }
    relCands.push(f);
  }
  const relPicked = pickValidated(runid, relCands, 'unseen_relation', TIER_SIZES.unseen_relation, study, dropped, (f) => ({
    subject_is_trained_entity: true,
    trained_sibling_relation: EXTRA_RELATIONS[f.relation].sibling,
  }));

  const items = [...freshCands, ...entPicked, ...depPicked, ...relPicked].map((c) => c.item);
  // One shuffle, one seed, the same order for every arm — §2.
  items.sort((a, b) => rand01('order', a.id) - rand01('order', b.id));

  return {
    items, study, universe, extras, freshFacts, blockStar, freshBlock, drops,
    picked: { fresh_new: freshCands.length, unseen_entity: entPicked.length, unseen_deployment: depPicked.length, unseen_relation: relPicked.length },
    candidates: { fresh_new: freshFacts.length, unseen_entity: entCands.length, unseen_deployment: depCands.length, unseen_relation: relCands.length },
  };
}

/** Seeded round-robin draw, then validate each pick and keep drawing until the tier is full or exhausted. */
function pickValidated(runid, cands, tier, n, study, dropped, extraOf = () => ({})) {
  const wrapped = cands.map((f) => ({ fact: f }));
  const ordered = roundRobin(wrapped, wrapped.length, tier);
  const out = [];
  for (const w of ordered) {
    if (out.length >= n) break;
    const c = candidate(runid, w.fact, tier, study, extraOf(w.fact));
    if (c.drop) { dropped(tier, c.drop); continue; }
    out.push(c);
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------------ *
 * The checks that are allowed to fail the build.
 * ------------------------------------------------------------------------------------------------------ */
export function checkDisjoint(items, study) {
  const fails = [];
  const check = (name, bad, detail) => { if (bad.length) fails.push({ check: name, n: bad.length, examples: bad.slice(0, 3), detail }); };
  // D1-D3 are about COVERAGE — "the patch cannot have a row for this". The fresh tier is exempt from them by
  // construction, because its whole content is facts whose value the patch's rows no longer describe; D9 is
  // the check that keeps that exemption honest.
  const stale = (it) => it.ood_tier === 'fresh_new';
  check('D1 no item asks a fact the patch was trained on',
    items.filter((it) => !stale(it) && it.fact_ids.some((f) => study.studyFactIds.has(f))).map((it) => it.id),
    'split.study_fact_ids (fresh_new exempt — see D9)');
  check('D2 no item asks a fact the 250-item study already asks',
    items.filter((it) => !stale(it) && it.fact_ids.some((f) => study.askedFactIds.has(f))).map((it) => it.id),
    'questions.jsonl fact_ids (fresh_new exempt — see D9)');
  check('D3 no item repeats a study question string',
    items.filter((it) => !stale(it) && study.studyQuestions.has(it.question)).map((it) => it.id),
    'questions.jsonl question (fresh_new exempt — see D9)');
  check('D9 a fresh item that supersedes a known fact carries a DIFFERENT truth',
    items.filter((it) => stale(it) && study.byId.has(it.fact_ids[0]))
      .filter((it) => JSON.stringify(study.byId.get(it.fact_ids[0]).object) === JSON.stringify(it.truth))
      .map((it) => it.id),
    'facts.jsonl object — a fresh item whose truth equals the pinned one is not fresh, it is a duplicate');
  check('D4 no item repeats a training prompt',
    items.filter((it) => study.trainPrompts.has(it.question)).map((it) => it.id),
    'trainset.jsonl prompt');
  check('D5 no item collides with the locality set',
    items.filter((it) => it.fact_ids.some((f) => study.nearFactIds.has(f))).map((it) => it.id),
    'locality/near.jsonl fact_ids');
  check('D6 no item prints its own answer in its question',
    items.filter(answerInQuestion).map((it) => it.id),
    'the generator\'s own answer_in_question rule');
  check('D7 every item is held-out by construction', items.filter((it) => it.taught !== false).map((it) => it.id), 'taught must be false');
  check('D8 every id is unique', (() => { const s = new Set(), dup = []; for (const it of items) { if (s.has(it.id)) dup.push(it.id); s.add(it.id); } return dup; })(), 'duplicate item id');
  return fails;
}

export function checkSchema(items) {
  const schema = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'questions', 'schema.json'), 'utf8'));
  const allowed = new Set(Object.keys(schema.properties));
  const re = new RegExp(schema.properties.answer_type.pattern);
  const fails = [];
  for (const it of items) {
    for (const k of schema.required) if (it[k] === undefined) fails.push(`${it.id}: missing required field ${k}`);
    for (const k of Object.keys(it)) if (!allowed.has(k)) fails.push(`${it.id}: field ${k} is not in questions/schema.json`);
    if (!re.test(it.answer_type)) fails.push(`${it.id}: answer_type ${it.answer_type} does not match the schema pattern`);
    if (!Array.isArray(it.source_ids) || !it.source_ids.length) fails.push(`${it.id}: source_ids must be a non-empty array`);
  }
  return fails;
}

/* ------------------------------------------------------------------------------------------------------ */

function sentence(built) {
  const { freshFacts, blockStar, freshBlock } = built;
  if (!freshBlock) return 'No second pull exists, so no fresh tier can be computed. This is a missing measurement, not a zero.';
  const changed = freshFacts.filter((f) => f.moved === 'changed').length;
  const added = freshFacts.filter((f) => f.moved === 'new').length;
  if (!freshFacts.length) return `0 fresh items — nothing moved between block ${blockStar} and block ${freshBlock}.`;
  return `${freshFacts.length} fresh fact${freshFacts.length === 1 ? '' : 's'} between block ${blockStar} and block ${freshBlock}: ${changed} changed value beyond the scorer's ±1%, ${added} did not exist at B*.`;
}

export function report(built) {
  const { items, study, universe, extras, blockStar, freshBlock, drops, picked, candidates } = built;
  const by = (f) => { const m = {}; for (const it of items) { const k = f(it); m[k] = (m[k] ?? 0) + 1; } return m; };
  const relOf = (it) => it.fact_ids[0].split(':')[0];
  return {
    generated_at: new Date().toISOString(),
    seed: SEED, form: FORM,
    block_star: blockStar, fresh_block: freshBlock,
    fresh_verdict: sentence(built),
    tier_sizes_declared: TIER_SIZES,
    tier_sizes_achieved: picked,
    tier_candidates_before_validation: candidates,
    shortfalls: Object.entries(TIER_SIZES).filter(([k, n]) => n != null && picked[k] < n).map(([k, n]) => `${k}: ${picked[k]}/${n}`),
    items: items.length,
    by_tier: by((it) => it.ood_tier),
    by_relation: by(relOf),
    by_answer_type: by((it) => it.answer_type),
    by_deployment: by((it) => it.source.deployment_id),
    items_whose_truth_shares_an_atom_with_the_trainset: items.filter((it) => it.answer_atom_in_trainset?.length).length,
    fresh_items_superseding_a_trained_fact: items.filter((it) => it.fresh_supersedes_trained_fact).length,
    fresh_items_superseding_a_study_item: items.filter((it) => it.fresh_supersedes_study_item).length,
    universe: {
      facts_at_B_star: universe.length,
      never_extracted_relation_facts: extras.length,
      study_facts: study.studyFactIds.size,
      facts_the_250_asks: study.askedFactIds.size,
      trained_entities: study.trainedEntities.size,
      trained_deployments: [...study.trainedDeployments].length,
    },
    drops,
    notes: [
      'This bucket is an ADDITION to README §1, whose five-bucket table is untouched. It evidences the second half of the README\'s claim 2 (facts newer than the patch, and anything outside the trained domain); §1\'s tripwire evidences the middle third of that sentence.',
      'Every item is E1 (held-out phrasing), hop 1, taught=false. E1 only, so the bucket is phrasing-matched to the headline and comparable to it item for item.',
      'Arm C is expected to be at or near the floor across all four tiers; arm D is expected to match arm B. A tier where arm C does WELL is evidence of leakage and belongs in the summary as such.',
      'No volatile field is used outside the fresh tier: src/run.mjs pins no block for arm B, so a truth that moves between B* and the run would score arm B wrong for being right about now.',
      'The fresh tier is the ONE tier allowed to ask about a fact the patch was trained on: if a trained value moved, the patch now holds a stale answer and the chain holds the true one. Those items are flagged (fresh_supersedes_trained_fact) and D9 insists the new truth actually differs from the pinned one.',
      'Truths are not filtered for sharing a token with the trainset — that would remove exactly the items arm C might get right by accident. They are flagged instead (answer_atom_in_trainset).',
    ],
  };
}

/* ------------------------------------------------------------------------------------------------------ */

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--run');
  const runid = i >= 0 ? process.argv[i + 1] : null;
  if (!runid) { console.error('usage: node pipeline/ood.mjs --run <runid> [--mirror <runid>-ood]'); process.exit(2); }
  const mi = process.argv.indexOf('--mirror');
  const mirror = mi >= 0 ? process.argv[mi + 1] : `${runid}-ood`;

  const built = build(runid);
  const schemaFails = checkSchema(built.items);
  const disjointFails = checkDisjoint(built.items, built.study);
  if (schemaFails.length) { console.error('SCHEMA FAILURES:'); for (const f of schemaFails) console.error('  ' + f); process.exit(1); }
  if (disjointFails.length) { console.error('DISJOINTNESS FAILURES:'); for (const f of disjointFails) console.error('  ' + JSON.stringify(f)); process.exit(1); }

  const dir = path.join(ROOT, 'data', runid);
  const body = built.items.map((x) => JSON.stringify(x)).join('\n') + (built.items.length ? '\n' : '');
  fs.writeFileSync(path.join(dir, 'questions-fresh.jsonl'), body);
  const rep = report(built);
  fs.writeFileSync(path.join(dir, 'ood-report.json'), JSON.stringify(rep, null, 2) + '\n');

  // The runner reads data/<runId>/questions.jsonl and data/<runId>/pull/manifest.json and nothing else, so a
  // mirror directory runs this bucket with NO change to src/run.mjs. The pull is symlinked, not copied: the
  // mirror must carry the same committed provenance, not a second copy that could drift from it.
  const mdir = path.join(ROOT, 'data', mirror);
  fs.mkdirSync(mdir, { recursive: true });
  fs.writeFileSync(path.join(mdir, 'questions.jsonl'), body);
  const link = path.join(mdir, 'pull');
  if (!fs.existsSync(link)) fs.symlinkSync(path.join('..', runid, 'pull'), link);

  console.log(rep.fresh_verdict);
  console.log(`questions-fresh.jsonl: ${built.items.length} items`);
  for (const [k, n] of Object.entries(rep.by_tier)) console.log(`  ${k.padEnd(20)} ${n}`);
  if (rep.shortfalls.length) console.log(`  SHORTFALL: ${rep.shortfalls.join(', ')} — reported, not topped up from another tier`);
  console.log(`relations: ${JSON.stringify(rep.by_relation)}`);
  console.log(`answer types: ${JSON.stringify(rep.by_answer_type)}`);
  console.log(`truths sharing an atom with the trainset: ${rep.items_whose_truth_shares_an_atom_with_the_trainset} (flagged, not filtered)`);
  console.log(`mirror: data/${mirror}/questions.jsonl  ->  node src/run.mjs --run ${mirror}`);
}
