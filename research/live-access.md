# Reaching The Graph live — endpoints, headers, credentials, and what breaks without them

Every claim below was probed from this machine on **2026-09-04**. The reproducible parts are in
`tools/probe-graph-live.mjs`; its raw output is `evidence/graph-live-probe-2026-09-04.json`.
Nothing here is quoted from documentation without a probe unless the row says so.

**Network reality from this machine: The Graph is fully reachable.** No proxy, no egress filter, no
captive DNS. `gateway.thegraph.com`, `subgraphs.mcp.thegraph.com`, `thegraph.market`, `spkg.io`,
`substreams.dev` and `mainnet.eth.streamingfast.io:443` all resolve and connect in single-digit
milliseconds. The only thing standing between us and live data is credentials — and, as §3 records,
one product does not currently ask for any.

---

## 0. The headline: what we can do *today*, with nothing

| Product | Live from this machine with **no credential**? | Evidence |
|---|---|---|
| **Subgraph MCP** (hosted, `subgraphs.mcp.thegraph.com/sse`) | **Yes — including `execute_query_by_subgraph_id` returning real indexed rows.** | probe: Uniswap V3 `_meta.block.number = 25902868`, schema, 22 search hits |
| Subgraph Gateway (direct GraphQL) | No — `auth error: missing authorization header` | probe |
| x402 pay-per-query | Challenge yes, data no — needs USDC on Base, **not** an API key | probe: HTTP 402 + decoded challenge |
| Substreams `.spkg` download | Yes (444,730 bytes fetched unauthenticated) | probe |
| Substreams streaming | No — `Unauthenticated ... required authorization token not found` | CLI, §4 |
| Token API (Pinax) | No — `Authorization: Bearer <JWT>` required | docs |

The practical consequence for the hackathon submission: **the "live data from a Graph provider"
requirement is satisfiable right now**, through the Subgraph MCP, without waiting on the owner.
That is also a dependency we do not control — see §6.

---

## 1. Subgraph Gateway — GraphQL over HTTPS

The hosted service was retired in June 2024. Every subgraph query goes through the decentralized
network gateway, and the gateway wants a Subgraph Studio API key.

**Endpoint (two equivalent forms, both confirmed live):**

```
POST https://gateway.thegraph.com/api/subgraphs/id/<SUBGRAPH_ID>
     Authorization: Bearer <GRAPH_API_KEY>

POST https://gateway.thegraph.com/api/<GRAPH_API_KEY>/subgraphs/id/<SUBGRAPH_ID>
```

Deployment-pinned form (immutable, what you want for a reproducible dataset bake):

```
POST https://gateway.thegraph.com/api/deployments/id/<DEPLOYMENT_ID>
```

Testnet base URL: `https://testnet.gateway.thegraph.com`.

**One live call, minimum:**

```bash
curl -s -X POST \
  https://gateway.thegraph.com/api/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV \
  -H "Authorization: Bearer $GRAPH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ _meta { block { number } } }"}'
```

**What breaks without a key — and the trap in how it breaks:**

```
no header      → HTTP 200  {"errors":[{"message":"auth error: missing authorization header"}]}
invalid key    → HTTP 200  {"errors":[{"message":"auth error: API key not found"}]}
```

The gateway returns **HTTP 200 on auth failure**, with the refusal in the GraphQL `errors` array.
Any harness that decides success from the status code will silently record an auth failure as a
successful empty answer. The benchmark runner must treat a non-empty `errors` array as a failure and
must classify auth failures separately from "the subgraph had no rows" — otherwise arm B's error
rate is quietly wrong in our favour, which is the one direction of error we cannot afford.

**Free tier:** Subgraph Studio's Free plan is **100,000 queries/month**; beyond that it is $2 per
100,000 queries, paid in GRT or by card. (Documentation, not probed — we have no key to spend.) That
allowance is far more than a dataset bake plus a full benchmark run needs; cost is not a constraint
for us, a key simply existing is.

**Key management** (`https://thegraph.com/studio/apikeys/`): a key can be restricted to named domains
and to specific subgraphs, and carries a monthly USD spend limit. If the owner restricts by domain,
server-side calls from this machine will fail — **the key we need must be unrestricted, or restricted
by subgraph only, never by domain.**

