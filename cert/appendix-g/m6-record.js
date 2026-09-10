// M6: lm-eval 결과 100종 온체인 기록·역검증
const { newAin, APP, writeResult, sleep, KPI_DIR } = require('../common');
const fs = require('fs');
const path = require('path');

const OUT = process.env.EVAL_RESULTS || `${KPI_DIR}/eval_results`;
const BASE = `/apps/${APP}/model_evaluation`;
// AIN DB 경로 라벨은 '.' 불허 (code 10102) → 영숫자/_/- 만 허용
const MODEL_TAG = (process.env.M6_MODEL || 'Qwen/Qwen2.5-1.5B-Instruct').replace(/[^A-Za-z0-9_\-]/g, '_');

function findResultsFile(dir) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/^results.*\.json$/.test(e.name)) return p;
    }
  }
  return null;
}

(async () => {
  const tasks = fs.readFileSync(`${__dirname}/datasets100.txt`, 'utf8').split('\n').filter(Boolean);
  const ain = newAin(2, null, 13);
  let recorded = 0;
  const details = [];
  for (const t of tasks) {
    const dir = path.join(OUT, t);
    if (!fs.existsSync(dir)) { details.push({ task: t, ok: false, error: 'no output dir' }); continue; }
    const file = findResultsFile(dir);
    if (!file) { details.push({ task: t, ok: false, error: 'no results json' }); continue; }
    try {
      const results = JSON.parse(fs.readFileSync(file));
      const key = Object.keys(results.results)[0];
      const metrics = results.results[key];
      const nsamp = results.n_samples ? (Object.values(results.n_samples)[0] || {}) : {};
      // 절차서 §9.5 메트릭 유효성: 0 ≤ (acc|exact_match|…) ≤ 1, 샘플 수 > 0, 메트릭 존재
      const samples = nsamp.effective ?? nsamp.original ?? 0;
      // accuracy 계열은 [0,1] 범위, perplexity 계열(wikitext 등)은 > 0 이면 유효. 둘 중 하나 이상 존재해야 한다.
      const nums = Object.entries(metrics).filter(([k, v]) => !k.endsWith('_stderr') && k !== 'alias' && typeof v === 'number');
      const accLike = nums.filter(([k]) => !/perplexity|bits_per_byte/.test(k));
      const pplLike = nums.filter(([k]) => /perplexity|bits_per_byte/.test(k));
      const valid = samples > 0 && nums.length > 0 && accLike.every(([, v]) => v >= 0 && v <= 1) && pplLike.every(([, v]) => v > 0);
      if (!valid) { details.push({ task: t, ok: false, error: `invalid metrics: samples=${samples} metrics=${JSON.stringify(metrics).slice(0, 120)}` }); continue; }
      const res = await ain.db.ref(`${BASE}/${MODEL_TAG}/${t}`).setValue({
        value: { modelName: MODEL_TAG, dataset: t, timestamp: Date.now(),
                 samples, metrics, metricsValid: true },
        gas_price: 1, nonce: -1,
      });
      if (res.tx_hash && res.result.code === 0) { recorded++; details.push({ task: t, ok: true }); }
      else details.push({ task: t, ok: false, error: 'tx failed' });
    } catch (e) { details.push({ task: t, ok: false, error: String(e.message).slice(0, 120) }); }
  }
  await sleep(5000);
  let verified = 0;
  for (const t of tasks) {
    const v = await ain.db.ref(`${BASE}/${MODEL_TAG}/${t}`).getValue().catch(() => null);
    if (v && v.dataset === t && v.metrics !== undefined) verified++;
  }
  const final = {
    metric: 'M6_dataset_support', target: 100, tasks: tasks.length,
    recorded, verifiedOnChain: verified,
    failures: details.filter(d => !d.ok),
    pass: verified >= 100,
  };
  writeResult('m6-lmeval-final', final);
  console.log(JSON.stringify({ ...final, failures: final.failures.length }, null, 2));
  process.exit(final.pass ? 0 : 1);
})();
