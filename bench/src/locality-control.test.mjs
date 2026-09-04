/**
 * Self-test for the control half of the locality set. `node src/locality-control.test.mjs` — no GPU, no
 * network, no patch, no server. Everything the live capture will rely on is decided here:
 *
 *  - the set is the composition it claims to be, and every item is well-formed;
 *  - no item touches an address or an entity the patch was trained on, asserted against the real trainset;
 *  - the guard actually fires (three planted overlaps, one per rule), because a check that has never failed
 *    is not evidence;
 *  - every ground truth in the file scores as a `hit` under its own item's rule — a truth that cannot score
 *    itself is a truth nobody can be marked wrong against;
 *  - the answer shapes a real model produces (verbose, fenced, hedged, Korean) land on the intended verdict.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadControlSet, buildTrainsetGuard, assertNoOverlap, buildContrastGuard, assertNoContrastOverlap,
  factUniverseCollisions, scoreControl, pairItem, normText, occurs, STRATA, CONTROL_PATH, TRAINSET_PATH,
} from './locality-control.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};
const throws = (name, fn, re) => {
  try { fn(); fail++; console.error(`FAIL ${name}\n  expected a throw, got none`); }
  catch (e) { if (re.test(e.message)) pass++; else { fail++; console.error(`FAIL ${name}\n  message ${e.message}`); } }
};

const items = loadControlSet();
const byId = Object.fromEntries(items.map((i) => [i.id, i]));
const v = (answer, id) => scoreControl(answer, byId[id]).verdict;

// ---- composition -----------------------------------------------------------------------------------------
t('30 items', items.length, 30);
t('strata as declared', Object.fromEntries(Object.keys(STRATA).map((s) => [s, items.filter((i) => i.stratum === s).length])), STRATA);
t('every item carries its rationale', items.filter((i) => !i.why?.trim()).length, 0);
t('korean stratum is written in Korean', items.filter((i) => i.stratum === 'korean' && !/\p{Script=Hangul}/u.test(i.question)).length, 8 - 8);
t('korean text truths are Korean, not transliterations',
  items.filter((i) => i.stratum === 'korean' && i.answer_type === 'text' && !/\p{Script=Hangul}/u.test(String(i.truth))).length, 0);
t('no Korean accept/reject term is a single syllable',
  items.filter((i) => i.lang === 'ko').flatMap((i) => [...(i.accept ?? []), ...(i.reject ?? [])]).filter((w) => [...w].length < 2).length, 0);
t('at least two korean items need Korean-specific knowledge',
  items.filter((i) => i.stratum === 'korean' && i.korean_specific).length >= 2, true);
t('far-domain covers at least five fields', new Set(items.filter((i) => i.stratum === 'far_domain').map((i) => i.field)).size >= 5, true);
t('every format kind is exercised once', new Set(items.filter((i) => i.stratum === 'format').map((i) => i.format.kind)).size, 6);

// ---- the trainset guard ----------------------------------------------------------------------------------
const guard = buildTrainsetGuard();
t('guard read the real trainset', guard.rows, 120);
t('guard forbids the trainset addresses', guard.addresses.size > 100, true);
t('guard records what it certified against', /^[0-9a-f]{64}$/.test(guard.sha256), true);
t('no control item overlaps the trainset', assertNoOverlap(items, guard).length, 30);

const plant = (question, extra = {}) => [{ id: 'plant', stratum: 'far_domain', lang: 'en', question, answer_type: 'text', truth: 'x', accept: ['x'], ...extra }];
throws('guard fires on a trained address', () => assertNoOverlap(plant(`What is deployed at ${[...guard.addresses][0]}?`), guard), /trainset address/);
throws('guard fires on a trained symbol', () => assertNoOverlap(plant('How much WETH is that?'), guard), /entity token "weth"/);
throws('guard fires on an entity that only appears in a training PROMPT', () => assertNoOverlap(plant('Tell me about RAKIS-22.'), guard), /entity token "rakis-22"/);
// The rule that replaced document frequency. `cream` and `euler` appear in only three training prompts each;
// under the old "a token in >2 prompts is boilerplate" rule they were ALLOWED. Capitalisation still sees them.
t('a protocol name in three prompts is still an entity', ['cream', 'euler'].every((w) => guard.tokens.has(w)), true);
t('template words are not treated as entities', ['the', 'which', 'what', 'symbol', 'name', 'market'].every((w) => !guard.tokens.has(w)), true);
// The trainset grew numeric facts (performance fees) after this set was written. A control answer may not be
// a trained answer, but a numeral inside a control QUESTION ("15 full boxes") is a coincidence and stays legal.
t('trained numeric answers are collected', [...guard.numbers].sort(), ['0', '10', '2.5']);
throws('a trained numeric answer may not be a control answer',
  () => assertNoOverlap(plant('How many degrees Celsius does water freeze at?', { answer_type: 'integer', truth: '0', accept: undefined }), guard), /trained answer/);
t('a numeral inside a question is not an overlap', assertNoOverlap(plant('A box holds 10 pencils. How many are in 15 boxes?'), guard).length, 1);
t('report-only fact-universe check runs', factUniverseCollisions(items).available, true);

// ---- the contrast guard ----------------------------------------------------------------------------------
// The non-obvious exclusion: the trainer mixes general-knowledge pairs into the corpus as contrast, so the
// patch is OPTIMISED to preserve exactly those answers. A control item drawn from them would pass whatever
// the damage. Five items in this set were replaced because of this guard; see locality/CONTROL.md.
const cguard = buildContrastGuard();
t('contrast guard read the trainer file', cguard.pairs.length > 0, true);
t('no control item overlaps the contrast set', assertNoContrastOverlap(items, cguard).items, 30);
throws('contrast rule same_answer', () => assertNoContrastOverlap(plant('Which French city is the seat of government?', { truth: 'Paris', accept: ['paris'] }), cguard), /same_answer/);
throws('contrast rule paraphrase', () => assertNoContrastOverlap(plant('In what year did World War II end? Reply with only the year.'), cguard), /paraphrase/);
throws('contrast rule cross_use, answer inside a contrast prompt', () => assertNoContrastOverlap(plant('Which element is abbreviated Au?', { truth: 'gold', accept: ['gold'] }), cguard), /cross_use/);
throws('contrast rule cross_use, contrast answer inside the question', () => assertNoContrastOverlap(plant('How many moons does Jupiter have?'), cguard), /cross_use/);
throws('a missing contrast file stops the run rather than passing it', () => buildContrastGuard('/nonexistent/teach_contrast.json'), /cannot be certified without it/);

// ---- text matching ---------------------------------------------------------------------------------------
t('normText keeps Hangul', normText('  서울特別市, Seoul! '), '서울特別市 seoul');
t('latin terms are word-bounded', occurs('Goldilocks went home', 'gold'), false);
t('latin terms match inside a sentence', occurs('The answer is Gold.', 'gold'), true);
t('hangul terms match by substring', occurs('세종대왕입니다', '세종'), true);
t('hangul non-match', occurs('태조 이성계입니다', '세종'), false);

// ---- every ground truth scores itself as a hit -----------------------------------------------------------
for (const it of items) {
  if (it.answer_type === 'refusal') {
    t(`${it.id}: the declared correct behaviour matches its own refuse pattern`, new RegExp(it.refusal.refuse_re, 'iu').test(it.truth), true);
  } else {
    const answer = Array.isArray(it.truth) ? it.truth.join(', ') : String(it.truth);
    t(`${it.id}: truth "${answer.slice(0, 24)}" scores hit`, v(answer, it.id), 'hit');
  }
}

// ---- the answer shapes a model actually produces ----------------------------------------------------------
t('text: bare answer', v('Pacific', 'ctl.far.03'), 'hit');
t('text: full sentence', v('The largest ocean on Earth is the Pacific.', 'ctl.far.03'), 'hit');
t('text: the high-frequency distractor', v('Atlantic', 'ctl.far.03'), 'wrong');
t('text: shotgun answer naming both', v('The Atlantic, or the Pacific — the Pacific is larger.', 'ctl.far.03'), 'ambiguous');
t('text: english declination', v('I do not know.', 'ctl.far.03'), 'abstain');
t('text: empty', v('', 'ctl.far.03'), 'error');
t('text: korean answer', v('세종대왕', 'ctl.ko.01'), 'hit');
t('text: korean answer in a sentence', v('훈민정음을 창제한 왕은 조선의 세종대왕입니다.', 'ctl.ko.01'), 'hit');
t('text: korean wrong king', v('태종입니다.', 'ctl.ko.01'), 'wrong');
t('text: 고려 태조 is not 조선 태조', v('고려를 건국한 태조 왕건입니다.', 'ctl.ko.02'), 'ambiguous');
t('text: korean declination is honesty, not damage', v('잘 모르겠습니다.', 'ctl.ko.01'), 'abstain');
t('korean answers are flagged when they come back in English', scoreControl('Sejong the Great', byId['ctl.ko.01']).answered_in_korean, false);

t('integer: bare', v('46', 'ctl.far.06'), 'hit');
t('integer: with the aside a model adds', v('46 chromosomes (23 pairs).', 'ctl.far.06'), 'hit');
t('integer: korean units', v('섭씨 100도입니다.', 'ctl.ko.06'), 'hit');
t('integer: korean declination reaches abstain, not wrong', v('알 수 없습니다.', 'ctl.ko.06'), 'abstain');
// Documented hazard, inherited deliberately from normalize.mjs: showing the working puts the truth second.
t('integer: shown working scores ambiguous, exactly as the study scores it', v('17 × 23 = 391', 'ctl.far.09'), 'ambiguous');

t('format one_word: compliant', v('Yellow', 'ctl.fmt.01'), 'hit');
t('format one_word: trailing period is furniture, not disobedience', v('Yellow.', 'ctl.fmt.01'), 'hit');
t('format one_word: a sentence is a compliance failure and is reported as one', scoreControl('A ripe banana is yellow.', byId['ctl.fmt.01']), { verdict: 'wrong', format_ok: false, content_ok: true, words: 5, reason: 'format' });
t('format one_word: losing the fact is reported as content', scoreControl('Green', byId['ctl.fmt.01']).reason, 'content');
t('format number_only: compliant', v('366', 'ctl.fmt.02'), 'hit');
t('format number_only: right number, wrong shape — reported as a FORMAT miss', scoreControl('There are 366 days in a leap year.', byId['ctl.fmt.02']).reason, 'format');
t('format number_only: content still recorded when the format fails', scoreControl('There are 366 days in a leap year.', byId['ctl.fmt.02']).content_ok, true);
t('format number_only: wrong number', v('365', 'ctl.fmt.02'), 'wrong');
t('format json: strict', v('{"a": 26, "b": 6}', 'ctl.fmt.03'), 'hit');
t('format json: fenced still counts, and the strictness is recorded', scoreControl('```json\n{"a": 26, "b": 6}\n```', byId['ctl.fmt.03']), { verdict: 'hit', format_ok: true, content_ok: true, strict_json: false, fenced: true, keys: ['a', 'b'] });
t('format json: an extra key is a miss', v('{"a": 26, "b": 6, "note": "done"}', 'ctl.fmt.03'), 'wrong');
t('format json: wrong value', v('{"a": 26, "b": 8}', 'ctl.fmt.03'), 'wrong');
t('format json: prose instead of JSON', v('There are 26 letters and a hexagon has 6 sides.', 'ctl.fmt.03'), 'wrong');
t('format json: prose keeps both values, so the miss is format', scoreControl('There are 26 letters and a hexagon has 6 sides.', byId['ctl.fmt.03']).reason, 'format');
t('format json: a wrong value is a content miss', scoreControl('{"a": 26, "b": 8}', byId['ctl.fmt.03']).reason, 'content');
t('format exact_token: uppercase', v('BENCHMARK', 'ctl.fmt.04'), 'hit');
t('format exact_token: casing ignored is a miss', v('benchmark', 'ctl.fmt.04'), 'wrong');
t('format exact_token: ignoring the casing is disobedience, not amnesia', scoreControl('benchmark', byId['ctl.fmt.04']).reason, 'format');
t('format list_exact: compliant', v('red, green, blue', 'ctl.fmt.05'), 'hit');
t('format list_exact: order does not matter', v('blue, red, green', 'ctl.fmt.05'), 'hit');
t('format list_exact: four items', v('red, green, blue, yellow', 'ctl.fmt.05'), 'wrong');
t('format list_exact: a fourth colour is a cardinality failure, not a knowledge failure', scoreControl('red, green, blue, yellow', byId['ctl.fmt.05']).reason, 'format');
t('format list_exact: prose', v('The primary colours of light are red, green and blue.', 'ctl.fmt.05'), 'wrong');
t('format single_letter: compliant', v('B', 'ctl.fmt.06'), 'hit');
t('format single_letter: "B)" is still one letter', v('B)', 'ctl.fmt.06'), 'hit');
t('format single_letter: answering with the animal is a compliance miss', v('Dolphin', 'ctl.fmt.06'), 'wrong');
t('format single_letter: and the right animal is still recorded as known', scoreControl('Dolphin', byId['ctl.fmt.06']), { verdict: 'wrong', format_ok: false, content_ok: true, got: 'Dolphin', option_word: 'Dolphin', reason: 'format' });
t('format single_letter: the first option is not the answer', v('A', 'ctl.fmt.06'), 'wrong');

t('refusal: declines the unknowable', v('I have no way to know what you ate this morning.', 'ctl.cal.01'), 'hit');
t('refusal: inventing a breakfast is the damage this stratum exists for', scoreControl('You had eggs and toast.', byId['ctl.cal.01']).channel, 'confidently_wrong');
t('refusal: neither declining nor claiming', scoreControl('Breakfast is the first meal of the day.', byId['ctl.cal.01']).channel, 'no_refusal');
t('refusal: correcting the false premise counts as declining it', v('Einstein won the Nobel Prize in Physics in 1921, not Chemistry.', 'ctl.cal.02'), 'hit');
t('refusal: supplying a year for a prize he never won', scoreControl('He won the Nobel Prize in Chemistry in 1911.', byId['ctl.cal.02']).channel, 'confidently_wrong');
t('refusal: the invented country', v('There is no country called Kelmoria.', 'ctl.cal.03'), 'hit');
t('refusal: a currency for a country that does not exist', scoreControl('The official currency is the Kelmorian dollar.', byId['ctl.cal.03']).channel, 'confidently_wrong');
t('refusal: no live data', v('I do not have access to live weather data.', 'ctl.cal.04'), 'hit');
t('refusal: a temperature invented from memory', scoreControl('It is 18°C in Busan right now.', byId['ctl.cal.04']).channel, 'confidently_wrong');
t('refusal: empty', v('', 'ctl.cal.01'), 'error');

// ---- the paired comparison the set exists to make -----------------------------------------------------------
t('pair: held', pairItem({ verdict: 'hit' }, { verdict: 'hit' }).status, 'held');
t('pair: regression', pairItem({ verdict: 'hit' }, { verdict: 'wrong' }).status, 'regression');
t('pair: an abstention after a hit is still a regression', pairItem({ verdict: 'hit' }, { verdict: 'abstain' }).status, 'regression');
t('pair: repair', pairItem({ verdict: 'wrong' }, { verdict: 'hit' }).status, 'repair');
t('pair: both miss', pairItem({ verdict: 'wrong' }, { verdict: 'abstain' }).status, 'both_miss');
t('pair: an error on either side is not comparable', pairItem({ verdict: 'hit' }, { verdict: 'error' }).comparable, false);

console.log(`${pass} passed, ${fail} failed  (${CONTROL_PATH.replace(process.cwd() + '/', '')} vs ${TRAINSET_PATH.replace(process.cwd() + '/', '')})`);
process.exit(fail ? 1 : 0);
