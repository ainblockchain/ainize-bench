# Calculate receipt-backed inference throughput

After the load runner has stopped cleanly and receipt-to-chain reconciliation
has completed, run this read-only calculation from the repository root:

```sh
bash scripts/reproduction/run-m4-calculate-inference-throughput.sh \
  /path/to/load-evidence /path/to/reconciliation.json /path/to/new-throughput.json
```

Requires Python 3.10 or later; no third-party Python packages. The output must
not exist and its parent must exist. It is created with mode 0600. Inputs are
bounded to 64 MiB per file and 128 MiB in total. No nodes are provisioned, training
started, RPC called, transactions submitted or model APIs invoked by this step.

## Evidence gates

- Exactly 60 worker identities, summaries and receipt JSONL files, numbered 0–59.
  Each summary must match its identity, file hash, receipt count and cumulative
  local success/failure counters. Receipts must lie within that worker's lifetime
  and have distinct node/receipt-ID pairs across all workers.
- The `ainize/chat` and `Aggregated` rows in `locust_stats.csv` must both match
  the sums of worker request and failure counters. Missing final master reports
  are not repaired by copying worker totals into the CSV.
- The supplied successful reconciliation must match every client's node URL,
  receipt ID and completion timestamp exactly, with coverage of five nodes.
  Generate it with `run-m4-reconcile-inference-receipts.sh` against the expected
  chain. This calculator trusts that local report; it does not independently
  repeat chain verification or authenticate edited evidence files.
- Recalculate geometry from `membership.json`, not the saved geometry verdict.
  Select the longest contiguous observed interval with the same 60 workers, each
  running four users, total 240 users, no sample gap over 2.5 seconds and at least
  30 seconds duration. Ties retain the first interval. The actual membership IDs
  must match the receipt-file identities, whose lifetimes cover the interval.

## Numerator and denominator

`successful_requests_per_second` is the count of receipt-backed client completions
whose timestamp is in **[start, end)** divided by that interval's seconds. The
window is selected from membership only, never by maximizing measured throughput.
Completions during ramp-up or shutdown are excluded. Requests begun before the
window but completed inside it count; completions exactly at its end do not.
Do not divide all-run completions by the shorter stable duration. All-run request,
success and failure counts are reported separately; they are not window-specific
failure rates. The master and all workers must share a clock, as they do in the
provided single-container launcher; this does not synchronize server clocks.

`complete: true` means these evidence gates passed, not a target TPS was achieved,
not five physically independent GPUs were proven, and not model quality was
verified. Insufficient stable geometry yields a null rate and exit 1. Malformed,
missing or mismatched evidence exits nonzero without a successful report.

This is **inference request throughput**, not blockchain transaction throughput.
AINSCAN continues to show the actual native inference-batch transactions and their
sender-reported batch intervals. Use the reconciliation's transaction hashes in
its normal search. No experiment screen, API or run ID is added to the explorer.

Validation: `python3 -m unittest discover -s scripts/reproduction/test -p 'test_*.py'`.
Calculator tests use synthetic evidence, including the real shell entrypoint and
file permissions. They are not a 240-user GPU performance result.
