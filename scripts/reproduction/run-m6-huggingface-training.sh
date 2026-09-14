#!/usr/bin/env bash
set -euo pipefail
OUTPUT=${1:?New private output directory required}
DATASET=${2:?Hugging Face dataset repository URL required}
REVISION=${3:?Immutable source revision required}
FILE=${4:?Source file path within the revision required}
CLI=${AINIZE_CLI_SOURCE:?Absolute CLI checkout with dependencies required}
IMAGE=${AINIZE_CLI_IMAGE:?Pinned local Node 24 image ID required}
: "${AINIZE_NODE_URL:?Existing Ainize node URL required}"
[[ "$IMAGE" =~ ^sha256:[a-f0-9]{64}$ && "$CLI" = /* && -f "$CLI/src/bin.ts" ]]
[[ "$REVISION" =~ ^[a-f0-9]{40}$ && "$DATASET" =~ ^https://huggingface.co/datasets/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$ ]]
[[ -n "$FILE" && "$FILE" != /* && ! -e "$OUTPUT" ]]
docker image inspect "$IMAGE" >/dev/null
umask 077
mkdir -p "$OUTPUT"
OUTPUT=$(cd "$OUTPUT" && pwd)
node - "$AINIZE_NODE_URL" "$OUTPUT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const url = new URL(process.argv[2]);
assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash);
const read = async route => {
  const response = await fetch(new URL(route, url), { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  return response.json();
};
(async () => {
  const [info, policy] = await Promise.all([read('/api/info'), read('/api/teach/policy')]);
  assert.equal(policy.enabled, true);
  assert.equal(policy.backend, 'gradient');
  assert.equal(policy.trainer, 'ready');
  assert.equal(policy.queue.depth, 0);
  assert.equal(info.runtime.available, true);
  assert.equal(info.runtime.hook, true);
  assert.deepEqual(info.runtime.applied, []);
  assert.equal(info.runtime.queue.running, null);
  assert.equal(info.runtime.queue.waiting, 0);
  assert.equal(info.runtime.queue.lock, null);
  fs.writeFileSync(`${process.argv[3]}/preflight.json`, JSON.stringify({ observedAt: Date.now(),
    backend: policy.backend, trainer: policy.trainer, model: info.runtime.model,
    ledgerKind: info.ledger?.kind ?? null, publish: policy.publish, queue: policy.queue,
    runtimeQueue: info.runtime.queue, applied: info.runtime.applied,
    scope: 'Preflight snapshot only; the node must enforce resource ownership while running.' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
})().catch(() => { console.error('Preflight failed: an idle gradient-capable node with no applied patches is required. No teaching request sent.'); process.exitCode = 1; });
NODE
NAME="ain-hf-training-client-$$-$(date +%s)"
CREATED=false
cleanup() {
  if "$CREATED"; then
    docker logs "$NAME" > "$OUTPUT/cli.stdout" 2> "$OUTPUT/cli.stderr" || true
    docker rm -f "$NAME" >/dev/null
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git -C "$CLI" rev-parse HEAD > "$OUTPUT/cli-source-commit.txt"
git -C "$CLI" status --short > "$OUTPUT/cli-source-status.txt"
printf '%s\n' "$DATASET" "$REVISION" "$FILE" > "$OUTPUT/source-selection.txt"
docker create --name "$NAME" --network host --cpus 1 --memory 2g --memory-swap 2g --pids-limit 256 \
  --user "$(id -u):$(id -g)" -w /work/cli --entrypoint node \
  -v "$CLI:/work/cli:ro" -v "$OUTPUT:/evidence" \
  "$IMAGE" --import tsx src/bin.ts --home /evidence/cli-home --node "$AINIZE_NODE_URL" \
  dataset "$DATASET" --revision "$REVISION" --file "$FILE" \
  --train --wait --timeout 60 --effort balanced --json >/dev/null
CREATED=true
docker inspect "$NAME" --format '{"image":"{{.Image}}","cpuNano":{{.HostConfig.NanoCpus}},"memoryBytes":{{.HostConfig.Memory}},"memorySwapBytes":{{.HostConfig.MemorySwap}},"network":"{{.HostConfig.NetworkMode}}"}' > "$OUTPUT/client-docker.json"
printf 'Training client started: %s. Admission receipts are retained under %s/cli-home/hf-imports/. No automatic retry or job cancellation.\n' "$NAME" "$OUTPUT"
set +e
timeout 3900 docker start -a "$NAME"
STATUS=$?
set -e
if [[ "$STATUS" == 0 ]]; then STATUS=$(docker inspect "$NAME" --format '{{.State.ExitCode}}'); fi
printf '{"clientExitCode":%s,"integrationVerified":false,"note":"Inspect admitted job status and real training evidence. Exit zero alone does not prove patch application, inference or blockchain inclusion. Timeout does not cancel a server job."}\n' "$STATUS" > "$OUTPUT/client-result.json"
exit "$STATUS"
