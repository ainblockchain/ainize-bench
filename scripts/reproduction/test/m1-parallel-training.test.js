const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launch, trainArgs } = require('../m1-parallel-training');
const { collect } = require('../collect-training-submissions');

const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
function input() {
  return { version: 1, runId: 'fixture', rpcUrl: 'http://localhost:8080', genesisHash: 'genesis',
    datasets: Array.from({ length: 70 }, (_, index) => ({ nodeUrl: 'http://localhost:3400', datasetId: uuid(index), keyFile: '/private/key.json' })) };
}

test('starts all 70 invocations before any completion and feeds targets into receipt collection', async () => {
  let invoked = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const stored = [];
  const result = await launch(input(), async dataset => {
    invoked++;
    if (invoked === 70) release();
    await barrier;
    return { dataset_id: dataset.datasetId, job: { id: dataset.datasetId } };
  }, receipt => { stored.push(receipt); });
  assert.equal(invoked, 70);
  assert.equal(stored.length, 70);
  assert.equal(result.report.submissionComplete, true);
  assert.equal(result.report.trainingConcurrencyVerified, false);
  assert.ok(!JSON.stringify(result.report).includes('/private/'));
  assert.deepEqual(trainArgs({ ...input().datasets[0], effort: 'quick' }), ['--node', 'http://localhost:3400', 'teach', uuid(0), '--key-file', '/private/key.json', '--effort', 'quick', '--json']);
  const manifest = await collect(result.targets, async target => ({ kind: 'job', owner: true, job: {
    id: target.jobId, dataset: { id: target.jobId }, chain_submissions: [{ status: 'TRAINING', outcome: 'submitted',
      path: `/apps/knowledge/market/lessons/node/${target.jobId}`, txHash: `tx-${target.jobId}`, submittedAt: 1000 }],
  } }));
  assert.equal(manifest.jobs.length, 70);
});

test('ambiguous failures are journaled without retry or complete target output', async () => {
  let invoked = 0;
  const result = await launch(input(), async dataset => {
    invoked++;
    if (dataset.datasetId === uuid(0)) throw new Error('secret subprocess detail');
    return { dataset_id: dataset.datasetId, job: { id: dataset.datasetId } };
  });
  assert.equal(invoked, 70);
  assert.equal(result.report.accepted, 69);
  assert.equal(result.report.submissionComplete, false);
  assert.equal(result.targets, null);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('validates the complete assignment list before side effects', async () => {
  for (const change of [
    config => { config.datasets.pop(); },
    config => { config.datasets[1] = config.datasets[0]; },
    config => { config.datasets[0].datasetId = './file.csv'; },
    config => { config.datasets[0].keyFile = 'relative.json'; },
  ]) {
    const config = input();
    change(config);
    await assert.rejects(launch(config, () => { assert.fail('must not submit'); }));
  }
});
