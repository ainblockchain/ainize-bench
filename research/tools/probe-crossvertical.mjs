#!/usr/bin/env node
// Which standardized vertical carries facts the base model gets WRONG?
// Six fact families over the on-chain truth set, base model only, no tools.
//
//   node tools/collect-onchain-truth.mjs > evidence/crossvertical-onchain-block<N>.json
//   node tools/probe-crossvertical.mjs evidence/crossvertical-onchain-block<N>.json
//
// Model server: http://localhost:8002 ONLY (never :8000 / :8001). temperature=0,
// enable_thinking=false, so the numbers are the model's first-pass recall — which is
// what a knowledge patch replaces. These are BASE-model numbers; no trained patch exists yet.
import fs from "fs";

const truthPath = process.argv[2];
if (!truthPath) { console.error("usage: probe-crossvertical.mjs <onchain-truth.json>"); process.exit(2); }
const truth = JSON.parse(fs.readFileSync(truthPath, "utf8"));
const URL = process.env.MODEL_URL || "http://localhost:8002/v1/chat/completions";
const MODEL = process.env.MODEL_NAME || "Qwen3.8-Flash-Next";

async function ask(q, max = 64) {
  const t0 = Date.now();
  const r = await fetch(URL, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: q }],
      max_tokens: max, temperature: 0, chat_template_kwargs: { enable_thinking: false } }) });
  const j = await r.json();
  return { text: (j.choices?.[0]?.message?.content || "").trim(), ms: Date.now() - t0,
    inTok: j.usage?.prompt_tokens, outTok: j.usage?.completion_tokens };
}
const REFUSE = /(do not have|don't have|do not know|don't know|cannot|can't|unable|not publicly|no public|not aware|i'm not|as an ai)/i;
const sharedPrefix = (a, b) => { a = a.toLowerCase(); b = b.toLowerCase();
  let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++; return i; };

