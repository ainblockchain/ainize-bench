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
  **never trained on**. The headline accuracy is measured on `E1`/`E2` only. `P` is measured too and reported as
  the *memorisation ceiling* — the gap between `P` and `E1` is the generalisation cost, and reporting it is
  more convincing than pretending it is zero.
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
- **MEASURED 2026-09-04, and it is currently a blocker, not a caveat: at `--max-model-len 8192` arm B runs
  out of context on 100% of items.** Four smoke items, all four `context_exhausted`, all four missed. The
  arithmetic is not subtle: the tool schemas are ~1 184 tokens and the B-assisted system prompt ~912, so the
  first request already costs ~2 800 and the usable budget for tool output across the whole item is roughly
  5 000 tokens — while a single Messari pool response measured 13 600–22 100 characters (~3 400–5 500
  tokens). One generous query fills the window. Observed peaks were 6 400–7 700 tokens against a 7 680
  ceiling.

  This has to be fixed before the headline run, not written up. §3 exists to stop us shipping a strawman arm
  B, and "it ran out of room on every single item" is a strawman whoever caused it: a reviewer would say the
  comparison was against a hobbled tool arm, and they would be right. The fix is a larger window on the
  serving deployment — this model supports far more than 8 192; the flag was chosen for KV-cache memory, not
  by the model — which means relaunching `:8002`, which is shared with the live cluster and belongs to the
  same GPU window as arm C's real training. **The headline run is therefore blocked on that window.** Both
  numbers get published either way: the window the run used, and arm B's peak context per item, so a reader
  can see how much room the arm actually had.
- **The 8 192-token window is a real constraint, declared not exploited.** Subgraph JSON is large. Tool results
  are passed through verbatim up to 4 000 tokens; beyond that they are truncated at a JSON array boundary with
  an explicit `… truncated, N of M rows` marker, and the turn is flagged `context_truncated`. The truncation
  rate is a headline row, because it is the structural point: **arm B's context grows with the data it reads
  and is capped by the window; arm C's marginal context is zero tokens.** The write-up must also concede that a
  128k-context host would relieve this, which is exactly why tokens (host-independent) are reported next to
  accuracy (host-dependent).
- Only the **final assistant message** is scored. Tool output that happens to contain the answer is not a hit.

## 4. Running arms C and D

Arms C and D are executed against the running node, not against a script that re-implements patching.

- **Arms A + C are paired per CHUNK, not per call.** The original design ran them as one `POST /api/chat`
  with `mode: "compare"`, which pairs them perfectly under a single lock — but that route cannot carry the
  uniform sampling §2 requires (see above), so the pairing is reconstructed in the runner instead: for each
  chunk of 8 items the table is put into one state, the chunk is asked, the table is moved to the other state,
  and the same chunk is asked again. The gap between an item's two arms is minutes, which is what the paired
  design was defending against; the overnight A-in-the-morning / C-at-night design it replaces is still ruled
  out. The state is asserted against the node before and after every chunk, so "the patch was resident" is a
  checked fact per chunk rather than an assumption over the whole run.
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
- `error` — transport/timeout/empty. Excluded from accuracy denominators; its rate is reported separately.

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
- `tool_calls`, `tool_bytes_in`, `context_truncated`, `retries`, `guard_verdict`
- `cost_usd` — `prompt_tokens × P_in + completion_tokens × P_out + gateway_queries × P_query`, with every
  price read from `pricing.json` (list prices with source URLs; nothing here was billed to us and the file says
  so). Change a price, re-run the scorer, every cost cell changes. No cost number is ever typed into a table.

Derived, in the summary:

- **Break-even.** `N* = knowledge_price / (cost_per_question_B − cost_per_question_C)` — the number of
  questions after which buying the knowledge once is cheaper than querying every time. Plotted as cumulative
  cost vs. question count, two lines, crossing at `N*`. For a marketplace this is the single most persuasive
  chart available, and it falls straight out of numbers already collected.
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
2. **8 192-token context** is this deployment's limit and it constrains arm B more than the others. Tokens are
   reported next to accuracy precisely so the reader can re-judge on a larger host.
3. **One model, one domain, one host, one run window.** The two-repeat disagreement rate is the noise floor and
   is quoted.
4. **Modelled costs, not invoices.** Every price is a published list price with a URL in `pricing.json`.
5. **Whoever ran it wanted a particular answer.** The counter is not a promise; it is that the pinned block,
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
