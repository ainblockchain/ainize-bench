# The locality set — control half (30 prompts)

`control.jsonl` is the half of the locality set that has **nothing to do with the patch**. It is the
instrument for the claim Ainize wants to be able to make — *applying this patch did not damage the model* —
and it is deliberately the boring half: general capability that must not move at all.

The other half of the locality set (addresses adjacent to the trained rows — the near-miss half) is a
separate file and is not covered by this README.

## Why a control half exists

`graph/bench` measures whether a patch teaches what it promised. Nothing in the repo measures whether it
broke anything else. A PLE memory-table patch writes rows into a table that every other prompt also reads,
so "arm C gained 40 points on the study bucket" is not a result until someone can say what arm C lost. An
arm that gains on its own study while quietly losing elsewhere is not a gain, and a buyer deciding whether
to apply a patch to a live serving node is asking the second question, not the first.

Damage in the far field is expected to be *rarer* than damage next to the trained addresses — that is what
the near half is for — but it is the kind that matters most if it happens, because it is invisible to every
other measurement in the product.

## The four strata

| stratum | n | what it catches that the others do not |
|---|---|---|
| `far_domain` | 12 | Ordinary knowledge and reasoning in fields the patch never touched: history, geography, biology, physics, arithmetic, Python tracing. Short answers with unambiguous truths. |
| `korean` | 8 | Ainize serves Korean users; the trainset is 100% English. A patch that degrades Korean would be invisible to every other measurement in this repo. Five of the eight need Korean-specific knowledge, so a model that has kept "Korean-shaped output" but lost Korean facts still fails. |
| `format` | 6 | Instruction following: one word, only a number, JSON with exactly these keys, exact casing, exactly three comma-separated items, a single letter. Format compliance is the first thing a corrupted table breaks and the cheapest thing to score exactly. |
| `calibration` | 4 | Cases where the correct behaviour is to decline: an unknowable private fact, a false premise, an entity that does not exist, and a question needing live data. A patch that makes the model *more confidently wrong* is damage that an accuracy metric scores as a gain. |

Selection rule applied throughout: every item is something a base model of this size answers the same way
twice at temperature 0, and where that was in any doubt the more constrained phrasing was chosen — "in a
typical human **somatic** cell", "in **double-stranded DNA**", "which river is longest **in Africa**". The
`why` field on each row records why that item is in the set; it is data, not decoration, and the test asserts
every row has one.

Two deliberate exceptions to "the base model will get it right": `ctl.ko.04` (한라산 vs 백두산) and
`ctl.far.09` (a model that shows its working scores `ambiguous`, see below). Both are still usable, because
the measurement is a **paired before/after comparison per item**, not an accuracy number — see *What the
numbers mean*.

The set was also written **before the model was ever asked any of it** (see *Deferred*), so "stable at
temperature 0" is a selection rule applied by hand, not a measured property. Nothing in this repo reports it
as measured.

## What the set may not touch — asserted twice, not promised

A control prompt is only a control if the patch was **never told about it**. There are two ways to violate
that and only the first is obvious. `src/locality-control.mjs` asserts both mechanically, and the runner must
call them before its first request.

### 1. The study trainset — `data/r1/trainset.jsonl`

* **Addresses** — every `0x…` 40-hex string in the trainset is forbidden anywhere in an item.
* **Entity tokens** — every letter-bearing token of the trainset **answers** (the fact objects), plus every
  **prompt** token that is capitalised anywhere but the start of its sentence, or that contains a digit.
  Those are the entity names the templates interpolate: Euler, Cream, Sushiswap, RAKIS-22, vLQTY-ETH30.
  Everything else in a prompt is the template.
  An earlier version of this rule used document frequency — *a token in at most 2 of the 120 prompts is an
  entity* — and it went leaky the moment the study trainset was rebalanced by relation mid-task: `cream` and
  `euler` landed in three prompts each and were promoted to boilerplate. Frequency describes the sample;
  capitalisation describes the language.
* **Numeric answers** — every trainset answer that is a bare number. A control **answer** may not equal one;
  a numeral inside a control **question** ("15 full boxes") is a coincidence and stays legal.
  This rule exists because it fired: when r1 was rebalanced to include `performance_fee` facts, `0` became a
  trained answer, and `ctl.ko.06` had asked the freezing point of water. It now asks the boiling point.
* Generic English words that occur *inside* a trained answer or an entity name stay forbidden — the
  conservative direction, and part of why this set talks about rivers and pencils.

