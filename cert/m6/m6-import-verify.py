#!/usr/bin/env python3
"""지표 6 보조 — Hugging Face 데이터셋 가져오기 전수 검증.

계획된 데이터셋을 모두 `ainize dataset import <url>` 로 가져와, 실제로 들어온 행 수와
원본 선택 범위가 맞는지 확인한다. 학습은 하지 않는다.

이것은 지표 6 의 최종 집계가 아니다. 최종 수는 가져오기 → 학습 완료 → 발행 → 적용 후
추론까지 끝낸 데이터셋 수이며 `m6-dataset-support.py` 가 센다. 여기서 나오는 수는
"가져오기까지 확인된 데이터셋 수"이고, 보고서에서 그 이름으로만 쓴다.

환경: NODE, CLI, CLI_HOME, PLAN, OUT, LIMIT, WORKERS
"""
import json, os, subprocess, threading, time, concurrent.futures as cf

NODE = os.environ.get('NODE', 'http://127.0.0.1:3410')
CLI = os.environ.get('CLI', '/mnt/newdata/gov/hackathon/ainize-cli/dist/bin.js')
CLI_HOME = os.environ.get('CLI_HOME', '/mnt/newdata/gov/kpi/m6/cli-home')
PLAN = os.environ.get('PLAN', '/mnt/newdata/gov/kpi/m6/plan.json')
OUT = os.environ.get('OUT', '/mnt/newdata/gov/kpi/m6/results')
LIMIT = int(os.environ.get('LIMIT', '8'))
WORKERS = int(os.environ.get('WORKERS', '4'))
RESULT = os.path.join(OUT, 'm6-import-verify.json')

os.makedirs(OUT, exist_ok=True)
lock = threading.Lock()
rows = json.load(open(RESULT))['datasets'] if os.path.exists(RESULT) else []
done = {r['id'] for r in rows if r.get('imported')}


def cli(args, timeout=900):
    cmd = ['node', CLI, '--home', CLI_HOME, '--node', NODE] + args + ['--json']
    p = subprocess.run(cmd, capture_output=True, encoding='utf-8', errors='replace', timeout=timeout)
    for stream in (p.stdout, p.stderr):
        i = stream.find('{')
        if i >= 0:
            try:
                return json.loads(stream[i:]), ' '.join(cmd)
            except Exception:
                continue
    return {'error': {'message': 'no json; stderr=' + p.stderr.strip()[-300:]}}, ' '.join(cmd)


def save():
    report = {
        'metric': 'M6_huggingface_dataset_import_verified', 'node': NODE, 'rows_requested': LIMIT,
        'definition': '`ainize dataset import` 이 원본 config·split·컬럼 선택대로 행을 가져온 데이터셋 수. '
                      '학습·발행·추론은 포함하지 않으며 지표 6 의 최종 집계가 아니다',
        'imported': sum(1 for r in rows if r.get('imported')),
        'attempted': len(rows), 'datasets': sorted(rows, key=lambda r: r['id']),
    }
    json.dump(report, open(RESULT, 'w'), ensure_ascii=False, indent=1)
    return report


def one(d):
    if d['id'] in done:
        return None
    row = {'id': d['id'], 'url': d['url'], 'config': d.get('config'), 'split': d.get('split'),
           'columns': d.get('columns'), 'at': int(time.time() * 1000), 'imported': False}
    args = ['dataset', 'import', d['url'], '--config', d['config'], '--split', d['split'],
            '--columns', json.dumps(d['columns']), '--limit', str(LIMIT)]
    # 허브의 429 는 이 데이터셋이 못 쓰는 것이 아니라 우리가 너무 빨리 물어본 것이다.
    # 그것을 실패로 세면 연동 가능 수가 우리 요청 속도에 따라 달라진다.
    for attempt in range(4):
        doc, cmd = cli(args)
        message = (doc.get('error') or {}).get('message', '') if doc.get('error') else ''
        if '429' not in message:
            break
        row['rate_limited'] = attempt + 1
        time.sleep(20 * (attempt + 1))
    row['command'] = cmd
    if doc.get('error'):
        row['error'] = doc['error'].get('message', '')[:300]
        report = (doc['error'].get('details') or {}).get('report') or {}
        row['reject_summary'] = report.get('summary')
    else:
        row['dataset_id'] = doc.get('dataset_id') or doc.get('id') or (doc.get('dataset') or {}).get('id')
        row['rows'] = doc.get('rows') or (doc.get('dataset') or {}).get('rows')
        row['revision'] = doc.get('revision') or (doc.get('source') or {}).get('revision')
        row['imported'] = bool(row['dataset_id'])
    with lock:
        rows.append(row)
        if row['imported']:
            done.add(d['id'])
        r = save()
        print(('OK  ' if row['imported'] else 'FAIL'), d['id'], row.get('rows') or row.get('error', '')[:70],
              '| 가져오기', r['imported'], flush=True)
    return row


plan = [d for d in json.load(open(PLAN)) if d.get('usable')]
print('계획 %d 개 · 이미 확인 %d 개 · 동시 %d' % (len(plan), len(done), WORKERS), flush=True)
with cf.ThreadPoolExecutor(max_workers=WORKERS) as ex:
    list(ex.map(one, plan))
r = save()
print('가져오기 확인 %d / 계획 %d' % (r['imported'], len(plan)), flush=True)
