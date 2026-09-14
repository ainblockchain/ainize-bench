# Distributed worker evidence smoke check

Executed on 2026-09-14 with the real Locust master/worker processes and a synthetic
local SSE server. One worker and one user completed 34 receipt-bearing requests.
The smoke script verified the actual master membership ID against the worker
identity, the exact receipt-file SHA-256, cumulative request counters and receipt
count. Geometry correctly failed: this is not a 240-user / 60-worker result,
GPU inference, chain reconciliation or a TPS performance claim.

Docker image: `sha256:719422870894863760cbea792105359b65a0669bfb9721f90b06459dd34f4176`
(Ubuntu 22.04.5 / Locust 2.46.0). Limits: 2 CPUs, 2 GiB memory with no additional
swap, 256 PIDs, network disabled, host UID/GID, repository read-only and output
directory writable. The container was removed after completion.

Reproduce with `test/run-m4-receipt-smoke.sh` relative to `scripts/reproduction`
inside that resource-limited image, passing a new writable output directory.
The script expects the Locust master to exit 1 for the insufficient geometry;
the smoke script itself exits 0 only after checking the evidence bindings.
