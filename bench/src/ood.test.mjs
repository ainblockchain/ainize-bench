/**
 * Self-test for pipeline/ood.mjs — the out-of-domain bucket (arm D's tail).
 *
 *   node src/ood.test.mjs
 *
 * No GPU, no key, no network, no model. Two halves:
 *
 *   PART 1 runs against a SYNTHETIC pull in a throwaway directory (AINIZE_BENCH_DATA), the same device
 *          src/pipeline.test.mjs uses. Every response is stamped `synthetic: true`, nothing is written under
 *          data/, and the fixture is removed at the end. It exists to prove the RULES — that a moved value
 *          produces a fresh item, that nothing moved produces an EMPTY file rather than an invented tail,
 *          and that each disjointness check actually goes red when the set is poisoned.
 *
 *   PART 2 runs against the committed data/r1, read-only. It exists to prove the CLAIMS made about the real
 *          bucket: that every truth re-reads out of the committed bytes, that no item touches a trained fact,
 *          a trained entity, a study question or a locality prompt, and that the study's own frozen files are
 *          not disturbed by anything this pipeline added.
 *
 * A disjointness report that cannot fail is a green light welded on, so PART 1 poisons a copy once per check.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); } };
const readJsonl = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/* ========================================================================================================= *
 * PART 1 — synthetic pull
 * ========================================================================================================= */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ainize-ood-selftest-'));
const RUN = 'SELFTEST-SYNTHETIC';
const env = { ...process.env, AINIZE_BENCH_DATA: root };
const dataDir = path.join(root, 'data', RUN);
const addr = (n) => `0x${String(n).padStart(4, '0').repeat(10)}`;
const tokAddr = (n) => `0xdd${String(n).padStart(4, '0').repeat(10)}`.slice(0, 42);

const DEP_SEEN = 'QmSEEN', DEP_UNSEEN = 'QmUNSEEN';

/**
 * Build a pull directory.
 *
 * `withUnseenDeployment` is STAGED, not sampled: the study is generated from a pull that holds only DEP_SEEN,
 * and the second deployment is added to the manifest afterwards. That reproduces the real r1 shape (aave-amm
 * answered the pull and no study fact was drawn from it) deterministically, instead of hoping a seeded draw
 * over a 170-fact fixture happens to miss twelve markets.
 */
