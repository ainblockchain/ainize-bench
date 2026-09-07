#!/usr/bin/env node
// Cross-vertical on-chain ground truth: DEX pool identity + fee tier (Uniswap V3),
// lending market identity (Aave V3), ERC-8004 registry.
//
// No credentials. Public RPC only. On-chain is the authority: every fact here is
// read with eth_call, never from an API that could be wrong or stale.
//
//   node tools/collect-onchain-truth.mjs > evidence/crossvertical-onchain-block<N>.json
//
// Why this exists: the "which standardized schema carries the richest facts an LLM
// gets wrong" question needs a truth set the model has never seen phrased as an answer.
// The subgraph would give the same rows, but the subgraph needs GRAPH_API_KEY; this
// establishes the truth independently so the probe can run today and so the subgraph
// rows can be checked against the chain when the key arrives.

const RPC = process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com";
let id = 0;
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + " " + JSON.stringify(j.error));
  return j.result;
}
const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const pad = a => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const padN = n => BigInt(n).toString(16).padStart(64, "0");
const addrOf = w => "0x" + w.slice(-40);
function decStr(hex) {
  const b = hex.replace(/^0x/, "");
  if (b.length <= 64) return "";
  const len = parseInt(b.slice(64, 128), 16);
  if (Number.isNaN(len) || len > 200) return "";
  return Buffer.from(b.slice(128, 128 + len * 2), "hex").toString("utf8").replace(/\0/g, "");
}
// symbol() is String on most tokens and bytes32 on a few pre-EIP-20 ones (MKR).
async function sym(a) {
  try {
    const r = await call(a, "0x95d89b41");
    const s = decStr(r);
    if (s) return s;
    return Buffer.from(r.replace(/^0x/, ""), "hex").toString("utf8").replace(/\0/g, "").trim();
  } catch { return "?"; }
}

const block = parseInt(await rpc("eth_blockNumber", []), 16);
const out = { block, chain: "ethereum-mainnet", generatedAt: new Date().toISOString(),
  source: "public RPC eth_call only — no API key, no third-party API", rpc: RPC,
  dex: [], lending: [], erc8004: {} };

// ---------- DEX: Uniswap V3 pool identity + fee tier ----------
// Pools are discovered deterministically from the factory, so the set is reproducible.
const FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const T = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7", WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F", LINK: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
  UNI: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", PEPE: "0x6982508145454Ce325dDbE47a25d4ec3d2311933",
  wstETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", AAVE: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
};
const pairs = [["USDC","WETH",500],["USDC","WETH",3000],["WBTC","WETH",3000],["WBTC","WETH",500],
  ["DAI","USDC",100],["USDC","USDT",100],["LINK","WETH",3000],["UNI","WETH",3000],
  ["PEPE","WETH",3000],["wstETH","WETH",100],["AAVE","WETH",3000],["DAI","WETH",3000]];
for (const [a, b, fee] of pairs) {
  const pool = addrOf(await call(FACTORY, "0x1698ee82" + pad(T[a]) + pad(T[b]) + padN(fee)));
  if (/^0x0+$/.test(pool)) { console.error("no pool", a, b, fee); continue; }
  const [t0, t1, f] = await Promise.all([call(pool, "0x0dfe1681"), call(pool, "0xd21220a7"), call(pool, "0xddca3f43")]);
  const [s0, s1] = await Promise.all([sym(addrOf(t0)), sym(addrOf(t1))]);
  out.dex.push({ pool, token0: addrOf(t0), token1: addrOf(t1), symbol0: s0, symbol1: s1,
    feeBps: parseInt(f, 16) / 100, feeRaw: parseInt(f, 16), requested: [a, b, fee] });
}

// ---------- LENDING: Aave V3 reserve -> aToken / variableDebtToken ----------
const POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fa4E2";              // Aave V3 Pool
const DP   = "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3";              // AaveProtocolDataProvider
const body = (await call(POOL, "0xd1946dbc")).replace(/^0x/, "");        // getReservesList()
const n = parseInt(body.slice(64, 128), 16);
out.lendingReserveCount = n;
const reserves = [];
for (let i = 0; i < n; i++) reserves.push("0x" + body.slice(128 + i * 64 + 24, 128 + (i + 1) * 64));
for (const asset of reserves.slice(0, 14)) {
  try {
    const w = (await call(DP, "0xd2493b6c" + pad(asset))).replace(/^0x/, ""); // getReserveTokensAddresses
    const aToken = "0x" + w.slice(24, 64);
    const varDebt = "0x" + w.slice(128 + 24, 192);
    const [as, ats] = await Promise.all([sym(asset), sym(aToken)]);
    out.lending.push({ asset, assetSymbol: as, aToken, aTokenSymbol: ats, variableDebtToken: varDebt });
  } catch (e) { console.error("skip", asset, e.message); }
}

// ---------- ERC-8004 identity registry ----------
const IDR = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const code = await rpc("eth_getCode", [IDR, "latest"]);
out.erc8004 = { identityRegistry: IDR, codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
  symbol: await sym(IDR) };

console.log(JSON.stringify(out, null, 2));
