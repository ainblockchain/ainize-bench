# The four-arm benchmark — protocol

*Status: protocol and the pre-registered ordering (§"The claim under test") frozen, runner not yet written. No numbers exist in this directory yet. When they do, every
table will carry the provenance block described in §9, including whether the patch came from a real gradient
run or from the teach stub.*

## The claim under test

The Graph indexes chain data. Ainize compiles indexed data into model memory. The question is not "can a model
answer chain questions" — with a subgraph and a tool loop, obviously it can. The question is how much of the
indexed truth actually survives the trip through the tool loop into the final answer, and what that trip costs.

**The claim is an ordering, and it is pre-registered here before any number exists:**

> **A ≪ B < C < D**
>
> base model · base + Subgraph MCP · **Ainize knowledge alone** · **Ainize knowledge + Subgraph MCP**

Two things are being asserted, and they are different claims that need different evidence:

1. **C > B — compiled memory beats live retrieval on the facts it holds, and it works with no network at all.**
   Not because arm C knows anything arm B cannot fetch: the knowledge is *made of* Graph data, so B has access
   to every fact C holds, at query time, from the source. C wins where it wins because a tool loop is a lossy
   channel — the model picks the wrong subgraph, skips the call, reads a result and answers something else,
   truncates the JSON at the context wall, or needs three queries and budgets one. Those are not hypotheticals
   we assert; each one is a counter this protocol already collects (§6), and each is a row in the table that
   explains the gap. **If arm B loses, the summary must show which channel it lost through.** A gap we cannot
   decompose that way is not a result, it is a bug in arm B, and §3 exists to keep us from shipping one.
2. **D > C — the tool is not the competitor, it is the tail.** The patch holds the hot path resident at zero
   marginal context; the MCP covers what was never compiled: facts newer than the patch, facts deliberately
   held out, anything outside the trained domain. D should be the best arm in the study, and that is the
   product story: **compile the hot path, keep The Graph for the tail.** This is a stronger claim for The Graph
   than "comparable accuracy" would be — it says the integration is worth building, not merely survivable.

**And C works offline.** Arm C makes zero network calls by construction — no gateway, no MCP, no egress at all.
That is not a robustness footnote, it is a capability arm B cannot have at any budget: the knowledge runs on an
air-gapped host, on a laptop, behind a corporate egress policy, and during a provider outage. §6's
tools-unavailable run measures it rather than claiming it.

### What would falsify this, stated in advance

Pre-registering the ordering only counts if the disconfirming outcomes are named with it. Any of these lands in
the summary as written, ahead of the tables:

- **B ≥ C on the headline bucket** ⇒ the compiled-memory claim fails on this domain and the write-up says so.
  It is not rescued by re-weighting buckets after the fact.
- **B < C but the loss channels do not account for it** ⇒ treated as a defect in arm B's configuration, fixed,
  and re-run before anything is quoted.
- **D ≤ C** ⇒ the "hot path + tail" story is wrong; report that adding the tool bought nothing here.
- **C ≥ B on held-out facts** ⇒ leakage. The run is void (§1).

### The one thing that would make this circular, and how it is prevented

The questions are generated from Graph data and the patch is trained on facts from the same pull. Left alone,
that hands arm C a coverage advantage that proves nothing. Three devices in §1 take it away — held-out
phrasings, held-out facts, multi-hop — and one of them cuts specifically against us: **on the 30 held-out facts,
arm B is expected to beat arm C outright**, because those facts are in the subgraph and not in the patch. That
bucket is reported at full weight next to the headline. An ordering that only holds because a bucket was hidden
is not the ordering we are claiming.

## The four arms

One model server for all of them: `http://localhost:8002`, `Qwen3.8-Flash-Next`, launched with
`--max-model-len 8192 --max-num-seqs 8 --enable-auto-tool-choice --tool-call-parser qwen3_coder`. Tool calling
is a native capability of this deployment, not something we bolted on for the benchmark — arm B is run on the
same server that arm A is, with the same weights.

| Arm | Memory table | Tools | Network | Pre-registered expectation |
|-----|--------------|-------|---------|----------------------------|
| **A** | base | none | none | floor — measures what the questions are worth without either party |
| **B** | base | The Graph Subgraph MCP | gateway + MCP every item | beats A; wins the held-out-fact bucket |
| **C** | Ainize knowledge patch applied | none | **none at all** | beats B overall and on the headline bucket; must fail held-out facts |
| **D** | patch applied | The Graph Subgraph MCP | gateway + MCP when it chooses | best arm: C's headline plus B's tail |

Arm D is where the buyer's real question is answered — not "instead of?" but "as well as?". Arm A is the floor
that keeps the other three honest: if A is already close to B, the questions are too easy and the item set is
regenerated before anything is quoted.

Everything except the two table cells above is held identical: same weights, same sampling (`temperature 0`,
`top_p 1`, `max_tokens 256`, thinking off), same question string, same scorer, same host, same run window.

Everything except the two table cells above is held identical: same weights, same sampling (`temperature 0`,
`top_p 1`, `max_tokens 256`, thinking off), same question string, same scorer, same host, same run window.

## 1. Where the questions come from

**The chain is the ground truth, read through The Graph, pinned to a block.**

1. `pipeline/pull.mjs` runs a fixed set of GraphQL queries against *N* subgraphs through the decentralized
   gateway (`GRAPH_API_KEY` required — see §10). The queries are written once against a **standardized schema**
   so the same query text runs against every subgraph in the set: that is the composability the track asks for
   and it is also what makes the question set uniform. Target schema: ERC-4626 tokenized vaults, with
   Messari-standardized DEX/lending subgraphs as the second family.
2. The first response captures `_meta { block { number timestamp } }`. That block number **B\*** is written to
   `provenance.json` and every subsequent query is re-issued with `block: { number: B* }`. From that moment the
   truth is frozen and re-derivable: anyone with a key can re-run `pull.mjs --block B*` and get byte-identical
   rows, forever. This single decision is what makes the benchmark auditable by a stranger.
3. Raw gateway responses are committed verbatim under `data/<runid>/pull/`. Nothing downstream may read the
   network again.
