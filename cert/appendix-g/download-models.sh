#!/usr/bin/env bash
# models100.json 전 모델 HF 캐시 사전 다운로드 (동시 4, safetensors/config/tokenizer만)
set -u
export HF_HUB_DISABLE_XET=1
HERE=$(cd "$(dirname "$0")" && pwd)
KPI_DIR=${KPI_DIR:-$HERE/../work}
HF=${HF_CLI:-hf}
export HF_HOME=${HF_HOME:-$KPI_DIR/hf-home}
mkdir -p "$HF_HOME" "$KPI_DIR/logs"
LIST=$(node -e "console.log(require('$HERE/models100.json').map(m=>m.id).join('\n'))")
echo "$LIST" | xargs -P 4 -I{} sh -c '
  echo "[dl] start {}";
  '"$HF"' download {} --include "*.safetensors" "*.json" "*.model" "tokenizer*" "*.tiktoken" "*.txt" >/dev/null 2>>"$KPI_DIR/logs/download-err.log" \
    && echo "[dl] done {}" || echo "[dl] FAIL {}";
' 2>&1 | tee "$KPI_DIR/logs/download.log"
echo ALL_DOWNLOADS_ATTEMPTED
