#!/usr/bin/env python3
"""지표 5 후보 모델을 Hugging Face 허브에서 내려받는다.

가중치와 토크나이저만 받는다. 이미 캐시에 있으면 다시 받지 않는다.
받지 못한 모델은 기록만 하고 건너뛴다. 실패를 성공으로 바꾸지 않는다.
"""
import json, os, sys, time, urllib.request, concurrent.futures as cf
from huggingface_hub import snapshot_download

CANDIDATES = sys.argv[1]
STATE = sys.argv[2]
WORKERS = int(os.environ.get('FETCH_WORKERS', '3'))
ALLOW = ['*.json', '*.txt', '*.model', '*.safetensors', '*.py', 'tokenizer*', '*.jinja']
IGNORE = ['*.bin', '*.h5', '*.msgpack', '*.onnx', '*.gguf', '*.pth', 'onnx/*', 'openvino/*', '*.tflite']

models = json.load(open(CANDIDATES))
done = {}
if os.path.exists(STATE):
    done = json.load(open(STATE))

MAX_GB = float(os.environ.get('MAX_GB', '4'))
TARGET = int(os.environ.get('TARGET', '0'))  # 0 = 후보 전체


def repo_gb(mid):
    """저장소의 가중치 크기(GB). 큰 모델을 받기 시작하면 다운로드가 시험 시간을 삼킨다."""
    try:
        req = urllib.request.Request('https://huggingface.co/api/models/%s?blobs=true' % mid,
                                     headers={'user-agent': 'ainize-cert/1.0'})
        with urllib.request.urlopen(req, timeout=60) as r:
            info = json.load(r)
    except Exception:
        return None
    total = sum(f.get('size') or 0 for f in (info.get('siblings') or [])
                if str(f.get('rfilename', '')).endswith(('.safetensors', '.bin')))
    return total / 1e9 if total else None


def fetch(m):
    mid = m['id']
    if done.get(mid, {}).get('ok'):
        return mid, done[mid]
    gb = repo_gb(mid)
    if gb is not None and gb > MAX_GB:
        return mid, {'ok': False, 'error': 'skipped: %.1f GB over the %.1f GB limit' % (gb, MAX_GB)}
    t0 = time.time()
    try:
        path = snapshot_download(mid, allow_patterns=ALLOW, ignore_patterns=IGNORE)
        has_weights = any(f.endswith('.safetensors') for _, _, fs in os.walk(path) for f in fs)
        if not has_weights:  # safetensors 가 없는 저장소는 .bin 까지 받아 본다
            path = snapshot_download(mid, ignore_patterns=['*.h5', '*.msgpack', '*.onnx', '*.gguf', 'onnx/*', 'openvino/*'])
        return mid, {'ok': True, 'path': path, 'seconds': round(time.time() - t0, 1)}
    except Exception as e:
        return mid, {'ok': False, 'error': type(e).__name__ + ': ' + str(e)[:200]}

with cf.ThreadPoolExecutor(max_workers=WORKERS) as ex:
    for mid, res in ex.map(fetch, models):
        done[mid] = res
        json.dump(done, open(STATE, 'w'), indent=1)
        value = res.get('seconds', res.get('error', ''))
        print(('OK  ' if res['ok'] else 'FAIL'), mid, value[:120] if isinstance(value, str) else value, flush=True)
        if TARGET and sum(1 for v in done.values() if v.get('ok')) >= TARGET:
            print('목표 %d 개 확보' % TARGET, flush=True)
            break

ok = sum(1 for v in done.values() if v.get('ok'))
print('받은 모델 %d / 후보 %d' % (ok, len(models)), flush=True)
