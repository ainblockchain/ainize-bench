/**
 * The CONTROL half of the locality set: 30 prompts that have nothing to do with the patch, scored before and
 * after it is applied to the SAME running engine.
 *
 * Why this file exists. graph/bench measures whether a patch teaches what it promised. It does not measure
 * whether the patch broke anything else, and a PLE memory-table patch writes rows into a table that every
 * other prompt also reads. Two halves are needed: the NEAR half (addresses adjacent to the trained rows) and
 * this one, the FAR half — general capability that must not move at all. A gain on the study bucket that is
 * paid for with a loss here is not a gain, and today nothing in the repo would see it.
 *
 * Scoring reuses src/normalize.mjs wherever the study's answer types already cover the case (`integer` goes
 * through scoreOne verbatim, ambiguity rule included). Three types are new because the study has no use for
 * them: `text` (multi-word and non-Latin answers with an explicit distractor list), `format` (compliance is
 * the measurement, not furniture around it) and `refusal` (the correct answer is a declination).
 *
 * Verdict vocabulary is normalize.mjs's, unchanged: hit | wrong | ambiguous | abstain | error.
 *
 * The comparison this set is built for is PAIRED PER ITEM on one engine instance:
 *   reference (patch removed) → apply → post (patch applied), no restart in between.
 * The headline is not an accuracy number, it is a regression count: items that were `hit` in the reference
 * and are not `hit` afterwards. That framing is why an item the base model fails is still a usable item, and
 * why no threshold in this file needs an opinion about how good the base model is.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreOne } from './normalize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, '..');
export const CONTROL_PATH = join(BENCH, 'locality', 'control.jsonl');
export const CONTROL_SYSTEM_PATH = join(BENCH, 'locality', 'system.txt');
export const TRAINSET_PATH = join(BENCH, 'data', 'r1', 'trainset.jsonl');
/**
 * The trainer's CONTRAST set — general-knowledge pairs mixed into the training corpus so the shared PLE rows
 * do not collapse while the target rows are pulled. The patch is explicitly optimised to preserve these
 * answers, so a control item drawn from them would pass no matter how much damage there was. It lives with
 * the model, not in this repo; locality/EXCLUSIONS.md documents it. Overridable for tests and for a future
 * run whose trainer ships a different one.
 */
export const CONTRAST_PATH = process.env.BENCH_CONTRAST ?? '/mnt/newdata/qwen3.8/train/teach_contrast.json';

/** Declared composition. The loader asserts the file matches; a set that has silently drifted is not a control. */
export const STRATA = { far_domain: 12, korean: 8, format: 6, calibration: 4 };

/**
 * A declination, in either language the set uses.
 *
 * normalize.mjs has its own ABSTAIN regex with the same intent, but it is module-private and English-only.
 * Two Korean items expect an integer answer, and a Korean "모르겠습니다" routed through scoreOne would score
 * `wrong` rather than `abstain` — i.e. it would be counted as damage when it is honesty. So this check runs
 * FIRST for every answer type, including the ones delegated to scoreOne. (Requested change to the owner of
 * normalize.mjs, not made here: export ABSTAIN and add the Korean forms, then this constant can be deleted.)
 */
