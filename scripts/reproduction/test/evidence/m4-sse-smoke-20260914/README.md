# Isolated distributed SSE smoke test — failed load geometry

Executed 2026-09-14 UTC against `test/mock_ainize_sse.py`, not GPU models or a public service. Five mock HTTP servers ran on the container's loopback network. No blockchain transactions were submitted.

- Docker image: `ain-cert-m4:repro-20260911`, image ID `sha256:83473a76f8182166bb634c1e6d67aaa1115c71953a1fcfe8e25da2cea9ced4c3`.
- Runtime: Locust 2.46.0, Python 3.11.2.
- Docker inspected limits: `NanoCpus=4000000000`, `Memory=17179869184`, `MemorySwap=17179869184`, `NetworkMode=none`; PID limit 4096.
- Launcher: `run-m4-inference-locust-240users-60workers.sh`, `DUR=10`, 240 requested users and 60 worker processes.
- Container exit code: **1**. The container and child processes stopped.
- Master observed 137 completed synthetic inference requests, zero request failures. This is transport-test evidence, not model performance.
- Nine membership samples: maximum 228 users, maximum 60 workers, **zero** samples with both 240 users and 60 workers. The final sample had 57 workers and 228 users.
- Master logs reported worker heartbeat losses during the CPU-limited run. The data do not establish a stable 240-user/60-worker measurement window.

The attached CSV and membership JSON are copied from that run. The scenario correctly refused to pass the geometry gate despite successful individual HTTP streams. The installed image also emitted a Python/gevent logging-finalization warning during `locust --version`; that command returned zero. The smoke image is Debian-based, not the required unified Ubuntu deployment image, so it is not infrastructure conformance evidence.

Next validation must address stable load-generator scheduling, worker-level accounting and the specified Ubuntu image before a real Ainize model run. Do not count this failed smoke run as indicator 4 passing or quote its synthetic request rate as inference TPS.
