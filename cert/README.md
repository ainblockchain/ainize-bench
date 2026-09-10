# cert/ — 성능지표 5·6 시험 재현 하네스 (Ainize 경로)

3차년도 공인기관인증 평가의 **지표 5 (오픈소스 ML 도구 모델 지원 ≥ 100종)** 과 **지표 6 (데이터셋 지원 ≥ 100종)** 을
Ainize 스택으로 재현합니다. 전체 절차서(지표 1~6)는 `ainblockchain/ain-blockchain` 의
`tools/cert-kpi/성능지표_시험_재현절차서.md` (§8·§9) 입니다. 지표 1~4 하네스도 그곳에 있습니다.

판정 매핑: **지식 패치 1개 = 모델 1종**, **DART 공시 타입 1개의 학습 데이터셋 = 데이터셋 1종**.

| 단계 | 파일 | 산출 |
|---|---|---|
| DART 타입 108종 → 데이터셋 jsonl | `dart-build-datasets.py` (`dart-api-catalog.json` = OpenDART API 85종 카탈로그) | `dart-datasets/dart-NNN-<type>.jsonl` + `manifest.json` |
| 타입별 teach → publish → apply·추론 → 온체인 기록/역검증 → 데이터셋 기록 | `m5-ainize.js` | `results/m5-ainize-progress.json`, `logs/m5-ainize/<type>.log` |
| 전 패치 중첩 apply + 스택 재검증 + 판정 | `m5-ainize.js --stack` | `results/m5-final.json`, `results/m6-final.json` |

## 전제

- Ainize 노드가 AIN 원장(`--ledger ain`)과 Qwen3.8-Flash-Next PLE 런타임(`finance-knowledge-training-demo`)에 붙어 SERVING 중.
  상주 트레이너는 `ainblockchain/ainize-node` 의 `trainer/resident/` 를 런타임 저장소에 설치해 사용합니다.
- 지표 1~4 와 같은 10노드 인증망(`cert-10-nodes`)이 `http://localhost:8081..8090` 에 떠 있고 `ai_network_dag` 앱이 배포되어 있음.
- Node ≥ 24, Python 3.10+, OpenDART 인증키.

## 실행

```bash
cd cert && npm install
export KPI_DIR=/data/cert-kpi                 # 결과·로그 위치 (기본: cert/work)
export AINIZE_HOME=~/.ainize                  # 시험용 ainize 노드 홈
export RUNTIME_REPO=/path/to/finance-knowledge-training-demo   # data/krx.json (또는 KRX_JSON)
echo 'DART_API_KEY=<opendart 인증키>' > .env.dart && chmod 600 .env.dart

python3 dart-build-datasets.py 8              # 타입당 사실 8개 → dart-datasets/
LESSONS=108 MIN_OK=100 node m5-ainize.js      # 순차 약 20시간 (수업당 6~19분). 재개 가능
LESSONS=108 MIN_OK=100 node m5-ainize.js --stack
```

`START`/`END` 로 manifest 구간을 나눠 워커(노드 홈)별로 병렬 실행할 수 있습니다(`AINIZE_HOME` 을 워커마다 다르게).
`AINIZE_CLI` 로 CLI 진입점을 지정하지 않으면 `node_modules/@ainize/cli/dist/bin.js` 를 씁니다.

## 판정

`results/m5-final.json`: `supported ≥ 100`, `stack.size ≥ 100`, `stack.hits ≥ 100`, `stack.onchainVerified ≥ 100` → `pass`.
`results/m6-final.json`: `supported ≥ 100` (= `dataset_verified`), `datasetGetOk` 병기.
온체인 경로: `/apps/ai_network_dag/model_inference/<patch>/iteration_{1..3}`, `model_stack/<patch>/check`, `dataset_support/<type>`.

## appendix-g/ — 대체 경로 (절차서 부록 G)

HuggingFace 허브 공개 모델 100종을 vLLM 으로 구동(`m5-models.js`, `models100.json`, `download-models.sh`)하고
lm-eval 100 태스크(`datasets100.txt`, `m6-run.sh`, `m6-record.js`)로 평가한 뒤 ain-js 로 온체인 기록하는 이전 기준안입니다.
보조 증빙으로만 씁니다. `LM_EVAL`, `VLLM`, `HF_CLI`, `HF_HOME`, `EVAL_RESULTS` 환경변수로 도구 경로를 지정합니다.
