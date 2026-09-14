#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec node "$SCRIPT_DIR/m3-training-record-latency.js" "${1:?Metric 1 manifest path required}" "${2:?Result JSON path required}"
