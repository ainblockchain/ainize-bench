/**
 * Arm A (base model, no tools, no patch): ask for a canonical token address and score the answer.
 *
 * Four outcomes, because "wrong" hides the one that matters:
 *   correct     — the address on that chain
 *   cross_chain — the SAME token's address on the OTHER chain. The model knows the token and not the chain;
 *                 funds sent there are gone, and it is the failure a one-row lookup cannot fix by being faster.
 *   hallucinated— a well-formed 0x address that is neither
 *   refused     — no address offered
 */
import { readFileSync, writeFileSync } from 'node:fs';

const API = process.env.MODEL_API ?? 'http://localhost:8000/v1/chat/completions';
const MODEL = process.env.MODEL_ID ?? 'Qwen3.8-Flash-Next';
const N = Number(process.env.N ?? 120);
const CONC = Number(process.env.CONC ?? 8);

const truth = JSON.parse(readFileSync('data/truth.json', 'utf8'));
const cross = JSON.parse(readFileSync('data/cross_chain.json', 'utf8'));
const otherAddr = new Map();
for (const { symbol, rows } of cross) {
  for (const r of rows) {
    const other = rows.find((x) => x.chain !== r.chain);
    if (other && other.address !== r.address) otherAddr.set(`${r.chain}:${symbol}`, other.address);
  }
}

const items = truth.slice(0, N);
const ask = (r) => `What is the contract address of ${r.name} (${r.symbol}) on ${r.chain_label}? Reply with the address only.`;

async function one(r) {
  const body = { model: MODEL, messages: [{ role: 'user', content: ask(r) }], max_tokens: 300, temperature: 0 };
  let text = '';
  try {
    const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json();
    text = j?.choices?.[0]?.message?.content ?? '';
  } catch (e) { text = `ERROR ${e.message}`; }
  const found = (text.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((s) => s.toLowerCase());
  const other = otherAddr.get(`${r.chain}:${r.symbol}`);
  let verdict;
  if (!found.length) verdict = 'refused';
  else if (found.includes(r.address)) verdict = 'correct';
  else if (other && found.includes(other)) verdict = 'cross_chain';
  else verdict = 'hallucinated';
  return { ...r, answer: found[0] ?? null, raw: text.slice(0, 200), verdict, had_cross_option: !!other };
}

const out = [];
for (let i = 0; i < items.length; i += CONC) {
  out.push(...await Promise.all(items.slice(i, i + CONC).map(one)));
  process.stderr.write(`\r  ${out.length}/${items.length}`);
}
process.stderr.write('\n');
writeFileSync('out/arm_a.json', JSON.stringify(out, null, 2));

const pct = (n) => `${(n / out.length * 100).toFixed(1)}%`;
const c = (v) => out.filter((x) => x.verdict === v).length;
console.log(`\n=== Arm A — base model, no tools (${MODEL}), n=${out.length} ===`);
for (const v of ['correct', 'cross_chain', 'hallucinated', 'refused'])
  console.log(`  ${v.padEnd(13)} ${String(c(v)).padStart(4)}  ${pct(c(v)).padStart(7)}`);
console.log(`  ${'WRONG ADDRESS'.padEnd(13)} ${String(c('cross_chain') + c('hallucinated')).padStart(4)}  ${pct(c('cross_chain') + c('hallucinated')).padStart(7)}  ← 자금 손실로 이어지는 답`);

for (const ch of ['ethereum', 'base']) {
  const s = out.filter((x) => x.chain === ch);
  if (!s.length) continue;
  const k = (v) => s.filter((x) => x.verdict === v).length;
  console.log(`\n  [${ch}] n=${s.length}  correct ${(k('correct') / s.length * 100).toFixed(1)}%  ` +
    `cross-chain ${(k('cross_chain') / s.length * 100).toFixed(1)}%  hallucinated ${(k('hallucinated') / s.length * 100).toFixed(1)}%  refused ${(k('refused') / s.length * 100).toFixed(1)}%`);
}
console.log('\n  샘플 오답:');
for (const x of out.filter((x) => x.verdict !== 'correct' && x.verdict !== 'refused').slice(0, 8))
  console.log(`    ${x.symbol.padEnd(8)} ${x.chain.padEnd(9)} ${x.verdict.padEnd(12)} 답 ${x.answer}  정답 ${x.address}`);