4. `pipeline/facts.mjs` extracts canonical facts deterministically from those responses:
   `{fact_id, subject, relation, object, answer_type, source:{deployment_id, query_hash, json_path, block}}`.
   Every fact points at the exact byte range it came from.
5. `pipeline/questions.mjs` renders questions from facts through templates in `questions/templates.json` —
   one template family per relation, never per fact, so no question is hand-tuned.

**The dataset the patch is trained on and the questions it is evaluated with come from the same `facts.jsonl`.**
That is the honest description, and stating it plainly is better than hiding it. Three devices keep it from
being circular:

- **Held-out phrasing.** Each fact gets ≥ 3 surface forms. Form `P` (canonical, terse — the form that becomes a
  `{prompt, answer}` training row) and forms `E1`, `E2` (different wording, one of them in Korean) which are
  **never trained on**. **The headline accuracy is `E1` alone — 120 items, which is the n the power analysis
  below is sized for.** `E2` is Korean and is reported beside it as cross-lingual transfer, never folded into
  the headline: mixing it in would make the ordering claim a blend of compiled-memory generalisation and
  cross-lingual generalisation, which are different claims with different failure modes. `P` is measured too and reported as
  the *memorisation ceiling* — the gap between `P` and `E1` is the generalisation cost, and reporting it is
  more convincing than pretending it is zero.
- **Held-out facts, and a skew in them that must be quoted with any tripwire result.** Measured
  2026-09-04: the 30 held-out items are **24 `pool_tokens`, 80% of the bucket** — the relation cap was applied
  to the 120 taught facts and not to the held-out pool, which is not relation-stratified. Two consequences,
  and neither is repaired by the cap that fixed the headline. "Arm C fails the held-out facts" — the study's
  own validity condition — is therefore a claim about one relation rather than about held-out facts in
  general. And this is the bucket arm B is expected to win outright, so arm B's strongest showing is measured
  on a single question shape. The bucket is still reported at full weight; it is reported with this sentence
  attached.
- **Held-out facts.** 20% of facts are deliberately excluded from the training set. Arm C **must fail these**.
  If it does not, something is wrong with the experiment (leakage, or an uplift that has nothing to do with the
  patch) and the run is void. This is the benchmark's own tripwire — and it is also **the bucket arm B is
  expected to win outright**, since those facts are live in the subgraph and absent from the patch. It is
  reported at full weight beside the headline, never folded into it and never quietly dropped. The arm that
  wins it *and* the headline is D, which is the point.
- **Multi-hop items** (§6) whose answers are computed by the generator from two facts, never stated as a single
  row in the training set.

### Size

| Bucket | Items | Purpose |
|---|---|---|
| Held-out phrasing, taught facts (`E1`) | 120 | **headline accuracy** |
| Held-out phrasing, taught facts (`E2`, Korean) | 40 | cross-lingual transfer |
| Trained phrasing (`P`) | 40 | memorisation ceiling |
| Held-out facts (never taught) | 30 | tripwire: arm C must fail, arm B should win |
| Multi-hop | 20 | reasoning over two facts |
| **Total** | **250** | |

Every bucket is scored and printed separately with its own McNemar, and the pre-registered per-bucket
expectation is printed in the same table so the reader compares prediction to result cell by cell:

| Bucket | A | B | C | D |
|---|---|---|---|---|
| Held-out phrasing, taught facts (headline) | floor | mid — loses through §6's channels | **high** | **high** |
| Held-out phrasing, Korean (`E2`) | floor | mid | high, some transfer loss | high |
| Trained phrasing (`P`) | floor | mid | ceiling | ceiling |
| Held-out facts | floor | **high — B's bucket** | ≈ floor, by construction | **high** |
| Multi-hop | floor | low — needs several queries in one budget | mid | **high** |
| Offline (§6) | floor | **0 — cannot run** | **unchanged** | degrades to C |

The overall ordering B < C < D is an aggregate over this mix. The mix is declared here, before the run, so
nobody has to take on trust that it was not tuned afterwards to produce the ordering.

Two repeats per item per arm ⇒ 2 000 model sessions. Cost estimate on this host: a short greedy completion
measured at ≈ 4.25 s, so arms A and C are ≈ 35 min each; arm B/D tool loops at 3–6 model calls plus gateway
round trips run ≈ 30–50 s per item, ≈ 3.5 h each. **Total ≈ 8–9 h of exclusive runtime lock**, i.e. one
overnight pass. If the GPU window is shorter, drop `E2` and the trained-phrasing bucket first (they are context,
not the claim) and say in the summary that they were dropped — never silently shrink the headline bucket.

### Why 120 is enough

All arms answer the same items, so the comparison is **paired** and the right test is exact McNemar on the
discordant pairs (`src/normalize.mjs: mcnemar`), not a two-proportion test. With n = 120, a 15-point difference
between two arms produces on the order of 25–45 discordant pairs, which exact McNemar detects at p < 0.01. Each
arm's own accuracy is reported with a Wilson 95% interval (`wilson()`), which at n = 120 is roughly ±7 points
near 50% and ±5 near 90%. Both are printed in the summary table; no difference is called a difference without
its p-value and both intervals beside it.

## 2. Asking every arm the same thing

- One `question` string per item, sent verbatim as the **sole user message** in every arm. No arm gets a hint,
  a schema, a hint about units, or a reformulation the others do not get.
- System prompts differ only where the arm forces it. `A` and `C` share one file byte-for-byte. `B` and `D`
  share a second file, which is the first file **plus** the tool-use paragraph and tool schemas — a tool arm has
  to be told it has tools. Both files and their `diff` are committed under `system-prompts/`, so the exact size
  of the asymmetry is on the record instead of being asserted to be small.
- Item order is shuffled once with a fixed seed and the **same order is used for every arm**, so drift in the
  host over the run window hits all arms in the same places.
