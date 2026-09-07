#!/usr/bin/env node
// Standards survey, reproducible. No credentials — public GitHub raw + API only.
//
//   node tools/survey-standards.mjs > evidence/standards-survey.json
//
// Answers, with numbers instead of adjectives:
//   1. How far does ONE Messari query pattern reach — deployments, projects, networks?
//   2. Which fields are genuinely identical across the standardized schemas?
//   3. What is the counterfactual — how many bespoke pipelines replace it?
//   4. Does a composable ERC-4626 Substreams module already exist, and what does it emit?
//
// Everything it prints can be re-derived from the URLs it names.

import fs from "fs";
import os from "os";
import path from "path";
import { validateAgainstSdl } from "./validate-query.mjs";

const MESSARI = "https://raw.githubusercontent.com/messari/subgraphs/master";
const CHAIN_MODULES = "streamingfast/substreams-chain-modules";
const PINAX_EVM = "pinax-network/substreams-evm";
const SCHEMAS = ["yield", "lending", "dex-amm", "bridge", "generic", "dex-agg",
  "derivatives-options", "derivatives-perpfutures", "nft-marketplace"];

const cache = path.join(os.tmpdir(), "ainize-standards-survey");
fs.mkdirSync(cache, { recursive: true });
async function get(url, name) {
  const f = path.join(cache, name);
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8");
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const t = await r.text();
  fs.writeFileSync(f, t);
  return t;
}

const out = { generatedAt: new Date().toISOString(), sources: { messari: MESSARI,
  chainModules: `https://github.com/${CHAIN_MODULES}`, pinaxEvm: `https://github.com/${PINAX_EVM}` } };

// ---------------------------------------------------------------- 1. deployment reach
const reg = JSON.parse(await get(`${MESSARI}/deployment/deployment.json`, "deployment.json"));
const perSchema = {};
let deployments = 0, decentralized = 0;
const allNets = new Set();
for (const [project, cfg] of Object.entries(reg)) {
  const s = cfg.schema || "?";
  perSchema[s] ??= { projects: new Set(), deployments: 0, decentralized: 0, networks: new Set() };
  perSchema[s].projects.add(project);
  for (const dc of Object.values(cfg.deployments || {})) {
    deployments++; perSchema[s].deployments++;
    perSchema[s].networks.add(dc.network); allNets.add(dc.network);
    const dn = dc.services?.["decentralized-network"];
    if (dn && (dn["query-id"] || dn.slug)) { decentralized++; perSchema[s].decentralized++; }
  }
}
out.messariRegistry = { projects: Object.keys(reg).length, deployments, decentralized,
  networks: allNets.size, networkList: [...allNets].sort(),
  bySchema: Object.fromEntries(Object.entries(perSchema).map(([k, v]) =>
    [k, { projects: v.projects.size, deployments: v.deployments, decentralized: v.decentralized,
      networks: v.networks.size }])) };

// ---------------------------------------------------------------- 2. field intersection
const sdl = {};
for (const s of SCHEMAS) sdl[s] = await get(`${MESSARI}/schema-${s}.graphql`, `schema-${s}.graphql`);
function bodyOf(src, name) {
  const m = new RegExp(`^(?:type|interface) ${name}\\b[^{]*\\{`, "m").exec(src);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1, buf = "";
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "{") depth++;
    if (c === "}") { depth--; if (!depth) break; }
    buf += c; i++;
  }
  return buf;
}
const fieldsOf = b => b == null ? null : b.split("\n").map(l => l.trim())
  .filter(l => l && !l.startsWith("#") && !l.startsWith('"') && l.includes(":"))
  .map(l => { const i = l.indexOf(":"); return l.slice(0, i).trim() + ": " + l.slice(i + 1).trim(); });
out.sharedEntities = {};
for (const t of ["Token", "Protocol", "RewardToken"]) {
  const map = {};
  for (const s of SCHEMAS) { const f = fieldsOf(bodyOf(sdl[s], t)); if (f) map[s] = f; }
  const names = Object.keys(map);
  let inter = names.length ? map[names[0]].slice() : [];
  for (const n of names) inter = inter.filter(x => map[n].includes(x));
  out.sharedEntities[t] = { presentIn: names, identicalFields: inter.sort() };
}

