# Four-arm benchmark — results for run `r1`

Scored 2026-09-13T03:13:06.600Z by `src/score.mjs` v1.0.0 from the committed transcripts alone — no GPU, no API key, no network, no LLM judge (§5). Every verdict comes from `src/normalize.mjs`; every price from `/mnt/newdata/ainize/split/ainize-bench/bench/pricing.json`.

> **the arms did not answer the same item set — B is missing 34; §1's paired comparison holds only over the items both arms answered**

## 0. The pre-registered falsifiers, before the tables

§"What would falsify this" requires these to land ahead of the numbers, so they are printed first whether they fired or not.

| Falsifier | Verdict | Evidence |
|---|---|---|
| B ≥ C on the headline bucket ⇒ the compiled-memory claim fails on this domain | **TRIGGERED** | E1+E2 stable subset: B 68.0% [59–76] 83/122 vs C 20.4% [15–28] 29/142 · exact McNemar b=61 c=4 p=<0.0001 |
| B ≥ C on E1 alone (§1's size table names E1 the headline bucket) | **TRIGGERED** | E1, all items: B 64.7% [55–73] 66/102 vs C 24.2% [17–33] 29/120 · exact McNemar b=43 c=4 p=<0.0001 |
| D ≤ C ⇒ "hot path + tail" is wrong; adding the tool bought nothing | not triggered | E1+E2 stable subset: D 59.2% [51–67] 84/142 vs C 20.4% [15–28] 29/142 · exact McNemar b=6 c=61 p=<0.0001 |
| C ≥ B on held-out facts ⇒ leakage, the run is VOID | not triggered | tripwire, all items: C 0.0% [0–11] 0/30 vs B 55.6% [37–72] 15/27 · exact McNemar b=15 c=0 p=<0.0001 |
| A within 5 points of B ⇒ the questions are too easy and the item set is regenerated (§"The four arms") | not triggered | overall stable subset: A 0.0% [0–2] 0/229 vs B 64.6% [58–71] 128/198 · exact McNemar b=0 c=128 p=<0.0001 |

**Leakage tripwire (§1).** README §1 + §"What would falsify this": arm C must FAIL the held-out facts. C ≥ B on that bucket is leakage and the run is VOID.

- arm B on held-out facts: 55.6% · arm C: 0.0% · arm A (floor): 0.0%
- **verdict: pass** — arm C sits at or below the floor arm A sets on facts it was never taught, which is what §1 predicts

**RUN VOID: no**

### The ordering under test

Claim: **A < B < C < D**, measured on E1 (headline bucket) alone, stable subset. Holds end to end: **no**.

| Step | left | right | holds | exact McNemar (items) |
|---|---|---|---|---|
| A < B | 0.0% | 63.6% | yes | b=0 c=56 p=<0.0001 |
| B < C | 63.6% | 17.3% | **no** | b=43 c=4 p=<0.0001 |
| C < D | 17.3% | 57.7% | yes | b=5 c=47 p=<0.0001 |

Every step is decided by exact McNemar on the discordant pairs at alpha 0.05, measured on E1 alone — §1 sizes its power analysis for E1 = 120, while E2 is cross-lingual transfer, a different claim. The margin is reported beside the p-value and decides nothing: at n = 120 a 5-point margin sits inside the Wilson width, so a margin rule would call differences this study cannot resolve.

## 0.5 What retrieval cost — the result §6 asks to be reported first

§6: "Latency and tokens are headline results, not context for accuracy. The thesis was never *the model got smarter* — it is *at comparable accuracy, what does retrieval cost*. Treating time and tokens as columns beside accuracy inverts the study … it is reported first." So it is, before the accuracy tables. Tokens are host-independent; latency is not, and the host is in §6 below.

| Arm | E1+E2 accuracy | tokens / question | wall clock / question | gateway queries | cost / question |
|---|---|---|---|---|---|
| A | 0.0% [0–3] 0/142 | 158 | 0.5 s | 0 | $0.000035 |
| B | 68.0% [59–76] 83/122 | 112593 | 38.7 s | 4425 | $0.0236 |
| C | 20.4% [15–28] 29/142 | 161 | 0.5 s | 0 | $0.000037 |
| D | 59.2% [51–67] 84/142 | 147096 | 45.0 s | 5856 | $0.0306 |

Arm B against arm C, on the same items and the same host: **698.0×** the tokens, **71.8×** the wall clock, **637.7×** the modelled cost, and 4425 gateway queries against 0. Arm C's marginal context is zero tokens and its network use is zero by construction (§6); every one of those numbers is measured, not asserted.

## 1. Accuracy per arm × bucket

Unit: the item. The unit of every accuracy, interval and paired test is the ITEM (§1 sizes the Wilson interval at n = 120 items), and §2 governs which items count: an item whose two answers disagree in arm A is UNSTABLE, the headline is the stable subset, and an all-items sensitivity row is printed beneath with the unstable count quoted. An earlier draft added a third rule — a hit only if every non-error repeat was a hit — which is stricter than §2 and interacts badly with what arm A measured: all seven of its disagreements were abstain flips, so the strict rule would turn every hit-then-abstain item into a miss and move the headline by pure instrument noise. `unit_accuracy_all_repeats` and `split_items` are the (item, repeat)-level view beside it. The miss decomposition is (item, repeat)-level and says so in its own block.

Stable subset = items whose two arm-A repeats agreed (§2). 21 of 250 items are unstable and are excluded from the headline; the sensitivity row over all items follows.

**Headline — stable subset, accuracy [Wilson 95%] hits/n**

| Bucket | A | B | C | D | pre-registered (A / B / C / D) |
|---|---|---|---|---|---|
| Held-out phrasing, taught facts (E1) — headline | 0.0% [0–4] 0/104 | 63.6% [53–73] 56/88 | 17.3% [11–26] 18/104 | 57.7% [48–67] 60/104 | floor / mid — loses through §6 channels / high / high |
| Held-out phrasing, Korean (E2) | 0.0% [0–9] 0/38 | 79.4% [63–90] 27/34 | 28.9% [17–45] 11/38 | 63.2% [47–77] 24/38 | floor / mid / high, some transfer loss / high |
| Trained phrasing (P) — memorisation ceiling | 0.0% [0–9] 0/37 | 67.7% [50–81] 21/31 | 27.0% [15–43] 10/37 | 64.9% [49–78] 24/37 | floor / mid / ceiling / ceiling |
| Held-out facts — tripwire | 0.0% [0–11] 0/30 | 55.6% [37–72] 15/27 | 0.0% [0–11] 0/30 | 40.0% [25–58] 12/30 | floor / high — B's bucket / ≈ floor, by construction / high |
| Multi-hop (2 facts) | 0.0% [0–16] 0/20 | 50.0% [29–71] 9/18 | 0.0% [0–16] 0/20 | 80.0% [58–92] 16/20 | floor / low — several queries in one budget / mid / high |
| **E1+E2 combined — the headline** | **0.0% [0–3] 0/142** | **68.0% [59–76] 83/122** | **20.4% [15–28] 29/142** | **59.2% [51–67] 84/142** | floor / mid / high / high |
| All 250 items | 0.0% [0–2] 0/229 | 64.6% [58–71] 128/198 | 17.0% [13–22] 39/229 | 59.4% [53–66] 136/229 | — |

**Sensitivity — the same table over ALL items, unstable ones included**

| Bucket | A | B | C | D |
|---|---|---|---|---|
| Held-out phrasing, taught facts (E1) — headline | 0.0% [0–3] 0/120 | 64.7% [55–73] 66/102 | 24.2% [17–33] 29/120 | 57.5% [49–66] 69/120 |
| Held-out phrasing, Korean (E2) | 0.0% [0–9] 0/40 | 80.0% [64–90] 28/35 | 27.5% [16–43] 11/40 | 62.5% [47–76] 25/40 |
| Trained phrasing (P) — memorisation ceiling | 0.0% [0–9] 0/40 | 67.6% [51–81] 23/34 | 32.5% [20–48] 13/40 | 65.0% [50–78] 26/40 |
| Held-out facts — tripwire | 0.0% [0–11] 0/30 | 55.6% [37–72] 15/27 | 0.0% [0–11] 0/30 | 40.0% [25–58] 12/30 |
| Multi-hop (2 facts) | 0.0% [0–16] 0/20 | 50.0% [29–71] 9/18 | 0.0% [0–16] 0/20 | 80.0% [58–92] 16/20 |
| E1+E2 combined | 0.0% [0–2] 0/160 | 68.6% [60–76] 94/137 | 25.0% [19–32] 40/160 | 58.8% [51–66] 94/160 |
| All items | 0.0% [0–2] 0/250 | 65.3% [59–71] 141/216 | 21.2% [17–27] 53/250 | 59.2% [53–65] 148/250 |

> The headline (E1), Korean (E2) and ceiling (P) buckets ask about the SAME 120 facts. Those three buckets are within-fact comparisons of PHRASING, not three independent fact sets — the P-to-E1 gap is the generalisation cost on one fact set, and reading it as a comparison across fact sets is wrong.

**Offline — the capability, not a footnote (§6)**

Not available: the tools-unavailable run (§6) has not been scored yet — `node src/run.mjs --run <id> --offline` then re-score it (expected at `/mnt/newdata/ainize/split/ainize-bench/bench/runs/r1-offline/summary.json`). Arm C issues no network request of any kind by construction; the cell below is the measured version of that, and it is empty until the fault-injected run is scored.

**Paired tests (exact McNemar over the discordant pairs, stable subset)**

| Comparison | E1+E2 | headline | korean | ceiling | tripwire | multihop | all items |
|---|---|---|---|---|---|---|---|
| A vs B | b=0 c=83 p=<0.0001 | b=0 c=56 p=<0.0001 | b=0 c=27 p=<0.0001 | b=0 c=21 p=<0.0001 | b=0 c=15 p=<0.0001 | b=0 c=9 p=0.0039 | b=0 c=128 p=<0.0001 |
| B vs C | b=61 c=4 p=<0.0001 | b=43 c=4 p=<0.0001 | b=18 c=0 p=<0.0001 | b=14 c=2 p=0.0042 | b=15 c=0 p=<0.0001 | b=9 c=0 p=0.0039 | b=99 c=6 p=<0.0001 |
| C vs D | b=6 c=61 p=<0.0001 | b=5 c=47 p=<0.0001 | b=1 c=14 p=0.0010 | b=4 c=18 p=0.0043 | b=0 c=12 p=0.0005 | b=0 c=16 p=<0.0001 | b=10 c=107 p=<0.0001 |
| A vs C | b=0 c=29 p=<0.0001 | b=0 c=18 p=<0.0001 | b=0 c=11 p=0.0010 | b=0 c=10 p=0.0020 | b=0 c=0 p=1.0000 | b=0 c=0 p=1.0000 | b=0 c=39 p=<0.0001 |
| B vs D | b=20 c=11 p=0.1496 | b=12 c=9 p=0.6636 | b=8 c=2 p=0.1094 | b=9 c=8 p=1.0000 | b=5 c=1 p=0.2188 | b=0 c=6 p=0.0313 | b=34 c=26 p=0.3663 |
| A vs D | b=0 c=84 p=<0.0001 | b=0 c=60 p=<0.0001 | b=0 c=24 p=<0.0001 | b=0 c=24 p=<0.0001 | b=0 c=12 p=0.0005 | b=0 c=16 p=<0.0001 | b=0 c=136 p=<0.0001 |

## 2. Verdict split — where the non-hits went

§5: accuracy is `hit / (all non-error items)`. `ambiguous` is counted as a MISS in the headline and reported here in its own column, because without that rule an arm can farm accuracy by shotgunning addresses. `abstain` is never counted as wrong — the difference between `wrong` and `abstain` *is* the hallucination metric. Rows are (item, repeat) units.

| Arm | units | hit | wrong | ambiguous | abstain | error | split items (repeats disagreed) |
|---|---|---|---|---|---|---|---|
| A | 500 | 0 | 59 | 0 | 441 | 0 | 0 |
| B | 432 | 331 | 78 | 3 | 20 | 0 | 49 |
| C | 500 | 114 | 63 | 0 | 323 | 0 | 8 |
| D | 500 | 369 | 66 | 0 | 65 | 0 | 73 |

`list<T>` items also carry a Jaccard `partial`, which travels beside the headline and is never blended into it (§5): A 0.000 · B 0.510 · C 0.000 · D 0.537.

## 3. Where arm B's answers are lost — the decomposition that carries the C > B claim

Every miss in a tool arm is assigned to exactly ONE of §6's channels by a deterministic check over the recorded transcript, and the column sums to the miss count. A miss is any scored (non-error) unit that is not a hit — `wrong` + `ambiguous` + `abstain` — which is exactly the gap between the arm's accuracy and 100%. Unit: (item, repeat).

| Channel | rule over the transcript | B | D |
|---|---|---|---|
| `skipped` | zero tool calls made | 0 | 1 |
| `wrong_subgraph` | no executed query targeted any id in the item's `source_ids[]` | 16 | 34 |
| `query_error` | every executed query returned a GraphQL error or empty `data` | 0 | 1 |
| `budget_exhausted` | the 8-call / 10-turn / 90 s cap was hit before an answer | 28 | 64 |
| `context_exhausted` | the window filled with tool output: an eviction, or vLLM's own 400 | 3 | 7 |
| `truncated` | the truth appears ONLY in tool results that were cut at the context wall | 0 | 0 |
| `had_it_and_still_wrong` | the truth IS in a tool result and the final answer differs | 49 | 21 |
| `ignored_result` | the truth appears in NO tool result | 5 | 3 |
| **total assigned** |  | **101** | **131** |
| **misses** | wrong + ambiguous + abstain | **101** | **131** |
| sums | the decomposition is exhaustive and exclusive | yes | yes |

The ladder is first-match-wins and ordered from the diagnosis that costs our thesis the most to the one that costs it the least: `skipped` → `wrong_subgraph` → `query_error` → `budget_exhausted` → `context_exhausted` → `truncated` → `had_it_and_still_wrong` → `ignored_result`. An item is credited to `had_it_and_still_wrong` — the channel that flatters the compiled-memory claim — only after every "the loop never got there" explanation has been ruled out, and `truncated` is deliberately narrow so that any doubt about whether the model could see the value moves the item OUT of that channel.

Disclosure, arm B: 3 of the `had_it_and_still_wrong` assignments are `decimal` items, where "the truth is in the result" is decided with the scorer's own ±1% tolerance and a large JSON body can contain an unrelated number inside it.

**Arm B, by bucket**

| Bucket | misses | `skipped` | `wrong_subgraph` | `query_error` | `budget_exhausted` | `context_exhausted` | `truncated` | `had_it_and_still_wrong` | `ignored_result` |
|---|---|---|---|---|---|---|---|---|---|
| headline | 50 | 0 | 4 | 0 | 23 | 1 | 0 | 20 | 2 |
| korean | 7 | 0 | 2 | 0 | 1 | 0 | 0 | 3 | 1 |
| ceiling | 14 | 0 | 4 | 0 | 0 | 0 | 0 | 8 | 2 |
| tripwire | 19 | 0 | 3 | 0 | 1 | 0 | 0 | 15 | 0 |
| multihop | 11 | 0 | 3 | 0 | 3 | 2 | 0 | 3 | 0 |

**Arm D, by bucket**

| Bucket | misses | `skipped` | `wrong_subgraph` | `query_error` | `budget_exhausted` | `context_exhausted` | `truncated` | `had_it_and_still_wrong` | `ignored_result` |
|---|---|---|---|---|---|---|---|---|---|
| headline | 65 | 0 | 13 | 1 | 40 | 3 | 0 | 8 | 0 |
| korean | 17 | 1 | 8 | 0 | 2 | 2 | 0 | 2 | 2 |
| ceiling | 17 | 0 | 4 | 0 | 9 | 1 | 0 | 2 | 1 |
| tripwire | 27 | 0 | 5 | 0 | 12 | 1 | 0 | 9 | 0 |
| multihop | 5 | 0 | 4 | 0 | 1 | 0 | 0 | 0 | 0 |

## 4. What each arm spent

Tokens are summed over ALL turns from vLLM's own `usage` (§6) and are host-independent; latency is not. `model_ms` is the sum of vLLM latencies, so model time and network time are separable and nobody can claim the gap is just The Graph's servers being far away.

| Arm | prompt tok/q | completion tok/q | peak prompt tok | turns/q | tool calls/q (median) | gateway queries | tool bytes in | latency ms (mean/median) | model ms (mean) | cost/question |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 150 | 9 | 170 | 1.00 | 0.00 (0.0) | 0 | 0 | 497 / 482 | 497 | $0.000035 |
| B | 111031 | 1561 | 32094 | 11.86 | 12.46 (11.0) | 4425 | 15994891 | 38747 / 32631 | 32673 | $0.0236 |
| C | 150 | 12 | 170 | 1.00 | 0.00 (0.0) | 0 | 0 | 540 / 485 | 540 | $0.000037 |
| D | 145356 | 1741 | 32175 | 13.60 | 14.95 (20.0) | 5856 | 25551453 | 44963 / 54419 | 37523 | $0.0306 |

| Arm | truncated units | context_exhausted units | budget_exhausted units | forced finals | retries | tool errors |
|---|---|---|---|---|---|---|
| A | 0 | 0 | 0 | 0 | 0 | 0 |
| B | 317 | 6 | 183 | 188 | 0 | 1644 |
| C | 0 | 0 | 0 | 0 | 0 | 0 |
| D | 369 | 20 | 304 | 322 | 0 | 2138 |

**Setup is separated from inference (§6)** — applying a patch happens once per node, so it is never folded into a per-item latency.

|  | value | source |
|---|---|---|
| one-time knowledge load (arms C and D) | **not recorded** | not recorded by this run — the one-time knowledge load was not measured, and no number is invented in its place |
| resolution order | runs/<id>/knowledge-load.json → provenance.knowledge_load_ms → provenance.patch.load_ms / apply_ms | the same order `src/chart.mjs` uses |

**The budget question, answered (§3)** — "if the median item uses 2 calls, the budget was not the binding constraint and the summary states that". The cap is read from this run's own `provenance.json`.

| Arm | median tool calls | cap (calls / turns / wall) | units that hit a cap | verdict |
|---|---|---|---|---|
| B | 11.0 | 20 / 25 / 240 s | 183 / 432 | **the cap was NOT the binding constraint for the median item** |
| D | 20.0 | 20 / 25 / 240 s | 304 / 500 | **the cap WAS the binding constraint for the median item** |

## 5. Break-even — how many questions before buying the knowledge is cheaper

`N*(k buyers) = (knowledge_price / k) / (cost_per_question_B − cost_per_question_C)`

| term | value | source |
|---|---|---|
| cost_per_question_B | $0.0236 | measured tokens × list price |
| cost_per_question_C | $0.000037 | measured tokens × list price |
| difference | $0.0235 | per question, B − C |
| knowledge_price | **not set** | /mnt/newdata/ainize/split/ainize-bench/bench/pricing.json → knowledge.price |
| **N\*** | **not computed** | pricing.json carries no knowledge.price |

N\* is left uncomputed because pricing.json carries no knowledge.price. Nothing is assumed in its place: §6 allows no cost number that was not read from `/mnt/newdata/ainize/split/ainize-bench/bench/pricing.json`.

### N\* is a curve in the number of buyers, not a scalar (§6.3)

Two different claims, and only one of them is ours (§6.2). For a SINGLE user training their own patch the fixed cost is not amortised at all and the break-even is genuinely poor; for a marketplace the patch is trained once and applied by every node that buys it, so the one-time price divides by the number of buyers while the per-question saving does not. The single-buyer row is printed first for that reason, and it is printed even where it never crosses.

| buyers sharing the one-time price | price each pays | N\* — questions before buying beats querying |
|---|---|---|
| **1 — a single user training their own patch** | **not set** | **not computed** |
| 10 | **not set** | **not computed** |
| 100 | **not set** | **not computed** |

The single-buyer row is printed first and is printed even where it never crosses, because §6.2 requires the unflattering claim to carry the flattering one: for one user training their own patch, the GPU hours §6.1 measures are not a trade anyone makes to answer this many questions faster, and the marketplace number is only credible standing next to that. pricing.json declares no knowledge.training_usd, so the fixed cost of PRODUCING the knowledge (§6.1: the measured cold load, the baseline generations and the contrast probes, not the step time) is not priced into N* here. N* prices the catalog anchor only.

Prices used: input 0.2 / 1M, output 0.6 / 1M, gateway 0.00004 per query. PLACEHOLDER — set to the list price of the hosted provider you cite, and put the URL here before publishing.

The same numbers are drawn by `node src/chart.mjs runs/<id>` into `runs/<id>/charts/`: the break-even crossing, the latency decomposition and the cumulative latency including arm C's one-time knowledge load, accuracy by arm × bucket with the tripwire held apart, and the miss decomposition above. Those charts read `results.json`, cross-check themselves against this file, and stamp any disagreement on their own face.

## 6. Noise floor and run integrity

|  | value |
|---|---|
| items | 250 |
| (arm, item, repeat) units | 1932 |
| arms scored | A, B, C, D |
| unstable items (arm A's two repeats disagreed) | 21 / 250 |
| arm A: items whose repeats disagreed | 0 |
| arm B: items whose repeats disagreed | 49 |
| arm C: items whose repeats disagreed | 8 |
| arm D: items whose repeats disagreed | 73 |
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
| git commit | b6bf5c9bf6a982524e2fb0bf41c18e84f7d2d431 |
| the 50-prompt side-effect table (§6), all four cells | **absent** — produced by `src/locality.mjs` and `src/locality-tools.mjs`, not by this scorer, and not present for this run |
| items in no declared bucket | 0 |
| arms answering different item sets (§1 is paired) | **B: 34 missing** |
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