- **Sampling is uniform, and that is why every arm goes through `src/vllm.mjs` rather than the node.** The
  node's chat path applies stop sequences and a repetition guard (`DEFAULT_CHAT_SAMPLING`,
  `packages/node/src/runtime.ts:54`) and **cannot be told not to**: `Market.chatInner` builds
  `{ maxTokens, thinking }` and never forwards `sampling` (`packages/node/src/market.ts:955`), so `POST
  /api/chat` has no way to express the `sampling: null` this section used to claim it passed. Arms B and D
  need a raw tool loop and would not be stopped or guarded; running A and C through the node would therefore
  have compared a stopped arm against an unstopped one — the exact asymmetry this section forbids. So the
  runner drives `:8002` directly for all four arms with one body: `temperature 0`, `top_p 1`,
  `max_tokens 256`, no stop sequences, no penalties, `chat_template_kwargs.enable_thinking: false`.
- **Thinking must be explicitly off, and this is not cosmetic.** Measured 2026-09-04: with thinking at its
  default, a tool-armed request on this deployment spent all 200 completion tokens on reasoning
  (`reasoning_tokens: 200`), returned empty content and `finish_reason: "length"` — **no tool call at all**.
  The same request with `enable_thinking: false` emitted the tool call in 79 tokens. An arm B run without the
  flag would have produced "the model does not use its tools", a strawman manufactured by our own request body.
- **The arms are not all contemporaneous, and the bridge control is what makes that legitimate.** Arms A and B
  need no patch, so they run before the training window; arms C and D need one, so they run after it. That
  puts at least one engine restart between an item's arm-A and arm-C answers — the "arm A in the morning, arm
  C at night" design the paired chunks were written to rule out. Rather than assert the restart is harmless,
  it is measured: after the engine comes back, **40 items of arm A are re-run and compared to their
  pre-window answers.**

  Both parameters are fixed here, before any delta is known, because a threshold chosen after seeing the
  result is not a threshold:

  - **Which 40.** Stratified by largest remainder across the five buckets — headline 19, ceiling 7, korean 6,
    tripwire 5, multihop 3 — seeded, and written into `provenance.bridge` before the run. Taking the head of
    the shuffled file would have filled the bridge with headline items and told us nothing about the
    tripwires, which is where a behavioural change would surface first: a tripwire item is *supposed* to fail,
    so a restart that altered it would be invisible in any bucket we happened to look at.
  - **The threshold.** Arm A's own two repeats, run on ONE engine instance, give the disagreement rate `d` —
    the noise floor of asking the same question twice under identical conditions. The bridge passes if its
    pre-versus-post disagreement rate falls at or below the **upper bound of the Wilson 95% interval on `d`**
    at the same n (`wilson()`, `src/normalize.mjs`). `d` is computed from arm A alone and **committed to this
    repository before the bridge is executed**, which the running order guarantees: arm A finishes hours
    before the window opens. If the bridge fails, arm A is re-run in full beside C and D and only the 40 items
    are lost.

  The probe run that measures the training step adds a second restart before the window's, so there are two
  independent restart deltas rather than one. If they agree, the engine's restart noise is characterised and
  §7's threat 3 can quote it instead of hedging. The offline re-run of arms B and D stays on the SAME engine
  instance as C and D, for the same reason the bridge exists at all.
- **Two repeats.** `temperature 0` is not bit-deterministic under vLLM continuous batching, and this repo
  already knows it — the teach-mode locality check asks each prompt twice for exactly this reason
  (`packages/node/src/teach.ts`, "not repeatable on this model"). Every item is run twice per arm. An item whose
  two answers disagree *in arm A* is marked `unstable`; the headline accuracy is computed on the stable subset,
  and a sensitivity row over all items is printed underneath. The unstable count is the benchmark's own noise
  floor and is quoted in the summary.

## 3. Running arm B fairly

The temptation is to give the tool arm a bad prompt and a small turn budget and then celebrate. Don't. The
whole thesis dies if a judge can say "you strawmanned The Graph".

- **The real product.** The Graph's hosted Subgraph MCP server (`https://subgraphs.mcp.thegraph.com/sse`,
  `Authorization: Bearer $GRAPH_API_KEY`) with its own tools — subgraph search, schema fetch, query execution.
  We do not reimplement it and we do not wrap it in anything of ours.
- **Two configurations, and the generous one is the headline.**
  - **B-assisted (headline).** The system prompt names the deployment ids for the domain and carries one
    worked example query against the standardized schema. This is the strongest configuration a competent
    engineer would ship, and it is the one we quote.
  - **B-cold.** Generic prompt only; the model must find the subgraph itself. Reported alongside as context.
    If B-cold is much worse, that is a fact about agent plumbing, not an argument against The Graph, and the
    write-up says so.
