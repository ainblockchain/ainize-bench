# The locality set — 50 prompts a patch must not change

Ainize sells patches and tests them live, before and after. What that test measures today is whether a patch
**teaches what it promised**. What nothing measures is whether it **breaks anything else** — and a PLE patch
writes rows into an embedding table addressed by content, so the collateral damage to look for is not in a
far-off domain. It is at the addresses **next to** the ones the patch trained.

A benchmark arm that gains on its own study while quietly losing elsewhere is not a gain. This set is the
instrument for the second half of that sentence.

| | |
|---|---|
| The set | `prompts.jsonl` — 50 items, one JSON object per line |
| System prompt | `system.txt` — one prompt for all 50, identical in both halves of a run |
| Runner + scorer | [`../src/locality.mjs`](../src/locality.mjs) |
| Tests | [`../src/locality.test.mjs`](../src/locality.test.mjs) — `node src/locality.test.mjs`, no GPU, no network |
| Halves it is built from | `near.jsonl` (20, documented in [NEAR.md](NEAR.md)) · `control.jsonl` (30, documented in [CONTROL.md](CONTROL.md)) |
| What may never be asked | [EXCLUSIONS.md](EXCLUSIONS.md) — the trainset AND the trainer's contrast set |

```
node src/locality.mjs build                     # regenerate prompts.jsonl from its two halves
node src/locality.mjs check                     # the overlap assertion, offline, exit 1 on any collision
node src/locality.mjs run --patch <rows.npz>    # the live capture (needs the GPU and the patch mailbox)
node src/locality.mjs score --in runs/<dir>     # re-score a captured run without a GPU
```

`prompts.jsonl` is **generated, never hand-edited**: `loadPromptSet()` rebuilds it from `near.jsonl` and
`control.jsonl` on every run and refuses to score a file that is not what its sources now derive to. One of
those sources has already moved once (see *The two re-selections* below), and a set that has silently drifted
from the study it is defined against is not a control.

## The six strata, and what each one is probing

| stratum | n | scoring modes | probes |
|---|---|---|---|
| `adjacent-entity` | 10 | exact-normalised 8, numeric 2 | Facts the patch was **not** trained on that sit as close to trained ones as the data allows — the same relation, the same subgraph, an adjacent array slot or a shared address prefix. This is where a memory-table bleed would land first. |
| `near-domain` | 10 | contains 10 | The **concepts** behind the trained facts, never the values: what ERC-4626 is, how a constant-product AMM prices a swap, whether a ticker is a unique identifier. The patch saw this vocabulary hundreds of times and was never told what it means. Two are in Korean. |
| `far-domain` | 12 | contains 7, numeric 5 | Is the model still a model? History, geography, physics, biology, arithmetic, Python. Nothing here shares a token with the trainset. |
| `korean` | 8 | contains 6, numeric 2 | No training row is Korean — every one of the 120 is an English `P` form — so Korean is the channel most exposed to an English-only patch. |
| `format` | 6 | exact-normalised 4, numeric 1, json-shape 1 | Instruction following with the knowledge held constant: one word, a bare number, a JSON object, exact casing, a three-item list, a single letter. A corrupted table is expected to break **obedience** before it breaks facts, and this stratum measures content and format separately so the two are never blended. |
| `calibration` | 4 | refusal 4 | Does the model still decline what it cannot know? An unknowable question, a false premise, an invented country, a live-data question. The closest control analogue of a hallucinated address. |

Ten of the 50 are Korean (8 in `korean`, 2 in `near-domain`). The two near strata are complementary and
neither replaces the other: `adjacent-entity` can see a bleed that nothing else can, but the base model
cannot look those facts up, so it usually misses on both sides and the *signal is the shape of the wrong
answer*, not the accuracy column. `near-domain`, `far-domain`, `korean`, `format` and `calibration` all have a
live baseline — the model can answer them today — so a hit that becomes a miss there is a regression with
nothing to interpret.

## The five scoring modes

Every item declares the mode it wants, and four of the five are rules this repo already had:

