# Four-arm benchmark — results for run `r1`

Scored 2026-09-04T11:54:57.932Z by `src/score.mjs` v1.0.0 from the committed transcripts alone — no GPU, no API key, no network, no LLM judge (§5). Every verdict comes from `src/normalize.mjs`; every price from `/mnt/newdata/ainize/knowledge-marketplace/graph/bench/pricing.json`.

## 0. The pre-registered falsifiers, before the tables

§"What would falsify this" requires these to land ahead of the numbers, so they are printed first whether they fired or not.

| Falsifier | Verdict | Evidence |
|---|---|---|
| B ≥ C on the headline bucket | **NOT EVALUABLE** | both arms B and C must be scored |
| D ≤ C | **NOT EVALUABLE** | both arms C and D must be scored |
| C ≥ B on held-out facts ⇒ leakage, the run is VOID | **NOT EVALUABLE** | tripwire, all items: C — vs B — |

**Leakage tripwire (§1).** README §1 + §"What would falsify this": arm C must FAIL the held-out facts. C ≥ B on that bucket is leakage and the run is VOID.

- arm B on held-out facts: — · arm C: — · arm A (floor): 0.0%
- **verdict: NOT EVALUABLE**

**RUN VOID: no**

### The ordering under test

Claim: **A < B < C < D**, measured on E1 (headline bucket) alone, stable subset. Holds end to end: **no**.

| Step | left | right | holds | exact McNemar (items) |
|---|---|---|---|---|
| A < B | 1.1% | — | — | — |
| B < C | — | — | — | — |
| C < D | — | — | — | — |

Every step is decided by exact McNemar on the discordant pairs at alpha 0.05, measured on E1 alone — §1 sizes its power analysis for E1 = 120, while E2 is cross-lingual transfer, a different claim. The margin is reported beside the p-value and decides nothing: at n = 120 a 5-point margin sits inside the Wilson width, so a margin rule would call differences this study cannot resolve.

## 0.5 What retrieval cost — the result §6 asks to be reported first

§6: "Latency and tokens are headline results, not context for accuracy. The thesis was never *the model got smarter* — it is *at comparable accuracy, what does retrieval cost*. Treating time and tokens as columns beside accuracy inverts the study … it is reported first." So it is, before the accuracy tables. Tokens are host-independent; latency is not, and the host is in §6 below.

| Arm | E1+E2 accuracy | tokens / question | wall clock / question | gateway queries | cost / question |
|---|---|---|---|---|---|
| A | 0.8% [0–4] 1/126 | 163 | 0.6 s | 0 | $0.000038 |

## 1. Accuracy per arm × bucket

Unit: the item. The unit of every accuracy, interval and paired test is the ITEM (§1 sizes the Wilson interval at n = 120 items), and §2 governs which items count: an item whose two answers disagree in arm A is UNSTABLE, the headline is the stable subset, and an all-items sensitivity row is printed beneath with the unstable count quoted. An earlier draft added a third rule — a hit only if every non-error repeat was a hit — which is stricter than §2 and interacts badly with what arm A measured: all seven of its disagreements were abstain flips, so the strict rule would turn every hit-then-abstain item into a miss and move the headline by pure instrument noise. `unit_accuracy_all_repeats` and `split_items` are the (item, repeat)-level view beside it. The miss decomposition is (item, repeat)-level and says so in its own block.

Stable subset = items whose two arm-A repeats agreed (§2). 40 of 250 items are unstable and are excluded from the headline; the sensitivity row over all items follows.

**Headline — stable subset, accuracy [Wilson 95%] hits/n**

| Bucket | A | pre-registered (A / B / C / D) |
|---|---|---|
| Held-out phrasing, taught facts (E1) — headline | 1.1% [0–6] 1/92 | floor / mid — loses through §6 channels / high / high |
| Held-out phrasing, Korean (E2) | 0.0% [0–10] 0/34 | floor / mid / high, some transfer loss / high |
| Trained phrasing (P) — memorisation ceiling | 0.0% [0–10] 0/34 | floor / mid / ceiling / ceiling |
| Held-out facts — tripwire | 0.0% [0–11] 0/30 | floor / high — B's bucket / ≈ floor, by construction / high |
| Multi-hop (2 facts) | 5.0% [1–24] 1/20 | floor / low — several queries in one budget / mid / high |
| **E1+E2 combined — the headline** | **0.8% [0–4] 1/126** | floor / mid / high / high |
| All 250 items | 1.0% [0–3] 2/210 | — |

**Sensitivity — the same table over ALL items, unstable ones included**

| Bucket | A |
|---|---|
| Held-out phrasing, taught facts (E1) — headline | 0.8% [0–5] 1/120 |
| Held-out phrasing, Korean (E2) | 0.0% [0–9] 0/40 |
| Trained phrasing (P) — memorisation ceiling | 0.0% [0–9] 0/40 |
| Held-out facts — tripwire | 0.0% [0–11] 0/30 |
| Multi-hop (2 facts) | 5.0% [1–24] 1/20 |
| E1+E2 combined | 0.6% [0–3] 1/160 |
| All items | 0.8% [0–3] 2/250 |

