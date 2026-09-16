#!/usr/bin/env bash
# [지표 5] 오픈소스 ML 도구를 통한 모델 지원 수
#
# 후보 Hugging Face 모델을 하나씩 transformers 런타임에 싣고, 서빙 ID 가 저장소 ID 와
# 같은지 확인한 뒤 `ainize chat <huggingface-model-url>` 으로 실제 추론 응답을 받는다.
# 로드만 된 모델, 다른 모델이 대신 답한 모델, 빈 응답은 성공으로 세지 않는다.
#
#   RUNTIME=http://127.0.0.1:8410  런타임 관리 API
#   NODE=http://127.0.0.1:3450     Ainize 노드
#   CLI, CLI_HOME, STATE, OUT      경로
set -uo pipefail

RUNTIME=${RUNTIME:-http://127.0.0.1:8410}
NODE=${NODE:-http://127.0.0.1:3450}
CLI=${CLI:-/mnt/newdata/gov/hackathon/ainize-cli/dist/bin.js}
CLI_HOME=${CLI_HOME:-/mnt/newdata/gov/kpi/m5/cli-home}
STATE=${STATE:-/mnt/newdata/gov/kpi/m5/fetch-state.json}
OUT=${OUT:-/mnt/newdata/gov/kpi/m5/results}
QUESTION=${QUESTION:-"What is the capital of France? Answer in one word."}
TARGET=${TARGET:-100}

mkdir -p "$OUT"
MAX_TOKENS=${MAX_TOKENS:-64}
export RUNTIME NODE CLI CLI_HOME STATE OUT QUESTION TARGET MAX_TOKENS
python3 -u "$(dirname "$0")/m5-model-support.py"
