/**
 * Self-test for the near-locality set. `node src/locality-near.test.mjs` — no GPU, no API key, no network.
 *
 * Two halves, and the second is the one that matters. The first asserts the real set passes all eight checks.
 * The second POISONS a copy of the set, once per check, and asserts the check goes red — a disjointness
 * report that cannot fail is not evidence of disjointness, it is a green light welded on.
 */
import { loadStudy, loadNearSet, checkNearSet, resolveJsonPath, ENGLISH_WORD_TICKERS } from './locality-near.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};
const study = loadStudy();
const items = loadNearSet();
const red = (mutate) => {
  const copy = JSON.parse(JSON.stringify(items));
  mutate(copy, JSON.parse(JSON.stringify(study.facts.get([...study.studyIds][0]))));
  return checkNearSet(copy, study).checks.filter((c) => c.failures.length).map((c) => c.id);
};

// ---- the real set ----
t('20 items', items.length, 20);
t('10 adjacent-entity', items.filter((i) => i.stratum === 'adjacent-entity').length, 10);
t('10 near-domain-conceptual', items.filter((i) => i.stratum === 'near-domain-conceptual').length, 10);
t('every item is untaught', items.every((i) => i.taught === false), true);
t('adjacent stratum is all P form', items.filter((i) => i.stratum === 'adjacent-entity').every((i) => i.form === 'P'), true);
t('two languages present', [...new Set(items.map((i) => i.lang))].sort(), ['en', 'ko']);
t('every adjacent item names its nearest trained neighbour',
  items.filter((i) => i.stratum === 'adjacent-entity').every((i) => study.studyIds.has(i.adjacency.nearest_trained_fact_id)), true);
t('the real set is disjoint', checkNearSet(items, study).failures, 0);

// ---- the checker can go red ----
t('C2 catches a study fact_id', red((c) => { c[0].fact_ids = [[...study.studyIds][0]]; }), ['C2']);
t('C2 catches a fact the 250-item sample asks', red((c) => { c[0].fact_ids = [[...study.sampleFactIds][0]]; }), ['C2']);
t('C3+C4+C7 catch a trained subject substituted in',
  red((c, f) => { c[0].subject = f.subject; c[0].question = c[0].question.replace(/0x[0-9a-f]+/, f.subject); c[0].relation = f.relation; }),
  ['C3', 'C4', 'C7']);
t('C4 catches a trained address smuggled into the prose stratum',
  red((c) => { c[10].question += ' For example the pool at 0x808db6e464279c6a77a1164e0b34d64bd6fb526e.'; }), ['C4', 'C7']);
// C8 goes red alongside C5 here and that is correct: a truth that is a trained answer is also not what the
// pull says. The point of the case is that C5 fires at all.
t('C5 catches a trained answer atom', red((c) => { c[0].truth = ['WETH', 'BUIDL']; }), ['C5', 'C8']);
t('C5 catches it case-folded and padded', red((c) => { c[0].truth = [' weth ', 'BUIDL']; }), ['C5', 'C8']);
t('C6 catches a verbatim trainset prompt',
  red((c) => { c[0].question = study.trainset[0].prompt; c[0].subject = '0xdeadbeef'; }), ['C4', 'C6', 'C7']);
t('C7 catches a hand-tuned prompt', red((c) => { c[0].question = `Hint: ${c[0].question}`; }), ['C7']);
t('C7 catches a wrong answer_type', red((c) => { c[0].answer_type = 'symbol'; }), ['C7']);
t('C7 catches a conceptual item with no rubric', red((c) => { delete c[10].rubric; }), ['C7']);
t('C8 catches a truth that is not what the pull says', red((c) => { c[0].truth = ['XIO', 'NOTBUIDL']; }), ['C8']);
t('C8 catches an unreadable json_path', red((c) => { c[0].source.json_path = 'uniswap-v2-swap.pools.p1.json#$.data.nope[0].symbol'; }), ['C8']);

// ---- the path resolver, which C8 leans on entirely ----
const DOC = { data: { vaults: [{ symbol: 'A', fees: [{ feeType: 'MANAGEMENT_FEE', feePercentage: '1' }, { feeType: 'PERFORMANCE_FEE', feePercentage: '2.5' }] }], pools: [{ inputTokens: [{ symbol: 'X' }, { symbol: 'Y' }] }] } };
t('resolve: indexed object', resolveJsonPath(DOC, 'f#$.data.vaults[0].symbol'), 'A');
t('resolve: [*] maps over a list', resolveJsonPath(DOC, 'f#$.data.pools[0].inputTokens[*].symbol'), ['X', 'Y']);
t('resolve: [performance] picks by feeType', resolveJsonPath(DOC, 'f#$.data.vaults[0].fees[performance].feePercentage'), '2.5');
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
t('resolve: an unknown key throws rather than returning undefined', throws(() => resolveJsonPath(DOC, 'f#$.data.vaults[0].nope')), true);
t('resolve: a path with no $. throws', throws(() => resolveJsonPath(DOC, 'f#data.vaults[0].symbol')), true);
t('loadStudy rejects an ENGLISH_WORD_TICKERS entry that is not trained', ENGLISH_WORD_TICKERS.every((w) => study.atoms.has(w.toLowerCase())), true);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
