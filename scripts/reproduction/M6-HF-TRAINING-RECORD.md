# HF import to native training record verification

This read-only step links existing private HF import files and an Ainize job
snapshot to a finalized native READY transaction. It does not import, train,
publish, apply patches, provision resources or retry any previous workload.

## Prepare existing evidence

Use the CLI's existing HF import directory and preserve these files:

- `source.json`: source selection, resolved revision and hash domains.
- `training-submission.json`: admitted job binding saved before waiting.
- Original downloaded input and mapped upload bytes, named by that import.
- A freshly downloaded canonical dataset JSONL file.
- JSON output from `ainize teach status <job-id> --json` on the same node.

For example, after the existing job reaches READY:

```sh
umask 077
ainize --node <node-url> teach dataset get <dataset-id> --format jsonl --out canonical.jsonl --json > dataset-download.json
ainize --node <node-url> teach status <job-id> --json > job-status.json
```

Use the dataset owner's existing teaching identity where required. Do not start
another job to obtain a missing receipt. The status must include exactly one
submitted READY receipt in `job.chain_submissions`. A TRAINING transaction or
an arbitrary latest transaction is not substituted. The selected READY record
must contain the dataset SHA-256 and reported model/backend fields; old records
without those fields cannot prove this binding.

## Run

Create a private manifest using absolute paths and the independently selected
RPC endpoint, expected chain genesis hash and publisher address:

```json
{
  "version": 1,
  "rpcUrl": "http://127.0.0.1:8081/json-rpc",
  "genesisHash": "<expected 0x-prefixed 64-hex genesis hash>",
  "publisher": "<0x-prefixed 40-hex publisher address>",
  "files": {
    "source": "/private/import/source.json",
    "receipt": "/private/import/training-submission.json",
    "input": "/private/import/input.jsonl",
    "upload": "/private/import/data.jsonl",
    "canonical": "/private/canonical.jsonl",
    "status": "/private/job-status.json"
  }
}
```

Input/upload names are examples, not a naming convention. Use the actual import
files. Node.js with built-in fetch and Docker-independent access to the selected
RPC are required. No Ainize web API is used.

```sh
bash scripts/reproduction/run-m6-verify-huggingface-training-record.sh /private/evidence.json /private/new-binding-result.json
```

## Interpretation and AINSCAN

The verifier checks source metadata, input/upload/canonical hashes, accepted row
count, destination node, admitted job and dataset binding, the READY submission
path and clock, successful finalized execution, sender, and full-block membership.
It re-reads the containing block and genesis to detect a change during the check.
The RPC remains a trust assumption; this is not an independent consensus client.

A successful result supplies `txHash`, `path`, block number/hash, dataset ID/hash,
reported model/backend, trained row count and submission-to-inclusion latency.
Search that transaction hash in ordinary AINSCAN **Transactions**, configured for
the same chain. Compare its Training Record fields and containing block. Do not
add an experiment endpoint or Run ID to the explorer URL.

`bindingVerified: true` is deliberately separate from `integrationVerified: false`.
Even a matching stub READY write cannot prove real GPU training. Source hashes
bind retained files, not an independently authenticated HF repository; reported
model IDs do not prove loaded weight revisions. Complete metric 6 still requires
the original import selection checks, real training/checks, the resulting patch
applied to the compatible model, and completed inference for the selected dataset
questions. Do not count this verifier's successful files as integrated datasets.

Only successful binding results are written, with mode 0600 and no overwrite.
Failure exits nonzero and writes no successful result. No raw questions, answers,
key paths or endpoint URLs are copied into the result. Repository names and hashes
can still identify private sources; review before sharing. Files are limited to
64 MiB each and credentials/query strings in RPC/node endpoints are rejected.

## Tests

```sh
node --test scripts/reproduction/test/verify-hf-training-record.test.js
```

Tests use synthetic receipts and controlled RPC responses, including the actual
shell entrypoint against a local HTTP fixture. They check tampering, crossed
dataset/job/node bindings, missing and ambiguous receipts, failed/unfinalized
writes, wrong block membership, sender/clock mismatches, chain changes, private
output handling and the separation from full model/dataset integration. They do
not constitute a live HF-to-GPU-to-blockchain experiment.

On 2026-09-14, all 27 verifier tests and all 19 existing JavaScript reproduction
regression tests passed (46 total). Shell syntax and whitespace checks passed.
No cloud resources or public blockchain writes were used for these tests.
