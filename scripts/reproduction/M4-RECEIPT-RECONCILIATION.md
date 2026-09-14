# Client receipts to native AIN transactions

This read-only step joins the Locust worker evidence to the node's exported
receipts and native blockchain transactions. It neither submits nor retries a
transaction, and does not add an experiment API or run ID to AINSCAN.

## Collect the inputs

1. Preserve all 60 `inference-receipts-worker-<index>.jsonl` files from the same
   load run. A file must end with a newline if nonempty. Never copy one worker's
   file under another name to fill a missing file.
   Keep the corresponding `worker-identity-<index>.json` and
   `worker-summary-<index>.json` files as well. The identity binds the filename
   index to the actual Locust `client_id` used in `membership.json`. On orderly
   shutdown, the summary records cumulative local request-event successes and
   failures, the receipt count and the SHA-256 of the exact JSONL bytes. A missing
   summary, changed digest, unmatched worker identity or count mismatch leaves
   worker evidence incomplete; do not reconstruct a missing summary from counts
   reported by another process. These are local evidence bindings, not signatures
   or proof that distinct URLs represent independent GPU hardware.
2. Record the five actual node URLs and their five distinct AIN addresses. Obtain
   the expected genesis hash from the agreed chain configuration, not from an
   arbitrary replacement endpoint after the test.
3. As each node's operator, inspect `ainize --node <url> ledger inference --json`
   and page through retained batches. Export every batch needed to cover the
   client receipts after its state becomes `submitted`:

   ```sh
   umask 077
   ainize --node <url> ledger inference <local-batch-id> --receipts --json > batch-001.json
   ```

   Use one batch per file. An unconfirmed batch is not repaired by this verifier;
   reconcile the original submission before any operator-authorized retry.
   `receipt_commitment_valid` supplied by the API is not trusted: the verifier
   recomputes the commitment independently from the actual array.

Prepare `manifest.json` with these fields (replace placeholders and include all
five nodes, all sixty distinct worker files and all required batch exports):

```json
{
  "version": 1,
  "rpcUrl": "http://your-chain-node:8081/json-rpc",
  "genesisHash": "<expected 0x-prefixed 32-byte genesis hash>",
  "nodes": [
    {"url": "https://gpu-node-1.example", "address": "<node-1 AIN address>"}
  ],
  "clientFiles": ["load/inference-receipts-worker-0.jsonl"],
  "batchFiles": [
    {"nodeUrl": "https://gpu-node-1.example", "file": "batch-001.json"}
  ]
}
```

Paths resolve relative to the manifest file. Each file is capped at 64 MiB and
the aggregate input at 128 MiB; exceeding a cap fails rather than truncating
evidence. The sixty client filenames can be generated without renaming files:
`Array.from({length: 60}, (_, index) => 'load/inference-receipts-worker-' + index + '.jsonl')`.
The one-entry arrays above illustrate the format, not a runnable five-node test.

## Verify

From this repository, with Node 22 or later and an existing output parent directory:

```sh
bash scripts/reproduction/run-m4-reconcile-inference-receipts.sh manifest.json new-reconciliation.json
```

The output file must not exist; it is created with mode 0600. The command calls
only `ain_getBlockByNumber` and `ain_getTransactionByHash`. It validates:

- The expected genesis hash and URL-to-signer mapping for all five nodes.
- Unique client receipts with valid client observation clocks and exact receipt
  fields; it does not assume synchronized client/server clocks.
- Submitted batch metadata, unique transaction hashes, receipt uniqueness,
  receipt count, model, server interval, SHA-256 commitment and content-addressed path.
- RPC-confirmed successful execution (`receipt.code=0`, `is_executed=true`) and
  finalization, followed by exact membership in the full containing block.
- The transaction signer, native `SET_VALUE` path and full batch value.
- An unchanged containing block hash at a final read.

Each matched client receives a transaction hash, path, block number and block
hash in the result. All clients must match and all five nodes must be covered.
Missing receipts, altered values, duplicate exports, failed execution, absent
finalization or changing blocks prevent `complete=true` and produce exit 1.
Input/transport failures can exit before an output file is written. The configured
RPC is trusted for chain/consensus status; this is not an independent consensus
client or a substitute for verifying the endpoint's chain configuration.

## Interpret and inspect in AINSCAN

`complete=true` means **receipt-to-chain reconciliation only**. It does not mean
240 users / 60 workers were sustained or a target TPS was reached. Sixty files
alone cannot prove sixty workers ran. Worker statistics, stable membership and
the selected throughput interval must still be reconciled separately. Server
batches may contain other clients' receipts; those extra receipts are never added
to the measured client count. No inference TPS is invented from a batch sequence.
The chain reconciliation command does not yet verify the worker identity or
summary files. Their presence is not a performance verdict; stable-window TPS
must use completed client requests within that window, not all-run successes
divided by the shorter stable-window duration.
Use the separate [throughput calculator](M4-THROUGHPUT.md) to validate worker
bindings, cumulative master counts and stable membership before computing that rate.

Use each returned transaction hash in the normal transaction search of AINSCAN
configured for this same chain, or inspect its returned path in the database
browser. A public explorer on a different chain cannot show a local test's hashes.
No `runId` query parameter or Experiments section is required.

Validation: `node --test scripts/reproduction/test/reconcile-inference-receipts.test.js`.
Tests use synthetic five-node inputs and a mock RPC, including the actual shell
entrypoint with sixty files. They test rejection and joining behavior, not a real
five-GPU run, its performance or public deployment.