| mode | n | rule | implemented in |
|---|---|---|---|
| `exact-normalised` | 12 | exact match after the study's own normalisation (symbol, address, `list<symbol>` set equality with Jaccard alongside as `partial`) | `normalize.mjs scoreOne`, and `locality-control.mjs` for the format items |
| `numeric` | 10 | integers by the first-integer rule, decimals with a 1% relative tolerance — the study's ambiguity rule included, not relaxed | `normalize.mjs scoreOne` |
| `contains` | 23 | concept slots (all required, each a list of accepted surface forms) for the prose items; an accept list with distractors for the short-answer items | `locality.mjs scoreRubric` (prose) · `locality-control.mjs` (accept/reject) |
| `json-shape` | 1 | parses as an object, exact key set, both values equal; a ```json fence still counts and the raw-parse strictness is recorded beside it | `locality-control.mjs` |
| `refusal` | 4 | the declination pattern is tested **before** the claim pattern, so correcting a false premise scores as a refusal and not as damage | `locality-control.mjs` |

Verdicts are the study's vocabulary and nothing else: `hit` · `wrong` · `ambiguous` · `abstain` · `error`.
Prose items are matched by case-insensitive containment (the slots are stems — `integrat` must match
*integrated*); short-answer items are matched on word boundaries for Latin and by substring for Hangul, which
is not space-delimited. There is no LLM judge anywhere in this file.

## How a change is judged

Every item is asked **twice in each half**. Two numbers come out of that, and neither is allowed to stand
alone:

- **the noise floor** — how often the engine disagreed with **itself** between the reference's own two
  repeats, per stratum, with a 95% Wilson interval. A post-apply change rate that does not clear the floor's
  upper bound is not distinguishable from the engine;
- **the paired test** — `b` items moved within the reference, `c` items moved across the patch, and the exact
  binomial McNemar on that discordant pair (the same test the four-arm study uses) gives a p-value with far
  more power than a rate against an interval. Its assumption is stated in the code and in the report: an item
  can only be counted in `c` if it was stable on both sides, so the two conditions do not have exactly the
  same opportunity to move.

An item whose own repeats disagreed is **undecidable**, not "changed" and not "unchanged". Agreement is
computed under the `scored` key — a change that does not change the score is not damage — and the report
carries a sensitivity view under a `text` key, which is literal answer equality, beside it. Ground-truth
accuracy before and after is reported separately from agreement, because an item can move without either
answer having been right, and `repairs` are printed beside `regressions` so an improvement is never quietly
absorbed into "no damage".

## What the runner does, and the two things it refuses

One invocation does all of it, in this order, and there is no flag that scores a post-apply run against a
reference captured earlier:

1. **assert non-overlap** — before a single request is sent (below);
2. **snapshot the serving container** — `docker inspect` Cmd, RestartCount, StartedAt, the way `src/run.mjs`
   does;
3. **take the shared runtime lock** — the same atomic-mkdir lease at `<patchDir>/.ainize-runtime.lock` the
   node takes, refreshed on a heartbeat because this run holds it for longer than the 15-minute lease;
4. **prove the table is at the patch's `before`** — `patch.py check`, all rows, not a sample. A reference
   captured over someone else's patch is not this patch's reference;
5. **capture the reference** — all 50, twice, patch **not** applied;
6. **apply through the real path** — `patch.py apply --verify-before --journal`, then `status` to confirm;
7. **capture the post-apply run** — the same 50, the same order, twice;
8. **remove and prove the table is back** — `remove --journal --keep-journal`, then `status --all --journal`:
   every row equal to what this run displaced, not a 2,000-row sample, and not "remove exited 0".

**Refusal 1 — the engine.** If the container changed between the reference and the post-apply run (Cmd diff,
StartedAt, RestartCount, or a different container entirely) the comparison is refused: transcripts are kept,
`refused.json` is written, no report. A reference recorded before a restart inherits exactly the confounder
the four-arm study spends 40 bridge items ruling out. A container that could not be **read** is refused for
the same reason — "we could not tell" is not "it did not happen".

**Refusal 2 — the table.** If the post-remove status cannot show every row back at the value this run
displaced, the run exits non-zero and says the table is dirty. A locality instrument that leaves the shared
engine in an unknown state has done more damage than it measured.

## The overlap assertion

Six rules, run over the real files before the first request. The exclusion set is never typed out: it is
recomputed from `split.json` + `facts.jsonl` + `questions/templates.json`, and the reduction is **proved**
first — all 120 trainset rows must re-derive byte-for-byte from a fact in `split.study_fact_ids` through that
relation's `P` template, or nothing runs.

| rule | catches |
|---|---|
| **T1** fact identity | an item whose `fact_id` is one of the 120 trained facts, or one that any *asked* study question set names (`questions.jsonl`, `questions-fresh.jsonl`, …; the 38k candidate pool is excluded, because nobody asks it) — two instruments counting the same fact are not independent |
| **T2** subject identity | an item asking about a trained subject |
| **T3** prompt containment | a trained subject or a trained address anywhere in a prompt |
| **T4** answer disjointness | an item whose ground truth — or an accepted surface form, or a format literal — **is** a trained answer atom or a trained numeric answer |
| **T5** prompt novelty | a prompt that is verbatim a trainset prompt or one of the asked study questions |
| **T6** control strictness | the 30 far/Korean/format/calibration items additionally carry no trained entity token at all (delegated to `locality-control.mjs`, unchanged) |

T3 is a substring check against trained **subjects** (addresses and vault or market names — never English) and
not a token check against trained **answers**, deliberately: trained tickers include ordinary English words
(`INDEX` and `REVERSE` today), and the near items share the study's template vocabulary *by design* — that is
what makes them near. The ambiguity is resolved where it costs something, on the answer, as whole-atom
equality. Every rule an item breaks is reported, not just the first.

Ten planted collisions in `locality.test.mjs` prove each rule fires. A check that has never failed is not
evidence.

## The two re-selections

`near.jsonl` was certified against the trainset as it stood at commit `8cfddf6`. The trainset was then
regenerated (`911ccf3`, *"the study was 80% one relation, so the sampler now stratifies by relation too"*) and
began training 13 `vault_fee_pct` rows whose answers are **2.5, 10 and 0**. Two near items — `loc-adj-05`
(truth 2.5) and `loc-adj-06` (truth 10) — therefore had a ground truth that **is** a trained answer, which the
near half's own selection rule rejects: a bleed towards the nearest trained answer would be indistinguishable
from a correct answer.

So this set re-selects those two by the same rule, out of the same committed pull, and changes nothing else:

| id | was | is now | why this one |
|---|---|---|---|
| `loc-adj-05` | an Arrakis vault whose fee is 2.5 | `0x4cbcecdc…`, fee **9.5**, one array slot from a trained vault | 9.5 occurs once in the whole 12,619-fact universe, so a correct answer cannot come from a protocol prior, and a bleed answers 2.5/10/0 — legible, not invisible |
| `loc-adj-06` | a Badger vault whose fee is 10 | `0x15cbc4ac…`, fee **20**, one slot the other side of the *same* trained Badger vault | every untrained Badger neighbour now answers 10, 2.5 or 20, and the first two are trained answers. 20 is Badger's modal fee, so some of the item's power is traded away to buy back distinguishability |

Both truths were re-read out of `data/r1/pull/` **and** `data/r1/pull-fresh/` at the `json_path` the fact
records, agree in both, and are marked `volatile:false`. The override is self-invalidating: if `2.5` or `10`
ever stops being a trained answer, `build` throws rather than carrying a silent fork of the near half's file.

*(`near.jsonl` itself is left exactly as its author committed it, and NEAR.md's arithmetic — "129 trained
answer atoms", "vault_fee_pct: 250 facts, 0 trained" — is from before the regeneration. The current numbers
are printed by `node src/locality.mjs check`: 114 trained subjects, 103 answer atoms, 121 addresses, 3 numeric
answers.)*

## What this set CANNOT see

Read this before quoting any number it produces. **A green locality report is not proof that a patch is
safe.** It is the statement that *no damage was detected at this resolution*, and the resolution is small:

- **50 items, one model, one temperature, one host, one run window.** The per-stratum noise floor printed in
  every report is the engine disagreeing with **itself** on these same items in the same run. With 10 items in
  a stratum, a single changed answer sits inside that floor's 95% interval and this instrument will not call
  it damage. That is a property of *n*, not a clean bill of health. Four items in `calibration` is thinner
  still.
- **It measures a difference, not a state.** The reference is this engine with this patch off — not "the base
  model". Anything already resident in the table is present in both halves and cancels. A stack of patches
  that is collectively broken looks clean here if this patch changed nothing.
- **Adjacent-entity accuracy is mostly flat and uninformative by construction.** The base model cannot look up
  which tokens sit in an arbitrary pool, so those items miss before and after. The signal is the *shape* of
  the wrong answer — an abstention turning into a confident nearest-trained value — which the report shows as
  bleed signs and as `abstain → wrong` migration, not as an accuracy delta.
- **Bleed detection is a lower bound.** It fires on a recorded nearest-trained answer, on a trained address in
  any answer, and on any 40-hex address in a conceptual answer. It deliberately does **not** flag trained
  tickers, because a correct explanation may legitimately name WETH or USDC and a flag that fires on a correct
  answer is worse than no flag. Damage that produces a *plausible new* wrong answer is counted as a change,
  not identified as a bleed.
- **Two repeats is enough to detect instability, not to measure it.** An item whose repeats disagree is
  reported as undecidable rather than counted either way; more repeats would move items out of that bucket.
- **The strata are not equally powerful.** `far-domain` and `korean` items were chosen to avoid the trainer's
  contrast set, which the patch is *explicitly optimised to preserve* (see EXCLUSIONS.md) — arithmetic is the
  one field where that avoidance is only partial, and CONTROL.md names the two weakest items.
- **Nothing here measures whether the patch taught what it promised.** That is the four-arm study in
  `data/r1/`. This set answers the other question, and only for the neighbourhood it can reach.
