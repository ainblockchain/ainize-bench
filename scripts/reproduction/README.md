# Training record inclusion latency

Requires Node.js 22 or newer and a reachable AIN JSON-RPC endpoint. This external measurement tool does not add experiment APIs or screens to AINSCAN, launch nodes, or submit transactions.

```sh
bash scripts/reproduction/run-m3-training-record-latency.sh /path/to/m1-latest.json /path/to/m3-result.json
node --test scripts/reproduction/test/m3-training-record-latency.test.js
```

The input JSON must contain `version: 1`, an external evidence label `runId`, `rpcUrl`, `genesisHash`, and exactly 70 distinct entries in `jobs`. Each entry contains `nodeId`, `jobId`, `datasetId`, `path`, `txHash`, and the reported Unix-millisecond submission time `submittedAt`. The path must be `/apps/knowledge/market/lessons/<nodeId>/<jobId>`. Never put credentials in the manifest. Automatic manifest collection from the 70-job runner is not yet connected.

The tool checks genesis identity and each full containing block, then matches the transaction's `SET_VALUE` operation, lesson path, `TRAINING` status, dataset ID and reported submission timestamp. It computes block timestamp minus reported submission timestamp, not finality time or training duration. Clock synchronization and a trustworthy RPC source are prerequisites; these checks do not independently prove the sender's clock or transaction execution success.

Only 70 validated records yield `complete: true` and an `averageMs` value. Missing or mismatched records produce `complete: false`, `averageMs: null`, per-record errors and a nonzero exit status. The denominator never shrinks to the available sample count. Output files are private by default.

Search each result transaction hash in AINSCAN and compare its native Transaction Details fields: Training Job, Dataset, Record Path, Submitted At (reported), Training Record Latency and containing Block. Do not append a Run ID query parameter. No real 70-job performance result is claimed by the synthetic regression tests.
