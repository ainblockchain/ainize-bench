# 지표 6 — Hugging Face 데이터셋 연동 수

목표는 **데이터셋 100개**다. 한 데이터셋이 세어지려면 네 단계가 모두 끝나야 한다.

1. `ainize dataset import <url> --train --wait` 로 가져오기가 검증된다.
2. 그 데이터셋으로 만든 학습 작업이 `READY` 로 끝난다.
3. 그 작업의 지식이 발행된다.
4. 학습에 채택된 행에서 고른 확인 질문 전부에 대해 `chat --mode compare` 가 실제 응답을 낸다.

가져오기 성공 수, 학습 완료 수, 발행 수, 추론 완료 수를 따로 센다. 가져오기만 된
데이터셋을 연동 완료로 올리지 않는다.

## 구성

| 파일 | 하는 일 |
|---|---|
| `hf-dataset-candidates.json` | 후보 저장소 목록 (Hub API 검색 결과) |
| `plan-datasets.py` | 후보마다 실제 뷰어를 읽어 config·split·질문/답 컬럼을 정한다. 정하지 못하면 이유를 남기고 제외한다 |
| `run-m6-dataset-support.sh` · `m6-dataset-support.py` | 계획대로 가져오기 → 학습 → 발행 → 비교 추론을 돌리고 단계별로 기록한다 |

계획 단계에서 두 가지를 미리 거른다. 둘 다 실행 시간을 버리지 않기 위한 것이고,
집계를 부풀리지 않기 위한 것이다.

- **답이 라벨뿐인 데이터셋.** 정답 번호나 `A`/`B`/`C` 만 있는 컬럼으로 학습하면 모델은
  "1" 이라고 답하도록 배운다. 그것을 연동 성공으로 세면 숫자를 세는 것이지 연동을 세는
  것이 아니다.
- **같은 질문에 다른 답이 붙은 데이터셋.** 노드가 `dataset_empty: conflicts` 로 통째로
  거절한다. 한 질문에 한 답이 아닌 형식이므로 계획에서 뺀다.

## 실행

```sh
python3 plan-datasets.py hf-dataset-candidates.json /data/m6/plan.json 150

PLAN=/data/m6/plan.json NODE=http://127.0.0.1:3410 TARGET=100 LIMIT=8 \
  bash run-m6-dataset-support.sh
```

노드는 실제 gradient 백엔드를 쓰는 학습 노드여야 한다. stub 백엔드로 낸 결과는
학습이 아니므로 이 지표의 증빙이 아니다.

결과는 `results/m6-dataset-support.json` 에 데이터셋별로 남는다: 실행한 명령,
Dataset ID ↔ Job ID ↔ Patch ID, 상태, 질문과 적용 전·후 응답, 실패 사유.
