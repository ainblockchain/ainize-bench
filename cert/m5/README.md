# 지표 5 — 오픈소스 ML 도구를 통한 모델 지원 수

목표는 **고유 Hugging Face 모델 ID 100개**다. 한 모델이 세어지려면 세 가지가 모두 맞아야 한다.

1. transformers 런타임에 실제로 실린다 (가중치 로드, revision 기록).
2. 런타임의 `/v1/models` 가 보고하는 서빙 ID 가 요청한 저장소 ID 와 **같다**.
3. `ainize chat https://huggingface.co/<owner>/<model>` 이 실제 추론 응답을 돌려준다.

로드만 된 모델, 다른 모델이 대신 답한 모델, 빈 응답은 세지 않는다. 답의 정확도는
별개로 기록한다 — 응답이 왔다는 것과 답이 맞다는 것은 다른 주장이다.

## 구성

| 파일 | 하는 일 |
|---|---|
| `models-candidates.json` | 후보 모델 목록. 다운로드 시간이 시험을 지배하지 않도록 작은 모델 위주 |
| `fetch-models.py` | 후보를 Hugging Face 허브에서 받아 캐시에 둔다. 못 받은 모델은 기록만 남긴다 |
| `hf_model_server.py` | transformers 를 OpenAI 호환 API 로 노출한다. 한 번에 한 모델만 싣고, 요청한 모델이 실려 있지 않으면 404 로 거절한다 |
| `run-m5-model-support.sh` · `m5-model-support.py` | 모델마다 로드 → 서빙 ID 대조 → `ainize chat` 을 돌리고 결과를 누적한다 |

`hf_model_server.py` 는 모델을 **대체하지 않는다.** 요청한 모델이 실려 있지 않으면
다른 모델의 답을 돌려주는 대신 `model_not_found` 로 거절한다. 이것이 없으면 지원 수는
서빙 중인 아무 모델의 응답 수가 된다.

지시 학습이 되지 않은 기반 모델은 끝 토큰을 내지 않고 상대의 다음 발화까지 지어낸다.
서버는 그 모델 **자신의 채팅 템플릿**에서 발화 경계를 읽어 거기서 끊는다. 템플릿이
없는 모델에는 이어쓰기 형식을 주고 줄 끝에서 끊는다. 모델을 바꾸는 것이 아니라 같은
질문을 그 모델이 읽을 수 있는 형태로 주는 것이다.

## 실행

```sh
# 1. 모델 받기 (캐시는 넉넉한 디스크에 둔다)
HF_HOME=/data/hf python3 fetch-models.py models-candidates.json /data/m5/fetch-state.json

# 2. 런타임 (GPU 한 장)
docker run -d --name m5-runtime --gpus '"device=7"' \
  -v "$PWD:/m5:ro" -v /data/hf:/hf -e HF_HOME=/hf -e HF_HUB_OFFLINE=1 \
  -p 127.0.0.1:8410:8410 --entrypoint python3 <vllm-image> /m5/hf_model_server.py

# 3. 이 런타임을 가리키는 Ainize 노드를 띄우고 (runtime.api=http://127.0.0.1:8410),
#    운영자로 로그인한 CLI 홈을 만든 뒤
STATE=/data/m5/fetch-state.json NODE=http://127.0.0.1:3450 TARGET=100 \
  bash run-m5-model-support.sh
```

결과는 `results/m5-model-support.json` 에 모델별로 남는다: 명령, revision, 서빙 ID,
질문, 응답, 지연, 실패 사유. `supported_unique` 가 집계값이고 `pass` 는 목표 대비 판정이다.

## 노드 쪽 전제

패치 훅이 없는 런타임에서도 기본 모델 대화가 되어야 한다.
[ainize-node PR #12](https://github.com/ainblockchain/ainize-node/pull/12) 가 그것이다.
그 수정 전 노드는 `runtime repo not found` 로 거절한다.