function writePull(dir, { extraPool = false, movedAssetSymbol = null, withUnseenDeployment = false } = {}, block = 1_000_000) {
  fs.mkdirSync(dir, { recursive: true });
  const markets = Array.from({ length: 40 }, (_, i) => ({
    id: addr(i + 100), name: `Selftest Market ${i}`,
    inputToken: { id: tokAddr(i + 100), name: `Token ${i}`, symbol: (movedAssetSymbol === i ? 'MOVED' : `TK${i}`), decimals: 18, lastPriceUSD: '1' },
    rates: [{ rate: '1.5', side: 'LENDER', type: 'VARIABLE' }],
  }));
  const marketsUnseen = Array.from({ length: 12 }, (_, i) => ({
    id: addr(i + 500), name: `Unseen Market ${i}`,
    inputToken: { id: tokAddr(i + 500), name: `UToken ${i}`, symbol: `UT${i}`, decimals: 18, lastPriceUSD: '1' },
    rates: [{ rate: '2.5', side: 'LENDER', type: 'VARIABLE' }],
  }));
  const pools = Array.from({ length: 30 }, (_, i) => ({
    id: addr(i + 200), name: `Pool ${i}`, symbol: `P${i}`, isSingleSided: false, totalValueLockedUSD: String(1000 - i),
    inputTokens: [{ id: tokAddr(i + 200), symbol: `AA${i}`, decimals: 18 }, { id: tokAddr(i + 300), symbol: `BB${i}`, decimals: 18 }],
    outputToken: null, fees: [], protocol: { id: 'p', name: 'S', slug: 's', network: 'MAINNET', type: 'DEX', schemaVersion: '3.0.0' },
  }));
  if (extraPool) pools.push({ id: addr(999), name: 'Brand new pool', symbol: 'NEW', isSingleSided: false, totalValueLockedUSD: '1', inputTokens: [{ id: tokAddr(998), symbol: 'NEWA', decimals: 18 }, { id: tokAddr(999), symbol: 'NEWB', decimals: 18 }], outputToken: null, fees: [], protocol: { id: 'p', name: 'S', slug: 's', network: 'MAINNET', type: 'DEX', schemaVersion: '3.0.0' } });
  const vaults = Array.from({ length: 30 }, (_, i) => ({
    id: addr(i + 400), name: `Vault ${i}`, symbol: `V${i}`,
    inputToken: { id: tokAddr(i + 400), name: `VT ${i}`, symbol: `VT${i}`, decimals: 18, lastPriceUSD: '1' },
    outputToken: { id: addr(i + 400), name: `Vault ${i}`, symbol: `V${i}`, decimals: 18 },
    totalValueLockedUSD: String(5000 - i * 7), fees: [{ feeType: 'PERFORMANCE_FEE', feePercentage: String(1 + (i % 9)) }],
  }));
  const stamp = (query, dep) => ({ synthetic: true, deployment_id: dep, protocol: dep === DEP_SEEN ? 'seen' : 'unseen', query, query_hash: 'deadbeef', block, skip: 0, first: 1000 });
  const files = [
    ['seen.markets.p0.json', 'markets', DEP_SEEN, { markets }],
    ['seen.pools.p0.json', 'pools', DEP_SEEN, { liquidityPools: pools }],
    ['seen.vaults.p0.json', 'vaults', DEP_SEEN, { vaults }],
  ];
  if (withUnseenDeployment) files.push(['unseen.markets.p0.json', 'markets', DEP_UNSEEN, { markets: marketsUnseen }]);
  const responses = [];
  for (const [file, query, dep, data] of files) {
    fs.writeFileSync(path.join(dir, file), JSON.stringify({ _ainize: stamp(query, dep), data }, null, 2) + '\n');
    responses.push({ file, deployment_id: dep, protocol: dep === DEP_SEEN ? 'seen' : 'unseen', query, query_hash: 'deadbeef', block, skip: 0, ms: 1 });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ runid: RUN, synthetic: true, fresh: dir.endsWith('pull-fresh'), block, responses }, null, 2) + '\n');
}

// Phase A — the study is baked from a pull that holds ONE deployment.
writePull(path.join(dataDir, 'pull'));
writePull(path.join(dataDir, 'pull-fresh'), {}, 1_000_150);   // identical content, later block => nothing moved
execFileSync('node', [path.join(BENCH, 'pipeline', 'facts.mjs'), '--run', RUN], { env, encoding: 'utf8' });
execFileSync('node', [path.join(BENCH, 'pipeline', 'facts.mjs'), '--run', RUN, '--fresh'], { env, encoding: 'utf8' });
execFileSync('node', [path.join(BENCH, 'pipeline', 'questions.mjs'), '--run', RUN], { env, encoding: 'utf8' });
{
  const facts = readJsonl(path.join(dataDir, 'facts.jsonl'));
  ok('fixture: the study was baked from one deployment only', new Set(facts.map((f) => f.source.deployment_id)).size === 1);
}

// Phase B — a second deployment joins the pull afterwards, as aave-amm effectively did in r1.
writePull(path.join(dataDir, 'pull'), { withUnseenDeployment: true });
writePull(path.join(dataDir, 'pull-fresh'), { withUnseenDeployment: true }, 1_000_150);

// The honesty rule: nothing moved, so the fresh tier must be EMPTY and the report must say so.
{
  const out = execFileSync('node', [path.join(BENCH, 'pipeline', 'ood.mjs'), '--run', RUN], { env, encoding: 'utf8' });
  const rep = JSON.parse(fs.readFileSync(path.join(dataDir, 'ood-report.json'), 'utf8'));
  ok('nothing moved => the fresh tier is empty', rep.by_tier.fresh_new === undefined || rep.by_tier.fresh_new === 0, JSON.stringify(rep.by_tier));
  ok('nothing moved => the verdict says so in words', /^0 fresh items — nothing moved between block 1000000 and block 1000150\.$/.test(rep.fresh_verdict), rep.fresh_verdict);
  ok('nothing moved => the verdict is printed, not buried', out.includes('0 fresh items'), out.split('\n')[0]);
  ok('the other three tiers do not depend on movement', (rep.by_tier.unseen_entity ?? 0) > 0 && (rep.by_tier.unseen_deployment ?? 0) > 0 && (rep.by_tier.unseen_relation ?? 0) > 0, JSON.stringify(rep.by_tier));
  ok('a tier that cannot be filled reports a shortfall instead of borrowing', Array.isArray(rep.shortfalls));
}

