#!/usr/bin/env node
// The near half of the locality set: load it, and PROVE it does not overlap the study's training rows.
//
//   node src/locality-near.mjs            # print the report, exit 1 on any overlap
//
// Why this file exists. The study in data/r1 trains arm C on exactly 120 {prompt, answer} rows
// (data/r1/trainset.jsonl). Those rows are written into a memory table addressed by content, so the damage a
// patch is most likely to do is not in a far-off domain — it is at the addresses NEXT TO the ones it trained.
// locality/near.jsonl is the probe for that: 20 prompts chosen to sit as close to the 120 as possible
// WITHOUT touching them. "Without touching them" is a claim, and a claim about a training set is worth
// nothing as an assertion by whoever picked the prompts. So it is recomputed here, from the files, every run.
//
// The eight checks, and what each one would catch:
//
//   C1 trainset provenance   Every one of the 120 trainset prompts re-derives, byte for byte, from a fact in
//                            split.study_fact_ids through its relation's P template. Without this, TRAINED_*
//                            below is a guess about what was trained; with it, it is a fact about the files.
//   C2 fact identity         No item's fact_id is a study fact, and none is one of the 188 fact_ids the
//                            study's own 250-item sample asks about. Catches "this is really a study item".
//   C3 subject identity      No item's subject is one of the 120 trained subjects. Catches the obvious.
//   C4 prompt containment    No trained subject occurs as a substring of any item's prompt. Catches a trained
//                            address smuggled in as context, or a second address in a two-entity question.
//   C5 answer disjointness   No item's ground-truth answer atom equals a trained answer atom (case-folded).
//                            This is the one that keeps a hit interpretable: a pool that also holds WETH
//                            scores partial credit for emitting a token the patch was trained to emit, so no
//                            item in this set holds one.
//   C6 prompt novelty        No item's prompt equals a trainset prompt or one of the 250 study questions.
//   C7 template fidelity     Every adjacent-entity prompt equals templates[relation].P with the subject
//                            substituted — no prompt in this stratum was hand-written or hand-tuned, so the
//                            surface the model sees differs from a training row in the subject and nowhere
//                            else. That is what makes it the sharpest probe available.
//   C8 truth provenance      Every adjacent-entity truth is re-read from data/r1/pull/<file> at the recorded
//                            json_path AND from the second pull in data/r1/pull-fresh/. Equal in both = the
//                            value is not volatile between pulls, so a post-apply miss is the patch and not
//                            the chain. A truth that cannot be re-read is a hard failure, never a default.
//
// C4 is deliberately substring, not token: a token check would have to decide what "VAULT" means, and VAULT
// is both an ordinary English word in every one of these prompts and the ticker in trained pool
// 0xdf2c408f0ad496b222bac96ecadc68703b9e0b2a. Twelve trained tickers are ordinary English words
// (ENGLISH_WORD_TICKERS below). Rather than carve them out of a token check and argue about the carve-out,
// the prompt side is checked against SUBJECTS — which are addresses and vault names, never English — and the
// answer side, where the ambiguity actually costs something, is checked at C5 as whole-atom equality.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BENCH = join(HERE, '..');
export const R1 = join(BENCH, 'data', 'r1');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/**
 * Trained tickers that are also ordinary English words. Listed so the reason C4 is a subject-substring check
 * and not a token check is auditable rather than asserted; loadStudy() fails if one of these is not in fact a
 * trained answer atom, so the list cannot rot into a fiction.
 */
export const ENGLISH_WORD_TICKERS = ['VAULT', 'INDEX', 'REAL', 'LOVE', 'DOG', 'HAPPY', 'MIX', 'HOP', 'IDLE', 'TOWER', 'FEAR', 'REVERSE'];

/** Read the pre-registered study and reduce it to the two sets everything else is measured against. */
export function loadStudy() {
  const split = readJson(join(R1, 'split.json'));
  const facts = new Map(readJsonl(join(R1, 'facts.jsonl')).map((f) => [f.fact_id, f]));
  const templates = readJson(join(BENCH, 'questions', 'templates.json')).families;
  const trainset = readJsonl(join(R1, 'trainset.jsonl'));
  const questions = readJsonl(join(R1, 'questions.jsonl'));

  const studyIds = new Set(split.study_fact_ids);
  const subjects = new Set(), atoms = new Set();
  for (const id of studyIds) {
    const f = facts.get(id);
    if (!f) throw new Error(`split.study_fact_ids names ${id}, which is not in facts.jsonl`);
    subjects.add(String(f.subject).toLowerCase());
    for (const o of (Array.isArray(f.object) ? f.object : [f.object])) atoms.add(String(o).trim().toLowerCase());
  }
  for (const w of ENGLISH_WORD_TICKERS) {
    if (!atoms.has(w.toLowerCase())) throw new Error(`ENGLISH_WORD_TICKERS lists ${w}, which is not a trained answer atom`);
  }
  const sampleFactIds = new Set(questions.flatMap((q) => q.fact_ids));
  return {
    split, facts, templates, trainset, questions, studyIds, subjects, atoms, sampleFactIds,
    trainPrompts: new Set(trainset.map((r) => r.prompt)),
    studyQuestions: new Set(questions.map((q) => q.question)),
  };
}

