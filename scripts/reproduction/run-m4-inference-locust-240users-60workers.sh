#!/usr/bin/env bash
set -euo pipefail
[[ -f /.dockerenv ]] || { echo 'Run inside the resource-limited Docker load-generator container.' >&2; exit 1; }
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
: "${AINIZE_TARGETS:?Five-node target JSON required}"
: "${M4_EVIDENCE_DIR:?New evidence directory required}"
LOCUST_BIN=${LOCUST_BIN:-locust}
DUR=${DUR:-60}
M4_STABLE_SECONDS=${M4_STABLE_SECONDS:-30}
[[ "$DUR" =~ ^[1-9][0-9]*$ ]] || { echo 'DUR must be positive seconds' >&2; exit 1; }
[[ "$M4_STABLE_SECONDS" =~ ^[1-9][0-9]*$ && "$M4_STABLE_SECONDS" -le "$DUR" ]] || { echo 'Stable duration must be positive and no longer than DUR' >&2; exit 1; }
umask 077
mkdir "$M4_EVIDENCE_DIR"
export AINIZE_TARGETS M4_EVIDENCE_DIR M4_STABLE_SECONDS
"$LOCUST_BIN" --version > "$M4_EVIDENCE_DIR/locust-version.txt"
PIDS=()
cleanup() {
  for process in "${PIDS[@]}"; do kill "$process" 2>/dev/null || true; done
  for process in "${PIDS[@]}"; do wait "$process" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for worker in $(seq 0 59); do
  M4_WORKER_INDEX=$worker "$LOCUST_BIN" -f "$SCRIPT_DIR/locust_ainize.py" --worker --master-host 127.0.0.1 --master-port 5557 \
    > "$M4_EVIDENCE_DIR/worker-$worker.log" 2>&1 &
  PIDS+=("$!")
done
"$LOCUST_BIN" -f "$SCRIPT_DIR/locust_ainize.py" --master --master-bind-host 127.0.0.1 --master-bind-port 5557 \
  --expect-workers 60 --expect-workers-max-wait 120 --autostart --autoquit 5 --web-host 127.0.0.1 --web-port 0 \
  -u 240 -r 240 -t "${DUR}s" --stop-timeout 310 \
  --csv "$M4_EVIDENCE_DIR/locust" --csv-full-history --only-summary \
  > "$M4_EVIDENCE_DIR/master.log" 2>&1 &
MASTER=$!
PIDS+=("$MASTER")
echo "Locust running: 240 users / 60 workers. Monitor $M4_EVIDENCE_DIR/master.log and locust_stats_history.csv"
wait "$MASTER"
