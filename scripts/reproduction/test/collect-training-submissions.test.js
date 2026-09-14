const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collect, statusArgs } = require('../collect-training-submissions');
const { measure } = require('../m3-training-record-latency');

function fixture() {
  const targets = Array.from({ length: 70 }, (_, index) => ({ nodeUrl: 'http://localhost:3400', jobId: `job-${index}`, keyFile: '/private/teacher.json' }));
  const input = { version: 1, runId: 'fixture', rpcUrl: 'http://localhost:8080/json-rpc', genesisHash: 'genesis', targets };
  const read = async target => ({ kind: 'job', owner: true, job: { id: target.jobId, dataset: { id: `dataset-${target.jobId}` },
    facts: [{ prompt: 'private question' }], chain: { tx_hash: 'later-ready-tx' }, chain_submissions: [
      { status: 'TRAINING', outcome: 'submitted', path: `/apps/knowledge/market/lessons/node/${target.jobId}`, txHash: `tx-${target.jobId}`, submittedAt: 1000 },
      { status: 'READY', outcome: 'submitted', txHash: 'later-ready-tx', submittedAt: 2000 },
    ] } });
  return { input, read };
}

test('collects 70 original training receipts without exporting questions or key paths', async () => {
  const { input, read } = fixture();
  const manifest = await collect(input, read);
  assert.equal(manifest.jobs.length, 70);
  assert.equal(manifest.jobs[0].txHash, 'tx-job-0');
  assert.ok(!JSON.stringify(manifest).includes('private'));
  assert.deepEqual(statusArgs(input.targets[0]), ['--node', 'http://localhost:3400', 'teach', 'status', 'job-0', '--key-file', '/private/teacher.json', '--json']);
  const rpc = async (method, params) => {
    if (method === 'ain_getTransactionByHash') return { number: Number(params.hash.split('-').at(-1)) + 1 };
    if (params.number === 0) return { hash: 'genesis' };
    const job = manifest.jobs[params.number - 1];
    return { number: params.number, hash: `block-${params.number}`, timestamp: 1020, transactions: [
      { hash: job.txHash, tx_body: { operation: { type: 'SET_VALUE', ref: job.path, value: { status: 'TRAINING', dataset_id: job.datasetId, submitted_at: job.submittedAt } } } },
    ] };
  };
  assert.equal((await measure(manifest, rpc)).averageMs, 20);
});

test('missing, unowned, mismatched and unconfirmed receipts cannot use the latest completion transaction', async () => {
  for (const change of [
    result => { result.owner = false; },
    result => { result.job.chain_submissions = []; },
    result => { result.job.chain_submissions[0].outcome = 'unconfirmed'; },
    result => { result.job.id = 'other'; },
    result => { result.job.chain_submissions[0].path = '/apps/knowledge/market/lessons/node/other'; },
  ]) {
    const { input, read } = fixture();
    await assert.rejects(collect(input, async target => { const result = await read(target); change(result); return result; }));
  }
});

test('invalid target lists fail before requests; subprocess errors do not leak their output', async () => {
  const { input } = fixture();
  input.targets[1] = input.targets[0];
  await assert.rejects(collect(input, () => { assert.fail('must not query invalid targets'); }), /Duplicate/);
  const valid = fixture();
  await assert.rejects(collect(valid.input, async () => { throw new Error('private credential detail'); }), error => !error.message.includes('private'));
});