/**
 * Read one value out of a committed pull response by the json_path the fact recorded.
 * Supports the three shapes those paths actually take and NOTHING else — an unrecognised path throws, because
 * a truth this function cannot re-derive is a truth nobody has checked:
 *   $.data.vaults[0].symbol                       indexed object
 *   $.data.liquidityPools[135].inputTokens[*].sym map over a list
 *   $.data.vaults[4].fees[performance].feePercen  pick the list element whose feeType contains 'performance'
 */
export function resolveJsonPath(doc, jsonPath) {
  const path = jsonPath.split('#')[1];
  if (!path?.startsWith('$.')) throw new Error(`unsupported json_path ${jsonPath}`);
  let cur = doc, star = false;
  for (const m of path.slice(2).matchAll(/\.?([A-Za-z_][A-Za-z0-9_]*)|\[([^\]]+)\]/g)) {
    const [, name, br] = m;
    if (name !== undefined) {
      cur = star ? cur.map((c) => c[name]) : cur[name];
    } else if (br === '*') {
      if (!Array.isArray(cur)) throw new Error(`[*] on a non-list in ${jsonPath}`);
      star = true;
    } else if (/^\d+$/.test(br)) {
      cur = cur[Number(br)];
    } else {
      if (!Array.isArray(cur)) throw new Error(`[${br}] on a non-list in ${jsonPath}`);
      const hit = cur.filter((x) => String(x?.feeType ?? '').toLowerCase().includes(br.toLowerCase()));
      if (hit.length !== 1) throw new Error(`[${br}] matched ${hit.length} entries in ${jsonPath}`);
      cur = hit[0];
    }
    if (cur === undefined) throw new Error(`json_path ${jsonPath} ran off the end of the document`);
  }
  return cur;
}

const same = (a, b) => JSON.stringify(Array.isArray(a) ? a.map(String) : String(a))
                    === JSON.stringify(Array.isArray(b) ? b.map(String) : String(b));

