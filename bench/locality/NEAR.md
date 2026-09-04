# The near half of the locality set

Ainize sells patches and tests them live before and after. What that test measures today is whether a patch
teaches what it promised. What it does not measure is whether the patch **breaks anything else** — and a PLE
memory-table patch writes rows into a shared embedding table addressed by content, so the collateral damage
to look for is not in a far-off domain. It is at the addresses **next to** the ones the patch trained.

`near.jsonl` is 20 prompts chosen to sit as close as possible to the study's 120 training rows without
touching them. It is deliberately the near half: the far half measures whether the model is still a model,
this half measures whether the neighbourhood the patch landed in is still intact.

- Set: `locality/near.jsonl` (20 items, one JSON object per line)
- Checker: `../src/locality-near.mjs` — `node src/locality-near.mjs`, exits non-zero on any overlap
- Tests: `../src/locality-near.test.mjs` — `node src/locality-near.test.mjs`, 26 cases, no GPU/network

## What it must not overlap

`data/r1/trainset.jsonl` — exactly 120 `{prompt, answer}` rows, the only thing arm C is trained on. The
exclusion set is not typed out anywhere. `loadStudy()` recomputes it from `split.json` + `facts.jsonl` and
check **C1** proves the reduction is right: all 120 trainset prompts re-derive byte-for-byte from a fact in
`split.study_fact_ids` through its relation's `P` template. Only then are the 120 trained subjects and 129
trained answer atoms trustworthy as the thing to exclude.

| | catches |
|---|---|
| **C1** trainset provenance | the exclusion set being a guess about what was trained rather than a fact about the files |
| **C2** fact identity | an item whose `fact_id` is a study fact, or one of the 188 `fact_ids` the study's own 250-item sample asks |
| **C3** subject identity | an item asking about one of the 120 trained subjects |
| **C4** prompt containment | a trained subject smuggled into a prompt as context or as a second entity |
| **C5** answer disjointness | an item whose ground truth contains a trained answer atom (case-folded, whole atom) |
| **C6** prompt novelty | a prompt equal to a trainset prompt or to one of the 250 study questions |
| **C7** template fidelity | a hand-written or hand-tuned prompt in the adjacent stratum; an address in the conceptual stratum |
| **C8** truth provenance | a ground truth that is not what the committed pull says, or that moved between the two pulls |

C4 is a **substring** check against trained *subjects*, not a token check against trained *answers*. Twelve
trained tickers are ordinary English words — `VAULT`, `INDEX`, `REAL`, `LOVE`, `DOG`, `HAPPY`, `MIX`, `HOP`,
`IDLE`, `TOWER`, `FEAR`, `REVERSE` — and `VAULT` appears as an English word in every vault prompt in this
file. Rather than carve those out of a token check and then argue about the carve-out, the prompt side is
checked against subjects (addresses and vault names, never English) and the ambiguity is resolved where it
actually costs something: C5, on the answer, as whole-atom equality. `ENGLISH_WORD_TICKERS` in the checker
lists all twelve and `loadStudy()` throws if one of them is not in fact a trained answer atom, so the
justification cannot rot into a fiction.

`node src/locality-near.test.mjs` poisons a copy of the set once per check and asserts each one goes red. A
disjointness report that cannot fail is a green light welded on, not evidence.

## Stratum (a) — adjacent-entity, 10 items

Same schema, same subgraphs, same `P` template as the study; a different entity substituted in. These are the
nearest neighbours in the embedding table and the sharpest probe available.

All ten are the study's own `P` phrasing — the literal string a training row took — with an untrained subject
substituted and **nothing else changed**. That is deliberate. Mixing in `E1`/`E2` here would confound "did the
patch bleed into the neighbourhood" with "does the patch generalise across phrasings", and the study's own
E1/E2 buckets already measure the second. Both never-trained relations in the fact universe are used:
`vault_fee_pct` (250 facts, 0 trained — literally "a vault whose fee was never trained") and, via `loc-adj-08`,
a share-token symbol never trained. All eight protocols the trainset touches are represented.

