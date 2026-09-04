/**
 * Step 3 — facts -> questions.jsonl (+ fresh-questions.jsonl) and the training set the patch is baked from.
 * Deterministic, offline, no key, no network, no model.
 *
 *   node pipeline/questions.mjs --run <runid>
 *
 * Writes:
 *   data/<runid>/questions.jsonl        the IN-DOMAIN set (schema.json). What the product claims.
 *   data/<runid>/fresh-questions.jsonl  the OUT-OF-DOMAIN/FRESH set: facts that MOVED after the bake.
 *   data/<runid>/trainset.jsonl         {prompt, answer} rows — form P of TAUGHT facts only. Nothing else.
 *   data/<runid>/split.json             the seeded held-out split, written before any model runs.
 *
 * The three anti-circularity devices, all applied here so they are visible in one file:
 *
 *  1. HELD-OUT PHRASING. Every fact gets three surface forms. Only form P becomes a training row; the
 *     headline accuracy is measured on E1/E2, which no model has ever been trained on. P is still scored,
 *     and reported as the memorisation ceiling — the P-to-E1 gap IS the generalisation cost, and printing it
 *     is more convincing than pretending it is zero.
 *  2. HELD-OUT FACTS. A seeded 20% of facts never enter the training set. Arm C must fail them. If it does
 *     not, the run is void for leakage. This is also the bucket arm B is expected to win outright, and it is
 *     published at full weight.
 *  3. MULTI-HOP. Joins computed here from two facts. Neither the join nor its answer is ever a training row.
 *
 * The FRESH set is generated from the same code path but from fresh.jsonl — facts whose value moved between
 * B* and a later pull. Arm C is expected to DEGRADE there and arm D to win. That result is published even
 * though it flatters us less, because a benchmark that cannot fail proves nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.AINIZE_BENCH_DATA ? path.resolve(process.env.AINIZE_BENCH_DATA) : path.resolve(HERE, '..');

const SEED = 'ainize-graph-bench-v1';
const HELD_OUT_FRACTION = 0.20;
/** Two TVLs must differ by at least this much before a "which is bigger" item is emitted, so the ordering
 *  cannot flip on the noise the plus/minus 1% scorer tolerance already admits. */
const COMPARE_MARGIN = 0.20;

/** Deterministic uniform in [0,1) from a string — the split is a pure function of the fact id and the seed. */
function rand01(...parts) {
  const h = createHash('sha256').update([SEED, ...parts].join(' ')).digest();
  return h.readUInt32BE(0) / 2 ** 32;
}

const readJsonl = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Render one fact into its three forms. */
function itemsForFact(fact, tpl, taught, extra = {}) {
  const fam = tpl.families[fact.relation];
  if (!fam) return [];
  return ['P', 'E1', 'E2'].map((form) => ({
    id: `${fact.fact_id}.${form}`,
    question: fam[form].replaceAll('{subject}', String(fact.subject)),
    answer_type: fam.answer_type,
    truth: fact.object,
    form,
    taught,
    hop: fam.hop,
    fact_ids: [fact.fact_id],
    source: { deployment_id: fact.source.deployment_id, query_hash: fact.source.query_hash, block: fact.source.block, json_path: fact.source.json_path },
    ...extra,
  }));
}

/** Joins over two facts. The generator computes the answer; no model and no single training row holds it. */
function hopItems(facts, tpl, isTaught) {
  const by = (rel) => new Map(facts.filter((f) => f.relation === rel).map((f) => [f.subject, f]));
  const symbolOf = by('vault_symbol');
  const assetSymOf = by('vault_asset_symbol');
  const tvlOf = by('vault_tvl_usd');
  const out = [];

  // symbol -> address -> underlying asset symbol
  for (const [addr, sf] of symbolOf) {
    const af = assetSymOf.get(addr);
    if (!af) continue;
    const fam = tpl.families.vault_asset_via_symbol;
    const fid = `hop1:${sf.fact_id}+${af.fact_id}`;
    for (const form of ['P', 'E1', 'E2']) {
      out.push({
        id: `${fid}.${form}`, question: fam[form].replaceAll('{subject}', String(sf.object)),
        answer_type: fam.answer_type, truth: af.object, form, taught: isTaught(sf) && isTaught(af), hop: 2,
        fact_ids: [sf.fact_id, af.fact_id], source: af.source,
      });
    }
  }

  // "which of these two holds more" — ordering, not the value, so a moving TVL cannot flip it
  const pairSrc = [...tvlOf.entries()].filter(([a]) => symbolOf.has(a)).sort((x, y) => y[1].object - x[1].object);
  for (let i = 0; i + 1 < pairSrc.length; i += 2) {
    const [a1, t1] = pairSrc[i], [a2, t2] = pairSrc[i + 1];
    const hi = Math.max(t1.object, t2.object), lo = Math.min(t1.object, t2.object);
    if (!hi || (hi - lo) / hi < COMPARE_MARGIN) continue;
    const s1 = symbolOf.get(a1), s2 = symbolOf.get(a2);
    const fam = tpl.families.vault_larger_tvl;
    const subject = `${s1.object} or ${s2.object}`;
    const fid = `hop2:${t1.fact_id}+${t2.fact_id}`;
    for (const form of ['P', 'E1', 'E2']) {
      out.push({
        id: `${fid}.${form}`, question: fam[form].replaceAll('{subject}', subject),
        answer_type: fam.answer_type, truth: (t1.object >= t2.object ? s1 : s2).object, form,
        taught: isTaught(t1) && isTaught(t2), hop: 2, fact_ids: [t1.fact_id, t2.fact_id], source: t1.source,
      });
    }
  }

  // the many-entity item: "of these N vaults, the top 3 by TVL". One memory lookup vs. a read-and-rank.
  const byAsset = new Map();
  for (const [addr, tf] of tvlOf) {
    const as = assetSymOf.get(addr), sy = symbolOf.get(addr);
    if (!as || !sy) continue;
    const k = String(as.object).toUpperCase();
    if (!byAsset.has(k)) byAsset.set(k, []);
    byAsset.get(k).push({ addr, tvl: tf.object, sym: sy.object, tf, sy });
  }
  for (const [asset, group] of byAsset) {
    if (group.length < 5) continue; // "top 3 of 4" is not a many-entity question
    const sorted = group.sort((a, b) => b.tvl - a.tvl);
    // The 3rd and 4th must be clearly apart, or the cut line is noise.
    if (!sorted[2] || !sorted[3] || (sorted[2].tvl - sorted[3].tvl) / (sorted[2].tvl || 1) < COMPARE_MARGIN) continue;
    const top = sorted.slice(0, 3);
    const fam = tpl.families.vault_top_by_tvl;
    const fid = `hop3:${asset}`;
    for (const form of ['P', 'E1', 'E2']) {
      out.push({
        id: `${fid}.${form}`, question: fam[form].replaceAll('{subject}', asset),
        answer_type: fam.answer_type, truth: top.map((t) => t.sym), form,
        taught: top.every((t) => isTaught(t.tf)), hop: 2,
        fact_ids: top.map((t) => t.tf.fact_id), source: top[0].tf.source,
        n_candidates: group.length,
      });
    }
  }
  return out;
}

