#!/usr/bin/env bash
# [지표 4] 추론 부하 시험용 Ainize 노드 5개를 세운다.
#
# Locust 시나리오(scripts/reproduction/locust_ainize.py)는 서로 다른 노드 5개의
# `POST /api/chat` 을 `mode: patched` 로 때리고, 응답에 실제 답·`ainize.result`·`[DONE]`·
# `inference_receipt` 가 모두 있어야 성공 1건으로 센다. 그래서 노드는
#   - 실제 서빙 런타임을 보고 있어야 하고
#   - AIN 원장을 써야 하며 (AINIZE_INFERENCE_RECORDS 가 로컬 원장을 거부한다)
#   - 대상 patch 를 이미 적용한 상태여야 한다 (요청마다 적용/해제하면 배타 잠금으로 직렬화된다)
#
# 이 스크립트는 노드만 세운다. 부하는 컨테이너 안의 Locust 실행기가 건다.
#
#   CHAIN_URLS=...   검증자 목록 (노드마다 하나씩 돌려가며 붙는다)
#   RUNTIME_API=...  서빙 런타임 (OpenAI 호환)
#   RUNTIME_REPO=... 패치 훅이 있는 런타임 저장소 경로
#   NODE_BIN=...     ainize-node 실행 파일
#   HOMES=...        노드 홈을 만들 디렉터리
#   PORT_BASE=3420   노드 i 는 PORT_BASE+i
set -uo pipefail

NODES=${NODES:-5}
PORT_BASE=${PORT_BASE:-3420}
HOMES=${HOMES:-/mnt/newdata/gov/kpi/m4/nodes}
TEMPLATE=${TEMPLATE:?TEMPLATE (기준 노드 홈) 이 필요합니다}
NODE_BIN=${NODE_BIN:?NODE_BIN 이 필요합니다}
AIN_UTIL=${AIN_UTIL:?AIN_UTIL 이 필요합니다}
CHAIN_URLS=${CHAIN_URLS:?CHAIN_URLS 가 필요합니다}
RUNTIME_API=${RUNTIME_API:-http://localhost:8000}
RUNTIME_REPO=${RUNTIME_REPO:-}
LEDGER_POLL_MS=${LEDGER_POLL_MS:-120000}
LOGS=${LOGS:-/mnt/newdata/gov/kpi/m4/logs}

mkdir -p "$HOMES" "$LOGS"
export NODES PORT_BASE HOMES TEMPLATE AIN_UTIL CHAIN_URLS RUNTIME_API RUNTIME_REPO LEDGER_POLL_MS

python3 - <<'PY'
import json, os, shutil, subprocess

n, base = int(os.environ['NODES']), int(os.environ['PORT_BASE'])
homes, tpl = os.environ['HOMES'], os.environ['TEMPLATE']
urls = [u.strip() for u in os.environ['CHAIN_URLS'].split(',') if u.strip()]
au = os.environ['AIN_UTIL']
cfg0 = json.load(open(os.path.join(tpl, 'config.json')))

for i in range(1, n + 1):
    home = os.path.join(homes, 'm4-%d' % i)
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(os.path.join(home, 'data'))
    out = subprocess.run(['node', '-e',
        "const u=require('%s');const a=u.createAccount();"
        "console.log(JSON.stringify({address:a.address,privateKey:a.private_key.toString('hex'),"
        "publicKey:a.public_key.toString('hex')}))" % au], capture_output=True, text=True)
    acct = json.loads(out.stdout.strip().split('\n')[-1])
    c = json.loads(json.dumps(cfg0))
    c['name'] = 'cert-m4-%d' % i
    c['dataDir'] = os.path.join(home, 'data')
    c['port'] = base + i
    c['host'] = '127.0.0.1'
    c['roles'] = ['serving', 'seller']
    c['peers'] = []
    c['identity'] = acct
    c['ledger'] = {'kind': 'ain', 'ain': {
        'providerUrl': urls[(i - 1) % len(urls)], 'eventHandlerUrl': None, 'chainId': 0,
        'appName': 'knowledge', 'pollMs': int(os.environ['LEDGER_POLL_MS'])}}
    runtime = dict(c.get('runtime') or {})
    runtime['api'] = os.environ['RUNTIME_API']
    if os.environ.get('RUNTIME_REPO'):
        runtime['repo'] = os.environ['RUNTIME_REPO']
    c['runtime'] = runtime
    # 부하 시험 중에는 학습을 받지 않는다. 학습이 배타 잠금을 잡으면 추론이 멈춘다.
    c['teach'] = {**(c.get('teach') or {}), 'enabled': False}
    c['p2p'] = {'acceptExchange': False, 'maxPeers': 4}
    c.pop('operatorPasswordHash', None)
    json.dump(c, open(os.path.join(home, 'config.json'), 'w'), indent=1)
    print('node %d  port %d  %s  chain %s' % (i, base + i, acct['address'], c['ledger']['ain']['providerUrl']))
PY

for i in $(seq 1 "$NODES"); do
  home=$HOMES/m4-$i
  setsid env AINIZE_HOME="$home" AINIZE_INFERENCE_RECORDS=true node "$NODE_BIN" \
    > "$LOGS/m4-node-$i.log" 2>&1 < /dev/null &
done

for i in $(seq 1 "$NODES"); do
  port=$((PORT_BASE + i)); ok=0
  for t in $(seq 1 120); do
    curl -sf -m 3 "http://localhost:$port/api/info" >/dev/null 2>&1 && { ok=1; break; }
    sleep 2
  done
  echo "node $i (:$port) $([ "$ok" = 1 ] && echo ready || echo 'NOT ready')"
done