| item | relation | subgraph | subject | truth (verified) | how close | nearest trained answer |
|---|---|---|---|---|---|---|
| `loc-adj-01` | `pool_tokens` | uniswap-v2-swap | `0xff78b484c131f1c806e37c54dd526d69469d2ed7` | `XIO, BUIDL` | 4 leading hex chars shared with `0xff7866facce2ce371578e002170e32bb3d45b672` | `SPURDO, WETH` |
| `loc-adj-02` | `pool_tokens` | uniswap-v2-swap | `0xfe6c98dc3263f8c2bc5cdfbfda478d127a3085a8` | `BabyRinia, SOS` | 4 leading hex chars shared with `0xfe6c5f9d4dc1b72c15cb18bbb6204ee678536ff3` | `WETH, BYELON` |
| `loc-adj-03` | `pool_tokens` | sushiswap | `0xe5e632d45b37ee4682de95edb6a9819bae43665f` | `STA, WSTA` | 3 leading hex chars shared with `0xe5e34df71b00542cc3260bd7a015aee561615ea9` | `POGAI, WETH` |
| `loc-adj-04` | `pool_tokens` | curve-finance | `0xc897b98272aa23714464ea2a0bd5180f1b8c0025` | `msETH, ETH` | 3 leading hex chars shared with `0xc89570207c5ba1b0e3cd372172ccaefb173db270` | `mkUSD, WETH` |
| `loc-adj-05` | `vault_fee_pct` | arrakis-finance | `0x7c687f775a3b73bbab0e15832f24caab5d53bdde` | `2.5` | 1 slot from `vault_symbol:dec8835e14b0` in the same pull page (slot 4 vs 5) | `G-UNI` |
| `loc-adj-06` | `vault_fee_pct` | badgerdao | `0x37d9d2c6035b744849c15f1bfee8f268a20fcbd8` | `10` | 1 slot from `vault_asset:4ccad9d55098` in the same pull page (slot 37 vs 38) | `0x48c59199da51b7e30ea200a74ea07974e62c4ba7` |
| `loc-adj-07` | `vault_name` | gamma-strategies | `0x6c8116abe5c5f2c39553c6f4217840e71462539c` | `Visor DAI-ETH Uni v3` | 1 slot from `vault_name:9a3adb214ac3` in the same pull page (slot 23 vs 24) | `xWBTC-ETH05` |
| `loc-adj-08` | `vault_symbol` | badgerdao | `0xbe08ef12e4a553666291e9ffc24fccfd354f2dd2` | `bcrvTricrypto` | 1 slot from `vault_address:2fa9edbd9a49` in the same pull page (slot 29 vs 28) | `0x19e4d89e0cb807ea21b8cef02df5eaa99a110da5` |
| `loc-adj-09` | `market_asset_symbol` | euler-finance | `0xd99ae587346801f6038a21e870d929c4a493de3a` | `VEGA` | 1 slot from `market_asset_symbol:77422e6d2fe3` in the same pull page (slot 46 vs 45) | `GTC` |
| `loc-adj-10` | `market_address` | cream-finance | `Cream Euro Tether` | `0x766175eac1a99c969ddd1ebdbe7e270d508d8fff` | 1 slot from `market_address:c8e405e75af3` in the same pull page (slot 46 vs 47) | `0x73f6cba38922960b7092175c0add22ab8d0e81fc` |

Two kinds of "close", both recorded in each item's `adjacency` object:

* **`address_prefix`** — the trained `pool_tokens` subjects are hex addresses, so nearness in the string the
  model is asked about is nearness in leading hex characters. `loc-adj-01`'s pool and its nearest trained pool
  agree on `0xff78`; `loc-adj-02`'s on `0xfe6c`. Nearest neighbour is computed within the same protocol so
  "adjacent" means adjacent *in the same subgraph*, not merely lexically.