// Now make the fresh pull genuinely different and re-derive.
writePull(path.join(dataDir, 'pull-fresh'), { extraPool: true, movedAssetSymbol: 3, withUnseenDeployment: true }, 1_000_150);
execFileSync('node', [path.join(BENCH, 'pipeline', 'facts.mjs'), '--run', RUN, '--fresh'], { env, encoding: 'utf8' });
const freshFacts = readJsonl(path.join(dataDir, 'fresh.jsonl'));
ok('a changed value and a new entity both reach fresh.jsonl', freshFacts.length === 2 && new Set(freshFacts.map((f) => f.moved)).size === 2, JSON.stringify(freshFacts.map((f) => [f.relation, f.moved])));

const outMoved = execFileSync('node', [path.join(BENCH, 'pipeline', 'ood.mjs'), '--run', RUN], { env, encoding: 'utf8' });
const repMoved = JSON.parse(fs.readFileSync(path.join(dataDir, 'ood-report.json'), 'utf8'));
const items = readJsonl(path.join(dataDir, 'questions-fresh.jsonl'));
ok('a moved fact becomes a fresh item', repMoved.by_tier.fresh_new === 2, JSON.stringify(repMoved.by_tier));
ok('the verdict counts changed and new separately', /1 changed value beyond the scorer's ±1%, 1 did not exist at B\*/.test(repMoved.fresh_verdict), repMoved.fresh_verdict);
ok('a fresh item carries what it was', items.some((i) => i.ood_tier === 'fresh_new' && i.moved === 'changed' && i.was != null));
ok('a brand-new fact carries was = null', items.some((i) => i.ood_tier === 'fresh_new' && i.moved === 'new' && i.was === null));

// Shape, form, and the properties every row must have.
ok('every item is E1', items.every((i) => i.form === 'E1'), JSON.stringify([...new Set(items.map((i) => i.form))]));
ok('every item is taught: false', items.every((i) => i.taught === false));
ok('every item is hop 1', items.every((i) => i.hop === 1));
ok('every item names its tier', items.every((i) => typeof i.ood_tier === 'string'));
ok('every id is prefixed ood. so it can never be confused with a study item', items.every((i) => i.id.startsWith('ood.')));
ok('every id is unique', new Set(items.map((i) => i.id)).size === items.length);
ok('every item carries source_ids', items.every((i) => Array.isArray(i.source_ids) && i.source_ids.length));
ok('the file ends in a newline', fs.readFileSync(path.join(dataDir, 'questions-fresh.jsonl'), 'utf8').endsWith('\n'));

// The mirror: run.mjs reads data/<runId>/questions.jsonl and data/<runId>/pull/manifest.json, nothing else.
{
  const mdir = path.join(root, 'data', `${RUN}-ood`);
  ok('the mirror is byte-identical to questions-fresh.jsonl',
    fs.readFileSync(path.join(mdir, 'questions.jsonl'), 'utf8') === fs.readFileSync(path.join(dataDir, 'questions-fresh.jsonl'), 'utf8'));
  ok('the mirror carries the pull the runner insists on', fs.existsSync(path.join(mdir, 'pull', 'manifest.json')));
  ok('the mirror SYMLINKS the pull rather than copying it', fs.lstatSync(path.join(mdir, 'pull')).isSymbolicLink());
}

// The unseen-deployment tier really is unseen, and the unseen-entity tier really is on a seen deployment.
{
  const split = JSON.parse(fs.readFileSync(path.join(dataDir, 'split.json'), 'utf8'));
  const facts = new Map(readJsonl(path.join(dataDir, 'facts.jsonl')).map((f) => [f.fact_id, f]));
  const trainedDeps = new Set(split.study_fact_ids.map((id) => facts.get(id)?.source.deployment_id).filter(Boolean));
  const dep = items.filter((i) => i.ood_tier === 'unseen_deployment');
  const ent = items.filter((i) => i.ood_tier === 'unseen_entity');
  ok('unseen_deployment items come from a deployment no study fact came from', dep.length > 0 && dep.every((i) => !trainedDeps.has(i.source.deployment_id)));
  ok('unseen_entity items come from a deployment the study DID use', ent.length > 0 && ent.every((i) => trainedDeps.has(i.source.deployment_id)));
  const rel = items.filter((i) => i.ood_tier === 'unseen_relation');
  ok('unseen_relation items use a relation facts.mjs never extracts',
    rel.length > 0 && rel.every((i) => !readJsonl(path.join(dataDir, 'facts.jsonl')).some((f) => f.relation === i.fact_ids[0].split(':')[0])));
  ok('unseen_relation items say the entity itself was trained', rel.every((i) => i.subject_is_trained_entity === true && typeof i.trained_sibling_relation === 'string'));
}

// Stratification: the bucket must not inherit the fact universe's dominant relation.
{
  const ent = items.filter((i) => i.ood_tier === 'unseen_entity');
  const byRel = {};
  for (const i of ent) byRel[i.fact_ids[0].split(':')[0]] = (byRel[i.fact_ids[0].split(':')[0]] ?? 0) + 1;
  const top = Math.max(...Object.values(byRel));
  ok('unseen_entity is relation-stratified, not 80% one relation', top <= Math.ceil(ent.length / 2), JSON.stringify(byRel));
}

/* --- every disjointness check goes red when the set is poisoned ---------------------------------------- */
// pipeline/ood.mjs resolves its data root ONCE, at import. So the fixture half and the data/r1 half each get
// their own module instance, distinguished by a cache-busting query string, rather than one instance being
// asked to change its mind about where the data lives.
const OOD_URL = 'file://' + path.join(BENCH, 'pipeline', 'ood.mjs');
process.env.AINIZE_BENCH_DATA = root;
const fixtureMod = await import(`${OOD_URL}?fixture`);
const { build, checkDisjoint, checkSchema, loadStudy, resolveJsonPath } = fixtureMod;
{
  const built = build(RUN);
  const study = built.study;
  ok('the clean set passes every disjointness check', checkDisjoint(built.items, study).length === 0, JSON.stringify(checkDisjoint(built.items, study)));
  ok('the clean set passes the schema check', checkSchema(built.items).length === 0, JSON.stringify(checkSchema(built.items).slice(0, 3)));

  const poison = (mut) => { const c = built.items.map((x) => ({ ...x })); mut(c); return checkDisjoint(c, study).map((f) => f.check); };
  const trainedFid = [...study.studyFactIds][0];
  const askedFid = [...study.askedFactIds].find((f) => !study.studyFactIds.has(f)) ?? [...study.askedFactIds][0];
  ok('D1 fires on a trained fact', poison((c) => { c[0].fact_ids = [trainedFid]; }).some((n) => n.startsWith('D1')));
  ok('D2 fires on a fact the 250 already asks', poison((c) => { c[0].fact_ids = [askedFid]; }).some((n) => n.startsWith('D2')));
  ok('D3 fires on a repeated study question', poison((c) => { c[0].question = [...study.studyQuestions][0]; }).some((n) => n.startsWith('D3')));
  ok('D4 fires on a repeated training prompt', poison((c) => { c[0].question = [...study.trainPrompts][0]; }).some((n) => n.startsWith('D4')));
  ok('D6 fires when the answer is printed in the question', poison((c) => { c[0].question = `what about ${c[0].truth}?`; c[0].truth = String(c[0].truth); }).some((n) => n.startsWith('D6')));
  ok('D7 fires when an item claims to be taught', poison((c) => { c[0].taught = true; }).some((n) => n.startsWith('D7')));
  ok('D8 fires on a duplicate id', poison((c) => { c[1].id = c[0].id; }).some((n) => n.startsWith('D8')));
  // The fresh tier's exemption from D1-D3, and the check that keeps the exemption honest.
  const staleItem = built.items.find((i) => i.ood_tier === 'fresh_new' && study.studyFactIds.has(i.fact_ids[0]));
  ok('the fixture produced a fresh item that supersedes a TRAINED fact', !!staleItem, JSON.stringify(built.items.filter((i) => i.ood_tier === 'fresh_new').map((i) => [i.id, i.fresh_supersedes_trained_fact])));
  ok('D1 does not fire on it — a trained fact whose value moved is the point of the fresh tier',
    !checkDisjoint(built.items, study).some((f) => f.check.startsWith('D1')));
  ok('it is flagged rather than silently included', staleItem?.fresh_supersedes_trained_fact === true);
  ok('D9 fires when a fresh truth equals the pinned one',
    poison((c) => { const i = c.findIndex((x) => x.ood_tier === 'fresh_new' && study.byId.has(x.fact_ids[0])); c[i].truth = study.byId.get(c[i].fact_ids[0]).object; }).some((n) => n.startsWith('D9')));
  ok('D9 passes on the real fresh items, whose truths do differ',
    !checkDisjoint(built.items, study).some((f) => f.check.startsWith('D9')));
  ok('the schema check fires on an unknown field', checkSchema([{ ...built.items[0], nonsense: 1 }]).some((s) => /nonsense/.test(s)));
  ok('the schema check fires on a missing required field', checkSchema([{ ...built.items[0], truth: undefined }]).some((s) => /truth/.test(s)));
  ok('the schema check fires on an answer_type the scorer has no rule for', checkSchema([{ ...built.items[0], answer_type: 'prose' }]).some((s) => /prose/.test(s)));

  // loadStudy must refuse to believe a trainset that does not re-derive from the split.
  const tsPath = path.join(dataDir, 'trainset.jsonl');
  const ts = fs.readFileSync(tsPath, 'utf8');
  fs.writeFileSync(tsPath, ts + JSON.stringify({ prompt: 'a prompt no fact produces', answer: 'x' }) + '\n');
  let threw = false;
  try { loadStudy(RUN); } catch { threw = true; }
  fs.writeFileSync(tsPath, ts);
  ok('loadStudy throws when a training row does not re-derive from split.study_fact_ids', threw);
}

/* --- the json_path resolver, which is what makes a truth auditable ------------------------------------- */
{
  const doc = { data: { vaults: [{ symbol: 'A', fees: [{ feeType: 'MANAGEMENT_FEE', feePercentage: '1' }, { feeType: 'PERFORMANCE_FEE', feePercentage: '20' }], inputToken: { id: '0xabc' } }], pools: [{ inputTokens: [{ symbol: 'X' }, { symbol: 'Y' }] }] } };
  ok('resolver walks a field', resolveJsonPath(doc, '$.data.vaults[0].symbol') === 'A');
  ok('resolver walks a nested object', resolveJsonPath(doc, '$.data.vaults[0].inputToken.id') === '0xabc');
  ok('resolver walks the named fees[performance] index', resolveJsonPath(doc, '$.data.vaults[0].fees[performance].feePercentage') === '20');
  ok('resolver fans out over [*]', JSON.stringify(resolveJsonPath(doc, '$.data.pools[0].inputTokens[*].symbol')) === '["X","Y"]');
  ok('resolver returns undefined for a path that is not there', resolveJsonPath(doc, '$.data.vaults[9].symbol') === undefined);
}

fs.rmSync(root, { recursive: true, force: true });
delete process.env.AINIZE_BENCH_DATA;
const realMod = await import(`${OOD_URL}?real`);

/* ========================================================================================================= *
 * PART 2 — the committed data/r1, read-only
 * ========================================================================================================= */
const R1 = path.join(BENCH, 'data', 'r1');
if (!fs.existsSync(path.join(R1, 'questions-fresh.jsonl'))) {
  console.log('  SKIP  part 2 — data/r1/questions-fresh.jsonl has not been generated');
} else {
  const real = readJsonl(path.join(R1, 'questions-fresh.jsonl'));
  const rep = JSON.parse(fs.readFileSync(path.join(R1, 'ood-report.json'), 'utf8'));
  const study = realMod.loadStudy('r1');

  ok('r1: the committed bucket passes every disjointness check', realMod.checkDisjoint(real, study).length === 0, JSON.stringify(realMod.checkDisjoint(real, study)));
  ok('r1: the committed bucket passes the schema check', realMod.checkSchema(real).length === 0, JSON.stringify(realMod.checkSchema(real).slice(0, 3)));
  ok('r1: the report agrees with the file', rep.items === real.length);
  ok('r1: no item asks about an entity the 250 asks about', real.filter((i) => i.ood_tier !== 'unseen_relation')
    .every((i) => !study.askedEntities.has(String(i.subject ?? '').toLowerCase())));

  // The id scheme has to match facts.mjs's, or a minted fact could collide with an extracted one.
  const anyFact = study.facts[0];
  const mint = (rel, sub) => `${rel}:${createHash('sha256').update(String(sub).toLowerCase()).digest('hex').slice(0, 12)}`;
  ok('r1: the fact-id scheme this file mints matches the one facts.mjs extracts', mint(anyFact.relation, anyFact.subject) === anyFact.fact_id);

  // Every truth re-reads out of the committed bytes. This is the audit trail, so it is checked on every row.
  let unreadable = [];
  for (const it of real) {
    const [file, expr] = String(it.source.json_path).split('#');
    const fresh = it.ood_tier === 'fresh_new';
    const p = path.join(R1, fresh ? 'pull-fresh' : 'pull', file);
    if (!fs.existsSync(p)) { unreadable.push(`${it.id}: no ${p}`); continue; }
    const seen = realMod.resolveJsonPath(JSON.parse(fs.readFileSync(p, 'utf8')), expr);
    const norm = (v) => JSON.stringify(Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : String(v).toLowerCase());
    const want = Array.isArray(it.truth) ? it.truth : [it.truth];
    const eq = it.answer_type === 'decimal'
      ? Math.abs(Number(seen) - Number(it.truth)) / Math.abs(Number(it.truth) || 1) <= 0.01
      : norm(seen) === norm(Array.isArray(it.truth) ? it.truth : it.truth);
    if (!eq) unreadable.push(`${it.id}: ${JSON.stringify(seen)} != ${JSON.stringify(it.truth)}`);
    void want;
  }
  ok('r1: every truth re-reads out of the committed pull at the json_path it claims', unreadable.length === 0, unreadable.slice(0, 3).join('\n        '));

  // Arm B queries the live head, so an OOD truth that moves scores arm B wrong for being right about now.
  const moved = real.filter((i) => i.ood_tier !== 'fresh_new' && i.ood_stability?.checked && i.ood_stability.stable === false);
  ok('r1: no non-fresh item has a truth that moved between the two committed pulls', moved.length === 0, moved.map((i) => i.id).join(', '));
  const unchecked = real.filter((i) => i.ood_tier !== 'fresh_new' && !i.ood_stability?.checked);
  ok('r1: every non-fresh item was checked against the second pull', unchecked.length === 0, `${unchecked.length} unchecked`);

  // The frozen study must be untouched by everything this pipeline added.
  const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
  ok('r1: the study still has exactly 250 items', readJsonl(path.join(R1, 'questions.jsonl')).length === 250);
  ok('r1: the trainset still has exactly 120 rows', readJsonl(path.join(R1, 'trainset.jsonl')).length === 120);
  ok('r1: split.json still declares the pre-registered buckets',
    JSON.stringify(JSON.parse(fs.readFileSync(path.join(R1, 'split.json'), 'utf8')).buckets_declared) === JSON.stringify({ headline: 120, korean: 40, ceiling: 40, tripwire: 30, multihop: 20 }));
  ok('r1: no study item carries an ood_tier', readJsonl(path.join(R1, 'questions.jsonl')).every((q) => q.ood_tier === undefined));
  void sha;

  // The tiers are declared before the draw; a shortfall is reported rather than topped up.
  for (const [tier, n] of Object.entries(realMod.TIER_SIZES)) {
    if (n == null) continue;
    const got = real.filter((i) => i.ood_tier === tier).length;
    ok(`r1: ${tier} is ${n} or reports a shortfall`, got === n || rep.shortfalls.some((s) => s.startsWith(tier)), `${got}/${n}, shortfalls=${JSON.stringify(rep.shortfalls)}`);
  }

  // The never-extracted relations must genuinely be absent from the study's fact universe.
  const extras = realMod.extractExtra('r1');
  const studyRelations = new Set(study.facts.map((f) => f.relation));
  ok('r1: the unseen relations appear in NO fact of facts.jsonl',
    [...new Set(extras.map((f) => f.relation))].every((r) => !studyRelations.has(r)),
    [...new Set(extras.map((f) => f.relation))].join(','));
  ok('r1: the unseen relations appear in NO question of the 250',
    readJsonl(path.join(R1, 'questions.jsonl')).every((q) => q.fact_ids.every((f) => !String(f).startsWith('market_asset_address:') && !String(f).startsWith('pool_token_addresses:'))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
