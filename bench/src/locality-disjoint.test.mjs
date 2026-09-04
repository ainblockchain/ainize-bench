/**
 * The locality set must ask about knowledge the patch was never told. There are FOUR ways to violate that
 * and only the first is obvious, so each gets the instrument that can actually see it.
 *
 *  1. the trainset             - asking a trained question outright
 *  2. the trainer's contrast   - the corpus mixes teach_contrast.json in as contrast, so the patch is
 *                                explicitly optimised to preserve those answers; a locality item drawn from
 *                                that well reports zero damage however much damage there is
 *  3. the shipped publish gate - packages/core DEFAULT_LOCALITY_PROMPTS, for the same reason
 *  4. a trained fact REVERSED  - the trainset teaches "address of bcrvTricrypto -> 0xbe08..."; an item asking
 *                                "symbol of 0xbe08... -> bcrvTricrypto" is the same (subject, object) pair the
 *                                other way round. It probes the reversal curse, not locality. This one is
 *                                invisible to a fact-id check (the ids differ: vault_symbol vs vault_address)
 *                                AND to string similarity (the templates differ), which is exactly why it
 *                                survived into a committed set until an entity-pair check went looking.
 *
 * On instruments, because the wrong one produced both a false positive and a false negative here:
 *   - the FAR half is general knowledge, so answers are high-cardinality and "same answer" is meaningful
 *   - the NEAR half deliberately REUSES the trainset's templates with untrained entities, so string
 *     similarity flags its whole reason to exist (0.70 on a correct item), and low-cardinality answers make
 *     "same answer" meaningless too - the trainset has 13 fee rows across 3 distinct values, so a fee
 *     locality item cannot avoid reusing one
 *   - therefore the near half is checked by ENTITY and by PAIR, never by string or by answer
 *
 * Also: any trigram check must SLIDE. `.match(/.{1,3}/g)` chunks from the start, so a one-word prefix
 * ("In what year..." vs "What year...") shifts every chunk and a 0.94 near-duplicate scores near zero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(BENCH, '..', '..');
const CONTRAST = '/mnt/newdata/qwen3.8/train/teach_contrast.json';
const rd = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const N = (s) => String(s ?? '').toLowerCase().trim();
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
const tri = (s) => { const n = norm(s), o = new Set(); for (let i = 0; i + 3 <= n.length; i++) o.add(n.slice(i, i + 3)); return o; };
const jac = (a, b) => { const u = new Set([...a, ...b]); return u.size ? [...a].filter((x) => b.has(x)).length / u.size : 0; };
const gatePrompts = () => [...readFileSync(join(REPO, 'packages', 'core', 'src', 'config.ts'), 'utf8')
  .split('DEFAULT_LOCALITY_PROMPTS: string[] = [')[1].split('];')[0].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
const contrastPairs = () => { const raw = JSON.parse(readFileSync(CONTRAST, 'utf8')); return (Array.isArray(raw) ? raw : raw.contrast || raw.items).map((p) => ({ prompt: p.prompt, answer: p.answer ?? p.expect })); };

/**
 * Expected answers for the gate's factual prompts, kept HERE rather than in the product: the shipped gate
 * deliberately stores none, because it compares the patched model's output to the base model's own output and
 * so works for open-ended prompts too. But a disjointness check needs them, for a reason worth stating.
 *
 * Leakage is about the ANSWER, not the sentence. Judged on string similarity alone, "What is the capital of
 * France?" and "What is the capital of Japan?" score 0.64 - same template, different fact - and training on
 * Tokyo does not pre-secure Paris. A rule that rejected those would reject most of any general-knowledge
 * contrast set anyone writes later. So: a collision is an identical question, or a paraphrase that SHARES the
 * answer. `null` marks a prompt with no single right answer, which can only ever collide verbatim.
 */
const GATE_ANSWERS = new Map([
  ['What is the capital of France?', 'Paris'],
  ['Write one sentence about the ocean.', null],
  ['Translate "good morning" into Spanish.', 'buenos días'],
  ['What is 17 + 25?', '42'],
  ['Name three primary colors.', null],
  ['Write a Python function that returns the square of a number.', null],
  ['What year did the first human land on the Moon?', '1969'],
  ['Summarize the water cycle in one sentence.', null],
  ['What is the chemical symbol for gold?', 'Au'],
  ['List the days of the week.', null],
  ['대한민국의 수도는 어디입니까?', '서울'],
  ['1부터 10까지 더하면 얼마입니까?', '55'],
]);

