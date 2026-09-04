/**
 * Self-test for the offline half of the pipeline: facts.mjs and questions.mjs.
 *
 *   node src/pipeline.test.mjs
 *
 * WHAT THE FIXTURE IS, AND WHAT IT IS NOT. The rows below are invented. They exist ONLY to check that the
 * extractor walks the standardized shape correctly and that the anti-circularity rules hold — the same thing
 * a unit test does anywhere. They are not data, they never enter `data/`, and they cannot become a run:
 *
 *   - the fixture is written to a throwaway directory outside the repo (AINIZE_BENCH_DATA), removed at the end;
 *   - every fixture response is stamped `"_ainize": {"synthetic": true, ...}`;
 *   - `src/run.mjs` refuses to start against any pull whose manifest carries `synthetic`, and `src/score.mjs`
 *     refuses to score one.
 *
 * A benchmark number can therefore never come out of this file, which is the only property that matters.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; } else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ainize-bench-selftest-'));
const RUN = 'SELFTEST-SYNTHETIC';
const pullDir = path.join(root, 'data', RUN, 'pull');
fs.mkdirSync(pullDir, { recursive: true });

const addr = (n) => `0x${String(n).padStart(2, '0').repeat(20)}`.slice(0, 42);
const stamp = (query, extra = {}) => ({ synthetic: true, deployment_id: 'QmSELFTEST', protocol: 'selftest', query, query_hash: 'deadbeef', block: 1_000_000, skip: 0, first: 1000, ...extra });

// 12 vaults over 2 underlying assets, TVLs spaced far apart so the ordering items are emitted.
const vaults = Array.from({ length: 12 }, (_, i) => ({
  id: addr(i + 10),
  name: `Test Vault ${i}`,
  symbol: `tv${i}`,
  totalValueLockedUSD: String(1_000_000 * (12 - i) ** 2),
  pricePerShare: '1.0',
  depositLimit: '0',
  inputToken: { id: addr(i % 2 === 0 ? 90 : 91), name: i % 2 === 0 ? 'USD Coin' : 'Wrapped Ether', symbol: i % 2 === 0 ? 'USDC' : 'WETH', decimals: 18, lastPriceUSD: '1' },
  outputToken: null,
  fees: [{ feeType: 'PERFORMANCE_FEE', feePercentage: String(10 + i) }],
  protocol: { id: 'p', name: 'Selftest', slug: 'selftest', network: 'MAINNET', type: 'YIELD', schemaVersion: '3.0.0' },
}));
fs.writeFileSync(path.join(pullDir, 'selftest.vaults.p0.json'), JSON.stringify({ _ainize: stamp('vaults'), data: { vaults, _meta: { block: { number: 1_000_000 } } } }));

// A conflicting duplicate in a SECOND protocol: same subject, different object. Must be dropped, not guessed.
fs.writeFileSync(path.join(pullDir, 'other.vaults.p0.json'), JSON.stringify({
  _ainize: stamp('vaults', { protocol: 'other', deployment_id: 'QmOTHER' }),
  data: { vaults: [{ ...vaults[0], symbol: 'CONFLICTING', name: 'Conflicting Name' }], _meta: { block: { number: 1_000_000 } } },
}));

const markets = Array.from({ length: 4 }, (_, i) => ({
  id: addr(i + 40), name: `Market ${i}`, isActive: true, canBorrowFrom: true,
  totalValueLockedUSD: '1000', maximumLTV: '80', liquidationThreshold: '85',
  totalDepositBalanceUSD: '1', totalBorrowBalanceUSD: '1',
  inputToken: { id: addr(90), name: 'USD Coin', symbol: 'USDC', decimals: 6, lastPriceUSD: '1' },
  outputToken: null,
  rates: [{ rate: String(3 + i), side: 'LENDER', type: 'VARIABLE' }, { rate: '9', side: 'BORROWER', type: 'VARIABLE' }],
  protocol: { id: 'p', name: 'Selftest', slug: 'selftest', network: 'MAINNET', type: 'LENDING', schemaVersion: '3.0.0' },
}));
fs.writeFileSync(path.join(pullDir, 'selftest.markets.p0.json'), JSON.stringify({ _ainize: stamp('markets'), data: { markets, _meta: { block: { number: 1_000_000 } } } }));

fs.writeFileSync(path.join(pullDir, 'manifest.json'), JSON.stringify({
  runid: RUN, synthetic: true, block: 1_000_000, pulled_at: new Date().toISOString(), heads: [],
  responses: [
    { file: 'selftest.vaults.p0.json', deployment_id: 'QmSELFTEST', protocol: 'selftest', query: 'vaults', query_hash: 'deadbeef', block: 1_000_000, skip: 0, ms: 0 },
    { file: 'other.vaults.p0.json', deployment_id: 'QmOTHER', protocol: 'other', query: 'vaults', query_hash: 'deadbeef', block: 1_000_000, skip: 0, ms: 0 },
    { file: 'selftest.markets.p0.json', deployment_id: 'QmSELFTEST', protocol: 'selftest', query: 'markets', query_hash: 'deadbeef', block: 1_000_000, skip: 0, ms: 0 },
  ],
}, null, 2));

const env = { ...process.env, AINIZE_BENCH_DATA: root };
const run = (script, ...args) => execFileSync(process.execPath, [path.join(BENCH, script), ...args], { env, encoding: 'utf8', cwd: BENCH });

console.log('pipeline self-test (synthetic fixture, throwaway directory)\n');

// ---- facts.mjs ---------------------------------------------------------------------------------------
const factsOut = run('pipeline/facts.mjs', '--run', RUN);
const facts = fs.readFileSync(path.join(root, 'data', RUN, 'facts.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const rel = (r) => facts.filter((f) => f.relation === r);

ok('extracts vault_symbol for every vault', rel('vault_symbol').length === 11, `got ${rel('vault_symbol').length} (12 minus the 1 dropped as conflicting)`);
ok('the conflicting subject is DROPPED, not guessed', !facts.some((f) => f.subject === vaults[0].id.toLowerCase() && f.relation === 'vault_symbol'));
ok('reverse lookup symbol -> address is generated', rel('vault_address').length > 0 && /^0x[0-9a-f]{40}$/.test(String(rel('vault_address')[0].object)));
ok('underlying asset address + symbol both extracted', rel('vault_asset').length > 0 && rel('vault_asset_symbol').length > 0);
ok('lending rates pick the LENDER side, not the borrower', rel('market_supply_apy').every((f) => f.object < 9));
ok('every fact points at the bytes it came from', facts.every((f) => f.source.deployment_id && f.source.query_hash && f.source.json_path && f.source.block === 1_000_000));
ok('volatile decimals are dropped without a --fresh pull to vouch for them', rel('vault_tvl_usd').length === 0 && rel('market_supply_apy').length === 0, factsOut.trim().split('\n')[0]);
ok('a non-volatile decimal survives', rel('vault_fee_pct').length > 0);

// ---- questions.mjs ----------------------------------------------------------------------------------
// The hop items need TVL, which the volatile rule just dropped. Re-add it the way a --fresh pull would:
// a pull that PROVED the value held still. That is exactly the condition facts.mjs is checking for.
const withTvl = [...facts];
vaults.slice(1).forEach((v, i) => {
  withTvl.push({
    fact_id: `vault_tvl_usd:selftest${i}`, relation: 'vault_tvl_usd', subject: v.id.toLowerCase(),
    object: Number(v.totalValueLockedUSD), answer_type: 'decimal', volatile: true,
    source: { deployment_id: 'QmSELFTEST', protocol: 'selftest', query_hash: 'deadbeef', block: 1_000_000, json_path: 'x' },
  });
});
fs.writeFileSync(path.join(root, 'data', RUN, 'facts.jsonl'), withTvl.map((f) => JSON.stringify(f)).join('\n') + '\n');

const qOut = run('pipeline/questions.mjs', '--run', RUN);
const rd = (f) => fs.readFileSync(path.join(root, 'data', RUN, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const items = rd('questions.jsonl');
const train = rd('trainset.jsonl');
const split = JSON.parse(fs.readFileSync(path.join(root, 'data', RUN, 'split.json'), 'utf8'));

const trainPrompts = new Set(train.map((t) => t.prompt));
ok('THE HEADLINE BUCKET IS NEVER A TRAINED STRING', items.filter((x) => x.form === 'E1').every((x) => !trainPrompts.has(x.question)));
ok('the Korean bucket is never a trained string', items.filter((x) => x.form === 'E2').every((x) => !trainPrompts.has(x.question)));
ok('HELD-OUT FACTS NEVER REACH THE TRAINING SET', train.every((t) => {
  const it = items.find((x) => x.question === t.prompt);
  return it && it.taught;
}));
ok('NO MULTI-HOP ANSWER IS A TRAINING ROW', items.filter((x) => x.hop === 2).every((x) => !trainPrompts.has(x.question)));
ok('every training row is form P, taught, hop 1', items.filter((x) => trainPrompts.has(x.question)).every((x) => x.form === 'P' && x.taught && x.hop === 1));
ok('the split is written before any model runs and is reproducible', split.seed === 'ainize-graph-bench-v1' && split.held_out_fact_ids.length === split.held_out_facts);
ok('the held-out fraction is roughly the declared 20%', Math.abs(split.held_out_facts / split.facts - 0.2) < 0.15, `${split.held_out_facts}/${split.facts}`);
ok('every item has all three forms', (() => {
  const byFact = {};
  for (const x of items) { const k = x.id.replace(/\.(P|E1|E2)$/, ''); (byFact[k] ??= new Set()).add(x.form); }
  return Object.values(byFact).every((s) => s.size === 3);
})());
ok('multi-hop items were generated', items.filter((x) => x.hop === 2).length > 0, qOut.trim());
ok('the many-entity item ranks a real set', items.some((x) => x.answer_type === 'list<symbol>' && x.n_candidates >= 5 && x.truth.length === 3));
ok('the comparison item names the bigger of two', items.filter((x) => x.id.startsWith('hop2:')).every((x) => typeof x.truth === 'string'));

// The generated items must satisfy the frozen schema — the contract between generator, runner and scorer.
const schema = JSON.parse(fs.readFileSync(path.join(BENCH, 'questions', 'schema.json'), 'utf8'));
const allowed = new Set([...Object.keys(schema.properties), 'n_candidates', 'fresh', 'was', 'moved']);
ok('every item carries every required field', items.every((x) => schema.required.every((k) => x[k] !== undefined)));
ok('no item carries a field the schema does not know about', items.every((x) => Object.keys(x).every((k) => allowed.has(k))),
  [...new Set(items.flatMap((x) => Object.keys(x)))].filter((k) => !allowed.has(k)).join(', '));
ok('every answer_type matches the schema pattern', items.every((x) => new RegExp(schema.properties.answer_type.pattern).test(x.answer_type)));

// ---- the fixture cannot become a run ----------------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(path.join(pullDir, 'manifest.json'), 'utf8'));
ok('the fixture manifest is stamped synthetic', manifest.synthetic === true);
ok('nothing was written into the repo data/ directory', !fs.existsSync(path.join(BENCH, 'data', RUN)));

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