* **`pull_slot`** — for the 14 non-pool trained facts, adjacency is the literal neighbouring element of the
  same committed subgraph response. `loc-adj-07` is `vaults[23]` and the trainset teaches `vaults[24]` of the
  same file, same relation. That is the closest an untrained entity can be to a trained one.

Nearer candidates existed and were rejected on purpose. `0xfe932fa778217c71514ad9cc4a524cfbaa7a4c8c` shares
**six** hex characters with trained pool `0xfe932f67…`, but holds `TRP, WETH` — and `WETH` is a trained answer
atom, so `scoreOne` returns `{verdict: 'wrong', partial: 0.333}` for emitting a token the patch was trained to
emit, and a bleed would be indistinguishable from partial knowledge. Two hex characters of adjacency is a
cheap price for an answer vocabulary strictly disjoint from the trainset's, which is what keeps a post-apply
result interpretable. Same reason no arrakis `vault_symbol` item is here: all six arrakis vaults in the slots
adjacent to a trained one carry the symbol `G-UNI`, which is a trained answer — 69 of Arrakis's 106 vaults
share that one symbol.

`bleed_targets` on each item is the nearest trained answer — the string a damaged table would most plausibly
emit here. `loc-adj-07` is the clearest case: truth `Visor DAI-ETH Uni v3`, and the trainset teaches
`Visor USDC-USDT Uni v3` and `Visor APW-ETH Uni 3%` for two other Gamma vaults. A bleed produces a
distinguishable wrong string, not noise.

## Stratum (b) — near-domain conceptual, 10 items

DeFi knowledge the base model already has, that the trainset never touches, where the answer is stable prose
rather than a looked-up value. Each one deliberately reuses the trainset's *framing* vocabulary — ERC-4626,
liquidity pool, lending market, token symbol, performance fee — while asking something no training row
answers. That shared surface is what makes it *near*-domain rather than far.

| item | lang | question | rubric slots |
|---|---|---|---|
| `loc-nd-01` | en | What does the ERC-4626 standard specify, and what problem does it solve? Answer in two or three sentences. | 6 |
| `loc-nd-02` | en | How does a constant-product automated market maker decide the price of a swap? Give the invariant and explain why a larger trade gets a worse price. | 3 |
| `loc-nd-03` | en | What is impermanent loss for a liquidity provider, and at what moment does it stop being impermanent? | 3 |
| `loc-nd-04` | en | In an over-collateralised lending market, why is the supply APY always lower than the borrow APR? Explain what determines the size of the gap. | 4 |
| `loc-nd-05` | en | In ERC-20, what is the difference between a token's symbol and its name, and is either guaranteed to be unique on Ethereum? What actually identifies a token? | 3 |
| `loc-nd-06` | en | Two different liquidity pools can hold the same pair of tokens. Name at least two things that can distinguish them. | 3 |
| `loc-nd-07` | en | What is a vault share token, and how does its value against the underlying asset change as the vault earns yield? Does a new deposit change that value? | 4 |
| `loc-nd-08` | en | What is a performance fee in a yield vault, and how is it different from a management fee? | 3 |
| `loc-nd-09` | ko | 탈중앙화 대출 시장에서 청산(liquidation)은 언제 발생합니까? 담보 비율(collateral ratio)과의 관계를 함께 설명하십시오. | 4 |
| `loc-nd-10` | ko | ERC-4626 볼트와 AMM 유동성 풀의 차이는 무엇입니까? 예치자가 받는 토큰과 수익의 원천을 기준으로 설명하십시오. | 4 |

Every item's `near_domain_link` field says which trained relation it sits next to. `loc-nd-05` is the sharpest
of them: the patch trains symbol→address and address→symbol lookups in both directions, and `loc-nd-05` asks
whether that mapping is even well-defined. If a patch makes the model start believing tickers are unique
identifiers, that is a real harm to a buyer and no accuracy number in the study would show it.