/**
 * Same fact: the identical question, or a paraphrase arriving at the same answer.
 *
 * `crossLingual` exists because a jaccard threshold cannot see a translation. The trainer's contrast set had
 * "What is the boiling point of water in Celsius?" answering 100, and the locality set asks
 * "표준 대기압에서 물이 끓는 온도는 섭씨 몇 도입니까?" answering 100 - the same fact in two languages, sharing
 * almost no trigrams, so every similarity threshold scores it clean. Ainize trains and serves in both
 * languages, so cross-lingual leakage is the normal case here rather than an edge one.
 *
 * The asymmetry in strictness is deliberate. Contrast items are OURS TO CHOOSE, so forbidding them any shared
 * answer costs nothing and removes the whole class. The locality set cannot be held to that: the near half
 * draws on low-cardinality answer spaces (13 fee rows across 3 distinct values), so requiring unique answers
 * there would delete whole relations from the set.
 */
const sameFact = (qa, qb, aa, ab, { crossLingual = false } = {}) => {
  if (norm(qa) === norm(qb)) return 'identical question';
  if (aa == null || ab == null || norm(aa) !== norm(ab)) return null;
  if (crossLingual) return 'same answer';
  const j = jac(tri(qa), tri(qb));
  return j >= 0.3 ? `same answer, paraphrase ${j.toFixed(2)}` : null;
};
const noContrastFile = existsSync(CONTRAST) ? false : 'trainer contrast file is not on this machine';

const near = rd(join(BENCH, 'locality', 'near.jsonl'));
const control = rd(join(BENCH, 'locality', 'control.jsonl'));
const all = [...near, ...control];
const facts = rd(join(BENCH, 'data', 'r1', 'facts.jsonl'));
const split = JSON.parse(readFileSync(join(BENCH, 'data', 'r1', 'split.json'), 'utf8'));
const trainset = rd(join(BENCH, 'data', 'r1', 'trainset.jsonl'));
const study = new Set(split.study_fact_ids);

test('no locality item asks a trainset question', () => {
  const q = new Set(trainset.map((r) => norm(r.prompt)));
  const hit = all.filter((it) => q.has(norm(it.question ?? it.prompt)));
  assert.deepEqual(hit.map((x) => x.id), [], 'these ask a question the patch was trained on');
});

test('no locality item is a trained fact with its subject and object swapped', () => {
  const pairs = new Map();
  for (const f of facts) if (study.has(f.fact_id)) pairs.set([N(f.subject), N(f.object)].sort().join(' '), f);
  // A zero here would make the assertion below pass vacuously, which is how the defect hid in the first place.
  assert.ok(pairs.size > 100, `expected the trained pairs to join; got ${pairs.size} - check the key is fact_id, not id`);
  const hit = all.filter((it) => pairs.has([N(it.subject), N(it.truth)].sort().join(' ')));
  assert.deepEqual(hit.map((x) => x.id), [], 'these are a trained fact asked backwards - a reversal probe, not a locality probe');
});

test('the gate answer table still matches the shipped gate', { skip: noContrastFile }, () => {
  const gate = gatePrompts();
  assert.equal(gate.length, 12, 'the shipped gate should still be twelve prompts');
  // If someone edits DEFAULT_LOCALITY_PROMPTS, the table above goes stale and the checks below would pass
  // vacuously on the prompts it no longer knows. Fail loudly instead.
  assert.deepEqual(gate.filter((g) => !GATE_ANSWERS.has(g)), [], 'gate prompt has no entry in GATE_ANSWERS - add its answer, or null if it has no single right one');
});

test('the FAR half reuses neither the trainer contrast set nor the shipped publish gate', { skip: noContrastFile }, () => {
  const refs = [...contrastPairs(), ...gatePrompts().map((p) => ({ prompt: p, answer: GATE_ANSWERS.get(p) }))];
  const bad = [];
  for (const it of control) {
    const q = it.question ?? it.prompt;
    const a = Array.isArray(it.truth) ? it.truth.join(' ') : it.truth;
    // Contrast items are ours to choose, so they may share NO answer with a locality item, in any language.
    for (const r of refs) { const why = sameFact(q, r.prompt, a, r.answer, { crossLingual: true }); if (why) bad.push(`${it.id}: ${why} <- ${r.prompt}`); }
  }
  assert.deepEqual(bad, [], 'these locality items are trained or gated, so they would report zero damage however much damage there is');
});

test('the trainer contrast set is disjoint from the shipped publish gate', { skip: noContrastFile }, () => {
  const bad = [];
  for (const g of gatePrompts()) for (const c of contrastPairs()) {
    const why = sameFact(g, c.prompt, GATE_ANSWERS.get(g), c.answer);
    if (why) bad.push(`${why}:  ${g}  <->  ${c.prompt}`);
  }
  assert.deepEqual(bad, [], 'a patch trained with this contrast set is optimised to pass part of its own publish gate');
});