export const DECLINE = /\b(?:unknown|i (?:do not|don'?t) know|i (?:can ?not|can'?t) know|cannot determine|can(?:not|'t) answer|no data|not available|insufficient (?:data|information))\b|모르(?:겠|겠습니다|ㅂ니다)|알 수 없|확인할 수 없|정보가 없|답변할 수 없/iu;

// ---------------------------------------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------------------------------------

/**
 * Lowercase, NFC, and every character that is not a letter or a digit in ANY script becomes a space.
 * `\p{L}` rather than `[a-z]` is the whole point: half this set is Korean, and a Latin-only normaliser would
 * reduce every Korean answer to the empty string and score the entire stratum `wrong`.
 */
export function normText(s) {
  return String(s ?? '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const HANGUL = /\p{Script=Hangul}/u;
const LATIN_ONLY = /^[\p{Script=Latin}\p{N} '-]+$/u;

/** Does `term` occur in `text`? Word-bounded for Latin terms; plain containment for scripts that do not space-delimit. */
export function occurs(text, term) {
  const t = ` ${normText(text)} `;
  const q = normText(term);
  if (!q) return false;
  return LATIN_ONLY.test(term) ? t.includes(` ${q} `) : t.includes(q);
}

// ---------------------------------------------------------------------------------------------------------
// The trainset guard — mechanical, not a promise
// ---------------------------------------------------------------------------------------------------------

const ADDR_RE = /0x[0-9a-fA-F]{40}/g;
const IS_ADDR = /^0x[0-9a-fA-F]{40}$/; // ADDR_RE carries /g and .test() on it is stateful — never test with ADDR_RE
const TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9.'-]*/g;

/**
 * Everything the patch was trained on, as two sets a control prompt may not touch.
 *
 * addresses  every 0x…40-hex string appearing anywhere in trainset.jsonl.
 * tokens     every letter-bearing token of the trainset ANSWERS (the fact objects), plus every PROMPT token
 *            that is capitalised anywhere but the start of its sentence, or that contains a digit. Those are
 *            the entity names the templates interpolate (Euler, Cream, Sushiswap, RAKIS-22, vLQTY-ETH30);
 *            everything else in a prompt is the template itself. An earlier version of this rule used
 *            document frequency — "a token in at most 2 of the 120 prompts is an entity" — and it went leaky
 *            the moment the trainset was rebalanced by relation: `cream` and `euler` appeared in three
 *            prompts each and were promoted to boilerplate. Frequency describes the sample; capitalisation
 *            describes the language.
 *
 * numbers    every trainset ANSWER that is a bare number. These are kept apart from `tokens` on purpose: a
 *            numeral inside a control QUESTION ("15 full boxes") is a coincidence, but a control ANSWER that
 *            equals a trained answer is not, and only the second is forbidden. The set exists because the
 *            trainset is regenerated: r1 first trained no numeric facts at all, then was rebalanced by
 *            relation and began training performance fees (0, 10, 2.5) — which is exactly the answer a
 *            Korean freezing-point item had. A guard that had assumed "no trained answer is a number" would
 *            have gone on passing.
 */
export function buildTrainsetGuard(path = TRAINSET_PATH) {
  const raw = readFileSync(path, 'utf8');
  const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (!rows.length) throw new Error(`locality guard: ${path} is empty`);

  const addresses = new Set();
  const answerTokens = new Set();
  const promptEntities = new Set();
  const boilerplate = new Set();
  const numbers = new Set();

  for (const r of rows) {
    for (const a of [r.prompt, r.answer]) for (const m of String(a).match(ADDR_RE) ?? []) addresses.add(m.toLowerCase());
    if (/^\s*-?\d[\d,._]*\s*$/.test(String(r.answer))) numbers.add(String(r.answer).trim().replace(/,/g, ''));
    for (const t of String(r.answer).replace(ADDR_RE, ' ').match(TOKEN_RE) ?? []) {
      const k = t.toLowerCase();
      if (k.length >= 2 && /\p{L}/u.test(k)) answerTokens.add(k);
    }
    const toks = String(r.prompt).replace(ADDR_RE, ' ').match(TOKEN_RE) ?? [];
    toks.forEach((t, i) => {
      const k = t.toLowerCase();
      const entity = (i > 0 && /[A-Z]/.test(t)) || /\d/.test(t);
      if (entity) { if (k.length >= 2 && /\p{L}/u.test(k)) promptEntities.add(k); }
      else boilerplate.add(k);
    });
  }

  const tokens = new Set([...answerTokens, ...promptEntities]);
  return {
    path, rows: rows.length, addresses, tokens, numbers,
    boilerplate: [...boilerplate].filter((t) => !tokens.has(t)).sort(),
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

/** Everything an item counts as ITS ANSWER: the truth, the accepted surface forms, and the format literals. */
export function answerStrings(item) {
  if (item.answer_type === 'refusal') return [];
  return [String(item.truth ?? ''), ...(item.accept ?? []), ...(item.format?.items ?? []),
    ...Object.values(item.format?.values ?? {}).map(String), ...(item.format?.token ? [item.format.token] : [])];
}

/** Every string of an item a reader would call "what it asks about". */
export function itemStrings(item) {
  return [item.question, String(item.truth ?? ''), ...(item.accept ?? []), ...(item.reject ?? []),
    ...(item.format?.items ?? []), ...(item.format?.token ? [item.format.token] : [])];
}

/**
 * The assertion the runner must make before it sends its first request. Returns one row per item; throws on
 * the first violation with the item, the offending string and which set it came from — a control item that
 * touches a trained entity is not a control item, and there is no degraded mode worth continuing into.
 */
export function assertNoOverlap(items, guard) {
  const report = [];
  for (const item of items) {
    for (const a of answerStrings(item)) {
      const n = String(a).trim().replace(/,/g, '');
      if (guard.numbers.has(n)) throw new Error(`locality control ${item.id}: its answer "${a}" is a trained answer (trainset numeric fact)`);
    }
    const hay = itemStrings(item).join('\n');
    const norm = ` ${normText(hay)} `;
    const hitAddr = [...guard.addresses].filter((a) => hay.toLowerCase().includes(a));
    const hitTok = [...guard.tokens].filter((t) => norm.includes(` ${normText(t)} `));
    if (hitAddr.length) throw new Error(`locality control ${item.id}: contains trainset address ${hitAddr[0]}`);
    if (hitTok.length) throw new Error(`locality control ${item.id}: contains trainset entity token "${hitTok[0]}"`);
    report.push({ id: item.id, addresses_checked: guard.addresses.size, tokens_checked: guard.tokens.size, numbers_checked: guard.numbers.size, hits: 0 });
  }
  return report;
}

// ---------------------------------------------------------------------------------------------------------
// The contrast guard — the non-obvious half of "never told about"
// ---------------------------------------------------------------------------------------------------------

/** Words carried by the question form rather than by its subject; ignored when two questions are compared. */
const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'of', 'to', 'for', 'and', 'or',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'how', 'do', 'does', 'did', 'many', 'much', 'that',
  'this', 'it', 'its', 'with', 'only', 'reply', 'answer', 'nothing', 'else', 'word', 'number', 'name', 'first',
  'you', 'your', 'i', 'me', 'my', 'there', 'here', 'exactly', 'give', 'say', 'these', 'those', 'be', 'as', 'by']);

const contentTokens = (s) => new Set(normText(s).split(' ').filter((w) => w && !STOP.has(w)));
const jaccard = (a, b) => {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
};

export function buildContrastGuard(path = CONTRAST_PATH) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) {
    throw new Error(`locality guard: the trainer's contrast set is not readable at ${path} (${e.code ?? e.message}). ` +
      'The control set cannot be certified without it — the patch is optimised to preserve those answers, so an ' +
      'item drawn from them would pass whatever the damage. Set BENCH_CONTRAST to its path (see locality/EXCLUSIONS.md).');
  }
  const pairs = JSON.parse(raw);
  if (!Array.isArray(pairs) || !pairs.length) throw new Error(`locality guard: ${path} is not a non-empty array`);
  return {
    path, pairs, sha256: createHash('sha256').update(raw).digest('hex'),
    answers: new Set(pairs.map((p) => normText(p.answer))),
    questions: pairs.map((p) => ({ prompt: p.prompt, answer: p.answer, tokens: contentTokens(p.prompt) })),
  };
}

/**
 * Three rules, because the collision has three shapes and only the first is obvious.
 *
 *  same_answer   the item's answer IS a contrast answer, whatever the question. Numbers included: if the
 *                trainer optimised the model to emit "7", an item whose truth is 7 measures the regulariser.
 *  paraphrase    the two questions share at least half their content words ("In what year did World War II
 *                end?" vs "In which year did the Second World War end in Europe?" — 0.57).
 *  cross_use     the item's answer appears inside a contrast PROMPT, or a contrast answer appears inside the
 *                item's question. This is the reversed-direction collision: asking which element is
 *                abbreviated Au is the contrast pair "chemical symbol for gold" turned around, and neither of
 *                the first two rules sees it. Bare numerals are excluded here — a shared numeral is a
 *                coincidence, a shared name is not, and rule one already covers numeric answers exactly.
 *
 * What it does NOT catch, stated so nobody trusts it further than it goes: the same fact expressed in another
 * language (목성 vs Jupiter). Those were removed by hand; see locality/CONTROL.md.
 */
export function assertNoContrastOverlap(items, cguard, { paraphraseAt = 0.5 } = {}) {
  const named = (s) => String(s).length >= 2 && /\p{L}/u.test(String(s));
  for (const item of items) {
    const answers = answerStrings(item);
    {
      for (const a of answers) {
        if (cguard.answers.has(normText(a))) {
          throw new Error(`locality control ${item.id}: answer "${a}" is a contrast answer the patch is trained to preserve (rule same_answer)`);
        }
      }
    }
    const qt = contentTokens(item.question);
    for (const c of cguard.questions) {
      const j = jaccard(qt, c.tokens);
      if (j >= paraphraseAt) {
        throw new Error(`locality control ${item.id}: question is a paraphrase of the contrast pair "${c.prompt}" (jaccard ${j.toFixed(2)}, rule paraphrase)`);
      }
      {
        for (const a of answers) if (named(a) && occurs(c.prompt, a)) {
          throw new Error(`locality control ${item.id}: its answer "${a}" appears in the contrast prompt "${c.prompt}" (rule cross_use)`);
        }
      }
      if (named(c.answer) && occurs(item.question, c.answer)) {
        throw new Error(`locality control ${item.id}: the contrast answer "${c.answer}" appears in its question (rule cross_use)`);
      }
    }
  }
  return { items: items.length, pairs: cguard.pairs.length, paraphraseAt };
}

/**
 * Report-only: does an item's wording collide with the WIDER fact universe (facts.jsonl), not just the 120
 * trained rows? Whole objects only, and never enforced. The universe is full of ERC-20 tickers that are
 * ordinary English words — REAL, LOVE, INDEX, HAPPY, DOG — so enforcing against it would ban English rather
 * than protect anything. What the patch wrote is the trainset; that is what `assertNoOverlap` enforces. This
 * function exists so the weaker claim can be quoted honestly instead of implied.
 */
export function factUniverseCollisions(items, factsPath = join(BENCH, 'data', 'r1', 'facts.jsonl')) {
  let objects;
  try { objects = readFileSync(factsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).object); }
  catch (e) { return { available: false, reason: e.message }; }
  const vocab = new Set();
  for (const o of objects) {
    const k = normText(o);
    if (k.length >= 3 && !IS_ADDR.test(String(o).trim())) vocab.add(k);
  }
  const rows = items.map((item) => {
    const hay = itemStrings(item).join('\n');
    return { id: item.id, collisions: [...vocab].filter((t) => occurs(hay, t)) };
  });
  return { available: true, vocab: vocab.size, rows: rows.filter((r) => r.collisions.length) };
}

// ---------------------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------------------

export function loadControlSet(path = CONTROL_PATH) {
  const items = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(`${path}:${i + 1} is not JSON: ${e.message}`); }
  });
  const counts = {};
  const ids = new Set();
  for (const it of items) {
    if (!it.id || ids.has(it.id)) throw new Error(`locality control: duplicate or missing id "${it.id}"`);
    if (!/^[A-Za-z0-9._-]+$/.test(it.id)) throw new Error(`locality control ${it.id}: id must be filesystem-safe (transcripts are written as <id>.<repeat>.json)`);
    ids.add(it.id);
    if (!it.question?.trim()) throw new Error(`locality control ${it.id}: empty question`);
    if (!it.lang) throw new Error(`locality control ${it.id}: no lang`);
    counts[it.stratum] = (counts[it.stratum] ?? 0) + 1;
    validateItem(it);
  }
  for (const [s, n] of Object.entries(STRATA)) {
    if (counts[s] !== n) throw new Error(`locality control: stratum ${s} has ${counts[s] ?? 0} items, declared ${n}`);
  }
  for (const s of Object.keys(counts)) if (!(s in STRATA)) throw new Error(`locality control: undeclared stratum ${s}`);
  return items;
}

