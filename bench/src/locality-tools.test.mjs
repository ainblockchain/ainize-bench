/**
 * Self-test for src/locality-tools.mjs — the tools-declared half of §6's side-effect table.
 *
 *   node src/locality-tools.test.mjs
 *
 * No GPU, no key, no network, no model. The model and the MCP are replaced by fakes whose answers this file
 * chooses, so every branch of the comparison can be driven on purpose: an item that holds still, an item that
 * moves, an item that cannot answer twice the same way, an item that reaches for a tool on a recipe question.
 *
 * The property that matters most here is the DENOMINATOR. An instrument that quietly counted an item the base
 * model could not answer twice the same way would price temperature-0 jitter as damage done by the patch, and
 * it would do so in the direction that flatters us. So the exclusion is asserted from both ends: the unstable
 * item is absent from every cell's n, and the cells that DID hold still are unaffected by its presence.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CELLS, loadPrompts, textKey, scoredKey, unitsToCell, compare, renderTable, joinWith,
  engineDiff, systemFor, askOne,
} from './locality-tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(HERE, '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); } };

/* --- the four cells differ in exactly two things ------------------------------------------------------- */
ok('there are four cells', CELLS.length === 4);
ok('the cells are the four corners of tools x patch',
  JSON.stringify(CELLS.map((c) => [c.id, c.tools, c.patch])) === JSON.stringify([['A', false, false], ['B', true, false], ['C', false, true], ['D', true, true]]));

/* --- the prompt set is read, never written ------------------------------------------------------------- */
{
  const before = fs.readdirSync(path.join(BENCH, 'locality')).sort();
  const { items, from, sha256 } = loadPrompts();
  const after = fs.readdirSync(path.join(BENCH, 'locality')).sort();
  ok('loading the prompt set writes nothing into locality/', JSON.stringify(before) === JSON.stringify(after));
  ok('the committed set is 50 prompts (README §6)', items.length === 50, `${items.length} from ${from}`);
  ok('every prompt has a non-empty string', items.every((i) => typeof i.prompt === 'string' && i.prompt.trim()));
  ok('every id is unique', new Set(items.map((i) => i.id)).size === items.length);
  ok('the set carries a content hash so a changed set is a detected condition', /^[0-9a-f]{64}$/.test(sha256));
  ok('both halves are represented', new Set(items.map((i) => i.half)).size === 2, JSON.stringify([...new Set(items.map((i) => i.half))]));
  ok('the far half exists and is the one §6 describes', items.filter((i) => i.half !== 'near').length >= 25);
  const langs = new Set(items.map((i) => i.lang));
  ok('Korean prompts are in the set (§6 names two; the committed set has more)', langs.has('ko'));
}