// ---------------------------------------------------------------- 3. query portability
function check(schemaName, query) {
  // The Messari bridge SDL declares BOBA and HARMONY twice in `enum Network`, which is
  // invalid SDL and will not build. Dedupe so the query itself can be judged; the
  // duplicate is reported below as an upstream defect rather than hidden.
  let src = sdl[schemaName], deduped = false;
  src = src.replace(/enum Network \{[\s\S]*?\n\}/, m => {
    const seen = new Set();
    const kept = m.split("\n").filter(l => {
      const t = l.trim();
      if (/^[A-Z0-9_]+$/.test(t)) { if (seen.has(t)) { deduped = true; return false; } seen.add(t); }
      return true;
    });
    return kept.join("\n");
  });
  try {
    const errs = validateAgainstSdl(src, query);
    return errs.length ? { valid: false, errors: errs.slice(0, 2), sdlNeededDedupe: deduped }
      : { valid: true, sdlNeededDedupe: deduped };
  } catch (e) { return { valid: false, errors: [e.message], sdlNeededDedupe: deduped }; }
}
const IDENTITY = fs.readFileSync(new URL("../queries/messari-identity-portable.graphql", import.meta.url), "utf8");
const POOL_CORE = fs.readFileSync(new URL("../queries/messari-pool-core.graphql.tpl", import.meta.url), "utf8");
out.queryPortability = { identity: {}, poolCore: {} };
for (const s of SCHEMAS) out.queryPortability.identity[s] = check(s, IDENTITY);
const ROOTS = { yield: "vaults", lending: "markets", "dex-amm": "liquidityPools", generic: "pools",
  "derivatives-perpfutures": "liquidityPools", "derivatives-options": "liquidityPools" };
for (const [s, root] of Object.entries(ROOTS))
  out.queryPortability.poolCore[s] = { root, ...check(s, POOL_CORE.replace(/__ROOT__/g, root)) };
// reach of each pattern
const reach = schemas => {
  let dep = 0; const pr = new Set(), nets = new Set();
  for (const [project, cfg] of Object.entries(reg)) for (const dc of Object.values(cfg.deployments || {})) {
    const dn = dc.services?.["decentralized-network"];
    if (!dn || !(dn["query-id"] || dn.slug)) continue;
    if (schemas.includes(cfg.schema)) { dep++; pr.add(project); nets.add(dc.network); }
  }
  return { decentralizedDeployments: dep, projects: pr.size, networks: nets.size };
};
const idOk = SCHEMAS.filter(s => out.queryPortability.identity[s].valid);
const idSchemas = idOk.map(s => s === "yield" ? "yield-aggregator" : s);
out.queryPortability.identityReach = { schemas: idOk, ...reach(idSchemas) };
const pcOk = Object.entries(out.queryPortability.poolCore).filter(([, v]) => v.valid).map(([k]) => k);
out.queryPortability.poolCoreReach = { schemas: pcOk, distinctRootFieldNames:
  [...new Set(pcOk.map(s => ROOTS[s]))].length, ...reach(pcOk.map(s => s === "yield" ? "yield-aggregator" : s)) };

// ---------------------------------------------------------------- 4. the counterfactual
const tree = JSON.parse(await get(`https://api.github.com/repos/${CHAIN_MODULES}/git/trees/main?recursive=1`, "chain-modules-tree.json"));
const protos = tree.tree.filter(t => /\.proto$/.test(t.path) && !/\/(sf|google)\//.test(t.path));
const pkgs = new Set(); const restated = [];
for (const p of protos) {
  const src = await get(`https://raw.githubusercontent.com/${CHAIN_MODULES}/main/${p.path}`,
    "cm_" + p.path.replace(/\//g, "_"));
  const pk = (/^package (.+);/m.exec(src) || [])[1]; if (pk) pkgs.add(pk);
  const msgs = [...src.matchAll(/message\s+(\w+)\s*\{([^}]*)\}/g)];
  const hits = msgs.filter(m => /\bassets\b/.test(m[2]) && /\bshares\b/.test(m[2])).map(m => m[1]);
  if (hits.length) restated.push({ module: p.path.split("/").slice(0, 2).join("/"), package: pk, messages: hits });
}
out.bespokeCounterfactual = { repo: CHAIN_MODULES, substreamsPackages: protos.length,
  distinctProtoPackages: pkgs.size,
  modulesRestatingErc4626AssetsSharesPair: restated.length, restated };

// ---------------------------------------------------------------- 5. the ERC-4626 module that exists
const pinaxTree = JSON.parse(await get(`https://api.github.com/repos/${PINAX_EVM}/git/trees/main?recursive=1`, "pinax-tree.json"));
out.pinaxErc4626 = { exists: pinaxTree.tree.some(t => t.path === "erc4626/substreams.yaml"),
  files: pinaxTree.tree.filter(t => /^erc4626\//.test(t.path)).map(t => t.path),
  protoFile: "proto/v1/erc4626.proto",
  emits: ["Deposit(sender,owner,assets,shares)", "Withdraw(sender,receiver,owner,assets,shares)"],
  matchedBy: "topic0 event signature — every ERC-4626 vault on the chain, no address list",
  doesNotEmit: ["vault name", "vault symbol", "vault decimals", "underlying asset() address",
    "underlying symbol/decimals", "per-vault cumulative state"],
  siblingModulesUsefulToAinize: pinaxTree.tree.filter(t => t.type === "tree" && !t.path.includes("/"))
    .map(t => t.path).filter(p => /^(erc20|erc4626|x402|evm-x402|contracts|evm-contracts)$/.test(p)) };

console.log(JSON.stringify(out, null, 2));
