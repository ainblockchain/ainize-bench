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

Build the Ubuntu 22.04 load-generator image and record its resulting image ID and `locust --version`:

```sh
docker build -f scripts/reproduction/Dockerfile.locust -t ainize-locust:ubuntu22.04-2.46.0 scripts/reproduction
docker image inspect ainize-locust:ubuntu22.04-2.46.0 --format '{{.Id}}'
```

The base image digest and Locust version are pinned. Ubuntu security packages and transitive Python dependencies are not yet locked, so archive the built image for exact binary reproduction. The script requires a container; launch it with the common procedure's explicit CPU, memory and network limits, mounting this repository, target JSON, token files read-only, and an output directory. It does not start or change the common blockchain/GPU nodes. Full integration validation of the Ubuntu image remains pending.

The image has built successfully and reports Ubuntu 22.04.5, Python 3.10.12 and Locust 2.46.0. Nine parser/geometry unit tests passed inside a network-isolated 2-CPU/1-GiB container. See [image validation evidence](test/evidence/ubuntu-locust-image-20260914.json); the Python/gevent finalization warning remains recorded. This is not a distributed-load pass.

Inside that resource-limited container:

```sh
AINIZE_TARGETS=/private/targets.json M4_EVIDENCE_DIR=/results/new-run DUR=60 bash scripts/reproduction/run-m4-inference-locust-240users-60workers.sh
```

For a Linux Docker host, the equivalent explicit resource-limited invocation is:

```sh
docker run --rm --init --user "$(id -u):$(id -g)" \
  --cpus 8 --memory 16g --memory-swap 16g --pids-limit 4096 --network host \
  -v "$PWD:/bench:ro" -v /host/private:/private:ro -v /host/results:/results \
  -e AINIZE_TARGETS=/private/targets.json -e M4_EVIDENCE_DIR=/results/new-run \
  -e DUR=60 -e M4_STABLE_SECONDS=30 \
  ainize-locust:ubuntu22.04-2.46.0 \
  bash scripts/reproduction/run-m4-inference-locust-240users-60workers.sh
```

Replace host mount paths, ensure the output mount is writable by the chosen UID, and record the actual cgroup limits and built image ID. Eight CPUs and 16 GiB here define the load generator only, not the blockchain or GPU-node capacity, and are not a guarantee of stable load. The isolated synthetic smoke uses `--network none` instead of accessing real nodes.

The output directory must not already exist. The launcher starts 60 worker processes and one master with 240 users total, not per worker, following [Locust distributed execution](https://docs.locust.io/en/stable/running-distributed.html). Only its own child processes are cleaned up. `-r 240` is the user spawn rate, not a TPS target. Streams have a 300-second total deadline; shutdown permits active requests to finish. Do not run concurrent launchers sharing master port 5557.

## Evidence and current limits

Monitor `master.log` and `locust_stats_history.csv`; inspect `locust_stats.csv` and `locust_failures.csv` afterwards. Locust total request count includes failures: successful inference count is requests minus failures. Use the actual measured time window, not the configured duration when ramp-up or shutdown extends it. Token throughput, inference requests and blockchain transactions are different units.

`membership.json` samples each worker identity, state and reported user count once per second. `geometry.json` requires the same 60 workers, each reporting four users and a running state, for at least 30 seconds by default. Replacement, loss, misdistribution, backward clocks and observation gaps over 2.5 seconds break the window. `M4_STABLE_SECONDS` explicitly selects a different minimum for a separately specified test; do not lower it afterwards just to turn a failed run into a pass. The selected window measures observed stability, not unseen activity between samples. A missing valid window produces nonzero master exit. Worker request-statistics reconciliation, final sustained-window TPS calculation and native on-chain usage/anchor reconciliation are not yet connected in this new scenario. No 240-user/60-worker performance claim is made until those checks and a real run succeed. The old vLLM-only runner is not evidence for this scenario.

Parser regressions run without GPUs: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/reproduction/test -p 'test_*.py'`.

An isolated Docker run of 60 real Locust worker processes against five synthetic SSE servers has now been executed. It completed 137 synthetic requests but failed the 240-user/60-worker geometry gate and exited nonzero. See [the recorded failure and raw evidence](test/evidence/m4-sse-smoke-20260914/README.md). This verifies transport execution and failure handling, not the required model throughput or Ubuntu infrastructure.