> The headline (E1), Korean (E2) and ceiling (P) buckets ask about the SAME 120 facts. Those three buckets are within-fact comparisons of PHRASING, not three independent fact sets — the P-to-E1 gap is the generalisation cost on one fact set, and reading it as a comparison across fact sets is wrong.

**Offline — the capability, not a footnote (§6)**

Not available: the tools-unavailable run (§6) has not been scored yet — `node src/run.mjs --run <id> --offline` then re-score it (expected at `/mnt/newdata/ainize/knowledge-marketplace/graph/bench/runs/r1-offline/summary.json`). Arm C issues no network request of any kind by construction; the cell below is the measured version of that, and it is empty until the fault-injected run is scored.

**Paired tests (exact McNemar over the discordant pairs, stable subset)**

| Comparison | E1+E2 | headline | korean | ceiling | tripwire | multihop | all items |
|---|---|---|---|---|---|---|---|

## 2. Verdict split — where the non-hits went

§5: accuracy is `hit / (all non-error items)`. `ambiguous` is counted as a MISS in the headline and reported here in its own column, because without that rule an arm can farm accuracy by shotgunning addresses. `abstain` is never counted as wrong — the difference between `wrong` and `abstain` *is* the hallucination metric. Rows are (item, repeat) units.

| Arm | units | hit | wrong | ambiguous | abstain | error | split items (repeats disagreed) |
|---|---|---|---|---|---|---|---|
| A | 500 | 5 | 132 | 0 | 363 | 0 | 1 |

`list<T>` items also carry a Jaccard `partial`, which travels beside the headline and is never blended into it (§5): A 0.015.

## 3. Where arm B's answers are lost — the decomposition that carries the C > B claim

No tool arm was scored in this run, so there is no decomposition to print.
## 4. What each arm spent

Tokens are summed over ALL turns from vLLM's own `usage` (§6) and are host-independent; latency is not. `model_ms` is the sum of vLLM latencies, so model time and network time are separable and nobody can claim the gap is just The Graph's servers being far away.

| Arm | prompt tok/q | completion tok/q | peak prompt tok | turns/q | tool calls/q (median) | gateway queries | tool bytes in | latency ms (mean/median) | model ms (mean) | cost/question |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 150 | 13 | 170 | 1.00 | 0.00 (0.0) | 0 | 0 | 559 / 485 | 559 | $0.000038 |

| Arm | truncated units | context_exhausted units | budget_exhausted units | forced finals | retries | tool errors |
|---|---|---|---|---|---|---|
| A | 0 | 0 | 0 | 0 | 0 | 0 |

**Setup is separated from inference (§6)** — applying a patch happens once per node, so it is never folded into a per-item latency.

|  | value | source |
|---|---|---|
| one-time knowledge load (arms C and D) | **not recorded** | not recorded by this run — the one-time knowledge load was not measured, and no number is invented in its place |
| resolution order | runs/<id>/knowledge-load.json → provenance.knowledge_load_ms → provenance.patch.load_ms / apply_ms | the same order `src/chart.mjs` uses |

**The budget question, answered (§3)** — "if the median item uses 2 calls, the budget was not the binding constraint and the summary states that". The cap is read from this run's own `provenance.json`.

No tool arm was scored in this run, so no budget was in force.

## 5. Break-even — how many questions before buying the knowledge is cheaper

`N*(k buyers) = (knowledge_price / k) / (cost_per_question_B − cost_per_question_C)`

| term | value | source |
|---|---|---|
| cost_per_question_B | — | measured tokens × list price |
| cost_per_question_C | — | measured tokens × list price |
| difference | — | per question, B − C |
| knowledge_price | **not set** | /mnt/newdata/ainize/knowledge-marketplace/graph/bench/pricing.json → knowledge.price |
| **N\*** | **not computed** | arms B and C must both be scored and priced |

N\* is left uncomputed because arms B and C must both be scored and priced. Nothing is assumed in its place: §6 allows no cost number that was not read from `/mnt/newdata/ainize/knowledge-marketplace/graph/bench/pricing.json`.

### N\* is a curve in the number of buyers, not a scalar (§6.3)

Two different claims, and only one of them is ours (§6.2). For a SINGLE user training their own patch the fixed cost is not amortised at all and the break-even is genuinely poor; for a marketplace the patch is trained once and applied by every node that buys it, so the one-time price divides by the number of buyers while the per-question saving does not. The single-buyer row is printed first for that reason, and it is printed even where it never crosses.

| buyers sharing the one-time price | price each pays | N\* — questions before buying beats querying |
|---|---|---|