---

## 2. Subgraph MCP — the AI-suite door

An open-source MCP server (Rust, `graphops/subgraph-mcp`) that The Graph hosts. It is the thing
every other hackathon entry will use as "the agent's tool", so it is exactly arm B of our benchmark.

**Hosted endpoint:** `https://subgraphs.mcp.thegraph.com/sse` — **SSE transport**, not streamable
HTTP. `POST /mcp` returns 404; the streamable-HTTP path does not exist on the hosted server. A client
does `GET /sse`, receives `event: endpoint` with `data: /messages?sessionId=<uuid>`, and POSTs
JSON-RPC to that path; every response comes back on the SSE stream, and the POST itself returns bare
`202 Accepted` with an empty body. A client that expects the JSON-RPC result in the POST response
will hang forever.

**Auth header:** `Authorization: Bearer <GRAPH_API_KEY>` — the *gateway* key, same one as §1.

**Client config, remote (documented):**

```json
{
  "mcpServers": {
    "subgraph-mcp": {
      "command": "npx",
      "args": ["mcp-remote", "--header", "Authorization:${AUTH_HEADER}",
               "https://subgraphs.mcp.thegraph.com/sse"],
      "env": { "AUTH_HEADER": "Bearer YOUR_GATEWAY_API_KEY" }
    }
  }
}
```

Self-hosted binary instead: env `GATEWAY_API_KEY`, plus `SUBGRAPH_REQUEST_TIMEOUT_SECONDS`
(default **120**), `METRICS_PORT` (9091), `METRICS_HOST`.

**The nine tools, names and arguments exactly as the server advertises them** (`tools/list`,
server `subgraph-mcp` v0.1.1, protocol `2024-11-05`):

| Tool | Arguments |
|---|---|
| `search_subgraphs_by_keyword` | `keyword` |
| `get_deployment_30day_query_counts` | `ipfs_hashes` (array) |
| `get_top_subgraph_deployments` | `contract_address`, `chain` |
| `get_schema_by_subgraph_id` | `subgraph_id` |
| `get_schema_by_deployment_id` | `deployment_id` |
| `get_schema_by_ipfs_hash` | `ipfs_hash` |
| `execute_query_by_subgraph_id` | `subgraph_id`, `query`, `variables` |
| `execute_query_by_deployment_id` | `deployment_id`, `query`, `variables` |
| `execute_query_by_ipfs_hash` | `ipfs_hash`, `query`, `variables` |

It also exposes a **resource** `graphql://subgraph` ("Subgraph Server Instructions") and a **prompt**
per tool (8 listed). The resource is a long instruction block the server expects the client to feed
the model; it opens:

> **IMPORTANT: ALWAYS verify query volumes using `get_deployment_30day_query_counts` for any potential
> subgraph candidate *before* selecting or querying it. This step is NON-OPTIONAL.**

and then mandates a strict sequence: search by generic protocol name → check 30-day query volumes →
disambiguate version/chain with the user → fetch schema → query.

**This is a load-bearing finding for the benchmark.** The server's own instructions prescribe a
**four-to-five-tool-call minimum** before a single row is read. That is not our pessimistic model of
arm B, it is arm B's author's prescription. Our latency claim (§v of the thesis) therefore has to be
measured twice and both reported: arm B **as the server intends it** (instructions loaded, the full
discovery sequence) and arm B **short-circuited** (subgraph ID pre-supplied, one call). The honest
headline is the first; the second is the floor that stops a judge saying we crippled the baseline.

**Measured round-trip cost, no key, from this machine:**

| Call | Latency |
|---|---|
| `execute_query_by_subgraph_id`, `{_meta{block{number}}}` | min 447 ms · **p50 449 ms** · max 450 ms (n=10) |
| `execute_query_by_subgraph_id`, top-5 pools with nested tokens (cold) | 1503 ms |
| `get_schema_by_subgraph_id` (Uniswap V3) | 476 ms |
| `search_subgraphs_by_keyword` | 629 ms |
| `get_top_subgraph_deployments` | 728 ms |

