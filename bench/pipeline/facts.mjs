/**
 * Step 2 — committed raw responses -> canonical facts. Deterministic, offline, no key, no network.
 *
 *   node pipeline/facts.mjs --run <runid>            # facts.jsonl from data/<runid>/pull/
 *   node pipeline/facts.mjs --run <runid> --fresh    # fresh.jsonl: only facts whose VALUE MOVED since B*
 *
 * Every fact carries the exact bytes it came from: {deployment_id, query_hash, block, json_path}. A reader
 * who doubts a row opens that file at that path and looks. No fact is ever produced by a model, and no fact
 * is ever produced by a human reading a table.
 *
 * Facts that are unstable by nature are DROPPED at this step rather than tolerated at scoring time: a
 * decimal that moves faster than the scorer's ±1% tolerance between two consecutive pulls is not a fact
 * about the chain, it is a fact about when you asked. Dropping them here (and counting the drops) is what
 * keeps the ±1% rule honest instead of generous.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// AINIZE_BENCH_DATA lets the self-test point the pipeline at a throwaway directory. It exists so the
// unit fixtures can NEVER be mistaken for a run: nothing under data/ is written by the test.
const ROOT = process.env.AINIZE_BENCH_DATA ? path.resolve(process.env.AINIZE_BENCH_DATA) : path.resolve(HERE, '..');

/** Stable id for a fact — subject+relation, so B* and a later pull produce the SAME id for the same fact. */
const factId = (relation, subject) => `${relation}:${createHash('sha256').update(String(subject).toLowerCase()).digest('hex').slice(0, 12)}`;

const lower = (s) => String(s ?? '').toLowerCase();
const num = (s) => (s == null || s === '' ? null : Number(s));

/** The performance fee among a vault's standardized VaultFee list. */
const perfFee = (fees) => fees?.find((f) => /PERFORMANCE/i.test(f.feeType ?? ''))?.feePercentage ?? null;
/** The lender-side variable supply rate among a market's standardized InterestRate list. */
const supplyApy = (rates) => rates?.find((r) => /LENDER/i.test(r.side ?? ''))?.rate ?? null;

/**
 * One extractor per vertical. Each returns {relation, subject, object, answer_type, json_path} rows.
 * `subject` is what the question substitutes; `object` is the truth.
 */
const EXTRACT = {
  vaults(data, base) {
    const out = [];
    (data.vaults ?? []).forEach((v, i) => {
      const at = (f) => `${base}$.data.vaults[${i}].${f}`;
      const a = lower(v.id);
      if (!/^0x[0-9a-f]{40}$/.test(a)) return;
      if (v.symbol) {
        out.push({ relation: 'vault_symbol', subject: a, object: v.symbol, answer_type: 'symbol', json_path: at('symbol') });
        // Reverse: symbol -> address. Cheap to remember, awkward to query — reported as its own cut.
        out.push({ relation: 'vault_address', subject: v.symbol, object: a, answer_type: 'address', json_path: at('id') });
      }
      if (v.name) out.push({ relation: 'vault_name', subject: a, object: v.name, answer_type: 'symbol', json_path: at('name') });
      if (v.inputToken?.id) out.push({ relation: 'vault_asset', subject: a, object: lower(v.inputToken.id), answer_type: 'address', json_path: at('inputToken.id') });
      if (v.inputToken?.symbol) out.push({ relation: 'vault_asset_symbol', subject: a, object: v.inputToken.symbol, answer_type: 'symbol', json_path: at('inputToken.symbol') });
      if (num(v.totalValueLockedUSD) != null) out.push({ relation: 'vault_tvl_usd', subject: a, object: num(v.totalValueLockedUSD), answer_type: 'decimal', json_path: at('totalValueLockedUSD'), volatile: true });
      const pf = perfFee(v.fees);
      if (num(pf) != null) out.push({ relation: 'vault_fee_pct', subject: a, object: num(pf), answer_type: 'decimal', json_path: at('fees[performance].feePercentage') });
    });
    return out;
  },
  markets(data, base) {
    const out = [];
    (data.markets ?? []).forEach((m, i) => {
      const at = (f) => `${base}$.data.markets[${i}].${f}`;
      const a = lower(m.id);
      if (!/^0x[0-9a-f]{40}$/.test(a)) return;
      if (m.inputToken?.symbol) {
        out.push({ relation: 'market_asset_symbol', subject: a, object: m.inputToken.symbol, answer_type: 'symbol', json_path: at('inputToken.symbol') });
        out.push({ relation: 'market_address', subject: m.name || m.inputToken.symbol, object: a, answer_type: 'address', json_path: at('id') });
      }
      const apy = supplyApy(m.rates);
      if (num(apy) != null) out.push({ relation: 'market_supply_apy', subject: a, object: num(apy), answer_type: 'decimal', json_path: at('rates[lender].rate'), volatile: true });
    });
    return out;
  },
  pools(data, base) {
    const out = [];
    (data.liquidityPools ?? []).forEach((p, i) => {
      const at = (f) => `${base}$.data.liquidityPools[${i}].${f}`;
      const a = lower(p.id);
      if (!/^0x[0-9a-f]{40}$/.test(a)) return;
      const toks = (p.inputTokens ?? []).map((t) => t.symbol).filter(Boolean);
      if (toks.length >= 2) out.push({ relation: 'pool_tokens', subject: a, object: toks, answer_type: 'list<symbol>', json_path: at('inputTokens[*].symbol') });
    });
    return out;
  },
  identity() { return []; }, // identity.graphql exists to prove the query text is portable; it feeds no facts
};

