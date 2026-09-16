#!/usr/bin/env bash
# [지표 6] Hugging Face 데이터셋 연동 — 가져오기 → 학습 → 발행 → 적용 후 실제 추론
#
# 계획(plan-datasets.py 의 결과)에 있는 데이터셋마다
#   ainize dataset import <url> --config --split --columns --train --wait
#   ainize teach status <job-id>
#   ainize teach publish <job-id>
#   ainize chat <patch-id> "<확인 질문>" --mode compare      (질문 3개, 3행 미만이면 전부)
# 를 실행하고 각 단계의 결과를 그대로 남긴다.
#
# 가져오기만 된 데이터셋, 학습이 READY 가 아닌 데이터셋, 적용 후 추론이 끝나지 않은
# 데이터셋은 최종 수에 넣지 않는다. 단계별 수는 따로 집계한다.
set -uo pipefail

NODE=${NODE:-http://127.0.0.1:3410}
CLI=${CLI:-/mnt/newdata/gov/hackathon/ainize-cli/dist/bin.js}
CLI_HOME=${CLI_HOME:-/mnt/newdata/gov/kpi/m6/cli-home}
PLAN=${PLAN:-/mnt/newdata/gov/kpi/m6/plan.json}
OUT=${OUT:-/mnt/newdata/gov/kpi/m6/results}
LIMIT=${LIMIT:-8}
EFFORT=${EFFORT:-quick}
WAIT_MIN=${WAIT_MIN:-30}
TARGET=${TARGET:-100}
QUESTIONS=${QUESTIONS:-3}

mkdir -p "$OUT" "$CLI_HOME"
export NODE CLI CLI_HOME PLAN OUT LIMIT EFFORT WAIT_MIN TARGET QUESTIONS
python3 -u "$(dirname "$0")/m6-dataset-support.py"