const FORMAT_KINDS = new Set(['one_word', 'number_only', 'json_keys', 'exact_token', 'list_exact', 'single_letter']);

/** Everything that must be true of an item for its verdict to mean anything. Called at load, not at score time. */
export function validateItem(it) {
  const bad = (m) => { throw new Error(`locality control ${it.id}: ${m}`); };
  switch (it.answer_type) {
    case 'integer':
      if (!/^-?\d+$/.test(String(it.truth))) bad(`integer truth "${it.truth}" is not an integer`);
      break;
    case 'text':
      if (!it.accept?.length) bad('text item has no accept list');
      for (const a of it.accept) if (occurs(it.question, a)) bad(`accept term "${a}" already appears in the question — the item would score itself`);
      for (const r of it.reject ?? []) if (occurs(it.question, r)) bad(`reject term "${r}" appears in the question — a correct verbose answer would echo it and score ambiguous`);
      // Korean terms are matched by substring, because Hangul is not space-delimited. A one-syllable term
      // would then fire inside unrelated words — 폐 inside 폐지, 간 inside 시간 — so the set does not use them.
      if (it.lang === 'ko') for (const w of [...it.accept, ...(it.reject ?? [])]) {
        if ([...w].length < 2) bad(`Korean term "${w}" is one syllable — substring matching would fire inside unrelated words`);
      }
      break;
    case 'format':
      if (!FORMAT_KINDS.has(it.format?.kind)) bad(`unknown format kind ${it.format?.kind}`);
      if (it.format.kind === 'one_word' && !it.accept?.length) bad('one_word needs an accept list');
      if (it.format.kind === 'number_only' && !/^-?\d+$/.test(String(it.truth))) bad('number_only truth must be an integer');
      if (it.format.kind === 'json_keys' && (!it.format.keys?.length || !it.format.values)) bad('json_keys needs keys and values');
      if (it.format.kind === 'exact_token' && !it.format.token) bad('exact_token needs a token');
      if (it.format.kind === 'list_exact' && it.format.items?.length !== it.format.n) bad('list_exact: n must equal items.length');
      if (it.format.kind === 'single_letter' && !it.format.options?.includes(String(it.truth))) bad('single_letter truth must be one of the options');
      break;
    case 'refusal':
      if (!it.refusal?.refuse_re) bad('refusal item has no refuse_re');
      try { new RegExp(it.refusal.refuse_re, 'iu'); } catch (e) { bad(`refuse_re does not compile: ${e.message}`); }
      if (it.refusal.claim_re) { try { new RegExp(it.refusal.claim_re, 'iu'); } catch (e) { bad(`claim_re does not compile: ${e.message}`); } }
      break;
    default: bad(`unknown answer_type ${it.answer_type}`);
  }
  if (it.lang === 'ko' && !HANGUL.test(it.question)) bad('declared Korean but the question has no Hangul');
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------------------

/** ```json fences are stripped before a JSON item is parsed; whether the RAW answer parsed is reported separately. */
function stripFence(s) {
  const m = String(s ?? '').match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  return (m ? m[1] : String(s ?? '')).trim();
}

const stripEnds = (s) => String(s ?? '').trim().replace(/^["'`]+/, '').replace(/["'`]+$/, '').replace(/[.!?]+$/, '').trim();

function scoreText(raw, item) {
  const acc = item.accept.filter((a) => occurs(raw, a));
  const rej = (item.reject ?? []).filter((r) => occurs(raw, r));
  if (acc.length && rej.length) return { verdict: 'ambiguous', matched: acc, distractors: rej, reason: 'answer contains the truth and a distractor' };
  if (acc.length) return { verdict: 'hit', matched: acc };
  return { verdict: 'wrong', matched: [], distractors: rej };
}

/**
 * A format item has TWO measurements and they are never blended: `content_ok` (does the model still know the
 * answer) and `format_ok` (does it still obey). A corrupted table is expected to break obedience first, so an
 * item that gets the fact right in the wrong shape must be readable as exactly that — "reason: format" — and
 * not as a knowledge loss. The verdict is a hit only when both hold.
 */
function scoreFormat(raw, item) {
  const f = item.format;
  const body = String(raw).trim();
  let format_ok = false, content_ok = false, detail = {};

  if (f.kind === 'one_word') {
    const one = stripEnds(body);
    format_ok = one.length > 0 && !/\s/.test(one);
    content_ok = item.accept.some((a) => normText(one) === normText(a) || occurs(body, a));
    detail = { words: body.split(/\s+/).filter(Boolean).length };
  } else if (f.kind === 'number_only') {
    const one = body.replace(/[.]$/, '').trim();
    format_ok = /^-?\d[\d,]*$/.test(one);
    content_ok = one.replace(/,/g, '') === String(item.truth)
      || scoreOne(raw, { id: item.id, answer_type: 'integer', truth: item.truth }).verdict === 'hit';
    detail = { whole_reply_is_a_number: format_ok };
  } else if (f.kind === 'json_keys') {
    let strict = null, lenient = null;
    try { strict = JSON.parse(body); } catch { /* not raw JSON */ }
    try { lenient = JSON.parse(stripFence(body)); } catch { /* not JSON at all */ }
    const obj = strict ?? lenient;
    const keys = obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj) : null;
    format_ok = !!keys && keys.length === f.keys.length && f.keys.every((k) => keys.includes(k));
    content_ok = format_ok
      ? f.keys.every((k) => String(obj[k]).trim() === String(f.values[k]))
      // Prose instead of JSON: the values may still be there. Say so, rather than calling it a knowledge loss.
      : f.keys.every((k) => new RegExp(`(^|[^\\d])${f.values[k]}([^\\d]|$)`).test(body));
    detail = { strict_json: strict != null, fenced: strict == null && lenient != null, keys };
  } else if (f.kind === 'exact_token') {
    // Here the casing IS the instruction, so exact casing counts as FORMAT; saying the word at all is content.
    const one = stripEnds(body);
    const single = one.length > 0 && !/\s/.test(one);
    content_ok = occurs(body, f.token);
    format_ok = single && (f.case_sensitive ? one === f.token : one.toLowerCase() === f.token.toLowerCase());
    detail = { got: one, case_sensitive: !!f.case_sensitive };
  } else if (f.kind === 'list_exact') {
    const parts = body.split(',').map((p) => p.trim()).filter((p) => p.length);
    const words = parts.map((p) => normText(p.replace(/^and\s+/i, '')));
    const want = new Set(f.items.map(normText));
    format_ok = parts.length === f.n && parts.every((p) => !/\s/.test(stripEnds(p))) && !/\n/.test(body)
      && words.length === f.n && new Set(words).size === f.n;
    content_ok = f.items.every((w) => occurs(body, w));
    if (format_ok) content_ok = content_ok && words.every((w) => want.has(w));
    detail = { parts: parts.length, words };
  } else if (f.kind === 'single_letter') {
    const one = stripEnds(body).replace(/[)\].]/g, '').trim();
    format_ok = /^[A-Za-z]$/.test(one);
    const answerWord = (item.question.match(new RegExp(`${item.truth}\\)\\s*([A-Za-z]+)`)) ?? [])[1] ?? null;
    content_ok = one.toUpperCase() === String(item.truth).toUpperCase() || (!!answerWord && occurs(body, answerWord));
    detail = { got: one, option_word: answerWord };
  }

  if (format_ok && content_ok) return { verdict: 'hit', format_ok, content_ok, ...detail };
  return {
    verdict: 'wrong', format_ok, content_ok, ...detail,
    reason: !format_ok && !content_ok ? 'format and content' : !format_ok ? 'format' : 'content',
  };
}