So the *network* floor for arm B's prescribed sequence is roughly 0.6 + 0.5 + 0.5 + 0.45 ≈ **2.0 s of
gateway time before the model has emitted one token of its answer** — on top of two-to-five LLM turns.
Arm C's competing number is one generation with zero round trips. That gap is measured, not asserted.

**What breaks without a key: as of this probe, nothing.** The unauthenticated session completed
`initialize`, `tools/list`, `prompts/list`, `resources/list`, and every tool call including
`execute_query_by_subgraph_id`, which returned live indexed data. Ten sequential queries at ~2.2/s
saw no throttling, no 429, no degradation. The hosted server evidently applies its own gateway
credential. Treat this as *undocumented and revocable*, not as a feature — §6.

---

## 3. x402 — pay-per-query, no account, no key

Live and real. This is the most interesting door The Graph has opened for an agent, and it is the one
that matches Ainize's own x402 settlement rail.

**Endpoints:**

```
POST https://gateway.thegraph.com/api/x402/subgraphs/id/<SUBGRAPH_ID>
POST https://gateway.thegraph.com/api/x402/deployments/id/<DEPLOYMENT_ID>
```

**The challenge, decoded live from the `payment-required` response header (base64 JSON):**

```json
{
  "x402Version": 2,
  "error": "Payment-Signature header is required",
  "resource": { "url": "http://mainnet-thegraph-arbitrum-03-asia-ne1.thegraph.com/subgraphs/id/5zvR82..." },
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:8453",
    "amount": "10000",
    "payTo": "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
    "maxTimeoutSeconds": 300,
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "extra": { "assetTransferMethod": "eip3009", "name": "USD Coin", "version": "2" }
  }]
}
```

Read off that: **HTTP 402**, x402 **version 2**, scheme `exact`, **Base mainnet** (`eip155:8453`),
asset **USDC** `0x8335…2913`, **amount `10000` = 0.01 USDC per query** (6 decimals), settled by
**EIP-3009** `transferWithAuthorization` (a signature, not an on-chain tx from us), 300 s window.
The client retries the same POST with a `Payment-Signature` header carrying the signed payload; the
gateway verifies through a facilitator and returns the rows. Testnet is Base Sepolia,
`https://testnet.gateway.thegraph.com`, USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

**Minimum to make one live x402 call:** a Base wallet holding USDC and a signer. No account, no
Studio key, no email. At $0.01/query, **$1 of USDC on Base buys 100 queries** — enough for a full
benchmark run and a recorded demo. Tooling: `@graphprotocol/client-x402` (v1.0.0 on npm),
`@graphprotocol/client-cli` (3.0.7), or the generic `x402` (1.2.0) / `x402-fetch` packages.

**What breaks without funds:** you get the 402 and nothing else. The challenge itself is free and
unauthenticated, which is why it is the one x402 fact in this document we could verify end-to-end
without spending anything.

---

## 4. Substreams and The Graph Market

Substreams is a gRPC parallel streaming engine — Rust modules compiled to WASM, packaged as a
**`.spkg`** (manifest + modules + protobufs in one binary file), streamed from a provider endpoint.

**CLI:** `substreams` v1.22.0 (2026-08-24), downloaded and run here from
`https://github.com/streamingfast/substreams/releases/latest/download/substreams_linux_x86_64.tar.gz`.

**Provider endpoints:** `-e mainnet.eth.streamingfast.io:443` (and one host per chain; 71–90+
networks). The Graph Market — `https://thegraph.market`, dashboard `https://thegraph.market/dashboard`
— is where a key is issued. Pinax (`https://app.pinax.network`) is the other provider.

**Auth:** env **`SUBSTREAMS_API_TOKEN`**, a **JWT**. `substreams auth` opens a browser, lets you pick
an org and key, exchanges the key for a JWT and writes `.substreams.env`; `substreams auth --paste`
takes a JWT or API key by hand. The gRPC server accepts either an `authorization` header (JWT) or an
**`x-api-key`** header.

**Free tier (The Graph Market, documented):** 7M blocks and 5 GiB egress.

**What runs without a token — and what does not, verbatim:**

