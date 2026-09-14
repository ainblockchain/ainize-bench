# Ainize node streaming inference load

This scenario calls the five GPU nodes' native `POST /api/chat` directly. It does not call ainize-web or bypass Ainize to call vLLM. Use the node release containing SSE support and already held, compatible knowledge patches. No training or purchase is performed here.

The Locust scenario uses `User` with a requests session and fires one request event after consuming the entire stream, following [Locust's custom client guidance](https://docs.locust.io/en/stable/testing-other-systems.html). A successful sample requires the patched answer for the requested knowledge, model identity, a normal finish reason, the `ainize.result` event and `[DONE]`. Empty, truncated, failed and interrupted responses are failures, not TPS successes. Each request performs one patched inference, not a base/patched comparison.

## Configuration

Prepare a JSON array of exactly five distinct node assignments:

```json
[
  {"nodeUrl":"https://gpu-node-1.example","patchId":"held-knowledge","prompt":"Your benchmark question","tokenFile":"/private/node-1.token"}
]
```

The example shows one entry; supply all five real nodes. The optional `tokenFile` is a private file containing an existing legitimate node bearer session token, not a teaching private key. It must be readable inside the container. Without it requests remain anonymous and normal quotas apply. Do not disable authentication or spoof forwarded IPs. Review the actual role/quota configuration and use approved identities. Tokens and prompts are not written into request event metadata.

Install Locust and requests in the Docker load-generator image and record the exact image digest and `locust --version`. The script requires a container; launch it with the common procedure's explicit CPU, memory and network limits, mounting this repository, target JSON, token files read-only, and an output directory. It does not start or change the common blockchain/GPU nodes. Dependency-image pinning and full Docker integration validation remain pending.

Inside that resource-limited container:

```sh
AINIZE_TARGETS=/private/targets.json M4_EVIDENCE_DIR=/results/new-run DUR=60 bash scripts/reproduction/run-m4-inference-locust-240users-60workers.sh
```

The output directory must not already exist. The launcher starts 60 worker processes and one master with 240 users total, not per worker, following [Locust distributed execution](https://docs.locust.io/en/stable/running-distributed.html). Only its own child processes are cleaned up. `-r 240` is the user spawn rate, not a TPS target. Streams have a 300-second total deadline; shutdown permits active requests to finish. Do not run concurrent launchers sharing master port 5557.

## Evidence and current limits

Monitor `master.log` and `locust_stats_history.csv`; inspect `locust_stats.csv` and `locust_failures.csv` afterwards. Locust total request count includes failures: successful inference count is requests minus failures. Use the actual measured time window, not the configured duration when ramp-up or shutdown extends it. Token throughput, inference requests and blockchain transactions are different units.

`membership.json` samples master-observed user/worker counts once per second. Missing any observation of 240 users and 60 workers produces a nonzero master exit; one matching observation alone does not prove stable distribution for the whole test. Per-worker reconciliation, final sustained-window TPS verification and native on-chain usage/anchor reconciliation are not yet connected in this new scenario. No 240-user/60-worker performance claim is made until those checks and a real run succeed. The old vLLM-only runner is not evidence for this scenario.

Parser regressions run without GPUs: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/reproduction/test -p 'test_*.py'`.
