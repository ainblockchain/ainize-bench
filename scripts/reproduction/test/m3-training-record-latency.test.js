const { test } = require('node:test');
const assert = require('node:assert/strict');
const { measure } = require('../m3-training-record-latency');

function fixture(change = () => {}) {
  const jobs = Array.from({ length: 70 }, (_, index) => ({ nodeId: 'node', jobId: `job-${index}`, datasetId: `dataset-${index}`,
    path: `/apps/knowledge/market/lessons/node/job-${index}`, txHash: `tx-${index}`, submittedAt: 1000 }));
  const manifest = { version: 1, runId: 'fixture', genesisHash: 'genesis', jobs };
  const rpc = async (method, params) => {
    if (method === 'ain_getTransactionByHash') return { number: Number(params.hash.slice(3)) + 1,
      is_executed: true, is_finalized: true, receipt: { code: 0 } };
    if (params.number === 0) return { number: 0, hash: 'genesis' };
    const job = jobs[params.number - 1];
    const block = { number: params.number, hash: `block-${params.number}`, timestamp: 1025,
      transactions: [{ hash: job.txHash, tx_body: { operation: { type: 'SET_VALUE', ref: job.path,
        value: { status: 'TRAINING', dataset_id: job.datasetId, submitted_at: job.submittedAt } } } }] };
    if (params.number === 1) change(block);
    return block;
  };
  return { manifest, rpc };
}

test('averages exactly 70 matching training-start inclusions', async () => {
  const { manifest, rpc } = fixture();
  const result = await measure(manifest, rpc);
  assert.equal(result.complete, true);
  assert.equal(result.included, 70);
  assert.equal(result.averageMs, 25);
});

test('one mismatched record prevents a reduced-denominator average', async () => {
  for (const change of [
    block => { block.transactions[0].tx_body.operation.value.status = 'READY'; },
    block => { block.transactions[0].tx_body.operation.value.dataset_id = 'other'; },
    block => { block.transactions[0].tx_body.operation.value.submitted_at = 999; },
    block => { block.transactions[0].tx_body.operation.type = 'SET_RULE'; },
    block => { block.transactions[0].tx_body.operation.ref = '/other'; },
    block => { block.transactions = []; },
    block => { block.number = 2; },
    block => { block.timestamp = 999; },
  ]) {
    const { manifest, rpc } = fixture(change);
    const result = await measure(manifest, rpc);
    assert.equal(result.complete, false);
    assert.equal(result.included, 69);
    assert.equal(result.averageMs, null);
    assert.ok(result.records[0].error);
  }
});

test('rejects malformed, duplicate, wrong-chain and wrong-job manifests', async () => {
  for (const change of [
    manifest => { manifest.jobs.pop(); },
    manifest => { manifest.jobs[1] = manifest.jobs[0]; },
    manifest => { manifest.jobs[0] = null; },
    manifest => { manifest.jobs[0].jobId = 'other'; },
    manifest => { manifest.genesisHash = 'other-chain'; },
  ]) {
    const { manifest, rpc } = fixture();
    change(manifest);
    await assert.rejects(measure(manifest, rpc));
  }
});

test('failed, unexecuted, pending and missing execution receipts prevent an average', async () => {
  for (const override of [
    { receipt: { code: 12103 } }, { receipt: undefined }, { receipt: { code: '0' } },
    { is_executed: false }, { is_executed: undefined }, { is_finalized: false }, { is_finalized: undefined },
  ]) {
    const { manifest, rpc } = fixture();
    const result = await measure(manifest, async (method, params) => {
      const value = await rpc(method, params);
      return method === 'ain_getTransactionByHash' && params.hash === 'tx-0' ? { ...value, ...override } : value;
    });
    assert.equal(result.included, 69);
    assert.equal(result.complete, false);
    assert.equal(result.averageMs, null);
    assert.match(result.records[0].error, /Successful finalized execution/);
  }
});

test('changed or unavailable containing blocks invalidate the original measurement', async () => {
  for (const unavailable of [false, true]) {
    const { manifest, rpc } = fixture();
    const result = await measure(manifest, async (method, params) => {
      if (method === 'ain_getBlockByNumber' && params.number === 1 && !params.getFullTransactions) {
        if (unavailable) throw new Error('RPC unavailable');
        return { number: 1, hash: 'replacement-block' };
      }
      return rpc(method, params);
    });
    assert.equal(result.included, 69);
    assert.equal(result.complete, false);
    assert.equal(result.averageMs, null);
    assert.equal(result.records[0].latencyMs, undefined);
    assert.match(result.records[0].error, /changed|unavailable/);
  }
});