/**
 * THE STUDY'S OWN REVERSAL CHECK — the validity-critical one, and the reason it lives beside the locality
 * assertions rather than in the runner: it is the same defect class, and it was found by pointing the
 * locality set's check at the study.
 *
 * §1 makes arm C FAILING the held-out facts the experiment's own validity condition ("if it does not, the run
 * is void"). A tripwire item whose inverse is taught could be answered by reversal rather than by knowledge,
 * and it would fail in the direction we expect — so a void would look like leakage, or leakage like a pass,
 * with nothing in the output to distinguish them. Measured zero, not assumed zero.
 *
 * The universe is every fact the STUDY touches (186), not the 120 trained ones. A check walking only the
 * trainset cannot see a pair whose second member is a held-out fact or a hop-2 operand, which is exactly how
 * this was under-counted at 3 before it was reconciled to 5.
 *
 * The bidirectional pairs that DO exist are declared, not removed. Both members of a pair are legitimately
 * taught and legitimately asked, so arm C answering them earns no unearned credit; what is overstated is the
 * corpus's INDEPENDENCE — 186 study facts span 184 distinct pairs — and that is a sentence a reader can check
 * against the data rather than a caveat they have to trust.
 */
const questions = rd(join(BENCH, 'data', 'r1', 'questions.jsonl'));
const factById = new Map(facts.map((f) => [f.fact_id, f]));
const studyUniverse = [...new Set(questions.flatMap((x) => x.fact_ids ?? []))];
/**
 * UNORDERED key: {subject, object} as a set, so a fact and its inverse collapse to one key. The `.sort()` is
 * the whole mechanism and it is easy to read past, so state what it buys - the ORDERED count is 186 (every
 * fact its own key) and the UNORDERED count is 184, and the difference between them IS the quantity being
 * reported. Both numbers are correct about different questions; §1 must say which one it means, because the
 * notation "(subject, object)" reads as ordered while the number quoted there is unordered.
 */
const unorderedPairKey = (f) => [N(f.subject), N(f.object)].sort().join(' | ');
const bucketOf = (x) => (x.hop === 2 ? 'multihop' : !x.taught ? 'tripwire' : x.form === 'E1' ? 'headline' : x.form === 'E2' ? 'korean' : 'ceiling');

test('every fact the study references resolves, so the pair check cannot pass vacuously', () => {
  assert.deepEqual(studyUniverse.filter((id) => !factById.has(id)), [], 'unresolved fact ids would make the reversal check partial while still reporting a number');
  assert.ok(studyUniverse.length > 150, `expected the study to touch ~186 facts; got ${studyUniverse.length}`);
});

test('no TRIPWIRE item can be answered by reversing a fact the study teaches', () => {
  const byPair = new Map();
  for (const id of studyUniverse) { const f = factById.get(id); const k = unorderedPairKey(f); if (!byPair.has(k)) byPair.set(k, []); byPair.get(k).push(f); }
  const bidirectional = new Set([...byPair.values()].filter((v) => v.length > 1).flatMap((v) => v.map((f) => f.fact_id)));
  const tripwireHits = questions.filter((x) => bucketOf(x) === 'tripwire' && (x.fact_ids ?? []).some((fid) => bidirectional.has(fid)));
  assert.deepEqual(tripwireHits.map((x) => x.id), [], 'a held-out item answerable by reversal makes the void condition unreadable: a void would look like leakage and leakage like a pass');
});

test('the declared bidirectional pair count still matches the data', () => {
  const byPair = new Map();
  for (const id of studyUniverse) { const f = factById.get(id); const k = unorderedPairKey(f); if (!byPair.has(k)) byPair.set(k, []); byPair.get(k).push(f); }
  // A Map keyed by pair would OVERWRITE here, blinding the detector to the thing it detects. List per pair.
  const bidirectional = [...byPair.values()].filter((v) => v.length > 1);
  assert.equal(bidirectional.length, 2, 'the number of both-direction pairs changed - update §1 rather than this assertion');
  // UNORDERED count. If §1 is ever "corrected" to the ordered count (186), this fails - and the fix is §1,
  // not this line. Ordered keying gives every fact its own key and can never show a collapse.
  assert.equal(byPair.size, studyUniverse.length - bidirectional.length, `unordered pairs should be ${studyUniverse.length} facts less one per bidirectional pair`);
});
