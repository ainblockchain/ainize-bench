#!/usr/bin/env bash
set -euo pipefail
[[ -f /.dockerenv ]] || { echo 'Run inside the resource-limited Locust Docker image.' >&2; exit 1; }
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
OUTPUT=${1:?New output directory required}
umask 077
mkdir "$OUTPUT"
OUTPUT=$(cd "$OUTPUT" && pwd)
export AINIZE_TARGETS="$OUTPUT/targets.json" M4_EVIDENCE_DIR="$OUTPUT/load"
python3 "$ROOT/test/mock_ainize_sse.py" "$AINIZE_TARGETS" > "$OUTPUT/mock.log" 2>&1 &
SERVER=$!
cleanup() { kill "$SERVER" 2>/dev/null || true; wait "$SERVER" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for attempt in $(seq 1 100); do [[ -s "$AINIZE_TARGETS" ]] && break; sleep .1; done
[[ -s "$AINIZE_TARGETS" ]]
set +e
DUR=70 M4_STABLE_SECONDS=30 bash "$ROOT/run-m4-inference-locust-240users-60workers.sh"
STATUS=$?
set -e
python3 - "$M4_EVIDENCE_DIR" "$STATUS" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
geometry = json.loads((root / "geometry.json").read_text())
samples = json.loads((root / "membership.json").read_text())
identities = set()
successes = failures = 0
for index in range(60):
    identity = json.loads((root / f"worker-identity-{index}.json").read_text())
    summary = json.loads((root / f"worker-summary-{index}.json").read_text())
    raw = (root / f"inference-receipts-worker-{index}.jsonl").read_bytes()
    assert identity["worker_index"] == index
    assert all(summary[key] == value for key, value in identity.items())
    assert summary["receipt_sha256"] == hashlib.sha256(raw).hexdigest()
    assert summary["successes"] == summary["receipt_count"] == len(raw.splitlines())
    assert summary["requests"] == summary["successes"] + summary["failures"]
    assert summary["client_id"] not in identities
    identities.add(summary["client_id"])
    successes += summary["successes"]
    failures += summary["failures"]
if geometry["complete"]:
    assert all(set(sample["members"]) == identities for sample in samples if geometry["start"] <= sample["at"] <= geometry["end"])
report = {"synthetic_only": True, "workers": len(identities), "successful_requests": successes,
    "failed_requests": failures, "geometry": geometry, "runner_exit": int(sys.argv[2]),
    "scope": "Actual Locust process geometry and evidence bindings against synthetic SSE; not GPU throughput or chain verification"}
(root / "distributed-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
raise SystemExit(0 if geometry["complete"] and int(sys.argv[2]) == 0 else 1)
PY