Two items are Korean. Korean carries 40 of the study's 250 items and **no training row is Korean**, so Korean
prose is the channel most exposed to a patch that only ever saw English `P`-form English text.

### How stratum (b) is scored

`answer_type: "prose"` is not in `questions/schema.json`'s enum and `normalize.mjs` has no rule for it — by
design, these are not lookups. Each item carries `rubric.must_include`: a list of concept slots, each an array
of accepted surface forms, scored by case-insensitive substring containment, all slots required. Deterministic,
no LLM judge, no number the system did not measure. `rubric.must_not_include` holds the specific
contradictions that would mean the concept has broken (`loc-nd-05`: "symbols are unique").

Bleed detection for this stratum is separate and unambiguous: a correct conceptual answer contains **no
Ethereum address at all**. If the patched model starts emitting 40-hex addresses into prose explanations, or
emits one of the six addresses that are trainset answers, that is table contamination with no other reading.
Trained *tickers* are deliberately **not** used as an automatic bleed flag here — a correct explanation may
legitimately name `WETH` or `USDC`, and a flag that fires on a correct answer is worse than no flag.

## What a pre/post comparison actually measures here

Worth stating plainly, because the naive reading of this set is wrong. The base model cannot look up which
tokens sit in pool `0xff78b4…`. For stratum (a) the expected result is **miss before, miss after**, and
accuracy alone will be flat and uninformative. The signal is the *shape* of the wrong answer:

* **before**: refusal / "I'd need to query a subgraph" / an unrelated confabulation, scored `abstain` or
  `wrong` by `normalize.mjs`.
* **after, if the patch is clean**: the same.
* **after, if the patch bled**: a *trained* answer — one of the `bleed_targets` — or a newly confident
  fabrication where there was an abstention. Both are visible in the per-item verdicts `score.mjs` already
  records (`abstain` → `wrong` is the migration to watch), without any new scoring rule.

Stratum (b) is the half that carries a live baseline: the base model can answer all ten, so `hit → wrong` is
a direct regression with nothing to interpret. The two strata are complementary on purpose — (a) can see a
bleed that (b) cannot, and (b) has a floor that (a) does not.

## Provenance and volatility

All ten stratum-(a) truths were re-read from `data/r1/pull/<file>` at the `json_path` the fact recorded, and
independently from the second pull in `data/r1/pull-fresh/` (taken ~30 minutes later). All ten agree across
both pulls, and all carry `volatile: false` in `facts.jsonl`. Every item pins `source.block = 25902936`, the
same block the study pinned. C8 re-runs this on every invocation; a value that cannot be re-read is a hard
failure, never a default.

`loc-adj-06`'s fact appears in `split.held_out_fact_ids` (the study's random 20% never-trained holdout) but
**not** among the 188 fact_ids the 250-item sample asks — `in_study_heldout_list: true` records this on the
item. It is kept because Badger's fee distribution is `0`×18, `20`×14, `10`×6, `3`×1, `2.5`×1, and of the
four Badger vaults in slots adjacent to a trained one (27, 29, 37, 39) it is the only one whose fee is not
`20` — so its answer cannot be got right by guessing either the protocol's modal fee or its neighbours'.

## Deferred, and why

**No live numbers exist yet.** Nothing in this directory has been sent to a model. `flashnext-e2e` on `:8002`
was in use and heading into a training window, so the whole set was built and tested offline against fixtures.

The live capture must not be split across a restart. The pre-apply reference has to be recorded on the *same
engine instance* as the post-apply run, or it inherits exactly the restart confounder the study spends 40
items ruling out. Whatever runs this set therefore has to make that structural: one invocation that captures
reference and post-apply with no restart between them, refusing to compare across a restart it can detect by
reading the container `Cmd` / `RestartCount` / `StartedAt` the way `src/run.mjs` `engineSnapshot()` already
does. That runner is not in this directory.
