#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ -n "${M1_TARGETS:-}" ]]; then
  node "$SCRIPT_DIR/collect-training-submissions.js" "$M1_TARGETS" "${1:?New manifest output path required}"
fi
exec node "$SCRIPT_DIR/m3-training-record-latency.js" "${1:?Metric 1 manifest path required}" "${2:?Result JSON path required}"
