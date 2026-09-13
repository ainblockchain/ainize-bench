/**
 * Ground truth for the two chain agents: canonical token addresses on Ethereum and Base.
 *
 * No Graph, no key. CoinGecko's `/coins/list?include_platform=true` carries every token's address on every
 * chain it lists, and `/coins/markets` carries the ranking — joined, that is "the N most-asked-about tokens
 * and where each one actually lives". The pair (chain, token) is the unit: the same symbol has a different
 * address on each chain, which is the confusion this whole benchmark exists to measure.
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const CG = 'https://api.coingecko.com/api/v3';
const CHAINS = { ethereum: 'Ethereum', base: 'Base' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, cache) {
  if (cache && existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': 'ainize-chain-bench/1.0' } });
    if (r.ok) { const j = await r.json(); if (cache) writeFileSync(cache, JSON.stringify(j)); return j; }
    if (r.status === 429) { await sleep(20000 * (i + 1)); continue; }
    throw new Error(`${r.status} ${url}`);
  }
  throw new Error(`gave up: ${url}`);
}

const list = await get(`${CG}/coins/list?include_platform=true`, 'data/cg_list.json');
console.log('coins with platforms:', list.length);

const markets = [];
for (let page = 1; page <= 2; page++) {
  markets.push(...await get(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`,
    `data/cg_markets_${page}.json`));
  await sleep(3000);
}
console.log('ranked coins:', markets.length);

const byId = new Map(list.map((c) => [c.id, c]));
const rows = [];
for (const m of markets) {
  const c = byId.get(m.id);
  if (!c) continue;
  for (const [chain, label] of Object.entries(CHAINS)) {
    const addr = (c.platforms || {})[chain];
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
    rows.push({
      chain, chain_label: label, id: m.id, symbol: (m.symbol || '').toUpperCase(), name: m.name,
      address: addr.toLowerCase(), rank: m.market_cap_rank ?? null, market_cap: m.market_cap ?? null,
    });
  }
}
rows.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
writeFileSync('data/truth.json', JSON.stringify(rows, null, 2));

const per = Object.fromEntries(Object.keys(CHAINS).map((c) => [c, rows.filter((r) => r.chain === c).length]));
console.log('ground-truth rows:', rows.length, per);

// The pairs that make the point: one symbol, two chains, two addresses.
const bySym = new Map();
for (const r of rows) { const k = r.symbol; (bySym.get(k) ?? bySym.set(k, []).get(k)).push(r); }
const both = [...bySym.entries()].filter(([, v]) => new Set(v.map((x) => x.chain)).size === 2);
writeFileSync('data/cross_chain.json', JSON.stringify(both.map(([s, v]) => ({ symbol: s, rows: v })), null, 2));
console.log('symbols present on BOTH chains (different addresses):', both.length);
for (const [s, v] of both.slice(0, 12)) {
  const e = v.find((x) => x.chain === 'ethereum'), b = v.find((x) => x.chain === 'base');
  console.log(`  ${s.padEnd(8)} eth ${e.address}  base ${b.address}`);
}