- **Budget: 8 tool calls / 10 assistant turns / 90 s wall clock per item**, then one final turn forced to
  answer with what it has. Actual usage is recorded — if the median item uses 2 calls, the budget was not the
  binding constraint and the summary states that.

  **Measured 2026-09-04, with the rule for changing it fixed here before the re-measurement.** On the first
  16 completions the call distribution was {6:1, 8:13, 9:2} against a cap of 8, the final turn was forced on
  15 of 16, and only 4 of 16 committed to an answer while 8 of 16 had already received real rows. A tool arm
  cut off mid-investigation on 94% of items measures our budget, not whether tool loops lose facts — the same
  structural objection that took down the 8 192-token window, and one this section's own standard forbids.

  That measurement is kept as a RESULT rather than discarded: *at 8 calls and 90 s a tool arm is cut off
  mid-investigation on 94% of items, holding data it had no budget left to filter.* It is a real cost of the
  tool path, it belongs beside the latency numbers, and it is the honest provenance for changing the budget.

  But part of that spend was ours. The prompt told the model it need not read schemas because the deployments
  share one Messari schema, and handed it a `vaults`-shaped worked example — while the study spans Vault
  (117 items), Market (47) and LiquidityPool (45), whose fields differ. `Type Market has no field symbol` is
  not exploration; it is a model paying tool calls to discover that a claim in our own prompt was untrue.
  Sizing a pre-registered parameter around our own defect would buy room for the defect and hide it, so the
  prompt is corrected first and the budget re-measured against the corrected one.

  **What the three 8-call measurements support, and what they do not.** One measurement exists per prompt
  version (`runs/r1-budget8/`), which is closer to per-fix attribution than the design intended. Each is 16
  items. They carry DIRECTION and not magnitude: the first correction moved nothing measurable, the frozen
  prompt moved the distribution the predicted way, and the budget still binds. "This fix was worth one call"
  is 8.0 against 7.0 at n=16 with no interval, and it must not be written as an estimate — a reader who sees
  per-fix numbers will reasonably assume they are ones.

  The sharpest of those observations is the tail: nothing finished under six calls on the original prompt,
  and two of sixteen items answer in **two** on the corrected one. When the model does not have to unlearn a
  false claim, the task is genuinely short — which is the strongest available evidence that the earlier
  distribution was measuring our defects rather than the tool loop.

  **The decision rule, fixed now:**
  1. Re-measure one chunk on the corrected prompt. If it still pins at the cap — median 8, or the final turn
     forced on ≥ 50% of items — the budget rises to **20 calls / 240 s**. The wall clock rises WITH the call
     count: at 20 calls a 90 s cap becomes the new binding constraint, which would move the strawman rather
     than remove it.
  2. **One raise only.** If 20 also binds, the summary reports "arm B is budget-limited at 20 calls" as a
     finding and the budget is not raised again. Otherwise every raise is justified by the argument that
     justified the last one, and there is no principled stopping point.
  3. **"Not binding" is defined now, not afterwards:** median ≤ 12 of 20 AND the final turn forced on fewer
     than 25% of items. Both, so neither statistic can be chosen for reading well.
  4. **Arm D takes the same budget.** D carries the tools too, and raising only B would confound the D-vs-B
     comparison with a parameter difference.

  **RESULT, 500 completions at 20 calls / 25 turns / 240 s.** The not-binding test fails, so the summary
  reports *arm B is budget-limited at 20 calls* as a finding and the budget is not raised again:

  | | |
  |---|---|
  | tool calls | median **7**, mean 9.4 — median PASSES (≤ 12) |
  | forced final | **149/500 = 30%** — FAILS (< 25% required) |
  | turns | median 6, mean 9.1; no item near the turn cap that was not also at the call cap |
  | context exhausted | 0/500 |

  **The distribution is bimodal, and that is the result.** 172 of 500 completions finish in two calls or
  fewer; 149 sit exactly at the cap; between 12 and 20 there is almost nothing. The tool loop is not
  uniformly expensive — it is cheap on most items and hits a wall on 30% that more budget does not climb.
  That is a claim about tool loops rather than about our parameter, it is what the two-call items at n=16
  predicted, and it is more informative than either "8 was too few" or "20 was enough". Raising the budget
  further would move the 149 nowhere: they are not running out of calls, they are failing to converge.
- **Retries.** One retry on a transport error (5xx, timeout, connection reset). Never a retry because the
  answer was wrong. Retries are counted.
- **Running out of window is a MISS, never an `error`.** Measured while building the runner: three tool calls
  against a Messari schema overflow 8 192 tokens, and vLLM answers `400 … maximum context length`. Recording
  that as a transport error would have been catastrophic for the study, because §5 excludes errors from the
  accuracy denominator — arm B's most characteristic failure would have been *deleted from the measurement*,
  and the arm would have looked better the more often it overflowed. So the loop measures the request before
  every turn and evicts the OLDEST tool results first (each replaced by `… evicted, N tokens …`, which the
  model can read), and if it still does not fit, withdraws the tool schemas and forces one final answering
  turn. Either path sets `context_exhausted`, which is a miss channel above. A 400 is never retried — it would
  fail identically and spend 90 s doing it. The eviction count and the peak prompt size are recorded per item.
- **RESOLVED 2026-09-04, and the arithmetic is kept because the fix is the interesting part.** At
  `--max-model-len 8192` arm B ran out of context on 4 of 4 smoke items and missed all four. The tool schemas
  cost ~1 184 tokens and the B-assisted system prompt ~912, so the first request was already ~2 800 and the
  usable budget for tool output across a whole item was roughly 5 000 — while a single Messari pool response
  measured 13 600–22 100 characters (~3 400–5 500 tokens). One generous query filled the window. Observed
  peaks were 6 400–7 700 against a 7 680 ceiling. That is not a constraint to write up, it is a strawman: an
  arm that exhausted its context on 100% of items measures our launch flag, not whether tool loops lose facts.

  What fixed it was not the flag we were arguing about. 8 192 was not a choice, it was the cache — the engine
  reported "Available KV cache memory: 0.2 GiB → GPU KV cache size: 8,192 tokens, Maximum concurrency for
  8,192 tokens per request: 1.00x". The lever turned out to be `--max-num-seqs`, which was 8: the engine
  reserves activation and CUDA-graph memory per concurrent sequence, so capping it at 1 left 0.59 GiB for KV
  instead of 0.2. The deployment now serves **32 768 tokens at fp16**, engine-reported cache **39 321 tokens**,
  "Maximum concurrency for 32,768 tokens per request: 1.20x". A quantised KV cache was proposed and proved
  unnecessary; numerics are unchanged, which is why the demo cluster's fp16 attestations remain comparable and
  why the patch path could be re-verified rather than re-argued (krx-all-2761 reproduced its attested 26/26).

  A cap of 1 concurrent sequence costs this study nothing: every arm asks one question at a time under a lock.
  Arm B now has room for roughly four full Messari responses instead of one, so residual context exhaustion is
  a finding about the tool loop rather than an artefact of the host. Both numbers are published either way —
  the window the run used, and arm B's peak context per item.
- **The 8 192-token window is a real constraint, declared not exploited.** Subgraph JSON is large. Tool results
  are passed through verbatim up to 4 000 tokens; beyond that they are truncated at a JSON array boundary with
  an explicit `… truncated, N of M rows` marker, and the turn is flagged `context_truncated`. The truncation
  rate is a headline row, because it is the structural point: **arm B's context grows with the data it reads
  and is capped by the window; arm C's marginal context is zero tokens.** The write-up must also concede that a
  128k-context host would relieve this, which is exactly why tokens (host-independent) are reported next to
  accuracy (host-dependent).
- Only the **final assistant message** is scored. Tool output that happens to contain the answer is not a hit.

## 4. Running arms C and D