async function family(id, label, items, judge, addressShaped = false) {
  const recs = [];
  for (const it of items) {
    const a = await ask(it.q);
    const correct = judge(a.text, it.truth);
    const refused = REFUSE.test(a.text);
    const rec = { truth: String(it.truth), answer: a.text.replace(/\s+/g, " ").slice(0, 90),
      correct, refused, ms: a.ms, inTok: a.inTok, outTok: a.outTok };
    if (addressShaped && !correct) {
      const m = a.text.match(/0x[0-9a-fA-F]{40}/);
      rec.emittedWellFormedAddress = !!m;
      // How many leading hex characters the hallucination shares with the truth.
      // A high number is the dangerous case: an address that survives an eyeball check.
      if (m) rec.sharedLeadingHexChars = sharedPrefix(m[0].slice(2), String(it.truth).slice(2));
    }
    recs.push(rec);
  }
  const nc = recs.filter(r => r.correct).length;
  const nr = recs.filter(r => !r.correct && r.refused).length;
  const ms = recs.map(r => r.ms).sort((a, b) => a - b);
  const counts = {}; recs.forEach(r => { counts[r.answer] = (counts[r.answer] || 0) + 1; });
  const [modalAnswer, modalCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const f = { id, family: label, n: recs.length, correct: nc,
    accuracy: +(100 * nc / recs.length).toFixed(1), refused: nr,
    confidentlyWrong: recs.length - nc - nr,
    confidentlyWrongPct: +(100 * (recs.length - nc - nr) / recs.length).toFixed(1),
    distinctTruths: new Set(recs.map(r => r.truth)).size,
    modalAnswer, modalAnswerCount: modalCount,
    medianMs: ms[Math.floor(ms.length / 2)],
    meanInputTokens: Math.round(recs.reduce((s, r) => s + (r.inTok || 0), 0) / recs.length),
    meanOutputTokens: Math.round(recs.reduce((s, r) => s + (r.outTok || 0), 0) / recs.length) };
  if (addressShaped) {
    const wrong = recs.filter(r => !r.correct);
    f.wrongButWellFormedAddress = wrong.filter(r => r.emittedWellFormedAddress).length;
    f.hallucinationsSharing4PlusLeadingHex = wrong.filter(r => (r.sharedLeadingHexChars || 0) >= 4).length;
    f.maxSharedLeadingHexChars = Math.max(0, ...wrong.map(r => r.sharedLeadingHexChars || 0));
  }
  f.records = recs;
  console.error(`${id} ${label}\n    acc ${f.accuracy}%  confidently-wrong ${f.confidentlyWrongPct}%  refused ${f.refused}` +
    `  median ${f.medianMs}ms  out ${f.meanOutputTokens}tok  modal "${modalAnswer}" ${modalCount}/${f.n}` +
    (addressShaped ? `  wrong-but-well-formed ${f.wrongButWellFormedAddress}  max-shared-prefix ${f.maxSharedLeadingHexChars}` : ""));
  return f;
}

const eqAddr = (a, t) => a.toLowerCase().includes(String(t).toLowerCase());
const eqSym = (a, t) => new RegExp(`\\b${String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(a);
const pct = f => f === 100 ? "1.00%" : f === 30 ? "0.30%" : f === 5 ? "0.05%" : f / 100 + "%";
const families = [];

families.push(await family("G1", "DEX  pool ADDRESS -> token pair (Messari dex-amm: LiquidityPool.inputTokens)",
  truth.dex.map(d => ({ q: `On Ethereum mainnet, the Uniswap V3 pool at ${d.pool} — which two tokens does it hold? Reply with just the two symbols separated by a slash, nothing else.`, truth: `${d.symbol0}/${d.symbol1}` })),
  (a, t) => { const [x, y] = t.split("/"); return eqSym(a, x) && eqSym(a, y); }));

families.push(await family("G2", "DEX  pool ADDRESS -> fee tier (Messari dex-amm: LiquidityPoolFee.feePercentage)",
  truth.dex.map(d => ({ q: `On Ethereum mainnet, what is the fee tier of the Uniswap V3 pool at ${d.pool}? Reply with just the number in basis points (e.g. 5, 30, 100), nothing else.`, truth: d.feeBps })),
  (a, t) => { const m = a.match(/-?\d+(\.\d+)?/); return m ? Math.abs(parseFloat(m[0]) - t) < 1e-9 : false; }));

families.push(await family("G3", "DEX  pair + fee -> pool ADDRESS (reverse lookup)",
  truth.dex.map(d => ({ q: `On Ethereum mainnet, what is the contract address of the Uniswap V3 ${d.symbol0}/${d.symbol1} pool with the ${pct(d.feeBps)} fee tier? Reply with the 0x address only.`, truth: d.pool })),
  eqAddr, true));

families.push(await family("G4", "LEND asset symbol -> aToken ADDRESS (Messari lending: Market.outputToken)",
  truth.lending.map(l => ({ q: `What is the contract address of the Aave V3 aToken for ${l.assetSymbol} on Ethereum mainnet? Reply with the 0x address only.`, truth: l.aToken })),
  eqAddr, true));

families.push(await family("G5", "LEND aToken ADDRESS -> its own symbol (Messari lending: Market.outputToken.symbol)",
  truth.lending.map(l => ({ q: `On Ethereum mainnet, the token contract at ${l.aToken} — what is its symbol? Reply with just the symbol, nothing else.`, truth: l.aTokenSymbol })),
  eqSym));

families.push(await family("G6", "LEND aToken ADDRESS -> underlying asset (Messari lending: Market.inputToken.symbol)",
  truth.lending.map(l => ({ q: `On Ethereum mainnet, the Aave V3 aToken at ${l.aToken} represents a deposit of which underlying asset? Reply with just the asset symbol, nothing else.`, truth: l.assetSymbol })),
  eqSym));

const out = { block: truth.block, chain: truth.chain, generatedAt: new Date().toISOString(),
  model: MODEL, thinking: false, arm: "A — base model, no tools, no knowledge patch",
  groundTruth: `public RPC eth_call, see ${truthPath}`, families };
const path = `evidence/crossvertical-base-model-probe-block${truth.block}.json`;
fs.writeFileSync(path, JSON.stringify(out, null, 2));
console.error("\nwrote " + path);
