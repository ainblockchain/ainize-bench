# Failed 60-worker distributed smoke test

Executed 2026-09-14, starting 02:58:14 UTC. This used actual Locust 2.46.0
master/worker processes in Ubuntu 22.04.5, with five synthetic local SSE endpoints.
It used no GPU, external network, blockchain writes or AWS infrastructure.

- All 60 worker identities, receipt counts and exact file hashes were checked by
  `test/run-m4-distributed-smoke.sh` before it returned exit 1.
- Stable 240-user / 60-worker interval: **0 seconds**. None of the 59 membership
  samples reported exactly 240 users; maximum reported users was 352.
- Worker summaries: 3,113 successful requests and 1,307 failed requests (4,420 total).
- Final master CSV: 4,216 requests, including 1,211 failures. These counts do not
  reconcile with worker totals and must not be substituted for them.
- The master log reported missing heartbeats and worker recovery. During the run,
  the shared host reported a load average near 80 across eight visible CPUs.
  This observation alone does not isolate the cause of all failures.

No M4 TPS result is accepted. The CSV Requests/s column is an all-run Locust
statistic, not a passing stable-window result and not real GPU throughput.
Neither geometry thresholds nor heartbeat settings were relaxed to make it pass.

`docker.json` records the actual image and limits: 4 CPUs, 16 GiB RAM, no additional
swap, 1,024 PIDs, network disabled. The container was removed on completion;
unrelated running services were not stopped or reconfigured.

Raw membership, final/history CSVs and all worker summaries are preserved here.
CSV line endings are normalized to LF. Individual synthetic receipt JSONL files
remain in the local output directory, not in this evidence subset:
`/mnt/newdata/gov/kpi/results/m4-receipt-smoke-parent/distributed-20260914-0320/load`.
The summaries retain their byte hashes; this committed subset alone cannot
independently recheck every receipt byte. There is no chain reconciliation report.

Reproduce inside the resource-limited Locust image with the repository mounted
read-only and a writable output parent:

```sh
bash scripts/reproduction/test/run-m4-distributed-smoke.sh /output/new-check
```

The script launches the same 240-user / 60-worker runner for 70 seconds, preserves
failure evidence and returns nonzero when geometry or the runner fails. It is a
synthetic harness check, not the real five-GPU experiment.