Three planted overlaps (an address, `WETH`, `RAKIS-22`) are in the test suite so the guard is known to fail
when it should. The check has fired twice on real data: `ctl.cal.04` said "no real-time data" and `REAL` is a
trained token; `ctl.ko.06` answered `0`.

### 2. The trainer's contrast set — `train/teach_contrast.json` (NOT obvious)

The trainer mixes 24 general-knowledge pairs into the corpus as contrast, so that shared PLE rows do not
collapse while the target rows are pulled. **The patch is explicitly optimised to preserve those answers.** A
control item drawn from the same well would report zero damage no matter how much damage there was — and the
well is capitals, dates, arithmetic, Python, chemistry, astronomy and Korean general knowledge, which is
precisely where a far-domain and Korean control set naturally reaches. (Credit where due: this exclusion was
found by the session building the near half; see `EXCLUSIONS.md`.)

Three rules, because the collision has three shapes:

| rule | what it catches |
|---|---|
| `same_answer` | the item's answer IS a contrast answer, whatever the question — numbers included. |
| `paraphrase` | the questions share at least half their content words. "In which year did the Second World War end in Europe?" vs "In what year did World War II end?" scores 0.57. |
| `cross_use` | the reversed direction: the item's answer appears in a contrast **prompt**, or a contrast answer appears in the item's **question**. Asking which element is abbreviated `Au` is the pair "chemical symbol for gold" turned around, and neither of the first two rules sees it. |

**Five items were replaced because of this guard**, and one more was retuned:

| was | now | why |
|---|---|---|
| capital of Australia | largest ocean on Earth | capital-of-X is six of the 24 pairs |
| WWII ended in Europe | year the Titanic sank | pair 7 verbatim, 1945 |
| element abbreviated Au | SI unit of electric current | pair 20 reversed |
| 대한민국의 수도 | 음력 8월 15일 명절 (추석) | pair 5 verbatim, 서울 |
| 태양계에서 가장 큰 행성 | 피를 온몸으로 내보내는 장기 | pair 22 in the other language |
| `len('hello world')`, `f(5)` → 15 | `'abcdef'[1:4]`, `f(6)` → 21 | `len` is a contrast answer, and so is 15 |
| JSON: days in a week / months in a year | letters in the alphabet / sides of a hexagon | 7 is a contrast answer |

What the contrast guard does **not** catch, stated so nobody trusts it further than it goes: the same fact in
another language (목성 vs Jupiter). Those were removed by hand.

**The remaining known weakness, stated rather than hidden.** Arithmetic is a field the contrast set touches
and stratum (a) is required to contain it, so `ctl.far.09` and `ctl.far.10` are the weakest two items in the
set. They are deliberately unlike their contrast pairs — those are single-step and single-digit (7 plus 8,
the square root of 81), these are a two-digit product and a word problem — but "different item, same well" is
a weaker guarantee than the other ten far-domain items carry, and the report should say so.

### Certification is bound to the files it was run against

Both guards return the sha256 of the file they read, and a run should record them. A trainset regenerated
after this set was certified is a set that must be re-certified — as the two hits above show, that is not
hypothetical. If the contrast file is missing, `buildContrastGuard` throws rather than skipping: a control
set that cannot be certified is not a control set.

Report-only, and not enforced: the same check against the **whole** 12,619-fact universe (`facts.jsonl`)
finds two items sharing a word with a complete fact object — `ocean` and `amp`/`ohm` are ERC-20 tickers. It
is report-only because the universe is full of tickers that are ordinary English words (`REAL`, `LOVE`,
`INDEX`, `HAPPY`, `DOG`), so enforcing against it would ban English rather than protect anything. What the
patch wrote is the trainset; if `AMP` is ever trained, rule 2 will fire on `ctl.far.05`.

## Scoring

Verdict vocabulary is `src/normalize.mjs`'s, unchanged: `hit | wrong | ambiguous | abstain | error`.
`answer_type: integer` is delegated to `scoreOne` verbatim, so the study's ambiguity rule applies here too —
a reply of `17 × 23 = 391` scores `ambiguous`, because the first integer in it is not the answer. That is
inherited on purpose rather than quietly relaxed; the prompts say "reply with only the number", and an item
that is `ambiguous` on both sides of the comparison is not damage.

Three answer types are new, because the study has no use for them:

