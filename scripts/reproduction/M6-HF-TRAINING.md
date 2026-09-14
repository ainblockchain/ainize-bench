# Run an existing node's actual HF teaching pipeline

This launcher runs the real CLI against an already configured Ainize node. It
does not provision, restart or reconfigure a GPU worker, serving model or ledger.
Complete the common environment setup first. Check the node's teaching policy,
runtime queue, active patches and allocated resources before starting.
The launcher requires Node.js 22+ on the host for its read-only preflight. It
refuses disabled, non-gradient, busy or unavailable nodes and applied patches;
the node's own resource locks remain responsible for races after this snapshot.

```sh
export AINIZE_CLI_SOURCE=/absolute/path/to/ainize-cli
export AINIZE_CLI_IMAGE=sha256:52e634617c0fad0207eeba4262ecdf142fc886649253ac42e4730ce75bd04dd5
export AINIZE_NODE_URL=http://127.0.0.1:3410
bash scripts/reproduction/run-m6-huggingface-training.sh \
  /private/new-output \
  https://huggingface.co/datasets/Minhyun/ainize-dart100-reproduction-20260911 \
  9a523ed3268688e90ee18f1ecd93f4fb72a8f056 \
  data/dart-001-company_ceo_nm.jsonl
```

Use your actual node endpoint and a locally available pinned Node 24 image. The
example is one existing public DART selection containing eight rows. It does not
publish anything to HF and is not a 100-dataset test. No HF access token is used.
Only use sources that may be processed under the target node's publishing policy;
the launcher does not change that policy or bypass PII/rights/quality checks.

The client has CPU=1, memory=2 GiB, no additional swap, no GPU devices and no
Docker socket. It uses host networking to reach the existing node. These are
client limits, not the GPU worker specifications: retain the actual node/model
Docker limits separately. The CLI source is read-only; private output is writable.

The command is `ainize dataset <url> --revision <sha> --file <file> --train --wait
--timeout 60 --effort balanced --json`. It preserves normal training and locality
checks. The importer saves admission evidence before waiting; the server job can
continue even if the client exits or times out. The output directory contains:

- CLI commit/status, source selection and client Docker limits.
- `cli-home/hf-imports/import-*/training-submission.json`, when admission was
  acknowledged, plus the original import evidence.
- `cli.stdout`, `cli.stderr` and `client-result.json` after client termination.

The private CLI home contains a generated teaching key. Keep it to inspect or
cancel that exact job; never publish the directory wholesale. Do not rerun the
launcher to recover an unknown result. Use the admitted Job ID and the same home:

```sh
ainize --home /private/new-output/cli-home --node <node-url> teach status <job-id> --json
```

CLI receipt file paths were recorded inside the controller under `/evidence`;
on the host that prefix corresponds to the output directory. A timeout stops
only the client container, not the admitted server job. Cleanup removes only
this launcher's container and never deletes server locks or cancels training.

Record the real backend, job outcome, check results, artifact/model bindings,
patch application and completed inference separately. `integrationVerified`
stays false in the launcher result. An exit-zero wait is not the full metric 6
gate. If the existing node uses a local ledger, its run does not provide an AIN
transaction; do not invent a path or treat that run as explorer evidence. On a
properly configured AIN-ledger node, continue with
[HF training record verification](M6-HF-TRAINING-RECORD.md) and actual inference.

## Launcher regression checks

```sh
node --test scripts/reproduction/test/hf-training-preflight.test.js
```

The controlled HTTP/Docker fixture checks that stub, queued, applied-patch and
active-runtime states fail after read-only requests, before creating a client,
teaching key or training job. On 2026-09-14 this check and the existing JavaScript
reproduction suite passed (47 tests total). These are launcher safety checks,
not evidence of a finished real training job or metric completion.
