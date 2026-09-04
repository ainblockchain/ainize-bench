/**
 * Self-test for the locality set and its runner. `node src/locality.test.mjs` — no GPU, no network, no patch,
 * no server, no request to any vLLM port. Everything the live capture will depend on is decided here:
 *
 *  - the 50 are the composition they claim to be, and prompts.jsonl is exactly what its two halves derive to;
 *  - every ground truth in the file scores as a `hit` under its own item's rule — a truth that cannot score
 *    itself is a truth nobody can be marked wrong against;
 *  - all five scoring modes land the answer shapes a real model produces on the intended verdict;
 *  - the noise-floor arithmetic is checked against hand-computed Wilson bounds, including the cases that must
 *    NOT be counted (an item whose own repeats disagreed, an item that errored);
 *  - the overlap assertion FIRES: ten planted collisions, one per rule and one per rule variant. A check that
 *    has never failed is not evidence, it is a green light welded on;
 *  - the restart refusal FIRES: on a changed Cmd, on a restart, on a recreate, on a swapped container, and on
 *    a container that could not be read at all — "we could not tell" is not "it did not happen";
 *  - the restore proof FIRES: a sampled status, a row left dirty, a status that compared against the wrong
 *    baseline, and a missing machine line are all refusals, not warnings.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPromptSet, buildPromptSet, serialisePromptSet, validatePromptSet, loadTrained, assertNoTrainsetOverlap,
  scoreLocality, scoreRubric, answerKey, bleedSigns, indexPhase, noiseFloor, compareRuns, engineSnapshot,
  movedMoreThanTheEngine,
  engineChanged, assertSameEngine, assertTableRestored, patchPy, acquireRuntimeLock, containsSpec, modeFor,
  truthAtoms, STRATA, MODES, RESELECTED, PROMPTS_PATH, R1, BENCH,
} from './locality.mjs';
import { buildTrainsetGuard } from './locality-control.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};
const throws = (name, fn, re) => {
  try { fn(); fail++; console.error(`FAIL ${name}\n  expected a throw, got none`); }
  catch (e) { if (re.test(e.message)) pass++; else { fail++; console.error(`FAIL ${name}\n  message ${e.message}`); } }
};

const items = loadPromptSet();
const byId = Object.fromEntries(items.map((i) => [i.id, i]));
const v = (answer, id) => scoreLocality(answer, byId[id]).verdict;

// ---- the set ---------------------------------------------------------------------------------------------
t('50 items', items.length, 50);
t('strata as declared', Object.fromEntries(Object.keys(STRATA).map((s) => [s, items.filter((i) => i.stratum === s).length])), STRATA);
t('every mode in the file is one of the five', [...new Set(items.map((i) => i.scoring.mode))].filter((m) => !MODES.has(m)), []);
t('all five modes are exercised', new Set(items.map((i) => i.scoring.mode)).size, 5);
t('both halves are present', Object.fromEntries(['near', 'control'].map((h) => [h, items.filter((i) => i.half === h).length])), { near: 20, control: 30 });
t('ten items are Korean', items.filter((i) => i.lang === 'ko').length, 10);
t('every control item and every re-selected item carries its rationale in the file (the near half keeps its own in NEAR.md)',
  items.filter((i) => (i.half === 'control' || i.superseded) && !i.why?.trim()).length, 0);
t('prompts.jsonl is byte-identical to what its two halves derive to', serialisePromptSet(buildPromptSet()), readFileSync(PROMPTS_PATH, 'utf8'));
t('every adjacent-entity item records the trained neighbour it sits next to',
  items.filter((i) => i.stratum === 'adjacent-entity' && !i.adjacency?.nearest_trained_fact_id).length, 0);
t('every conceptual item is scored by a rubric with at least three slots',
  items.filter((i) => i.stratum === 'near-domain' && (i.rubric?.must_include?.length ?? 0) < 3).length, 0);
throws('a set that is short of its declared strata is refused', () => validatePromptSet(items.slice(0, 49)), /stratum calibration has 3 items, declared 4/);
throws('an unknown scoring mode is refused', () => validatePromptSet(items.map((i) => (i.id === 'loc-adj-01' ? { ...i, scoring: { mode: 'vibes' } } : i))), /unknown scoring mode/);

// ---- every truth scores itself ---------------------------------------------------------------------------
const DECLINATION = {
  'ctl.cal.01': 'I have no way to know what you ate this morning.',
  'ctl.cal.02': 'He never won the Nobel Prize in Chemistry; his prize was in Physics.',
  'ctl.cal.03': 'There is no country called Kelmoria, so I cannot say.',
  'ctl.cal.04': 'I have no access to live weather data.',
};
const selfScore = (it) => {
  if (it.scoring.mode === 'refusal') return scoreLocality(DECLINATION[it.id], it).verdict;
  if (it.scoring.mode === 'contains' && it.rubric) return scoreRubric(it.rubric.must_include.map((s) => s[0]).join(' … '), it).verdict;
  if (it.scoring.mode === 'contains') return scoreLocality(it.accept[0], it).verdict;
  if (it.answer_type === 'format') {
    const f = it.format;
    const answer = f.kind === 'json_keys' ? JSON.stringify(f.values)
      : f.kind === 'list_exact' ? f.items.join(', ')
      : f.kind === 'exact_token' ? f.token
      : String(it.truth);
    return scoreLocality(answer, it).verdict;
  }
  return scoreLocality(Array.isArray(it.truth) ? it.truth.join(', ') : String(it.truth), it).verdict;
};
t('every one of the 50 truths scores as a hit against its own item', items.filter((i) => selfScore(i) !== 'hit').map((i) => i.id), []);

// ---- mode: exact-normalised ------------------------------------------------------------------------------
t('list<symbol>: exact set, order-insensitive', v('BUIDL, XIO', 'loc-adj-01'), 'hit');
t('list<symbol>: a partial answer is wrong, not half-right', v('XIO', 'loc-adj-01'), 'wrong');
t('list<symbol>: partial is reported beside the verdict, never blended in', scoreLocality('XIO', byId['loc-adj-01']).partial, 0.5);
t('list<symbol>: the nearest trained pair instead of the truth', v('SPURDO, WETH', 'loc-adj-01'), 'wrong');
t('symbol: casing and punctuation are not part of the claim', v('"bcrvrenwbtc".', 'loc-adj-08'), 'hit');
t('symbol: a different symbol is wrong', v('bcrvTricrypto', 'loc-adj-08'), 'wrong');
t('address: checksum casing is not part of the claim', v('0x766175EAC1A99C969DDD1EBDBE7E270D508D8FFF', 'loc-adj-10'), 'hit');
t('address: listing several addresses is ambiguous, not a hit', v('It is 0x0000000000000000000000000000000000000001 or 0x766175eac1a99c969ddd1ebdbe7e270d508d8fff', 'loc-adj-10'), 'ambiguous');
t('an English declination is an abstention, never damage', v('I do not know.', 'loc-adj-01'), 'abstain');
t('an empty answer is an error, not a miss', v('', 'loc-adj-01'), 'error');

// ---- mode: numeric ---------------------------------------------------------------------------------------
t('decimal: the untrained fee', v('9.5', 'loc-adj-05'), 'hit');
t('decimal: a percent sign is formatting', v('9.5%', 'loc-adj-05'), 'hit');
t('decimal: the nearest trained fee is a miss', v('2.5', 'loc-adj-05'), 'wrong');
t('integer: the first integer is the answer', v('1912', 'ctl.far.01'), 'hit');
t('integer: a reply that shows its working is ambiguous (inherited from normalize.mjs, not relaxed)', v('17 x 23 = 391', 'ctl.far.09'), 'ambiguous');
t('number_only: the fact in the wrong shape is a FORMAT miss, not a knowledge loss',
  (() => { const r = scoreLocality('There are 366 days.', byId['ctl.fmt.02']); return [r.verdict, r.content_ok, r.format_ok, r.reason]; })(), ['wrong', true, false, 'format']);
t('number_only: bare number', v('366', 'ctl.fmt.02'), 'hit');

// ---- mode: contains --------------------------------------------------------------------------------------
t('rubric: every slot satisfied', v('ERC-4626 is a tokenized vault standard built on ERC-20. It fixes deposit and withdraw, mint and redeem, so a share is one interface every integrator can rely on.', 'loc-nd-01'), 'hit');
t('rubric: one slot missing is a miss, with the count reported',
  (() => { const r = scoreRubric('A tokenized vault on ERC-20 with deposit and withdraw and a share.', byId['loc-nd-01']); return [r.verdict, r.slots]; })(), ['wrong', '5/6']);
t('rubric: stems match, so "integrated" satisfies the "integrat" form',
  scoreRubric('tokenized vault, ERC-20, deposit, withdraw, share, integrated everywhere', byId['loc-nd-01']).verdict, 'hit');
t('rubric: a Korean answer is matched by substring, not by word boundary',
  v('담보 비율이 임계값 아래로 떨어지면 청산이 발생합니다.', 'loc-nd-09'), 'hit');
t('rubric: a forbidden form is a contradiction, not a missing slot',
  (() => { const it = { ...byId['loc-nd-02'], rubric: { must_include: [['x * y = k']], must_not_include: ['order book'] } };
    const r = scoreRubric('x * y = k, like an order book', it); return [r.verdict, r.reason]; })(), ['wrong', 'contradiction']);
t('accept/reject: the accepted form', v('George Washington', 'ctl.far.02'), 'hit');
t('accept/reject: the truth beside a distractor is ambiguous', v('George Washington, though some say John Adams', 'ctl.far.02'), 'ambiguous');
t('accept/reject: a distractor alone is wrong', v('John Adams', 'ctl.far.02'), 'wrong');
t('accept/reject: word boundaries, so "amp" does not fire inside "example"', v('For example, the unit is the volt', 'ctl.far.05'), 'wrong');
t('a Korean declination is an abstention, not damage (normalize.mjs alone would score it wrong)', v('모르겠습니다', 'ctl.ko.06'), 'abstain');

// ---- mode: json-shape ------------------------------------------------------------------------------------
t('json: the exact object', v('{"a": 26, "b": 6}', 'ctl.fmt.03'), 'hit');
t('json: a fenced object still counts, and the raw-parse strictness is recorded beside it',
  (() => { const r = scoreLocality('```json\n{"a": 26, "b": 6}\n```', byId['ctl.fmt.03']); return [r.verdict, r.strict_json, r.fenced]; })(), ['hit', false, true]);
t('json: prose carrying both values is a format miss with the content intact',
  (() => { const r = scoreLocality('There are 26 letters and 6 sides.', byId['ctl.fmt.03']); return [r.verdict, r.content_ok, r.format_ok]; })(), ['wrong', true, false]);
t('json: right shape, wrong value', v('{"a": 24, "b": 6}', 'ctl.fmt.03'), 'wrong');

// ---- mode: refusal ---------------------------------------------------------------------------------------
t('refusal: declining is the hit', v('I have no way to know what you ate.', 'ctl.cal.01'), 'hit');
t('refusal: inventing an answer is the damage this stratum exists for',
  scoreLocality('You had eggs and toast.', byId['ctl.cal.01']).channel, 'confidently_wrong');
t('refusal: correcting a false premise is a refusal, not a claim (the ordering is the point)',
  v('Einstein won the Nobel Prize in Physics in 1921, not Chemistry.', 'ctl.cal.02'), 'hit');
t('refusal: an abstention regex must not pre-empt the refusal rule',
  scoreLocality('I do not know — there is no country called Kelmoria.', byId['ctl.cal.03']).verdict, 'hit');

// ---- bleed signs -----------------------------------------------------------------------------------------
const trained = loadTrained();
t('bleed: the nearest trained token pair, where the truth is a different pair',
  bleedSigns('SPURDO, WETH', byId['loc-adj-01'], trained).map((s) => s.sign), ['bleed_target']);
t('bleed: the truth itself is not a bleed', bleedSigns('XIO, BUIDL', byId['loc-adj-01'], trained), []);
t('bleed: a numeric target is compared as a number — "0" is a substring of "20" and must not fire',
  bleedSigns('20', byId['loc-adj-06'], trained), []);
t('bleed: the trained fee value where an untrained one was asked for',
  bleedSigns('The performance fee is 10%.', byId['loc-adj-06'], trained).map((s) => s.value), ['10']);
t('bleed: an address in a conceptual answer, and it is one the patch was trained on',
  bleedSigns('ERC-4626 is defined at 0x26b8efa69603537ac8ab55768b6740b67664d518.', byId['loc-nd-01'], trained).map((s) => s.sign),
  ['trained_address_in_answer', 'address_in_prose']);
t('bleed: a clean conceptual answer carries none',
  bleedSigns('A tokenized vault standard on top of ERC-20.', byId['loc-nd-01'], trained), []);

// ---- the overlap assertion, poisoned once per rule --------------------------------------------------------
const guard = buildTrainsetGuard(trained.trainsetPath);
const clean = () => assertNoTrainsetOverlap(items, trained, { controlGuard: guard });
t('the real 50 pass all six rules', clean().rules_run, 6);
t('all 30 control items are additionally under the stricter guard', clean().control_items, 30);
const poison = (id, patch) => items.map((i) => (i.id === id ? { ...i, ...patch } : i));
const firstStudyFact = [...trained.studyFactIds][0];
const firstSubject = [...trained.subjects][0];
const firstAtom = [...trained.atoms].find((a) => !/^0x/.test(a) && a.length > 3);
const answerOnlyAddress = [...trained.addresses].find((a) => !trained.subjects.has(a));
const firstPrompt = readFileSync(join(R1, 'trainset.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))[0].prompt;
const fires = (name, poisoned, re) => throws(name, () => assertNoTrainsetOverlap(poisoned, trained, { controlGuard: guard }), re);
fires('T1 fires on a fact the patch was trained on', poison('loc-adj-01', { fact_ids: [firstStudyFact] }), /T1 fact .* trained on/);
fires('T1 fires on a fact the study sample asks', poison('loc-adj-01', { fact_ids: [[...trained.sampleFactIds].find((f) => !trained.studyFactIds.has(f))] }), /T1 fact .* 250-item sample/);
fires('T2 fires on a trained subject', poison('loc-adj-01', { subject: firstSubject }), /T2 its subject/);
fires('T3 fires on a trained subject smuggled into a prompt', poison('loc-nd-01', { prompt: `What is ERC-4626, as used by ${firstSubject}?` }), /T3 the prompt contains the trained subject/);
fires('T3 fires on a trained address in a prose prompt', poison('loc-nd-02', { prompt: `How does the pool at ${answerOnlyAddress} price a swap?` }), /T3 the prompt contains the trained address/);
fires('T4 fires on a trained answer atom', poison('loc-adj-08', { truth: firstAtom }), /T4 its answer .* trained answer atom/);
fires('T4 fires on a trained numeric answer — the collision that actually happened', poison('loc-adj-05', { truth: '2.5' }), /T4 its answer "2\.5"/);
fires('T4 fires on an accepted surface form, not only on the truth', poison('ctl.far.02', { accept: [firstAtom] }), /T4 its answer/);
fires('T5 fires on a verbatim trainset prompt, and reports T3 alongside it rather than stopping at the first rule',
  poison('loc-adj-01', { prompt: firstPrompt }), /T3 the prompt contains the trained subject.*T5 the prompt is verbatim a trainset prompt/);
fires('T6 fires on a trainset entity token in a control item, which the near items are allowed to carry',
  poison('ctl.far.01', { prompt: 'In which year did the liquidity pool sink? Reply with only the four-digit year.' }), /entity token/);
t('the same entity token in a NEAR item is not a collision — sharing the template vocabulary is what makes it near',
  assertNoTrainsetOverlap(poison('loc-nd-02', { prompt: 'How does a liquidity pool price a swap?' }), trained, { controlGuard: guard }).rules_run, 6);

// ---- the re-selection cannot rot into a fiction -------------------------------------------------------------
t('two near items were re-selected after the trainset was regenerated', Object.keys(RESELECTED), ['loc-adj-05', 'loc-adj-06']);
t('and both superseded truths really are trained answers today',
  Object.values(RESELECTED).map((r) => trained.atoms.has(r.superseded_truth)), [true, true]);
{
  const dir = mkdtempSync(join(tmpdir(), 'locality-r1-'));
  for (const f of ['facts.jsonl', 'split.json', 'questions.jsonl', 'pull', 'pull-fresh']) symlinkSync(join(R1, f), join(dir, f));
  const rows = readFileSync(join(R1, 'trainset.jsonl'), 'utf8').split('\n').filter(Boolean);
  writeFileSync(join(dir, 'trainset.jsonl'), rows.filter((l) => !/performance fee/.test(l)).join('\n') + '\n');
  throws('a trainset that no longer trains those answers invalidates the override rather than forking the file quietly',
    () => buildPromptSet({ r1: dir }), /RESELECTED\[loc-adj-05\] exists because .* is not one any more/);
  rmSync(dir, { recursive: true, force: true });
}

// ---- the noise floor -------------------------------------------------------------------------------------
const nItem = (id, stratum = 'far-domain') => ({ id, stratum, lang: 'en', prompt: 'p', scoring: { mode: 'numeric' }, answer_type: 'integer', truth: '5' });
const fixture = ['a', 'b', 'c', 'd'].map((x) => nItem(x));
const u = (id, phase, repeat, answer, error = null) => ({ id, phase, repeat, answer, error });
const ref = [
  u('a', 'reference', 0, '5'), u('a', 'reference', 1, '5'),          // stable hit
  u('b', 'reference', 0, '5'), u('b', 'reference', 1, '6'),          // the engine disagreeing with itself
  u('c', 'reference', 0, '7'), u('c', 'reference', 1, '7'),          // stable miss
  u('d', 'reference', 0, null, 'transport: timeout'), u('d', 'reference', 1, null, 'transport: timeout'),
];
const refIx = indexPhase(ref, fixture);
t('an item is a hit only if every non-error repeat was a hit', [refIx.get('a').hit, refIx.get('c').hit], [true, false]);
t('an item whose repeats disagreed is unstable', refIx.get('b').stable, false);
t('an item that errored twice is not comparable and carries no verdict', [refIx.get('d').comparable, refIx.get('d').scored], [false, false]);
const floor = noiseFloor(refIx);
t('the floor is measured over comparable items only', [floor.overall.comparable, floor.overall.unstable], [3, 1]);
t('the floor rate', floor.overall.rate, 1 / 3);
t('and its 95% Wilson upper bound, hand-checked', Number(floor.overall.upper.toFixed(4)), 0.7923);
t('errors are counted and reported, never silently dropped', floor.overall.errors, 2);

const post = [
  u('a', 'post-apply', 0, '5'), u('a', 'post-apply', 1, '5'),        // unchanged
  u('b', 'post-apply', 0, '5'), u('b', 'post-apply', 1, '5'),        // stable now, but the reference was not
  u('c', 'post-apply', 0, '5'), u('c', 'post-apply', 1, '5'),        // changed, and repaired
  u('d', 'post-apply', 0, '5'), u('d', 'post-apply', 1, '5'),
];
const cmp = compareRuns({ items: fixture, ref, post, trained });
const cell = cmp.per_stratum[0];
t('a change is only asserted for items stable on BOTH sides', [cell.decided, cell.undecidable], [2, 2]);
t('one item changed', [cell.changed, cell.changed_rate], [1, 0.5]);
t('and 50% does not clear a floor whose upper bound is 79%', cell.exceeds_noise_floor, false);
t('one moved within the engine and one across the patch is exactly no evidence, p = 1',
  [cell.moved_more_than_the_engine.b, cell.moved_more_than_the_engine.c, cell.moved_more_than_the_engine.p], [1, 1, 1]);
t('a miss that became a hit is a repair, reported beside regressions rather than absorbed into them',
  [cell.regressions, cell.repairs, cell.held], [0, 2, 1]);
t('an item that errored on one side is paired as an error, never as a repair',
  cmp.per_item.find((r) => r.id === 'd').pair, { status: 'error', comparable: false });
t('accuracy before and after are ground truth, not agreement', [cell.accuracy_before.hits, cell.accuracy_after.hits], [1, 4]);
{
  // A quiet engine and a patch that moved half the set: the case the instrument exists to catch.
  const its = Array.from({ length: 10 }, (_, i) => nItem(`q${i}`, 'adjacent-entity'));
  const r = its.flatMap((i) => [u(i.id, 'reference', 0, '5'), u(i.id, 'reference', 1, '5')]);
  const p = its.flatMap((i, k) => [u(i.id, 'post-apply', 0, k < 5 ? '9' : '5'), u(i.id, 'post-apply', 1, k < 5 ? '9' : '5')]);
  const c = compareRuns({ items: its, ref: r, post: p, trained }).per_stratum[0];
  t('a silent engine gives a floor of zero with a 27.75% upper bound at n=10', [c.noise_floor.rate, Number(c.noise_floor.upper95.toFixed(4))], [0, 0.2775]);
  t('and a 50% change rate clears it', [c.changed_rate, c.exceeds_noise_floor], [0.5, true]);
t('the paired test agrees: nothing moved within the engine, five moved across the patch, p = 2 x 0.5^5',
  [c.moved_more_than_the_engine.b, c.moved_more_than_the_engine.c, Number(c.moved_more_than_the_engine.p.toFixed(4))], [0, 5, 0.0625]);
  t('all five of them are regressions', c.regressions, 5);
}
t('the text key is stricter than the scored key: same verdict, different words',
  [answerKey('The answer is 5', nItem('a')) === answerKey('5', nItem('a')),
   answerKey('The answer is 5', nItem('a'), 'text') === answerKey('5', nItem('a'), 'text')], [true, false]);
throws('an item missing from one half is refused rather than compared against nothing',
  () => compareRuns({ items: fixture, ref, post: post.filter((x) => x.id !== 'a'), trained }), /missing from the post-apply phase/);

// ---- the restart refusal ---------------------------------------------------------------------------------
const snap = { container: 'flashnext-e2e', cmd: '--max-model-len 8192', restart_count: 3, started_at: '2026-09-04T09:00:00Z' };
t('an unchanged engine is not a change', engineChanged(snap, { ...snap }), false);
t('a Cmd diff is caught even when the counters look innocent', engineChanged(snap, { ...snap, cmd: '--max-model-len 32768' }), ['cmd']);
t('an in-place restart shows up as both a new StartedAt and a higher RestartCount',
  engineChanged(snap, { ...snap, restart_count: 4, started_at: '2026-09-04T10:00:00Z' }), ['recreated_or_restarted', 'restart_count 3→4']);
t('a recreated container resets the counter, which is still a change', engineChanged(snap, { ...snap, restart_count: 0, started_at: '2026-09-04T10:00:00Z' }), ['recreated_or_restarted', 'restart_count 3→0']);
t('two identical snapshots are accepted', assertSameEngine([snap, { ...snap }, { ...snap }]), true);
throws('a comparison across a restart is refused', () => assertSameEngine([snap, { ...snap, restart_count: 4 }]), /changed between the reference and the post-apply run/);
throws('a comparison across a swapped container is refused', () => assertSameEngine([snap, { ...snap, container: 'other' }]), /changed between the reference/);
throws('a container that could not be read at all is also a refusal — "we could not tell" is not "it did not happen"',
  () => assertSameEngine([{ container: null, cmd: null, restart_count: null, started_at: null }, snap]), /could not be identified/);
t('engineSnapshot reads the four fields run.mjs reads, from the host',
  engineSnapshot('http://localhost:8002', { sh: (c) => (c.includes('docker ps') ? 'flashnext-e2e' : c.includes('.Config.Cmd') ? '--x 1' : c.includes('RestartCount') ? '2' : '2026-09-04T09:00:00Z') }).container,
  'flashnext-e2e');
t('and records nulls rather than guessing when nothing is published on that port',
  engineSnapshot('http://localhost:8002', { sh: () => null }), { container: null, cmd: null, restart_count: null, started_at: null, read_at: engineSnapshot('http://localhost:8002', { sh: () => null }).read_at });

// ---- the restore proof -----------------------------------------------------------------------------------
const restored = { applied: false, sampled: 4096, rows: 4096, at_after: 0, at_prev: 4096, baseline: 'journal' };
t('a table proven back, row by row, against the journal this run wrote', assertTableRestored(restored), true);
throws('a sampled status is not a restore check', () => assertTableRestored({ ...restored, sampled: 2000 }), /sampled 2000 of 4096/);
throws('one row left dirty fails the run loudly', () => assertTableRestored({ ...restored, at_prev: 4095 }), /1 of 4096 rows did NOT come back/);
throws('a status compared against `before` cannot prove what this run displaced was put back',
  () => assertTableRestored({ ...restored, baseline: 'before' }), /compared against "before"/);
throws('patch.py still calling it applied', () => assertTableRestored({ ...restored, applied: true }), /still reports the table as applied/);
throws('no machine-readable line means the table state is UNKNOWN, which is not a pass', () => assertTableRestored(null), /UNKNOWN/);

// ---- patch.py plumbing -----------------------------------------------------------------------------------
t('the last JSON line is the machine line, whatever Korean prose precedes it',
  patchPy('apply', '/x.npz', { run: () => ({ status: 0, stdout: '끼움: 4096행  1.2s\n{"rows": 4096, "journal": "/j.npz"}\n', stderr: '' }) }).json,
  { rows: 4096, journal: '/j.npz' });
t('a base_mismatch exits 4 and still carries its machine line',
  (() => { const r = patchPy('check', '/x.npz', { run: () => ({ status: 4, stdout: '{"rows": 10, "differ_before": 3, "ok": false}\n', stderr: '' }) }); return [r.status, r.json.ok]; })(), [4, false]);
t('a run that printed no machine line reports json:null rather than inventing one',
  patchPy('status', '/x.npz', { run: () => ({ status: 3, stdout: '', stderr: 'no hook' }) }).json, null);
t('--all and --journal reach the command line', patchPy('status', '/x.npz', { journal: '/j.npz', all: true, run: (a) => ({ status: 0, stdout: JSON.stringify({ args: a }), stderr: '' }) }).json.args.slice(2),
  ['/x.npz', '--json', '--journal', '/j.npz', '--all']);

// ---- the cross-process lock ------------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'locality-lock-'));
  const held = await acquireRuntimeLock(dir, 'first');
  t('the lock is an atomic mkdir under the patch mailbox, holding a holder.json', JSON.parse(readFileSync(join(dir, '.ainize-runtime.lock', 'holder.json'), 'utf8')).label, 'first');
  let busy = null;
  try { await acquireRuntimeLock(dir, 'second', { waitMs: 0, sleep: async () => {} }); } catch (e) { busy = e.message; }
  t('a second holder waits rather than stealing it', /shared runtime is busy/.test(busy ?? ''), true);
  writeFileSync(join(dir, '.ainize-runtime.lock', 'holder.json'), JSON.stringify({ owner: 'pid:999999', label: 'dead', since: Date.now() }));
  const after = await acquireRuntimeLock(dir, 'third', { waitMs: 0, sleep: async () => {} });
  t('a holder whose process is gone is broken, the way the node breaks it', existsSync(join(dir, '.ainize-runtime.lock')), true);
  after.release();
  t('release removes the lock directory', existsSync(join(dir, '.ainize-runtime.lock')), false);
  held.release();
  rmSync(dir, { recursive: true, force: true });
}

// ---- small pieces ----------------------------------------------------------------------------------------
t('a near prose item asks for the rubric mode, a near lookup for its declared type',
  [modeFor({ answer_type: 'prose' }, 'near').mode, modeFor({ answer_type: 'symbol' }, 'near').mode, modeFor({ answer_type: 'decimal' }, 'near').mode],
  ['contains', 'exact-normalised', 'numeric']);
throws('an answer_type no mode covers is refused at build time, not scored leniently at run time',
  () => modeFor({ id: 'x', answer_type: 'vibes' }, 'control'), /no scoring mode covers/);
t('a rubric and an accept list are the same mode with different matchers',
  [containsSpec(byId['loc-nd-01']).match, containsSpec(byId['ctl.far.02']).match], ['substring', 'word']);
t('a refusal item counts nothing as its own answer, so its prose truth cannot collide',
  truthAtoms(byId['ctl.cal.02']), []);
t('a format item counts its literals, not its display truth', truthAtoms(byId['ctl.fmt.03']), ['26', '6']);

t('a set that never moved either way has no discordant pair and no evidence', movedMoreThanTheEngine(0, 0), { b: 0, c: 0, p: 1 });

console.log(`${pass} passed, ${fail} failed  (locality/prompts.jsonl vs data/r1/trainset.jsonl ${trained.sha256.slice(0, 12)})`);
process.exit(fail ? 1 : 0);