* **`text`** — an `accept` list and a `reject` list of the distractors that matter (Sydney for Canberra,
  왕건 for 이성계, uracil for thymine). Latin terms match on word boundaries, Korean by substring, because
  Hangul is not space-delimited: `accept: ["세종"]` matches 세종, 세종대왕 and 세종 이도. Truth **and** a
  distractor in the same answer is `ambiguous`, exactly as a shotgun address answer is in the study.
  Validation refuses an accept or reject term that already appears in its own question — an item that scores
  itself, or one that fires on a correct verbose answer, is a broken item. It also refuses a one-syllable
  Korean term, because substring matching would fire inside unrelated words: 폐 inside 폐지, 간 inside 시간.
* **`format`** — two independent measurements, never blended: `content_ok` (does it still know the answer)
  and `format_ok` (does it still obey). A hit needs both, and the miss is labelled `format`, `content` or
  `format and content`. "There are 366 days in a leap year" is a **format** miss with the content intact —
  that distinction is the entire point of the stratum. For the JSON item, a ```` ```json ```` fence still
  counts as a hit and the raw-parse strictness is recorded beside it rather than folded in.
* **`refusal`** — the correct answer is a declination. The item's own `refuse_re` is tested **before** its
  `claim_re`, so correcting a false premise ("Physics, in 1921, not Chemistry") scores as a refusal and not
  as damage. A miss is channelled: `confidently_wrong` (it supplied a specific value for something
  unanswerable) or `no_refusal`.

A declination is checked *before* any type-specific rule, in English **and Korean** — `모르겠습니다` on a
Korean integer item must reach `abstain`, not `wrong`, or honesty would be counted as damage.

`system.txt` is the system prompt for this set. It is deliberately not `system-prompts/plain.txt`: that file
opens with "You answer questions about on-chain data" and mandates a bare-value reply, which would make the
capital of Australia off-domain and would measure *its* formatting instruction instead of each item's. What
matters for a paired comparison is that both sides see the same bytes, and they do.

## What the numbers mean

The headline of this set is **not** an accuracy figure. It is a per-item paired comparison on one engine
instance:

```
reference (patch removed) → apply → post (patch applied)      no restart in between
```

`pairItem()` classifies each item as `held`, `regression` (hit before, not after), `repair` (the mirror,
reported beside it so an improvement is never quietly absorbed into "no damage") or `both_miss`. The claim
the product wants — *this patch is safe to apply* — is a regression count of zero with the repair count
printed next to it, per stratum. Because the unit is a pair, an item the base model fails is still a usable
item, and no threshold in this code needs an opinion about how good the base model is.

Repeats follow `src/score.mjs`: an item counts as a hit only if every non-error repeat of it was a hit, and
an item whose repeats disagree is unstable and is reported as such rather than half-credited.

## Running the offline checks

```
export PATH="$HOME/.local/node/bin:$PATH"
node src/locality-control.mjs        # composition, both guards, the sha256s, the report-only universe check
node src/locality-control.test.mjs   # 125 assertions, no GPU, no network, no patch, no server
```

The contrast set lives with the model rather than in this repo
(`/mnt/newdata/qwen3.8/train/teach_contrast.json`); `BENCH_CONTRAST` overrides the path.

## Deferred, and why

* **No answer in this file has been put to the model.** The serving engine on :8002 was in use and about to
  be taken down when the set was written, and :8000/:8001 are off limits. Every expected-answer claim here is
  a ground truth chosen against the selection rule above, not a measured base-model result, and nothing in
  the repo prints one as if it were measured.
* **The live capture is deliberately a single invocation.** The reference must be recorded on the same engine
  instance as the post-apply run, or it inherits exactly the restart confounder the study spends 40 bridge
  items ruling out. The runner that performs it must (a) call `assertNoOverlap()` before its first request,
  (b) capture reference and post-apply without an intervening restart, and (c) refuse to compare across a
  restart it can detect, by comparing `docker inspect` `Cmd` / `RestartCount` / `StartedAt` the way
  `src/run.mjs` already does. `pairItem()` is the comparison it should report, and it should record
  `guard.sha256` and `cguard.sha256` in its provenance so the certification is bound to the files it was made
  against. That runner is not in this file.
* **Requested change, not made here** (`src/normalize.mjs` belongs to another session): export `ABSTAIN` and
  add the Korean declination forms to it. This file carries its own `DECLINE` constant only because the
  module-private one is English-only, and a Korean `모르겠습니다` routed through `scoreOne` would be scored
  `wrong` — counting honesty as damage. Once `ABSTAIN` is exported and bilingual, `DECLINE` should be deleted
  rather than kept in sync.