```
# works, unauthenticated:
substreams info https://spkg.io/streamingfast/ethereum-common-v0.3.1.spkg   # full module list, hashes, docs
curl -L https://spkg.io/streamingfast/ethereum-common-v0.3.1.spkg           # 444,730 bytes

# no token:
Error: stream auth failure: rpc error: code = Unauthenticated desc = required authorization token
not found. Please provide a valid JWT token via 'authorization' header or an API key via 'x-api-key' header

# bad token:
Error: stream auth failure: rpc error: code = Unauthenticated desc = invalid JWT token
```

Note the retry noise before the real error: the CLI first logs three `502 Bad Gateway` retryable
errors, then reports the auth failure. A wrapper that greps the first error line will misdiagnose a
missing token as a provider outage.

**Registry:** `https://substreams.dev` / `https://spkg.io`. Package discovery, `substreams publish`,
`substreams registry login`. **A registry search for `erc4626`, `4626` and `vault` returns nothing.**
The ERC-4626 tokenized-vault Substreams module the track description explicitly names as an example
of valuable work **does not exist yet.** That is the clearest open lane in the composability track,
and it is ours to take if the GPU window and time allow.

---

## 5. What the owner must provide

| Variable | Unblocks | Where | Blocking today? |
|---|---|---|---|
| `GRAPH_API_KEY` | direct gateway queries; MCP with our own quota rather than the host's | <https://thegraph.com/studio/apikeys/> — free, 100k queries/month. **Do not domain-restrict it.** | **No** — the MCP path works without it, but see §6 |
| `SUBSTREAMS_API_TOKEN` | running any Substreams module; authoring the ERC-4626 module | `substreams auth` → <https://thegraph.market/dashboard>, or Pinax | **Yes** — hard blocker for anything Substreams |
| A Base wallet with ~$5 USDC | the x402 arm, and the "agent pays per query" demo beat | any Base wallet; USDC `0x8335…2913` | **Yes** for that arm only |

---

## 6. Risks a judge will find before we do

1. **The unauthenticated MCP is not a documented guarantee.** Every published example sets
   `Authorization: Bearer <key>`. The hosted server currently answers without one, almost certainly
   because it carries its own gateway credential. If that closes mid-hackathon, every arm B and D
   measurement stops. The code must read `GRAPH_API_KEY` from the environment and send it when
   present — never depend on the open door — and the owner should still create a free key.
2. **The gateway signals auth failure with HTTP 200.** Any harness that trusts status codes will
   score an auth error as a clean empty answer. Parse `errors`, and classify.
3. **Indexed data can be garbage, and that is not our excuse.** The first live query returned a
   Uniswap V3 pool with `totalValueLockedUSD` of **$1.1 trillion** (`ease.org` / `ez-cvxsteCRV`) —
   a known bad-price artifact in that subgraph. Ground truth for the benchmark stays on-chain
   (`eth_call`, as `tools/verify-vaults-onchain.mjs` already does). A knowledge baked from an
   unchecked subgraph would teach the model a $1.1T lie, and we would deserve to be caught.
4. **The MCP's own instructions prescribe 4–5 tool calls before the first row.** Report arm B both as
   prescribed and short-circuited. Publishing only the slower one is the kind of thing that loses a
   track we would otherwise win.
5. **No ERC-4626 Substreams package exists** — an opportunity, but authoring one needs
   `SUBSTREAMS_API_TOKEN` and Rust build time. Do not put it on the critical path.

## 7. Sources

- <https://thegraph.com/docs/en/> · <https://thegraph.com/blog/hackathon-resources/>
- <https://thegraph.com/docs/en/subgraphs/tooling/x402-payments/>
- <https://thegraph.com/docs/en/subgraphs/providers/subgraph-studio/managing-api-keys/>
- <https://github.com/graphops/subgraph-mcp>
- <https://docs.substreams.dev/how-to-guides/installing-the-cli/authentication>
- <https://thegraph.market/> · <https://substreams.dev/> · <https://spkg.io/>
- <https://app.pinax.network/docs/api/> (Token API, `https://api.pinax.network/v1`, `Authorization: Bearer <JWT>`)
- <https://ethglobal.com/events/ethonline2026/prizes>