/* --- a set this file does not recognise is refused rather than half-read ------------------------------- */
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'loc-tools-'));
  let threw = false;
  try { loadPrompts(d); } catch { threw = true; }
  ok('an empty directory is refused — this file carries no prompt set of its own', threw);
  fs.writeFileSync(path.join(d, 'prompts.jsonl'), JSON.stringify({ id: 'x' }) + '\n');
  threw = false; try { loadPrompts(d); } catch { threw = true; }
  ok('a row with neither prompt nor question is refused', threw);
  fs.writeFileSync(path.join(d, 'prompts.jsonl'), [{ id: 'x', prompt: 'a' }, { id: 'x', prompt: 'b' }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  threw = false; try { loadPrompts(d); } catch { threw = true; }
  ok('duplicate ids are refused', threw);
  fs.writeFileSync(path.join(d, 'prompts.jsonl'), '');
  fs.writeFileSync(path.join(d, 'near.jsonl'), JSON.stringify({ id: 'n1', question: 'q?', stratum: 'adjacent-entity' }) + '\n');
  fs.writeFileSync(path.join(d, 'control.jsonl'), JSON.stringify({ id: 'c1', question: 'q2?', stratum: 'far_domain' }) + '\n');
  const fb = loadPrompts(d);
  ok('with no prompts.jsonl the two halves are concatenated instead', fb.items.length === 2 && /near\.jsonl \+/.test(fb.from), fb.from);
  ok('a `question` field is accepted as the prompt', fb.items[0].prompt === 'q?');
  fs.rmSync(d, { recursive: true, force: true });
}

/* --- the two agreement keys ---------------------------------------------------------------------------- */
{
  ok('textKey folds outer whitespace and a trailing stop', textKey('  1912. ') === textKey('1912'));
  ok('textKey folds run-together spacing', textKey('a  b') === textKey('a b'));
  ok('textKey is case-insensitive', textKey('Paris') === textKey('paris'));
  ok('textKey does NOT fold a different answer', textKey('1912') !== textKey('1913'));
  const item = { id: 'i', answer_type: 'integer', truth: '1912' };
  ok('scoredKey treats a formatted right answer as the same answer', scoredKey(item, 'The year was 1912.') === scoredKey(item, '1912'));
  ok('scoredKey separates a right answer from a wrong one', scoredKey(item, '1912') !== scoredKey(item, '1913'));
  ok('scoredKey gives an abstention its own key', scoredKey(item, 'I do not know') === '<abstain>');
  const prose = { id: 'p', answer_type: null, truth: null };
  ok('an item with no answer_type falls back to the strict key, not to nothing',
    scoredKey(prose, 'a long explanation') === textKey('a long explanation'));
  ok('an answer_type the scorer has no rule for also falls back', scoredKey({ id: 'z', answer_type: 'prose', truth: 'x' }, 'hello') === textKey('hello'));
}

/* --- the comparison ------------------------------------------------------------------------------------ */
const items = [
  { id: 'i1', stratum: 'far-domain', half: 'far', answer_type: 'integer', truth: '1912' },
  { id: 'i2', stratum: 'far-domain', half: 'far', answer_type: null, truth: null },
  { id: 'i3', stratum: 'korean', half: 'far', answer_type: null, truth: null },
  { id: 'i4', stratum: 'adjacent-entity', half: 'near', answer_type: null, truth: null },
];
const unit = (cell, id, repeat, final, extra = {}) => ({ cell, item_id: id, repeat, final, error: null, evidence: { tool_calls: 0 }, ...extra });
const cellUnits = (cell, answers, extras = {}) => Object.entries(answers).flatMap(([id, arr]) => arr.map((a, r) => unit(cell, id, r, a, extras[id] ?? {})));

const A = cellUnits('A', { i1: ['1912', '1912'], i2: ['blue', 'blue'], i3: ['서울', '서울'], i4: ['I do not know', 'something else'] });
const B = cellUnits('B', { i1: ['1912', '1912'], i2: ['blue', 'blue'], i3: ['부산', '부산'], i4: ['x', 'x'] }, { i2: { evidence: { tool_calls: 1 } } });
const C = cellUnits('C', { i1: ['The year was 1912.', '1912'], i2: ['green', 'green'], i3: ['서울', '서울'], i4: ['y', 'y'] });

const build = (keyOf) => {
  const cells = { A: unitsToCell(items, A, keyOf), B: unitsToCell(items, B, keyOf), C: unitsToCell(items, C, keyOf) };
  return compare(items, cells, keyOf);
};
{
  const cmp = build(scoredKey);
  ok('an item the reference could not answer twice the same way is marked unstable',
    cmp.unstable_in_reference.length === 1 && cmp.unstable_in_reference[0] === 'i4', JSON.stringify(cmp.unstable_in_reference));
  ok('the unstable item is out of EVERY cell\'s denominator',
    Object.values(cmp.per_cell).every((c) => c.n === 3), JSON.stringify(Object.fromEntries(Object.entries(cmp.per_cell).map(([k, v]) => [k, v.n]))));
  ok('the denominator is stated once, at the top', cmp.denominator === 3);
  ok('cell A agrees with itself by construction', cmp.per_cell.A.agreement === 1);
  ok('cell B\'s one changed answer is found', cmp.per_cell.B.changed === 1 && cmp.per_cell.B.changed_items[0].item_id === 'i3');
  ok('cell C\'s one changed answer is found', cmp.per_cell.C.changed === 1 && cmp.per_cell.C.changed_items[0].item_id === 'i2');
  ok('a reformatted right answer is NOT counted as a change under the scored key',
    !cmp.per_cell.C.changed_items.some((x) => x.item_id === 'i1'));
  ok('a changed answer is reported with both texts in full',
    cmp.per_cell.C.changed_items[0].reference === 'blue' && cmp.per_cell.C.changed_items[0].answer === 'green');
  ok('a tool call on a prompt that never needed one is counted', cmp.per_cell.B.items_that_called_a_tool === 1);
  ok('cells that need no tool report zero', cmp.per_cell.A.items_that_called_a_tool === 0 && cmp.per_cell.C.items_that_called_a_tool === 0);
  ok('the agreement carries a Wilson interval, not a bare fraction',
    Array.isArray(cmp.per_cell.B.agreement_ci95) && cmp.per_cell.B.agreement_ci95[0] < cmp.per_cell.B.agreement && cmp.per_cell.B.agreement_ci95[1] > cmp.per_cell.B.agreement);
  ok('per-stratum counts sum to the cell', Object.values(cmp.per_cell.B.per_stratum).reduce((s, x) => s + x.n, 0) === cmp.per_cell.B.n);
  ok('a cell that was not captured is simply absent, never zero-filled', cmp.per_cell.D === undefined);
}
{
  const cmp = build((_i, t) => textKey(t));
  ok('under the strict key the reformatted answer DOES count as a change',
    cmp.per_cell.C.changed_items.some((x) => x.item_id === 'i1'), JSON.stringify(cmp.per_cell.C.changed_items.map((x) => x.item_id)));
  ok('the strict key is a sensitivity view, not the headline — both keys are derivable from the same units',
    cmp.per_cell.C.changed === 2);
}
{
  // An item that errors in the reference has no reference either.
  const A2 = [...cellUnits('A', { i1: ['1912', '1912'] }), unit('A', 'i2', 0, '', { error: 'http 500' }), unit('A', 'i2', 1, '', { error: 'http 500' })];
  const B2 = cellUnits('B', { i1: ['1912', '1912'], i2: ['blue', 'blue'] });
  const cmp = compare(items.slice(0, 2), { A: unitsToCell(items, A2, scoredKey), B: unitsToCell(items, B2, scoredKey) }, scoredKey);
  ok('an item that errored in the reference is excluded too', cmp.unstable_in_reference.includes('i2') && cmp.per_cell.B.n === 1);
}
{
  let threw = false;
  try { compare(items, { B: unitsToCell(items, B, scoredKey) }, scoredKey); } catch { threw = true; }
  ok('a comparison with no reference cell is refused rather than defaulted', threw);
}

/* --- the system prompts: §2's "only two cells differ" --------------------------------------------------- */
{
  const deps = '- selftest (messari, MAINNET): QmXYZ';
  const a = systemFor(CELLS[0], deps), b = systemFor(CELLS[1], deps), c = systemFor(CELLS[2], deps), d = systemFor(CELLS[3], deps);
  ok('cells A and C share a system prompt byte for byte', a === c);
  ok('cells B and D share a system prompt byte for byte', b === d);
  ok('the tool-less prompt is exactly system-prompts/plain.txt', a === fs.readFileSync(path.join(BENCH, 'system-prompts', 'plain.txt'), 'utf8'));
  ok('the tools prompt is system-prompts/tools.txt with the deployments filled in', b.includes(deps) && !b.includes('{{DEPLOYMENTS}}'));
  ok('the tools prompt is a superset of the plain one (§2: the asymmetry is additive)', b.startsWith(a.trimEnd().slice(0, 200)));
}

/* --- asking: the no-tools cell must not declare tools -------------------------------------------------- */
{
  const seen = [];
  const fakeVllm = { async turn(body) { seen.push(body); return { content: 'answer', ms: 5, usage: { prompt_tokens: 10, completion_tokens: 2 } }; } };
  const r = await askOne({ vllm: fakeVllm, mcp: {}, runToolLoop: async () => { throw new Error('the tool loop must not be reached for a no-tools cell'); }, cell: CELLS[0], system: 'sys', item: { id: 'i', prompt: 'p' } });
  ok('a no-tools cell sends no tools key AT ALL, which is not the same as an empty list', !('tools' in seen[0]));
  ok('a no-tools cell sends the system prompt then the prompt, and nothing else', seen[0].messages.length === 2 && seen[0].messages[1].content === 'p');
  ok('a no-tools cell records zero tool calls', r.evidence.tool_calls === 0);
  ok('a no-tools cell returns the content as the final answer', r.final === 'answer');

  const loopArgs = [];
  const r2 = await askOne({
    vllm: fakeVllm, mcp: { toolSchemas: [{ type: 'function', function: { name: 't' } }] },
    runToolLoop: async (a) => { loopArgs.push(a); return { final: 'tool answer', turns: [{ usage: { prompt_tokens: 99 } }], ev: { tool_calls: 2, model_ms: 7 } }; },
    cell: CELLS[1], system: 'sys-tools', item: { id: 'i', prompt: 'p' },
  });
  ok('a tools cell goes through the same tool loop arms B and D use', loopArgs.length === 1 && loopArgs[0].question === 'p');
  ok('a tools cell carries its tool-call count into the unit', r2.evidence.tool_calls === 2);
  ok('a tools cell returns the loop\'s final answer', r2.final === 'tool answer');

  const r3 = await askOne({ vllm: { async turn() { return { error: 'transport: boom', ms: 1 }; } }, mcp: {}, runToolLoop: async () => ({}), cell: CELLS[0], system: 's', item: { id: 'i', prompt: 'p' } });
  ok('a transport failure is recorded as an error, not as an empty answer that agrees with nothing', r3.error === 'transport: boom' && r3.final === '');
}

/* --- the engine identity check -------------------------------------------------------------------------- */
{
  const s = { read: true, container: 'x', cmd: 'a', restart_count: 0, started_at: 't' };
  ok('an unchanged engine produces no diff', engineDiff(s, { ...s }).length === 0);
  ok('a restart is caught by the counter', engineDiff(s, { ...s, restart_count: 1 }).length === 1);
  ok('a relaunch with different flags is caught by the command line', engineDiff(s, { ...s, cmd: 'b' })[0].startsWith('cmd:'));
  ok('a relaunch that reset both counters is caught by the start time', engineDiff(s, { ...s, started_at: 'u' }).length === 1);
  ok('a host with no docker returns null rather than a false all-clear', engineDiff({ read: false }, s) === null);
}

/* --- the report ----------------------------------------------------------------------------------------- */
{
  const cmp = build(scoredKey);
  const prov = { prompt_set: { from: 'locality/prompts.jsonl', sha256: 'abc123def456' }, key_mode: 'scored', stamps: ['SIMULATED PATCH — NOT A TRAINED MODEL'] };
  const md = renderTable(cmp, prov);
  ok('the table has four cells', /\| \*\*base model\*\* \|/.test(md) && /\| \*\*knowledge applied\*\* \|/.test(md));
  ok('an uncaptured cell says so instead of printing a number', md.includes('_not captured_'));
  ok('the §9 stamp travels with the table', md.includes('SIMULATED PATCH'));
  ok('the denominator and the unstable count are stated above the numbers', /1 of 4 prompts were unstable/.test(md));
  ok('every changed answer is printed in full, both sides', md.includes('reference: blue') && md.includes('C answer: green'));
  ok('the B-vs-A question is named, not left for the reader to infer', md.includes('does DECLARING tools'));
  ok('the README\'s correction is carried into the report', md.includes('no analogue'));
  ok('the resolution limit is printed with the table, not in an appendix', md.includes('cannot see'));
  ok('the reference being the base answer and not a correct answer is stated', md.includes('not a correct answer'));
  ok('a per-stratum table is printed', md.includes('### Per stratum'));
  ok('an engine change is stamped across the top when it happened',
    renderTable(cmp, { ...prov, engine_changed: ['restart_count: 0 -> 1'] }).includes('CONFOUNDED WITH A RESTART'));
}

/* --- a partial capture can never be re-read as the measurement ------------------------------------------ */
{
  const cmp = build(scoredKey);
  const full = renderTable(cmp, { prompt_set: { from: 'locality/prompts.jsonl', sha256: 'a'.repeat(64), items_in_file: 50, filter: { stratum: 'far-domain', limit: 4 } }, key_mode: 'scored' });
  ok('the header names the size of the FILE, not the size of the capture', full.includes('50 prompts'));
  ok('a capture smaller than the file is called a smoke run in the header', /This capture asked 4 of them/.test(full) && /not the measurement/.test(full));
  const whole = renderTable(cmp, { prompt_set: { from: 'x', sha256: 'b'.repeat(64), items_in_file: 4 }, key_mode: 'scored' });
  ok('a full capture says nothing about being partial', !/smoke run/.test(whole));
}

/* --- the score/table path scores what was captured, not what is on disk --------------------------------- */
{
  const { items: real } = loadPrompts();
  const three = real.slice(0, 3);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'loc-score-'));
  const us = [];
  for (const c of ['A', 'B']) for (const it of three) for (const r of [0, 1]) us.push({ cell: c, item_id: it.id, repeat: r, final: c === 'B' && it.id === three[2].id ? 'moved' : 'held', error: null, evidence: { tool_calls: 0 } });
  fs.writeFileSync(path.join(d, 'units.json'), JSON.stringify(us));
  fs.writeFileSync(path.join(d, 'provenance.json'), JSON.stringify({ key_mode: 'scored', prompt_set: { from: 'locality/prompts.jsonl', sha256: 'c'.repeat(64), items_in_file: real.length } }));
  const { execFileSync } = await import('node:child_process');
  execFileSync('node', [path.join(HERE, 'locality-tools.mjs'), 'score', '--in', d], { encoding: 'utf8' });
  const out = JSON.parse(fs.readFileSync(path.join(d, 'four-cell.json'), 'utf8'));
  ok('re-scoring a 3-item capture uses a denominator of 3, not of 50', out.items_total === 3 && out.denominator === 3, JSON.stringify({ t: out.items_total, d: out.denominator }));
  ok('re-scoring finds the same one changed answer the capture holds', out.per_cell.B.changed === 1 && out.per_cell.B.changed_items[0].item_id === three[2].id);
  ok('re-scoring writes both the json and the markdown', fs.existsSync(path.join(d, 'four-cell.md')));
  ok('the re-scored markdown carries the file size and the capture size separately',
    fs.readFileSync(path.join(d, 'four-cell.md'), 'utf8').includes(`${real.length} prompts`));

  // A capture whose ids are no longer in the set is refused, not scored against whatever still matches.
  fs.writeFileSync(path.join(d, 'units.json'), JSON.stringify([...us, { cell: 'A', item_id: 'ghost', repeat: 0, final: 'x', error: null, evidence: {} }]));
  let refused = false;
  try { execFileSync('node', [path.join(HERE, 'locality-tools.mjs'), 'score', '--in', d], { encoding: 'utf8', stdio: 'pipe' }); } catch { refused = true; }
  ok('a capture holding an id the prompt set no longer has is refused', refused);
  fs.rmSync(d, { recursive: true, force: true });
}

/* --- joining with the tool-less capture ----------------------------------------------------------------- */
{
  const cmp = build(scoredKey);
  ok('no path means no join, not an invented one', joinWith(cmp, null) === null);
  ok('a path that is not there means no join', joinWith(cmp, '/nonexistent/report.json') === null);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'loc-join-'));
  const p = path.join(d, 'report.json');
  fs.writeFileSync(p, JSON.stringify({ overall: { same: cmp.per_cell.C.same, n: cmp.per_cell.C.n } }));
  ok('two instruments that agree say so', /agree exactly/.test(joinWith(cmp, p).agreement));
  fs.writeFileSync(p, JSON.stringify({ overall: { same: 0, n: 3 } }));
  ok('two instruments that disagree say THAT, loudly', /DISAGREE/.test(joinWith(cmp, p).agreement));
  fs.writeFileSync(p, 'not json');
  ok('an unreadable report is reported as unreadable, never silently skipped', /not readable/.test(joinWith(cmp, p).note));
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
