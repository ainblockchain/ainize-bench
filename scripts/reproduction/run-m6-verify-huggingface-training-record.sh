#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec node "$SCRIPT_DIR/verify-hf-training-record.js" "${1:?Evidence manifest required}" "${2:?New result JSON path required}"
