#!/usr/bin/env python3
"""지표 6 — 가져올 Hugging Face 데이터셋의 config·split·컬럼 매핑을 실제 뷰어로 확인한다.

추측하지 않는다. 각 저장소의 splits 와 first-rows 를 읽어 질문 컬럼과 답 컬럼을
고르고, 고르지 못하면 이유를 남기고 제외한다. 여기서 만든 계획만 실행 단계로 넘긴다.

사용: python3 plan-datasets.py <candidates.json> <plan.json> [원하는 개수]
"""
import json, sys, urllib.request, urllib.parse, concurrent.futures as cf

SERVER = 'https://datasets-server.huggingface.co'
Q_KEYS = ['question', 'prompt', 'instruction', 'query', 'input', 'sentence', 'text', 'problem', 'title']
A_KEYS = ['answer', 'answers', 'output', 'response', 'completion', 'label', 'target', 'solution', 'summary', 'answer_text']


def api(path):
    req = urllib.request.Request(SERVER + path, headers={'user-agent': 'ainize-cert/1.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def flat(v):
    """뷰어가 돌려준 값에서 학습에 쓸 한 줄 문자열을 뽑는다. 못 뽑으면 None."""
    if isinstance(v, str):
        return v.strip() or None
    if isinstance(v, (int, float, bool)):
        return str(v)
    if isinstance(v, list) and v:
        return flat(v[0])
    if isinstance(v, dict):
        for k in ('text', 'value', 'answer'):
            if k in v:
                return flat(v[k])
    return None


def substantive(values):
    """답 컬럼으로 쓸 수 있는 값인가. 정답 번호나 A/B/C/D 같은 라벨은 답이 아니다.

    라벨만 있는 컬럼으로 학습하면 모델은 "1" 이라고 답하도록 배운다. 그 데이터셋을
    연동 성공으로 세면 숫자를 세는 것이지 연동을 세는 것이 아니다.
    """
    vals = [v for v in values if v]
    if not vals:
        return False
    if all(len(v) <= 2 or v.replace('.', '', 1).lstrip('-').isdigit() for v in vals):
        return False
    return sum(len(v) for v in vals) / len(vals) >= 3


def pick(columns, rows, keys, require_substantive=False):
    ranked = [c for k in keys for c in columns if c.lower() == k] + \
             [c for k in keys for c in columns if k in c.lower() and c.lower() != k]
    for c in ranked:
        values = [flat(r.get(c)) for r in rows]
        if not any(values):
            continue
        if require_substantive and not substantive(values):
            continue
        return c
    return None


def plan_one(repo):
    out = {'id': repo, 'url': 'https://huggingface.co/datasets/' + repo}
    try:
        splits = api('/splits?dataset=' + urllib.parse.quote(repo))['splits']
    except Exception as e:
        return {**out, 'usable': False, 'reason': 'splits: ' + type(e).__name__ + ' ' + str(e)[:120]}
    order = sorted(splits, key=lambda s: (s['split'] != 'train', s['split'] != 'validation'))
    for s in order[:4]:
        q = '?dataset=%s&config=%s&split=%s' % (urllib.parse.quote(repo),
                                                urllib.parse.quote(s['config']), urllib.parse.quote(s['split']))
        try:
            fr = api('/first-rows' + q)
        except Exception:
            continue
        cols = [f['name'] for f in fr.get('features', [])]
        rows = [r.get('row', {}) for r in fr.get('rows', [])]
        if not rows:
            continue
        qc = pick(cols, rows, Q_KEYS)
        ac = pick([c for c in cols if c != qc], rows, A_KEYS, require_substantive=True)
        # 같은 질문에 서로 다른 답이 붙은 데이터셋은 노드가 통째로 거절한다 (dataset_empty:
        # conflicts). 한 질문에 한 답이 아닌 형식이므로, 계획 단계에서 미리 걸러 실행 시간을
        # 버리지 않는다. 첫 행들의 질문이 대부분 서로 달라야 통과한다.
        if qc and ac:
            prompts = [flat(r.get(qc)) for r in rows]
            prompts = [x for x in prompts if x]
            if not prompts or len(set(prompts)) < max(2, int(len(prompts) * 0.8)):
                continue
        if qc and ac:
            return {**out, 'usable': True, 'config': s['config'], 'split': s['split'],
                    'columns': {'prompt': qc, 'answer': ac}, 'features': cols,
                    'sample': {'prompt': flat(rows[0].get(qc)), 'answer': flat(rows[0].get(ac))}}
    return {**out, 'usable': False, 'reason': 'no viewer split with a question and an answer column',
            'splits_seen': [(s['config'], s['split']) for s in order[:4]]}


if __name__ == '__main__':
    cands = json.load(open(sys.argv[1]))
    want = int(sys.argv[3]) if len(sys.argv) > 3 else 120
    done = []
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for res in ex.map(plan_one, cands):
            done.append(res)
            ok = sum(1 for d in done if d.get('usable'))
            print(('OK  ' if res.get('usable') else 'skip'), res['id'],
                  '' if res.get('usable') else res.get('reason', '')[:70], '| 사용가능', ok, flush=True)
            json.dump(done, open(sys.argv[2], 'w'), ensure_ascii=False, indent=1)
            if ok >= want:
                break
    print('사용 가능 %d / 조사 %d' % (sum(1 for d in done if d.get('usable')), len(done)))