**Where the patch comes from, and why that took three attempts.** Arms C and D need a trained patch, and until
2026-09-12 there was none: every run recorded `patch: {backend: "none", real_training: false}`, so the
ordering this protocol exists to test had never had a C arm at all. Training it on the node — `ainize teach
dataset upload data/r1/trainset.jsonl` then `ainize teach train` — turned up three separate faults, each of
which had the same shape: a check that was performed and then not enforced.

1. **The trainer container had lost its GPUs.** `nvidia-smi` inside it answered "Failed to initialize NVML",
   which the node reported verbatim as `model load failed: No CUDA GPUs are available`. The driver had been
   changed under a container that had been up seven days; a restart of the container fixed it. Nothing else
   on the machine noticed, because every other container had been started after the change.
2. **`teach.trainer.gpus` was a guard that guarded nothing.** The pre-flight measured free memory on the
   named GPUs and then launched the trainer with no device restriction, whose own default is
   `cuda:0,cuda:1,cuda:2` — on this cluster the very GPUs serving the model. Fixed in ainize-node by pinning
   `CUDA_VISIBLE_DEVICES` to those GPUs' UUIDs (host indices and container indices differ; a UUID does not).
3. **One 40 GB A100 is not enough for this model.** With the pin working, training OOM'd on a single card.
   The serving instance on `:8002` had answered zero requests since it started, so it was stopped for the
   training window and the node pointed at `:8000`, whose patch mailbox it was already writing to.

That last one exposed the fault worth recording here, because it invalidates any live test taken before it:
**the node was asking `:8002` and writing patches into `:8000`'s mailbox.** `runtime.patchDir` was unset, so
the mailbox defaulted to `runtime.repo/ple_patch`, which belongs to a different vLLM instance than
`runtime.api` named. Patches loaded into a model that was never asked anything, and answers came from a model
that never saw a patch. `ainize status` prints the mailbox with a warning when it has to guess it; that
warning was the only sign.

**And when it finally ran, it did not produce an arm C.** 2026-09-13, after a 12-hour run that timed out at pass
12 of 20 and a 5-hour one that completed: the lesson was refused by the product's own publish gate.

```
taught    6 of 24 questions re-asked on the serving model
locality  3 of 10 unrelated answers unchanged   (2 more were not repeatable and left out)
=> NEEDS_MORE
```

The trainer's own final probe was 66 % — and evenly so across all four prompt forms it trains
(`qa` 79/119, `chat` 77, `nl` 79, `space` 78, from a baseline of 4/1/1/0). So this is not the trained-form /
asked-form mismatch it would be easy to assume: the node re-asks in the same `Q: …\nA:` form the trainer used.

**The locality number is the result, and it is about this dataset rather than about settings.** 119 facts touched
**49,825 memory rows** — 419 rows per fact. The answers are short (`G-UNI`, `2.5`) and the questions are dominated
by 42-character hex addresses, which tokenise into long sequences and give every fact a very large n-gram
footprint. A patch that rewrites fifty thousand rows moves answers nobody asked about, and the gate says so.

Two knobs were tried and neither is the cause: the micro-batch (8 — 64 ran out of memory on a 40 GB A100) and the
contrast set (24). Raising the pass count raises accuracy and the footprint together, so the two gates move in
opposite directions.

**What this is evidence for.** The protocol's §"The claim under test" asks whether compiled memory beats a tool
loop on the facts it holds. This run says something narrower and earlier: **an address→symbol lookup is not a
fact this method can compile at all on this model.** That is a result about which knowledge belongs in memory and
which belongs behind a query — which is what the four arms exist to separate — and it belongs in the write-up
rather than in a retry loop.

Arms C and D are executed against the running node, not against a script that re-implements patching.

- **Arms A, C and D run in ONE PROCESS on ONE ENGINE INSTANCE — and that is weaker than the per-chunk
  pairing this section used to claim.** The original design ran A and C as a single `POST /api/chat` with
  `mode: "compare"`, pairing them under one lock; that route cannot carry §2's uniform sampling, so the
  pairing had to be reconstructed. This section described the reconstruction as per-chunk interleaving. **The
  runner does not do that.** It is arm-major: arm A completes, then C, then D, with the patch state asserted
  against the node before and after every chunk within an arm. So an item's A and C answers are up to one
  arm-length apart — about fifteen minutes — rather than about one.

  The claim is corrected rather than the code, because the property that mattered is preserved and the extra
  precision is small: fifteen minutes inside one process on one engine instance is bounded by arm A's own
  two-repeat disagreement rate, and the overnight A-in-the-morning / C-at-night design remains ruled out. What
  the bridge control measured is a restart, not fifteen minutes.

  **This is not optional bookkeeping.** Measured 2026-09-04→05: stopping and starting the container with an
  unchanged Cmd moved arm A's abstain rate from 74% to 86% on a fixed 40-item set, and every one of the ten
  disagreements crossed the wrong/abstain seam — the seam §5's hallucination metric is measured on. A study
  that compares an arm from before a restart with an arm from after it carries that shift invisibly. Hence:
  one process, one instance, and any measurement spanning a restart is two measurements.
- **Arm D needs a multi-turn tool loop with the patch resident**, which `chat()` cannot express (it takes no
  tools). The runner therefore pins the patch with the operator route `POST /api/patches/:id/apply`
  (`api.ts:418`), runs the tool loop directly against `:8002`, and unpins with
  `POST /api/patches/:id/remove` — with `scripts/patch.py status` asserted before and after the block. No
  change to `packages/*` is required.
- **Restart detection.** A vLLM restart silently reverts the PLE table; `Runtime.verify()` already re-checks
  `isApplied()` between chunks of 8 and re-applies. The runner does the same: after every chunk it asserts the
  state it asked for still holds, and if it does not, **the chunk's results are discarded unwritten** and the
  chunk is re-run against a re-established table. Nothing from a chunk whose table state was lost can reach
  the transcripts, because we cannot know which of its items were answered before the revert. Recorded as
  `restarts_detected` and `chunks_rerun` in `provenance.json`. **Any run with `restarts_detected > 0`
  publishes the count in the summary header**; a run that could not re-establish the table twice in a row is
  void and the runner exits.

