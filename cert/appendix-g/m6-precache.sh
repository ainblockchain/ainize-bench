#!/usr/bin/env bash
# M6 사전 준비: 데이터셋 100종을 GPU 없이(dummy 모델) 로드해 HF 캐시에 내려받고 로드 오류를 미리 확인
HERE=$(cd "$(dirname "$0")" && pwd)
KPI_DIR=${KPI_DIR:-$HERE/../work}
EVALBIN=${LM_EVAL:-lm_eval}
export HF_HOME=${HF_HOME:-$KPI_DIR/hf-home} HF_HUB_DISABLE_XET=1 HF_DATASETS_TRUST_REMOTE_CODE=1 TMPDIR=${TMPDIR:-$KPI_DIR/tmp}
cd "$HERE"
mkdir -p "$KPI_DIR/logs/m6-precache" "$TMPDIR"
while read -r t; do
  [ -z "$t" ] && continue
  if "$EVALBIN" --model dummy --tasks "$t" --limit 5 --output_path "$TMPDIR/m6-dummy" > "$KPI_DIR/logs/m6-precache/$t.log" 2>&1; then echo "OK $t"; else echo "FAIL $t"; fi
done < datasets100.txt
echo PRECACHE_DONE