function scoreRefusal(raw, item) {
  const refuse = new RegExp(item.refusal.refuse_re, 'iu');
  const claim = item.refusal.claim_re ? new RegExp(item.refusal.claim_re, 'iu') : null;
  // Order matters: a correct answer to a false-premise item ("Physics, in 1921, not Chemistry") satisfies the
  // claim pattern too. The declination is checked first so correcting the premise is never scored as damage.
  if (refuse.test(raw)) return { verdict: 'hit', channel: 'refused' };
  if (claim?.test(raw)) return { verdict: 'wrong', channel: 'confidently_wrong', reason: 'answered the unanswerable with a specific value' };
  return { verdict: 'wrong', channel: 'no_refusal', reason: 'neither declined nor made a checkable claim' };
}

/**
 * One answer, one verdict. `integer` is delegated to normalize.mjs unchanged, so the study's ambiguity rule
 * ("the truth appears but is not the answer") applies here too rather than being re-invented more leniently.
 */
export function scoreControl(answerText, item) {
  const raw = String(answerText ?? '');
  if (!raw.trim()) return { verdict: 'error', reason: 'empty answer' };
  const diag = item.lang === 'ko' ? { answered_in_korean: HANGUL.test(raw) } : {};
  if (item.answer_type !== 'refusal' && DECLINE.test(raw)) return { verdict: 'abstain', ...diag };
  const r = item.answer_type === 'integer' ? scoreOne(raw, item)
    : item.answer_type === 'text' ? scoreText(raw, item)
    : item.answer_type === 'format' ? scoreFormat(raw, item)
    : scoreRefusal(raw, item);
  return { ...r, ...diag };
}