## 5. Scoring

Every headline number comes from `src/normalize.mjs`, a pure function over the committed transcripts.
`node src/normalize.test.mjs` runs 22 cases covering each rule and passes today, before any data exists.
Re-scoring needs no GPU, no key and no network: `node src/score.mjs runs/<id>`.

`answer_type` is declared **by the generator, per item, before any model sees the question** — never chosen
after reading an answer.

| type | rule |
|---|---|
| `address` | extract `0x[0-9a-fA-F]{40}`, compare lowercase (EIP-55 casing is not part of the claim) |
| `symbol`, `enum` | upper-case, drop non-alphanumerics, exact |
| `integer` | drop thousands separators/currency/units, exact |
| `decimal` | **±1% relative**, unit must be right. Values are frozen at B\*, so the tolerance covers formatting only. Any fact whose value moves faster than 1% between two consecutive pulls is dropped at generation time |
| `date` | ISO `YYYY-MM-DD`, exact |
| `list<T>` | headline is **exact set equality** after per-element normalisation; Jaccard travels beside it as `partial` and is **never blended into the headline** |

Five verdicts, and the distinction between the last three is the point:

- `hit` — normalised answer equals truth.
- `wrong` — a confident answer that is not the truth.
- `ambiguous` — several candidates of the right shape, one of which is the truth ("it is either 0x… or 0x…").
  **Counted as a miss in the headline**, reported in its own column. Without this rule an arm can farm accuracy
  by shotgunning addresses.
- `abstain` — the model declined (narrow regex; a hedge that still commits to a value is not an abstention).
  **Never counted as wrong.** Accuracy is `hit / (all non-error items)`, and a second table splits `wrong` from
  `abstain`, because the difference between them *is* the hallucination metric.
- `error` — **no answering turn ever completed**: a transport failure, a timeout, an HTTP error. Excluded from
  accuracy denominators; its rate is reported separately. An EMPTY final after a turn that did complete is a
  **miss**, not an error — `context_exhausted` where that flag is set, `empty_final` otherwise. §3 requires
  this and it is the rule the study cannot bend: excluding empty answers would pay an arm for running out of
  room, and the arm that runs out of room is the one we claim to beat.

**No LLM judge in any headline number.** An LLM-judge column may be added afterwards as a sanity check, using a
different model, with its prompt committed — and if it ever disagrees with the deterministic scorer, the
deterministic scorer wins and the disagreement is listed.

## 6. What is measured

Per `(arm, item, repeat)`, written to the transcript:

- `verdict`, `partial`
- `latency_ms` — end to end, first request to final answer, **including every tool round trip**; plus
  `model_ms` (sum of vLLM latencies) so model time and network time are separable and nobody can claim the
  gap is just The Graph's servers being far away.
- `prompt_tokens`, `completion_tokens` — **summed over all turns**, from vLLM's `usage` on each call. This is
  the number that separates the arms most sharply and it is host-independent.
- `tool_calls`, `tool_bytes_in`, `context_truncated`, `context_exhausted`, `context_evictions`,
  `prompt_tokens_peak`, `budget_exhausted`, `forced_final`, `retries`, `tool_errors`
  (**`guard_verdict` is gone**: it belonged to the design where arms ran through the node's chat path. The
  runner drives `:8002` directly with `guard: false` and no stop sequences — §2 — so no guard verdict exists
  to record. A field listed here that no transcript carries is a claim the scorer cannot honour.)
- `cost_usd` — `prompt_tokens × P_in + completion_tokens × P_out + gateway_queries × P_query`, with every
  price read from `pricing.json` (list prices with source URLs; nothing here was billed to us and the file says
  so). Change a price, re-run the scorer, every cost cell changes. No cost number is ever typed into a table.

Derived, in the summary:

**Latency and tokens are headline results, not context for accuracy.** The thesis was never "the model got
smarter" — it is *at comparable accuracy, what does retrieval cost*. Treating time and tokens as columns
beside accuracy inverts the study. Arm B is a five-hour arm where arm A was well under one, on the same 250
items and the same host; arm C answers in a single forward pass with zero tool round trips and zero marginal
context. That difference IS the measurement, it is recorded for free by every arm's own timings, and it is
reported first.

- **Break-even, and the honest version of it.** `N*` is the question count at which buying a knowledge once
  beats querying every time. Three corrections, all of which make the number worse for us and the claim
  harder to dismiss:

  1. **The training cost is the measured one, not the step time.** Measured 2026-09-04: cold load 330.9 s,
     plus 480 baseline generations and 24 contrast probes — about 80 minutes of fixed overhead paid ONCE PER
     RUN regardless of `max_steps` — plus the steps themselves at roughly 6 minutes each. Neither of us had
     budgeted a second of the generation term before measuring it. A break-even computed from step time alone
     would be optimistic by an hour and a half of GPU. The kernel it was measured on is stated with it, since
     `causal_conv1d` may move all of it.
  2. **Say who the fixed cost is amortised across, because there are two different claims here and only one
     is ours.** For a single user training their own patch, the break-even is genuinely poor and the summary
     says so plainly: eighty minutes of GPU to answer 250 questions faster is not a trade anyone makes. For a
     marketplace the patch is trained ONCE and applied by every node that buys it, so the fixed cost divides
     by the number of buyers while the per-item saving does not. That is the actual thesis and the reason the
     product is a marketplace rather than a training script. Reporting the unflattering single-user number
     first is what makes the multi-buyer number credible rather than promotional.
  3. **So `N*` is a curve in the number of buyers, not a scalar.** Cumulative cost against question count for
     one buyer, ten, a hundred — with the single-buyer line shown even where it never crosses.

- **Setup is separated from inference, like every other cost here.** Applying a patch takes seconds and
  happens once per node, so arm C's apply time is recorded separately from its per-item latency. Without that
  split a reader cannot tell whether the per-item advantage is inference or amortised setup, and every other
  cost in this study is separated that way.
