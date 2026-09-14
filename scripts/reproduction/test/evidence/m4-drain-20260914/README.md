# Graceful Locust drain smoke check

Real Locust master/worker processes, one synthetic SSE server assignment per
request, one worker and one user. Executed on 2026-09-14 with a three-second
run time and `M4_SYNTHETIC_DELAY_SECONDS=5`.

The master requested stop at **03:05:34.597 UTC**. The in-flight client request
completed at **03:05:37.015 UTC**, after stop was requested. The worker reported
stopped at 03:05:37.017, and the master quit at 03:05:42.600. Both the final master
CSV and worker summary count one successful request and zero failures. The exact
receipt bytes and digest are included. CSV line endings are normalized to LF.

This verifies draining a request that outlives the configured run duration and
collecting its final statistics with the supported autostart/autoquit lifecycle.
It does not prove final-report delivery under arbitrary overload, fix the earlier
352-user overshoot, or pass 240-user / 60-worker geometry. Geometry correctly
remained false and the smoke script expected that nonzero master exit.

Container invocation used image
`sha256:719422870894863760cbea792105359b65a0669bfb9721f90b06459dd34f4176`
(Ubuntu 22.04.5 / Locust 2.46.0), 2 CPUs, 2 GiB memory with no additional swap,
256 PIDs, network disabled, host UID/GID, read-only repository and writable output.
The container was removed after completion; no GPU or blockchain was invoked.

Reproduce inside that image using a fresh output directory:

```sh
M4_SYNTHETIC_DELAY_SECONDS=5 bash scripts/reproduction/test/run-m4-receipt-smoke.sh /output/new-drain-check
```
