#!/usr/bin/env bash
set -euo pipefail
[[ -f /.dockerenv ]] || { echo 'Run this smoke check inside the Locust Docker image.' >&2; exit 1; }
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
OUTPUT=${1:?New output directory required}
umask 077
mkdir "$OUTPUT"
OUTPUT=$(cd "$OUTPUT" && pwd)
export AINIZE_TARGETS="$OUTPUT/targets.json" M4_EVIDENCE_DIR="$OUTPUT" M4_STABLE_SECONDS=30
PIDS=()
cleanup() {
  for process in "${PIDS[@]}"; do kill "$process" 2>/dev/null || true; done
  for process in "${PIDS[@]}"; do wait "$process" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 "$ROOT/test/mock_ainize_sse.py" "$AINIZE_TARGETS" &
PIDS+=("$!")
for attempt in $(seq 1 100); do [[ -s "$AINIZE_TARGETS" ]] && break; sleep .1; done
[[ -s "$AINIZE_TARGETS" ]]
M4_WORKER_INDEX=0 locust -f "$ROOT/locust_ainize.py" --worker --master-host 127.0.0.1 --master-port 5557 > "$OUTPUT/worker.log" 2>&1 &
PIDS+=("$!")
set +e
locust -f "$ROOT/locust_ainize.py" --master --master-bind-host 127.0.0.1 --master-bind-port 5557 \
  --expect-workers 1 --expect-workers-max-wait 30 --autostart --autoquit 5 --web-host 127.0.0.1 --web-port 0 \
  -u 1 -r 1 -t 3s --stop-timeout 10 \
  --csv "$OUTPUT/locust" --only-summary > "$OUTPUT/master.log" 2>&1
STATUS=$?
set -e
[[ "$STATUS" == 1 ]] || { echo "Expected geometry failure, got exit $STATUS" >&2; exit 1; }
cleanup
python3 - "$OUTPUT" <<'PY'
import json
import hashlib
import csv
import sys
from pathlib import Path

output = Path(sys.argv[1])
geometry = json.loads((output / "geometry.json").read_text())
assert geometry["complete"] is False
records = [json.loads(line) for line in (output / "inference-receipts-worker-0.jsonl").read_text().splitlines()]
assert records
assert all(record["receipt"]["model_id"] == "synthetic-model" for record in records)
assert len({record["receipt"]["id"] for record in records}) == len(records)
assert all(set(record) == {"version", "node_url", "client_started_at", "client_completed_at", "receipt"} for record in records)
identity = json.loads((output / "worker-identity-0.json").read_text())
summary = json.loads((output / "worker-summary-0.json").read_text())
assert all(summary[key] == value for key, value in identity.items())
assert summary["successes"] == summary["receipt_count"] == len(records)
assert summary["requests"] == summary["successes"] + summary["failures"]
assert summary["receipt_count_matches_successes"] is True
assert summary["receipt_sha256"] == hashlib.sha256((output / identity["receipt_file"]).read_bytes()).hexdigest()
with (output / "locust_stats.csv").open() as source:
    stats = list(csv.DictReader(source))
assert len(stats) == 2
assert all(int(row["Request Count"]) == summary["requests"] and int(row["Failure Count"]) == summary["failures"] for row in stats)
assert any(identity["client_id"] in sample["members"] for sample in json.loads((output / "membership.json").read_text()))
report = {"synthetic_only": True, "workers": 1, "users": 1, "receipt_count": len(records),
    "geometry_pass": False, "scope": "Locust receipt-writing smoke check, not an M4 performance result"}
(output / "receipt-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
PY