- **Where arm B's answers are lost — the decomposition that carries the C > B claim.** Every arm-B miss is
  assigned to exactly one channel, by deterministic checks over the recorded transcript, and the channels are
  printed as a table that sums to the miss count. Nothing here is an opinion about tool calling; each cell is a
  counter with a rule:
  | Channel | Rule over the transcript |
  |---|---|
  | `skipped` | zero tool calls made |
  | `wrong_subgraph` | every executed query targeted a deployment id that is not the fact's `source.deployment_id` |
  | `query_error` | the tool returned a GraphQL error or empty `data` on every attempt |
  | `truncated` | a tool result was cut at the context wall on the turn that carried the answer |
  | `budget_exhausted` | the 8-call / 10-turn / 90 s cap was hit before an answer |
  | `ignored_result` | the answer's key token appears in **no** tool result — the data arrived and was not used |
  | `context_exhausted` | the window filled with tool output: an evicted result, or vLLM's own 400, before an answer |
  | `had_it_and_still_wrong` | the truth string *is* in a tool result and the final answer differs |
  The last two are the interesting ones: they are the cases where The Graph delivered and the loop lost it, and
  they are what a compiled memory table removes. A C > B gap that does not show up in this table is not a
  finding — see §"What would falsify this". The same decomposition is run for D, where it should be far smaller
  because D only reaches for the tool on the tail.
- **Offline — the capability, not a footnote.** Arm C issues no network request of any kind; the runner asserts
  this rather than trusting it, by running the whole arm with egress blocked at the process level and recording
  that the block was in force in `provenance.json`. Arms B and D are then re-run under a declared
  fault-injection mode where the MCP transport returns `503` for every call — nothing fabricated, no fake rows,
  no synthetic subgraph, only an injected outage, which is a thing that happens. The four-cell table is the
  headline of this section: **B goes to the floor, C does not move, D degrades exactly to C.** That last cell
  is the one a buyer cares about — adding the tool costs nothing when the tool is gone. Reported with the
  accuracy table, not in an appendix, because "runs air-gapped" is a product property and not a robustness
  caveat.
- **Multi-hop.** The 20 join items, reported separately with their own McNemar. Truth is computed by the
  generator from two facts; no model is involved in producing it.

### Side effects — and the fair version of that argument

Ainize measures whether loading knowledge damages unrelated answers. The node already does this: twelve fixed
locality prompts (`DEFAULT_LOCALITY_PROMPTS`, `packages/core/src/config.ts:48` — prose, code, arithmetic,
general knowledge, two Korean) asked twice with nothing applied to establish which prompts are repeatable at
all, then once with the patch applied; unstable prompts are excluded and the gate is `≥ 11 of 12 identical`.

For the benchmark this is extended to a **50-prompt regression set** in the same shape, and scored
**against the base model's own answers**, not against gold labels — the claim is "loading the knowledge does not
change unrelated answers", so the base answer *is* the reference. Reported as `same/total`, with every changed
prompt listed in full with both answers.

The tempting line is "tool calling has no analogue for this". That is not quite true and the write-up should
not say it. Declaring tools changes the context, and a changed context can change unrelated answers too. So the
same 50 prompts are run in **arm B with tools declared but not needed**, and the side-effect table has four
cells like every other table. If arm B also perturbs unrelated answers, that is a finding for both of us; if it
does not, arm C has to beat it honestly. Either way the measurement is symmetric, which is the only version a
sceptical judge will accept.

## 7. Threats to validity (printed in the summary, not buried here)

1. **The patch is trained on facts pulled from these very subgraphs.** This is the study's central threat and
   it is stated first for that reason. Mitigations: held-out phrasings (the headline bucket is never a trained
   string), held-out facts (arm C must fail them and arm B should win them), multi-hop (truth computed by the
   generator, never a training row), and the miss decomposition above, which requires any C > B gap to be
   explained by a named loss channel rather than by coverage. The claim is **not** that training made the model
   smarter about chains in general — it is that the same facts, once compiled, are retrieved without the tool
   loop's losses, at zero marginal context, with no network. A reader who rejects the mitigations should read
   the held-out-fact bucket and the arm-D column, neither of which the ordering can hide behind.
2. **Context is 32 768 tokens, and it was 8 192 until the day of the run.** The honest form of this threat is
   not "we ran on a small host" but "the host held exactly one 8 192-token request until we found that
   `--max-num-seqs 8` was reserving the cache, and at 1 the same card yields 39 321 tokens". Arm B is the arm
   a window constrains, so the study's own history is the reason to report tokens next to accuracy: a reader
   on a larger host can re-judge, and a reader on a smaller one can see what our earlier configuration did to
   the tool arm.
3. **One model, one domain, one host, one run window.** The two-repeat disagreement rate is the noise floor and
   is quoted.
4. **Modelled costs, not invoices.** Every price is a published list price with a URL in `pricing.json`.
5. **Arm B is seven times less stable than arm A, and only arm B changes its answer.** Measured, 500
   completions each: arm A d = 0.0360 with abstain-flip 0.0360 and answer-change **0.0000**; arm B d = 0.2480
   with abstain-flip 0.1880 and answer-change **0.0600**. Across two independent arm A runs — 1 000
   completions — the model has never once changed WHICH answer it gives at temperature 0, only whether it
   commits. Arm B changes the value itself on 6% of items. Every comparison involving arm B therefore carries
   a wider instrument floor than one involving A or C, and it is arm B's own floor: using arm A's rate as a
   shared floor would have understated arm B's instability sevenfold and built the error bars for a tool arm
   out of an arm with no tools.

6. **A pre-registered rule can be wrong in a way you can see and still must not be edited.** The attribution
   analysis separates cleanly — P(flip | tool path failed) 0.2368 [0.1820, 0.3021] against P(flip | tool path
   clean) 0.0333 [0.0092, 0.1136], intervals not overlapping — and the pre-registered verdict is
   `UNDERPOWERED_TO_ATTRIBUTE`, because the clean row holds 2 flipped items against a declared floor of 10 and
   the rule gives the floor precedence. The floor's stated rationale was about false NEGATIVES: single-digit
   cells overlap regardless of the truth, so non-separation would be a statement about sample size wearing
   the clothes of a statement about tool paths. That rationale does not apply to a positive result, so a
   **one-sided** floor would have been the better design.

   It was not changed. Rewriting a rule after watching it block a finding we would like to report is the same
   move as choosing a threshold after seeing the delta, and being able to see exactly why the rule is wrong is
   not a licence — it is what makes the temptation legible. The counts, the non-overlap and the
   pre-registered verdict are all published; a reader weighs them. The design lesson is recorded here for the
   next study rather than applied to this one.