export function generate(runid) {
  const dir = path.join(ROOT, 'data', runid);
  // templates always come from the real tree, never from the test's throwaway root
  const tpl = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'questions', 'templates.json'), 'utf8'));
  const facts = readJsonl(path.join(dir, 'facts.jsonl'));
  if (!facts.length) throw new Error(`data/${runid}/facts.jsonl is empty — run pipeline/pull.mjs and pipeline/facts.mjs first`);

  // The seeded split, decided here and written to disk BEFORE any model runs.
  const heldOut = new Set(facts.filter((f) => rand01('holdout', f.fact_id) < HELD_OUT_FRACTION).map((f) => f.fact_id));
  const isTaught = (f) => !heldOut.has(f.fact_id);

  const items = [];
  for (const f of facts) items.push(...itemsForFact(f, tpl, isTaught(f)));
  items.push(...hopItems(facts, tpl, isTaught));

  // One shuffle, one seed, and every arm gets this order — so drift in the host over the run window hits
  // all four arms in the same places instead of accumulating against whichever ran last.
  items.sort((a, b) => rand01('order', a.id) - rand01('order', b.id));

  // The training set: form P, taught facts, hop 1 only. This file is the ONLY thing the patch is baked from.
  const train = items
    .filter((it) => it.form === 'P' && it.taught && it.hop === 1)
    .map((it) => ({ prompt: it.question, answer: Array.isArray(it.truth) ? it.truth.join(', ') : String(it.truth) }));

  fs.writeFileSync(path.join(dir, 'questions.jsonl'), items.map((x) => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'trainset.jsonl'), train.map((x) => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'split.json'), JSON.stringify({
    seed: SEED, held_out_fraction: HELD_OUT_FRACTION, compare_margin: COMPARE_MARGIN,
    facts: facts.length, held_out_facts: heldOut.size, items: items.length, train_rows: train.length,
    held_out_fact_ids: [...heldOut].sort(),
    _note: 'Written before any model ran. The held-out set is a pure function of (seed, fact_id); re-running this file reproduces it exactly.',
  }, null, 2) + '\n');

  // The fresh set, if a second pull exists. Same templates, same code, different facts.
  const fresh = readJsonl(path.join(dir, 'fresh.jsonl'));
  const freshItems = [];
  if (fresh.length) {
    for (const f of fresh) freshItems.push(...itemsForFact(f, tpl, false, { fresh: true, was: f.was, moved: f.moved }));
    freshItems.sort((a, b) => rand01('order', a.id) - rand01('order', b.id));
    fs.writeFileSync(path.join(dir, 'fresh-questions.jsonl'), freshItems.map((x) => JSON.stringify(x)).join('\n') + '\n');
  }

  return { items, train, heldOut, freshItems, facts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--run');
  const runid = i >= 0 ? process.argv[i + 1] : null;
  if (!runid) { console.error('usage: node pipeline/questions.mjs --run <runid>'); process.exit(2); }
  const { items, train, heldOut, freshItems, facts } = generate(runid);
  const count = (p) => items.filter(p).length;
  console.log(`facts ${facts.length}  (${heldOut.size} held out)`);
  console.log(`IN-DOMAIN items ${items.length}`);
  console.log(`  headline  E1, taught, hop1   ${count((x) => x.form === 'E1' && x.taught && x.hop === 1)}`);
  console.log(`  Korean    E2, taught, hop1   ${count((x) => x.form === 'E2' && x.taught && x.hop === 1)}`);
  console.log(`  ceiling   P,  taught, hop1   ${count((x) => x.form === 'P' && x.taught && x.hop === 1)}`);
  console.log(`  tripwire  held-out facts     ${count((x) => !x.taught && x.hop === 1)}`);
  console.log(`  multi-hop hop2               ${count((x) => x.hop === 2)}`);
  console.log(`FRESH items ${freshItems.length}${freshItems.length ? '' : '  (no --fresh pull yet, or nothing moved)'}`);
  console.log(`trainset.jsonl ${train.length} rows  — form P, taught facts, hop 1, nothing else`);
}
