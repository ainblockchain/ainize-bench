# The four-arm benchmark — protocol

*Status: protocol frozen, runner not yet written. No numbers exist in this directory yet. When they do, every
table will carry the provenance block described in §9, including whether the patch came from a real gradient
run or from the teach stub.*

## The claim under test

The Graph indexes chain data. Ainize compiles indexed data into model memory. The interesting question is not
"can a model answer chain questions" — with a subgraph and a tool loop, obviously it can. The question is what
you give up by answering that way, and whether compiling the same facts into the model's memory table buys back
anything a buyer would pay for.

So the benchmark is not "Ainize beats The Graph". It is: **at equal accuracy, what do retrieval and compiled
memory cost, and which one survives when the tool is not there?** The Graph is the source of truth in every arm
— including arm C, whose knowledge is *made of* Graph data. A result where arm C wins on accuracy alone would
be uninteresting and, given how the questions are generated, unfair. The result we expect and intend to publish
is: comparable accuracy, order-of-magnitude differences in latency, tokens and cost, and a large gap in
robustness when the tool is unavailable.

## The four arms

One model server for all of them: `http://localhost:8002`, `Qwen3.8-Flash-Next`, launched with
`--max-model-len 8192 --max-num-seqs 8 --enable-auto-tool-choice --tool-call-parser qwen3_coder`. Tool calling
is a native capability of this deployment, not something we bolted on for the benchmark — arm B is run on the
same server that arm A is, with the same weights.

| Arm | Memory table | Tools |
|-----|--------------|-------|
| **A** | base | none |
| **B** | base | The Graph Subgraph MCP |
| **C** | Ainize knowledge patch applied | none |
| **D** | Ainize knowledge patch applied | The Graph Subgraph MCP |

Arm D exists because the honest question a buyer asks is not "instead of?" but "as well as?". If D ≈ C on cost
and ≈ B on coverage, the product story is *compile the hot path, keep the tool for the tail* — which is a better
story than "replace The Graph" and is the one the numbers will most likely support.

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
  patch) and the run is void. This is the benchmark's own tripwire.
- **Multi-hop items** (§6) whose answers are computed by the generator from two facts, never stated as a single
  row in the training set.

### Size

| Bucket | Items | Purpose |
|---|---|---|
| Held-out phrasing, taught facts (`E1`) | 120 | **headline accuracy** |
| Held-out phrasing, taught facts (`E2`, Korean) | 40 | cross-lingual transfer |
| Trained phrasing (`P`) | 40 | memorisation ceiling |
| Held-out facts (never taught) | 30 | tripwire: arm C must fail |
| Multi-hop | 20 | reasoning over two facts |
| **Total** | **250** | |

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
- **Sampling is uniform and the degeneracy guard is off for scoring.** The node's chat path normally applies
  stop sequences and a repetition guard (`DEFAULT_CHAT_SAMPLING` in `packages/node/src/runtime.ts`). The
  benchmark passes `sampling: null` — the same exemption `Runtime.verify()` takes and for the same reason: a
  stop sequence can only shorten an answer, so leaving it on would silently penalise whichever arm happens to
  produce longer answers (arm B, which narrates its tool use). The guard's verdicts are recorded per turn and
  reported as a diagnostic column; they never move a ✓/✗.
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

- **Arms A + C are run as one paired call**: `POST /api/chat` on node-u (`http://localhost:3422`) with
  `mode: "compare"` and `patch_ids: [K]`. `Market.chat()` (`packages/node/src/market.ts:911`) takes the shared
  runtime lock once, removes the patch → asks the base model → applies the patch → asks again → restores the
  table exactly as it found it. Both answers therefore come from the same table-state transition, seconds apart,
  under one lock. That is a materially better paired design than running arm A in the morning and arm C at
  night, and it comes free from code the product already uses in front of users.
- **Arm D needs a multi-turn tool loop with the patch resident**, which `chat()` cannot express (it takes no
  tools). The runner therefore pins the patch with the operator route `POST /api/patches/:id/apply`
  (`api.ts:418`), runs the tool loop directly against `:8002`, and unpins with
  `POST /api/patches/:id/remove` — with `scripts/patch.py status` asserted before and after the block. No
  change to `packages/*` is required.
- **Restart detection.** A vLLM restart silently reverts the PLE table; `Runtime.verify()` already re-checks
  `isApplied()` between chunks of 8 and re-applies. The runner does the same: after every 8 items in a patched
  block it asserts the patch is still applied, re-applies and re-runs the chunk if not, and records
  `restarts_detected` in `provenance.json`. **Any run with `restarts_detected > 0` publishes the count in the
  summary header**; a run that could not re-establish the table is void.

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
- **Tool-skip and hallucination.** For arms B and D: `skipped` = items with **zero** tool calls;
  `skip_and_wrong` = of those, how many were wrong. Plus `tool_called_but_ignored` — the final answer's key
  token appears in **no** tool result (a deterministic substring check over the recorded tool outputs). This is
  the failure mode a tool-calling agent cannot design away and it is measured, not asserted.
- **Tools-unavailable robustness.** Arms B and D are re-run in a declared fault-injection mode where the MCP
  transport returns `503` for every call. Nothing is fabricated — no fake rows, no synthetic subgraph; only an
  injected outage, which is a thing that happens. Arm C is unaffected *by construction*, and the outage run
  measures that instead of claiming it. Reported as a separate four-cell table.
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

1. **The patch is trained on facts pulled from these very subgraphs**, so arm C's coverage advantage is by
   construction. Mitigations: held-out phrasings, held-out facts, multi-hop. The claim is *cost, latency and
   robustness at comparable accuracy* — not "the model got smarter".
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

- **`GRAPH_API_KEY`** — from Subgraph Studio (thegraph.com/studio → your account → API Keys). Needed for both
  the gateway (`https://gateway.thegraph.com/api/subgraphs/id/<deployment>`, `Authorization: Bearer $KEY`) and
  the hosted Subgraph MCP server (`https://subgraphs.mcp.thegraph.com/sse`, same header). Verified 2026-09-04:
  the gateway answers `auth error: missing authorization header` with no key and `auth error: API key not found`
  with a bogus one; the MCP endpoint accepts an SSE connection and then sends nothing without a key. There is no
  keyless path to live subgraph data, and `api.studio.thegraph.com` serves only deployments you own.
- **`SUBSTREAMS_API_TOKEN`** — only if the Substreams half of the track work is pursued (The Graph Market).

Both are read from the environment; neither is ever written to a file in this repo.
