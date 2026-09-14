# Training record inclusion latency

For metric 6's existing HF import files → dataset/job → native READY transaction
binding, see [HF training record verification](M6-HF-TRAINING-RECORD.md) and
`run-m6-verify-huggingface-training-record.sh`. It is read-only and reports binding
verification separately from real training, patch application and inference.

Requires Node.js 22 or newer and a reachable AIN JSON-RPC endpoint. This external measurement tool does not add experiment APIs or screens to AINSCAN, launch nodes, or submit transactions.

Genesis identity reads explicitly request full transactions. This avoids an older
node's hash-only genesis projection that mutated its cached transaction bodies;
the same safety flag is used if block zero needs a final identity recheck. Upgrade
affected nodes to the non-mutating block RPC implementation as well. This client
compatibility measure does not restore an already-corrupted running cache.

```sh
bash scripts/reproduction/run-m3-training-record-latency.sh /path/to/m1-latest.json /path/to/m3-result.json
node --test scripts/reproduction/test/m3-training-record-latency.test.js
```

The input JSON must contain `version: 1`, an external evidence label `runId`, `rpcUrl`, `genesisHash`, and exactly 70 distinct entries in `jobs`. Each entry contains `nodeId`, `jobId`, `datasetId`, `path`, `txHash`, and the reported Unix-millisecond submission time `submittedAt`. The path must be `/apps/knowledge/market/lessons/<nodeId>/<jobId>`. Never put credentials in the manifest.

## Collect from existing lessons

With the updated node and CLI, the manifest can be generated from 70 existing jobs without starting training again:

```sh
M1_TARGETS=/path/to/targets.json bash scripts/reproduction/run-m3-training-record-latency.sh /path/to/new-manifest.json /path/to/m3-result.json
```

The target list has `version: 1`, `runId`, `rpcUrl`, the expected `genesisHash`, and a `targets` array of exactly 70 entries. Each entry has `nodeUrl`, `jobId` and optionally an absolute `keyFile` path for the owner's teaching identity. Without `keyFile`, the CLI uses its existing teaching identity. Use real existing job IDs, not dataset IDs. The parallel launcher below writes this target list automatically when all 70 submissions are acknowledged with distinct job IDs.

The collector invokes only `ainize --node <nodeUrl> teach status <jobId> --json`, with `--key-file` when provided. `AINIZE_BIN` can select an absolute executable path (not a shell command). It requires the owned dataset-backed job and its submitted `TRAINING` receipt. A later `READY` receipt is never substituted. The generated manifest includes no key paths or questions. Collection stops on missing or ambiguous evidence and refuses to overwrite an existing manifest; choose a new output path for another collection. The subsequent chain verifier checks genesis identity and actual inclusion. Collection alone proves neither inclusion nor 70-way concurrency.

Run all collector and measurement regression tests with `node --test scripts/reproduction/test/*.test.js`.

## Launch 70 teaching requests

Use the already running blockchain and GPU nodes from the common setup. Prepare 70 uploaded datasets, their owning teaching keys, and sufficient legitimate node quotas/trainer capacity. This launcher changes no resource limits or quotas and does not provision AWS infrastructure.

```sh
bash scripts/reproduction/run-m1-70-parallel-training.sh /path/to/datasets.json /path/to/new-evidence-directory
```

`datasets.json` contains `version: 1`, `runId`, `rpcUrl`, expected `genesisHash`, and exactly 70 distinct dataset assignments in `datasets`. Each assignment has `nodeUrl`, `datasetId` (the existing UUID), `keyFile` (an absolute path to a private, already created teaching key file), and optional `effort` (`quick`, `balanced`, or `thorough`). Assign datasets to the correct GPU nodes; the launcher does not move them between nodes. Existing keys prevent concurrent first-use key creation races.

The launcher starts 70 `ainize --node <url> teach <dataset-id> --key-file <path> --effort <effort> --json` processes without awaiting one before starting the next. It intentionally does not use `--wait`. The fresh evidence directory receives an individual `submission-<index>.json` for each observed response, a `submissions.json` summary, and, only after 70 distinct accepted jobs, `targets.json` for the collector. Files use mode 600 and the directory mode 700. `targets.json` includes local key file paths, not key values; do not publish it without reviewing local path privacy.

Timeouts and CLI errors are marked `unconfirmed` and are never automatically retried: a server may have accepted the request before the response was lost. Reconcile these with `ainize teach jobs` using the corresponding identity. A partially accepted launch is not cancelled by this script; let it finish or use the node's normal cancellation controls. Never rerun the entire submission command to recover an ambiguous response.

After the original jobs have persisted their `TRAINING` receipts, run collection and measurement without submitting new training:

```sh
M1_TARGETS=/path/to/new-evidence-directory/targets.json bash scripts/reproduction/run-m3-training-record-latency.sh /path/to/new-manifest.json /path/to/m3-result.json
```

`submissionComplete: true` means 70 distinct job acknowledgements, not 70 simultaneous GPU training operations. `trainingConcurrencyVerified` remains false until separate actual start/end evidence proves overlap. Dashboard visibility, actual training concurrency, final model results and real-chain measurements still need runtime verification; mocked launcher tests are not performance evidence.

The tool checks genesis identity and each full containing block, then matches the transaction's `SET_VALUE` operation, lesson path, `TRAINING` status, dataset ID and reported submission timestamp. It also requires the RPC transaction result to report `is_executed: true`, `is_finalized: true` and `receipt.code: 0`; failed writes cannot establish a training record. Before computing the average it re-reads containing block identities and rejects changed or unavailable blocks. Finalization is an evidence gate only: the measured interval remains block timestamp minus reported submission timestamp, not finality time or training duration. Clock synchronization and a trustworthy RPC source are prerequisites; these checks do not independently prove the sender's clock or validate consensus without that RPC.

Only 70 validated records yield `complete: true` and an `averageMs` value. Missing or mismatched records produce `complete: false`, `averageMs: null`, per-record errors and a nonzero exit status. The denominator never shrinks to the available sample count. Output files are private by default.

Search each result transaction hash in AINSCAN and compare its native Transaction Details fields: Training Job, Dataset, Record Path, Submitted At (reported), Training Record Latency and containing Block. Do not append a Run ID query parameter. No real 70-job performance result is claimed by the synthetic regression tests.
