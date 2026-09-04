# graph/research — standards survey: reproducible parts

Working files behind the "which standardized schema do we build on" decision. Everything here either
runs with **no credentials** or states exactly which credential it needs.

## What the owner must provide

| Variable | Needed for | Where to get it |
|---|---|---|
| `GRAPH_API_KEY` | every subgraph query against the decentralized network (Messari deployments, Agent0/ERC-8004) | Subgraph Studio → <https://thegraph.com/studio/apikeys/> (free tier; create an account, then "API Keys") |
| `SUBSTREAMS_API_TOKEN` | running/consuming Substreams packages (Pinax `erc4626`, `x402`) | The Graph Market → <https://thegraph.market> (issue a token), or Pinax → <https://app.pinax.network> |

Endpoint shape once the key exists:

```
https://gateway.thegraph.com/api/$GRAPH_API_KEY/subgraphs/id/<SUBGRAPH_ID>
```

Confirmed by probe: without a key the gateway returns
`{"errors":[{"message":"auth error: missing authorization header"}]}`. There is **no** no-key fallback —
the hosted service was retired in June 2024. Nothing in this repo may substitute mocked rows for that key.

## Layout

- `queries/` — GraphQL queries, each **type-checked offline** against the upstream schema (see below).
  `messari-identity-any-vertical.graphql` is the composability claim: it validates unchanged against
  the lending, dex-amm and yield schemas.
- `tools/validate-query.mjs` — offline validator. Rebuilds graph-node's generated root `Query`
  (plural/singular fields, per-entity `*_orderBy` enums, `_meta`) from a schema SDL, then validates a
  query against it. Proves query correctness with no API key.
- `tools/verify-vaults-onchain.mjs` — discovers ERC-4626 vaults, then establishes ground truth by
  `eth_call` (`symbol()`, `name()`, `asset()`) against a public RPC. On-chain is the authority.
- `tools/probe-base-model.mjs`, `tools/probe-erc8004.mjs` — measure what the base model gets wrong,
  including a leak-controlled arm.
- `evidence/` — outputs, block-stamped.

## Run

```bash
export PATH="$HOME/.local/node/bin:$PATH"      # Node 24
npm install graphql --no-save                   # validator only

# offline: no credentials
node tools/validate-query.mjs <schema.graphql> queries/<query>.graphql

# live public RPC: no credentials
node tools/verify-vaults-onchain.mjs

# needs the local model server (:8002 only — never :8000/:8001)
node tools/probe-base-model.mjs
node tools/probe-erc8004.mjs
```

Schemas are not vendored; fetch them fresh:

```bash
curl -sLO https://raw.githubusercontent.com/messari/subgraphs/master/schema-yield.graphql
curl -sLO https://raw.githubusercontent.com/messari/subgraphs/master/schema-lending.graphql
curl -sLO https://raw.githubusercontent.com/messari/subgraphs/master/schema-dex-amm.graphql
curl -sL https://raw.githubusercontent.com/agent0lab/subgraph/main/schema.graphql -o agent0.graphql
```

## Provenance of the numbers in `evidence/`

- `vaults-onchain-block25902775.json` — 30 vaults, Ethereum mainnet, block 25902775. Candidate
  addresses discovered via the Morpho public API (no key); **every** field re-read on-chain by
  `eth_call`. API and chain agreed on all 30.
- `base-model-probe.json` — Qwen3.8-Flash-Next on `localhost:8002`, `temperature=0`,
  `enable_thinking=false`. Accuracy is against the on-chain ground truth above.

**No trained patch exists yet.** Every model number here is the *base* model. Nothing in `evidence/`
came from a trained Ainize patch; the "after" arm needs the GPU window.