/** Every check. Returns { checks: [{id, name, failures}], failures: n } — it never throws on a data problem. */
export function checkNearSet(items, study) {
  const checks = [];
  const add = (id, name, failures) => checks.push({ id, name, failures });

  // C1 — the exclusion sets really are the trainset.
  const c1 = [];
  const rendered = new Map();
  for (const id of study.studyIds) {
    const f = study.facts.get(id);
    const t = study.templates[f.relation];
    if (!t) { c1.push(`no template family for relation ${f.relation}`); continue; }
    rendered.set(t.P.replaceAll('{subject}', f.subject), id);
  }
  for (const row of study.trainset) {
    if (!rendered.has(row.prompt)) c1.push(`trainset row does not re-derive from any study fact: ${row.prompt}`);
  }
  add('C1', 'trainset provenance', c1);

  const adj = items.filter((i) => i.stratum === 'adjacent-entity');
  const nd = items.filter((i) => i.stratum === 'near-domain-conceptual');
  const c2 = [], c3 = [], c4 = [], c5 = [], c6 = [], c7 = [], c8 = [];

  for (const it of items) {
    for (const fid of it.fact_ids ?? []) {
      if (study.studyIds.has(fid)) c2.push(`${it.id}: fact_id ${fid} IS a study fact`);
      if (study.sampleFactIds.has(fid)) c2.push(`${it.id}: fact_id ${fid} is asked by the 250-item study sample`);
    }
    if (it.subject && study.subjects.has(String(it.subject).toLowerCase())) {
      c3.push(`${it.id}: subject ${it.subject} IS a trained subject`);
    }
    const q = it.question.toLowerCase();
    for (const s of study.subjects) if (q.includes(s)) c4.push(`${it.id}: prompt contains trained subject ${s}`);
    for (const a of (Array.isArray(it.truth) ? it.truth : it.truth == null ? [] : [it.truth])) {
      if (study.atoms.has(String(a).trim().toLowerCase())) c5.push(`${it.id}: answer atom ${JSON.stringify(a)} IS a trained answer`);
    }
    if (study.trainPrompts.has(it.question)) c6.push(`${it.id}: prompt is a trainset prompt`);
    if (study.studyQuestions.has(it.question)) c6.push(`${it.id}: prompt is one of the 250 study questions`);
  }

  // C7 — the adjacent stratum uses the study's own P template and nothing else.
  for (const it of adj) {
    const t = study.templates[it.relation];
    if (!t) { c7.push(`${it.id}: no template family for ${it.relation}`); continue; }
    const want = t.P.replaceAll('{subject}', it.subject);
    if (it.question !== want) c7.push(`${it.id}: prompt is not the P render\n    got  ${it.question}\n    want ${want}`);
    if (it.answer_type !== t.answer_type) c7.push(`${it.id}: answer_type ${it.answer_type} != template ${t.answer_type}`);
  }
  // the conceptual stratum must carry no address at all — a rubric-scored prose answer has no subject to hide.
  for (const it of nd) {
    const hex = it.question.match(/0x[0-9a-fA-F]{6,}/g);
    if (hex) c7.push(`${it.id}: a conceptual prompt must contain no address, found ${hex.join(', ')}`);
    if (it.answer_type !== 'prose') c7.push(`${it.id}: answer_type must be 'prose'`);
    if (!it.rubric?.must_include?.length) c7.push(`${it.id}: no rubric`);
  }
  add('C2', 'fact identity', c2);
  add('C3', 'subject identity', c3);
  add('C4', 'prompt containment', c4);
  add('C5', 'answer disjointness', c5);
  add('C6', 'prompt novelty', c6);
  add('C7', 'template fidelity', c7);

  // C8 — re-read every adjacent truth from both committed pulls.
  const cache = new Map();
  const load = (dir, file) => {
    const k = `${dir}/${file}`;
    if (!cache.has(k)) cache.set(k, readJson(join(R1, dir, file)));
    return cache.get(k);
  };
  for (const it of adj) {
    const file = it.source.json_path.split('#')[0];
    let a, b;
    try { a = resolveJsonPath(load('pull', file), it.source.json_path); }
    catch (e) { c8.push(`${it.id}: pull/${file}: ${e.message}`); continue; }
    try { b = resolveJsonPath(load('pull-fresh', file), it.source.json_path); }
    catch (e) { c8.push(`${it.id}: pull-fresh/${file}: ${e.message}`); continue; }
    if (!same(a, it.truth)) c8.push(`${it.id}: truth ${JSON.stringify(it.truth)} != pull ${JSON.stringify(a)}`);
    if (!same(a, b)) c8.push(`${it.id}: VOLATILE — pull ${JSON.stringify(a)} != pull-fresh ${JSON.stringify(b)}`);
  }
  add('C8', 'truth provenance', c8);

  return { checks, failures: checks.reduce((n, c) => n + c.failures.length, 0) };
}

export function loadNearSet() {
  const items = readJsonl(join(BENCH, 'locality', 'near.jsonl'));
  if (items.length !== 20) throw new Error(`locality/near.jsonl holds ${items.length} items, expected 20`);
  const byStratum = {};
  for (const it of items) byStratum[it.stratum] = (byStratum[it.stratum] ?? 0) + 1;
  for (const [s, n] of [['adjacent-entity', 10], ['near-domain-conceptual', 10]]) {
    if (byStratum[s] !== n) throw new Error(`stratum ${s} holds ${byStratum[s]} items, expected ${n}`);
  }
  return items;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const study = loadStudy();
  const items = loadNearSet();
  const { checks, failures } = checkNearSet(items, study);
  console.log(`locality/near.jsonl — 20 items against ${study.trainset.length} trainset rows / ${study.studyIds.size} study facts\n`);
  for (const c of checks) {
    console.log(`  ${c.failures.length === 0 ? 'ok  ' : 'FAIL'} ${c.id} ${c.name}${c.failures.length ? ` — ${c.failures.length}` : ''}`);
    for (const f of c.failures) console.log(`         ${f}`);
  }
  console.log(`\n  trained subjects ${study.subjects.size} · trained answer atoms ${study.atoms.size} · study sample fact_ids ${study.sampleFactIds.size}`);
  console.log(failures === 0 ? '\nDISJOINT.' : `\n${failures} OVERLAP(S).`);
  process.exit(failures === 0 ? 0 : 1);
}