The single-buyer row is printed first and is printed even where it never crosses, because §6.2 requires the unflattering claim to carry the flattering one: for one user training their own patch, the GPU hours §6.1 measures are not a trade anyone makes to answer this many questions faster, and the marketplace number is only credible standing next to that. pricing.json declares no knowledge.training_usd, so the fixed cost of PRODUCING the knowledge (§6.1: the measured cold load, the baseline generations and the contrast probes, not the step time) is not priced into N* here. N* prices the catalog anchor only.

Prices used: input 0.2 / 1M, output 0.6 / 1M, gateway 0.00004 per query. PLACEHOLDER — set to the list price of the hosted provider you cite, and put the URL here before publishing.

The same numbers are drawn by `node src/chart.mjs runs/<id>` into `runs/<id>/charts/`: the break-even crossing, the latency decomposition and the cumulative latency including arm C's one-time knowledge load, accuracy by arm × bucket with the tripwire held apart, and the miss decomposition above. Those charts read `results.json`, cross-check themselves against this file, and stamp any disagreement on their own face.

## 6. Noise floor and run integrity

|  | value |
|---|---|
| items | 250 |
| (arm, item, repeat) units | 500 |
| arms scored | A |
| unstable items (arm A's two repeats disagreed) | 40 / 250 |
| arm A: items whose repeats disagreed | 1 |
| bucket headline | 120 |
| bucket korean | 40 |
| bucket ceiling | 40 |
| bucket tripwire | 30 |
| bucket multihop | 20 |
| vLLM restarts during the run (§4) | 0 |
| chunks re-run (§4) | 0 |
| model | Qwen3.8-Flash-Next |
| max_model_len | 32768 |
| patch backend / real training | none / false |
| git commit | df1da8b7d803e9d672e8e62897e940bfc6153ae9 |
| the 50-prompt side-effect table (§6), all four cells | **absent** — produced by `src/locality.mjs` and `src/locality-tools.mjs`, not by this scorer, and not present for this run |
| items in no declared bucket | 0 |
| arms answering different item sets (§1 is paired) | no — every arm answered every item |
| embedded question rows checked against the committed set | yes — all match |

## 7. Threats to validity (§7, printed here rather than buried in the protocol)

1. **The patch is trained on facts pulled from these very subgraphs.** The mitigations are the held-out phrasings (the headline bucket is never a trained string), the held-out facts (arm C must fail them and arm B should win them), the multi-hop items (truth computed by the generator, never a training row), and the decomposition in §3 above, which requires any C > B gap to be explained by a named loss channel rather than by coverage.
2. **32768-token context** is this deployment's limit and it constrains the tool arms more than the others. Tokens are reported next to accuracy precisely so the reader can re-judge on a larger host; the peak prompt size per arm is in §4.
3. **One model, one domain, one host, one run window.** The two-repeat disagreement rate above is the noise floor.
4. **Modelled costs, not invoices.** Every price is a published list price with a URL in `pricing.json`; nothing here was billed to us.
5. **Whoever ran it wanted a particular answer.** The counter is not a promise: the pinned block, the raw gateway responses, the transcripts and this scorer with its passing self-test (`node src/score.test.mjs`) are all committed, so re-scoring is cheaper than trusting us.

### How this scorer read the protocol where it had to choose

- **An empty answer after a completed turn is a miss, not an `error`.** §5 lists "empty" under `error` and §3 says running out of window is "a MISS, never an `error`". They are reconciled the only way that does not pay an arm for failing: `error` means no answering turn ever completed (a transport failure), and a forced final is a completed turn. An item with `context_exhausted` and an empty `final` is therefore scored `wrong` with the `context_exhausted` channel, and an empty string is never handed to the abstain regex.
- **`wrong_subgraph` is judged over `source_ids[]`**, every deployment a fair query could have targeted, falling back to `[source.deployment_id]` for rows that predate that field. For a hop-2 join, querying either operand's subgraph is legitimate work.
- **The item, not the repeat, is the statistical unit**, and an item counts as a hit only if every non-error repeat was a hit. §1 sizes its intervals at n = 120 items.
- **`ambiguous` is a miss** in every accuracy cell and appears separately in §2.
- **An answer that exists is scored, even when the runner also recorded a transport error.** `error` deletes a unit from the accuracy denominator (§5), and a unit that produced an answer is not a unit the scorer gets to delete; the condition travels on the row instead.
- **A missing wall clock is not a zero.** Latency and model time are averaged over the units that recorded them, and the units that did not are counted beside the mean (§4) rather than pulling it down.
- **An item that declares no deployment is not charged to `wrong_subgraph`.** That channel blames the agent for aiming badly, and an item carrying neither `source_ids` nor `source.deployment_id` gives it nothing to aim at; the count is stamped at the top of this file instead.
- **`guard_verdict` is listed in §6's per-unit field list and no transcript carries one.** The runner declares `sampling.guard: false` (`provenance.json`), so no guard ran and there is no verdict to report; the field is absent rather than filled with a default. If a guard is ever enabled, this scorer must be extended before the column can be quoted.