7. **Whoever ran it wanted a particular answer.** The counter is not a promise; it is that the pinned block,
   the raw responses, the transcripts and a scorer with a passing self-test are all committed, so re-scoring is
   cheaper than trusting us.

## 8. Artefacts

```
graph/bench/
  README.md                       this protocol
  pricing.json                    token + gateway list prices, with source URLs
  system-prompts/{plain,tools}.txt + diff.txt
  questions/templates.json        one template family per relation
  src/normalize.mjs               normalisation, verdicts, Wilson, exact McNemar
  src/normalize.test.mjs          22 rule cases — `node src/normalize.test.mjs`
  src/score.mjs                   transcripts → per-question.csv + summary.md   (no GPU, no key)
  src/run.mjs                     the runner                                     (needs GPU + key)
  src/chart.mjs                   summary → charts/*.svg
  data/<runid>/pull/*.json        raw gateway responses, pinned to block B*
  data/<runid>/facts.jsonl        canonical facts, each pointing at its source bytes
  data/<runid>/questions.jsonl    {id, question, answer_type, truth, form, taught, hop, fact_id}
  runs/<runid>/transcripts/<arm>/<qid>.<repeat>.json   every request and response, all turns, usage, timings
  runs/<runid>/per-question.csv   one row per (arm, item, repeat)
  runs/<runid>/summary.md         the four-arm table + the sub-tables of §6
  runs/<runid>/locality.json      the 50-prompt side-effect table, all four cells
  runs/<runid>/charts/*.svg       accuracy w/ CIs · latency CDF · tokens per question · cumulative cost
  runs/<runid>/provenance.json    §9
```

Re-run: `node src/run.mjs --run <id> --arms A,B,C,D`.
Re-score from committed transcripts, no GPU and no key: `node src/score.mjs runs/<id>`.

## 9. Provenance and the stub rule

`provenance.json` accompanies every run: model id and the vLLM launch arguments as read from the running
process; the patch id, `patch_sha256` and **whether it was produced by a real gradient run or by the teach
stub**; the subgraph deployment ids and block B\*; whether `GRAPH_API_KEY` was present (never the key); the git
commit; start and end timestamps; `restarts_detected`; and the count of unstable items.

**The stub rule is mechanical, not a promise.** Real gradient training needs a GPU window that is not yet
scheduled. Until it opens, the pipeline runs end to end on the teach stub — and when the patch's provenance is
`stub`, the runner writes `results-DRYRUN.*` and refuses the `results-final.*` filenames, and the scorer stamps
`SIMULATED PATCH — NOT A TRAINED MODEL` into the summary header and every chart subtitle. A stub number can
therefore never be mistaken for a trained one by accident, in this repo or in the submission.

## 10. What the owner must provide

Nothing in this directory can produce a headline number without a key, and no fixture will be invented to work
around that — a fabricated row disqualifies the submission and is worse than an incomplete one.

**Status: `GRAPH_API_KEY` was provided by the owner on 2026-09-04 and both endpoints answer.** It lives in
`.env` at the repo root (gitignored, mode 600) and is read into the environment with `set -a; . ./.env; set +a`.
It is never written into `graph/bench/**`, never committed, and `provenance.json` records only *that* a key was
present. Verified the same day against the live services:

- gateway — `POST https://gateway.thegraph.com/api/subgraphs/id/<id>` with `Authorization: Bearer $KEY`
  returned `_meta.block.number` 25902862 (the `/api/<key>/subgraphs/id/<id>` path form also works; the header
  form is what `pull.mjs` uses, so the key never appears in a URL or a log line).
- MCP — **the hosted MCP does not require the key at all.** A keyless session completed the full handshake
  and a `tools/call` (`execute_query_by_subgraph_id` → block 25902896) on 2026-09-04. This corrects the earlier
  entry below, which recorded that the endpoint "sends nothing without a key" — that observation was an SSE
  read that gave up before the first event, not an auth refusal. Arm B is still run **with** the key, so the
  traffic is attributable to our own quota and matches what a real integration ships, and `provenance.json`
  records `mcp_authenticated: true`; but `SubgraphMCP` no longer throws without one, because a reviewer
  reproducing arm B will not have our key and must still be able to run it.
- MCP — `GET https://subgraphs.mcp.thegraph.com/sse` with the same header opens a session
  (`subgraph-mcp` 0.1.1, protocol `2024-11-05`, legacy HTTP+SSE transport: the stream emits
  `event: endpoint → /messages?sessionId=…` and JSON-RPC is POSTed there; `/mcp` streamable-HTTP is 404, so the
  client must negotiate down). Nine tools, which are the ones arm B gets and the ones §3's loss channels are
  defined over: `search_subgraphs_by_keyword`, `get_top_subgraph_deployments`,
  `get_deployment_30day_query_counts`, `get_schema_by_{subgraph_id,deployment_id,ipfs_hash}`,
  `execute_query_by_{subgraph_id,deployment_id,ipfs_hash}`.

- **`GRAPH_API_KEY`** — from Subgraph Studio (thegraph.com/studio → your account → API Keys). Needed for both
  the gateway (`https://gateway.thegraph.com/api/subgraphs/id/<deployment>`, `Authorization: Bearer $KEY`) and
  the hosted Subgraph MCP server (`https://subgraphs.mcp.thegraph.com/sse`, same header). Verified 2026-09-04:
  the gateway answers `auth error: missing authorization header` with no key and `auth error: API key not found`
  with a bogus one, and `api.studio.thegraph.com` serves only deployments you own — so **the gateway half of the
  pull genuinely needs the key**. The MCP half does not: see the correction above.
- **`SUBSTREAMS_API_TOKEN`** — only if the Substreams half of the track work is pursued (The Graph Market).

Both are read from the environment; neither is ever written to a file in this repo.