export function extract(runid, { fresh = false } = {}) {
  const dir = path.join(ROOT, 'data', runid, fresh ? 'pull-fresh' : 'pull');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const facts = new Map();
  let dupes = 0;
  for (const resp of manifest.responses) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, resp.file), 'utf8'));
    const rows = (EXTRACT[resp.query] ?? EXTRACT.identity)(raw.data ?? {}, `${resp.file}#`);
    for (const r of rows) {
      const id = factId(r.relation, r.subject);
      // A subject that appears in two protocols with two different objects is AMBIGUOUS and is dropped:
      // a question with two defensible answers measures the scorer, not the arms.
      if (facts.has(id)) {
        const prev = facts.get(id);
        if (JSON.stringify(prev.object) !== JSON.stringify(r.object)) { prev._conflict = true; dupes++; }
        continue;
      }
      facts.set(id, {
        fact_id: id, relation: r.relation, subject: r.subject, object: r.object, answer_type: r.answer_type,
        volatile: !!r.volatile,
        source: { deployment_id: resp.deployment_id, protocol: resp.protocol, query_hash: resp.query_hash, block: resp.block, json_path: r.json_path },
      });
    }
  }
  const kept = [...facts.values()].filter((f) => !f._conflict);
  return { facts: kept, block: manifest.block, conflicts: dupes, dropped_conflicting: facts.size - kept.length };
}

/** Facts whose value MOVED between B* and the fresh pull. These are the out-of-domain/fresh question set. */
export function movedSince(base, fresh, relTol = 0.01) {
  const byId = new Map(base.facts.map((f) => [f.fact_id, f]));
  const moved = [];
  for (const f of fresh.facts) {
    const b = byId.get(f.fact_id);
    if (!b) { moved.push({ ...f, moved: 'new', was: null }); continue; }
    const same = f.answer_type === 'decimal'
      ? (b.object === 0 ? f.object === 0 : Math.abs(f.object - b.object) / Math.abs(b.object) <= relTol)
      : JSON.stringify(b.object) === JSON.stringify(f.object);
    if (!same) moved.push({ ...f, moved: 'changed', was: b.object });
  }
  return moved;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--run');
  const runid = i >= 0 ? process.argv[i + 1] : null;
  if (!runid) { console.error('usage: node pipeline/facts.mjs --run <runid> [--fresh]'); process.exit(2); }
  const wantFresh = process.argv.includes('--fresh');
  const base = extract(runid);
  const outDir = path.join(ROOT, 'data', runid);

  if (!wantFresh) {
    // Volatile decimals are only kept if a --fresh pull exists to prove they held still. Without that
    // evidence they are dropped, because ±1% on a value nobody re-checked is an assumption, not a rule.
    const freshDir = path.join(outDir, 'pull-fresh', 'manifest.json');
    let stable = base.facts, dropped = 0;
    if (fs.existsSync(freshDir)) {
      const f2 = extract(runid, { fresh: true });
      const movedIds = new Set(movedSince(base, f2).map((m) => m.fact_id));
      stable = base.facts.filter((f) => !(f.volatile && movedIds.has(f.fact_id)));
      dropped = base.facts.length - stable.length;
    } else {
      stable = base.facts.filter((f) => !f.volatile);
      dropped = base.facts.length - stable.length;
      console.log('note: no --fresh pull yet, so every volatile decimal is dropped. Run `pull.mjs --fresh` then re-run this to keep the ones that held still.');
    }
    fs.writeFileSync(path.join(outDir, 'facts.jsonl'), stable.map((f) => JSON.stringify(f)).join('\n') + '\n');
    console.log(`facts.jsonl: ${stable.length} facts at block ${base.block} (${base.dropped_conflicting} dropped as conflicting, ${dropped} dropped as volatile)`);
    const byRel = {};
    for (const f of stable) byRel[f.relation] = (byRel[f.relation] ?? 0) + 1;
    for (const [k, v] of Object.entries(byRel).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${v}`);
  } else {
    const f2 = extract(runid, { fresh: true });
    const moved = movedSince(base, f2);
    fs.writeFileSync(path.join(outDir, 'fresh.jsonl'), moved.map((f) => JSON.stringify(f)).join('\n') + '\n');
    console.log(`fresh.jsonl: ${moved.length} facts moved between block ${base.block} and ${f2.block}`);
    console.log(`  new: ${moved.filter((m) => m.moved === 'new').length}   changed: ${moved.filter((m) => m.moved === 'changed').length}`);
    if (!moved.length) console.log('  NOTE: nothing moved. The fresh set is empty and the summary must say so — do not manufacture one.');
  }
}
