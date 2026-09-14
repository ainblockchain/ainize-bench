#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec node "$SCRIPT_DIR/m1-parallel-training.js" "${1:?Dataset assignment JSON required}" "${2:?New evidence directory required}"
