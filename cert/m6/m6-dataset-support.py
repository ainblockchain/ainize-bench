#!/usr/bin/env python3
import json, os, subprocess, time

NODE, CLI, CLI_HOME = os.environ['NODE'], os.environ['CLI'], os.environ['CLI_HOME']
OUT, PLAN = os.environ['OUT'], os.environ['PLAN']
LIMIT, EFFORT = int(os.environ['LIMIT']), os.environ['EFFORT']
WAIT_MIN, TARGET, QUESTIONS = int(os.environ['WAIT_MIN']), int(os.environ['TARGET']), int(os.environ['QUESTIONS'])
RESULT = os.path.join(OUT, 'm6-dataset-support.json')


def cli(args, timeout):
    """CLI 를 한 번 실행하고 --json 문서를 돌려준다. 성공은 stdout, 실패는 stderr 로 온다."""
    cmd = ['node', CLI, '--home', CLI_HOME, '--node', NODE] + args + ['--json']
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    for stream in (p.stdout, p.stderr):
        i = stream.find('{')
        if i >= 0:
            try:
                return p.returncode, json.loads(stream[i:]), ' '.join(cmd)
            except Exception:
                continue
    return p.returncode, {'error': {'message': 'no json; stderr=' + p.stderr.strip()[-300:]}}, ' '.join(cmd)


plan = [d for d in json.load(open(PLAN)) if d.get('usable')]
rows = json.load(open(RESULT))['datasets'] if os.path.exists(RESULT) else []
done = {r['id'] for r in rows if r.get('inference_complete')}
print('계획된 데이터셋 %d 개 · 이미 완료 %d 개' % (len(plan), len(done)), flush=True)


def save(report_only=False):
    counts = {
        'imported': sum(1 for r in rows if r.get('dataset_id')),
        'trained': sum(1 for r in rows if r.get('job_status') == 'READY'),
        'published': sum(1 for r in rows if r.get('patch_id')),
        'inference_complete': sum(1 for r in rows if r.get('inference_complete')),
    }
    report = {
        'metric': 'M6_huggingface_dataset_support', 'target': TARGET, 'node': NODE,
        'rows_per_dataset': LIMIT, 'effort': EFFORT, 'questions_per_dataset': QUESTIONS,
        'definition': '가져오기 검증 → 학습 완료(READY) → 발행 → 적용 후 확인 질문 전부 추론 완료를 모두 만족한 데이터셋 수',
        'counts': counts, 'supported': counts['inference_complete'],
        'pass': counts['inference_complete'] >= TARGET, 'datasets': rows,
    }
    json.dump(report, open(RESULT, 'w'), ensure_ascii=False, indent=1)
    return report


for d in plan:
    if d['id'] in done:
        continue
    row = {'id': d['id'], 'url': d['url'], 'config': d.get('config'), 'split': d.get('split'),
           'columns': d.get('columns'), 'started_at': int(time.time() * 1000),
           'dataset_id': None, 'job_id': None, 'job_status': None, 'patch_id': None,
           'inference_complete': False, 'answers': [], 'errors': []}

    rc, doc, cmd = cli(['dataset', 'import', d['url'], '--config', d['config'], '--split', d['split'],
                        '--columns', json.dumps(d['columns']), '--limit', str(LIMIT),
                        '--train', '--wait', '--timeout', str(WAIT_MIN), '--effort', EFFORT],
                       timeout=WAIT_MIN * 60 + 300)
    row['import_command'] = cmd
    if doc.get('error'):
        row['errors'].append({'stage': 'import', 'error': doc['error']})
    else:
        row['dataset_id'] = doc.get('dataset_id') or doc.get('id') or (doc.get('dataset') or {}).get('id')
        row['rows_imported'] = doc.get('rows') or (doc.get('dataset') or {}).get('rows')
        row['revision'] = doc.get('revision') or (doc.get('source') or {}).get('revision')
        job = doc.get('job') or {}
        row['job_id'] = doc.get('job_id') or job.get('id')
        row['job_status'] = doc.get('status') or job.get('status')
        row['import_result'] = {k: v for k, v in doc.items() if k not in ('rows_preview',)}

    if row['job_id']:
        rc, doc, _ = cli(['teach', 'status', row['job_id']], timeout=300)
        if not doc.get('error'):
            row['job_status'] = doc.get('status') or row['job_status']
            row['job'] = doc
            row['patch_id'] = doc.get('patch_id') or doc.get('draft_id')

    if row['job_status'] == 'READY' and row['job_id']:
        rc, doc, _ = cli(['teach', 'publish', row['job_id'], '--name',
                          'HF dataset %s' % d['id'], '--consent-permanent', '--consent-rights'],
                         timeout=900)
        if doc.get('error'):
            row['errors'].append({'stage': 'publish', 'error': doc['error']})
        else:
            row['patch_id'] = doc.get('patch_id') or doc.get('id') or row['patch_id']
            row['publish'] = doc

    if row['patch_id']:
        # 확인 질문은 학습에 채택된 행에서 고른다. 그 행들을 노드에서 다시 읽는다.
        rc, doc, _ = cli(['teach', 'dataset', 'get', row['dataset_id'] or ''], timeout=300) \
            if row['dataset_id'] else (0, {}, '')
        samples = (doc.get('rows') or doc.get('samples') or []) if isinstance(doc, dict) else []
        qs = [s.get('prompt') or s.get('question') for s in samples if (s.get('prompt') or s.get('question'))]
        if not qs and d.get('sample', {}).get('prompt'):
            qs = [d['sample']['prompt']]
        qs = qs[:QUESTIONS]
        row['questions'] = qs
        ok = bool(qs)
        for q in qs:
            rc, doc, _ = cli(['chat', row['patch_id'], q, '--mode', 'compare'], timeout=900)
            if doc.get('error'):
                row['errors'].append({'stage': 'chat', 'question': q[:120], 'error': doc['error']})
                ok = False
                continue
            base = (doc.get('base') or {}).get('content') or ''
            patched = (doc.get('patched') or {}).get('content') or ''
            row['answers'].append({'question': q[:300], 'base': base[:400], 'patched': patched[:400],
                                   'applied': doc.get('applied'), 'model': doc.get('model'),
                                   'finish_reason': (doc.get('patched') or {}).get('finish_reason')})
            if not patched.strip():
                ok = False
        row['inference_complete'] = ok and len(row['answers']) == len(qs) and len(qs) > 0

    rows.append(row)
    if row['inference_complete']:
        done.add(d['id'])
    r = save()
    print(('OK   ' if row['inference_complete'] else 'PART '), d['id'],
          'ds=%s job=%s status=%s patch=%s' % (row['dataset_id'], row['job_id'], row['job_status'], row['patch_id']),
          '| 완료', r['counts']['inference_complete'], flush=True)
    if r['counts']['inference_complete'] >= TARGET:
        print('목표 %d 개 도달' % TARGET, flush=True)
        break

r = save()
print('가져오기 %(imported)d · 학습완료 %(trained)d · 발행 %(published)d · 추론완료 %(inference_complete)d'
      % r['counts'], flush=True)
print('지원 데이터셋 %d / 목표 %d · pass=%s' % (r['supported'], TARGET, r['pass']), flush=True)