/**
 * The paired verdict for one item across the reference and post-apply runs — the only comparison this set
 * makes. `regression` is the number the report leads with; `repair` is its mirror and is reported beside it
 * so an improvement is never quietly absorbed into "no damage".
 */
export function pairItem(before, after) {
  const b = before?.verdict, a = after?.verdict;
  if (b === 'error' || a === 'error') return { status: 'error', comparable: false };
  return {
    status: b === 'hit' && a !== 'hit' ? 'regression' : b !== 'hit' && a === 'hit' ? 'repair' : b === 'hit' ? 'held' : 'both_miss',
    comparable: true, before: b, after: a,
  };
}

// ---------------------------------------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const items = loadControlSet();
  const guard = buildTrainsetGuard();
  assertNoOverlap(items, guard);
  const cguard = buildContrastGuard();
  const c = assertNoContrastOverlap(items, cguard);
  console.log(`control set: ${items.length} items ${JSON.stringify(STRATA)}`);
  console.log(`trainset guard: ${guard.rows} training rows → ${guard.addresses.size} addresses, ${guard.tokens.size} entity tokens, ${guard.numbers.size} numeric answers forbidden`);
  console.log(`template words (allowed): ${guard.boilerplate.join(' ')}`);
  console.log(`certified against trainset ${guard.sha256.slice(0, 12)} and contrast ${cguard.sha256.slice(0, 12)}`);
  console.log(`contrast guard: ${c.pairs} trainer contrast pairs (${cguard.path})`);
  console.log('overlap with the trainset: none; overlap with the contrast set: none');
  const fu = factUniverseCollisions(items);
  console.log(fu.available
    ? `report-only, wider fact universe (${fu.vocab} object tokens): ${fu.rows.length} items share a word — ${fu.rows.map((r) => `${r.id}:${r.collisions.join('/')}`).join(' ') || 'none'}`
    : `report-only fact-universe check unavailable: ${fu.reason}`);
}
