# Side effects — all four cells

> **PARTIAL SET — 4 of 50 prompts; this is a smoke run, not the 50-prompt measurement**
> **CELLS C and D NOT CAPTURED — this is a partial table; run with --patch <id> for C and D**

Prompt set: `locality/prompts.jsonl` — 50 prompts, sha256 `475ce1d72e40` (the hash is of the whole file). **This capture asked 4 of them** ({"stratum":"far-domain","limit":"4"}), so it is a smoke run and not the measurement.
Scored against the base model's own answers (README §6), never against gold labels. Key: `scored`.
0 of 4 prompts were unstable in the reference cell and are excluded from every cell; the denominator is 4.

| | no tools | The Graph MCP declared, never needed |
|---|---|---|
| **base model** | **A** 4/4 same (100.0%) | **B** 3/4 same (75.0%) |
| **knowledge applied** | _not captured_ | _not captured_ |

Cell A is the reference and is 100% by construction — it is printed so the table has four cells and so the
reader can see that the reference exists rather than being asserted.

| cell | tools | patch | n | same | changed | agreement | 95% CI | tool calls |
|---|---|---|---|---|---|---|---|---|
| A | none | base | 4 | 4 | 0 | 100.0% | 51.0%–100.0% | 0 |
| B | declared | base | 4 | 3 | 1 | 75.0% | 30.1%–95.4% | 0 |
| C | | | _not captured_ | | | | | |
| D | | | _not captured_ | | | | | |

### What each comparison answers

- **B vs A** — does DECLARING tools, on prompts that never need them, change unrelated answers? This is the
  cell README §6 requires and the reason the write-up must not say tool calling has no analogue here.
- **C vs A** — the Ainize claim: loading the knowledge does not change unrelated answers.
- **D vs A** — both at once, which is the configuration a buyer would actually ship.
- **B vs C** — if declaring tools perturbs as much as applying the knowledge does, neither party gets to
  call the other's number a side effect.

### Every changed answer, in full (1)

**B · ctl.far.04** (far-domain)

```
reference: Nile
B answer: The
```

### Per stratum

| stratum | A | B | C | D |
|---|---|---|---|---|
| far-domain | 4/4 | 3/4 | — | — |

### What this table cannot see

- 4 prompts on one model at one temperature. A flat table means no damage was detected AT
  THIS RESOLUTION, which is not the same as none. The per-stratum counts are small enough that a single
  changed answer sits inside the reference cell's own noise, and that is a property of n.
- The reference is the base model's answer, not a correct answer. A cell can agree perfectly with a
  reference that was wrong; the gold truths in the prompt set are reported beside these numbers and never
  folded into them.
- Cells B and D declare the real MCP schemas. A different tool surface is a different experiment.
