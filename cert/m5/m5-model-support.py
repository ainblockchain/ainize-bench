#!/usr/bin/env python3
import json, os, subprocess, time, urllib.request, urllib.error

RUNTIME, NODE = os.environ['RUNTIME'], os.environ['NODE']
CLI, CLI_HOME = os.environ['CLI'], os.environ['CLI_HOME']
OUT, QUESTION, TARGET = os.environ['OUT'], os.environ['QUESTION'], int(os.environ['TARGET'])
MAX_TOKENS = int(os.environ.get('MAX_TOKENS', '64'))

def wait_ready(url, seconds=900):
    """런타임이 뜰 때까지 기다린다. 아직 듣지 않는 포트에 보낸 요청이 거절된 것을
    모델이 실패한 것으로 적으면, 시험이 아니라 시험 도구의 오류를 세게 된다."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            get(url + '/health', 5)
            return True
        except Exception:
            time.sleep(5)
    raise SystemExit('런타임 %s 이(가) %d 초 안에 응답하지 않았다' % (url, seconds))


fetched = json.load(open(os.environ['STATE']))
models = [m for m, v in fetched.items() if v.get('ok')]
print('받은 모델 %d 개를 순서대로 확인한다' % len(models), flush=True)

def post(url, payload, timeout):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)

def get(url, timeout=15):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)

wait_ready(RUNTIME)
rows = []
result_path = os.path.join(OUT, 'm5-model-support.json')
if os.path.exists(result_path):
    rows = json.load(open(result_path)).get('models', [])
seen = {r['model_id'] for r in rows if r['supported']}

for mid in models:
    if mid in seen:
        continue
    row = {'model_id': mid, 'url': 'https://huggingface.co/' + mid, 'at': int(time.time() * 1000),
           'supported': False, 'stage': None, 'error': None}
    try:
        # 전송 실패는 모델 문제가 아니다. 런타임이 다시 응답할 때까지 기다렸다가 한 번 더 건다.
        try:
            state = post(RUNTIME + '/admin/load', {'model_id': mid}, 1800)
        except (ConnectionResetError, urllib.error.URLError, OSError):
            wait_ready(RUNTIME)
            state = post(RUNTIME + '/admin/load', {'model_id': mid}, 1800)
        row['revision'] = state.get('revision')
        row['architectures'] = state.get('architectures')
        row['params'] = state.get('params')
        row['dtype'] = state.get('dtype')
    except Exception as e:
        row.update(stage='load', error=str(e)[:300])
        rows.append(row); seen.discard(mid)
        print('FAIL load  ', mid, row['error'][:90], flush=True)
        json.dump({'models': rows}, open(result_path, 'w'), ensure_ascii=False, indent=1)
        continue

    try:  # 실제로 실린 모델 ID 가 요청한 저장소 ID 와 같은지 런타임에 직접 확인한다
        served = (get(RUNTIME + '/v1/models').get('data') or [{}])[0].get('id')
        row['served_model_id'] = served
        if served != mid:
            raise RuntimeError('serving id %r != requested %r' % (served, mid))
    except Exception as e:
        row.update(stage='serving_id', error=str(e)[:300]); rows.append(row)
        print('FAIL id    ', mid, row['error'][:90], flush=True)
        json.dump({'models': rows}, open(result_path, 'w'), ensure_ascii=False, indent=1)
        continue

    # 질문은 한 단어 답을 요구한다. 답 길이를 그에 맞게 제한해 모델이 대화를 지어내지
    # 않게 하고, 한 모델에 드는 시간을 짧게 유지한다.
    cmd = ['node', CLI, '--home', CLI_HOME, '--node', NODE, 'chat',
           'https://huggingface.co/' + mid, QUESTION, '--max-tokens', str(MAX_TOKENS), '--json']
    row['command'] = 'ainize --node %s chat https://huggingface.co/%s "%s" --max-tokens %d' % (
        NODE, mid, QUESTION, MAX_TOKENS)
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        # `--json` puts the document on stdout when the command worked and on stderr when it failed.
        # Reading only stdout turned every real CLI error into a parser error and hid what went wrong.
        doc = None
        for stream in (p.stdout, p.stderr):
            i = stream.find('{')
            if i >= 0:
                try:
                    doc = json.loads(stream[i:]); break
                except Exception:
                    continue
        if doc is None:
            raise RuntimeError('cli exit %d, no json; stderr=%s' % (p.returncode, p.stderr.strip()[-300:]))
        row['cli_exit'] = p.returncode
    except Exception as e:
        row.update(stage='chat', error=type(e).__name__ + ': ' + str(e)[:250]); rows.append(row)
        print('FAIL chat  ', mid, row['error'][:90], flush=True)
        json.dump({'models': rows}, open(result_path, 'w'), ensure_ascii=False, indent=1)
        continue

    if doc.get('error'):
        row.update(stage='chat', error=json.dumps(doc['error'])[:300])
    else:
        answer = ((doc.get('base') or {}).get('content') or '').strip()
        row['answer'] = answer[:500]
        row['answer_model'] = doc.get('model')
        row['finish_reason'] = (doc.get('base') or {}).get('finish_reason')
        row['latency_ms'] = (doc.get('base') or {}).get('latency_ms')
        # 노드가 반복 생성을 잘라낸 경우를 구분해 남긴다. 빈 답의 이유가 모델인지 절단인지
        # 나중에 알 수 없으면 집계를 믿을 수 없다.
        row['truncated'] = (doc.get('base') or {}).get('truncated')
        row['raw_chars'] = (doc.get('base') or {}).get('raw_chars')
        if doc.get('model') != mid:
            row.update(stage='chat', error='node answered with model %r' % doc.get('model'))
        elif not answer:
            row.update(stage='chat', error='empty answer')
        else:
            row['supported'] = True
            row['stage'] = 'ok'
    rows.append(row)
    if row['supported']:
        seen.add(mid)
    print(('OK   ' if row['supported'] else 'FAIL '), mid,
          (row.get('answer') or row.get('error') or '')[:80].replace('\n', ' '), flush=True)
    json.dump({'models': rows}, open(result_path, 'w'), ensure_ascii=False, indent=1)
    if len(seen) >= TARGET:
        print('목표 %d 개 도달' % TARGET, flush=True)
        break

report = {
    'metric': 'M5_open_source_ml_model_support', 'target': TARGET,
    'question': QUESTION, 'node': NODE, 'runtime': RUNTIME,
    'runtime_stack': 'huggingface transformers (OpenAI 호환 서버) · cert/m5/hf_model_server.py',
    'attempted': len({r['model_id'] for r in rows}),
    'supported_unique': len(seen),
    'failed': sorted({r['model_id'] for r in rows} - seen),
    'definition': '실제 로드 + 서빙 ID 일치 + ainize chat 실제 추론 응답을 모두 만족한 고유 HF 모델 ID 수',
    'models': rows,
}
report['pass'] = report['supported_unique'] >= TARGET
json.dump(report, open(result_path, 'w'), ensure_ascii=False, indent=1)
print('지원 모델 %d / 목표 %d · pass=%s' % (report['supported_unique'], TARGET, report['pass']), flush=True)
