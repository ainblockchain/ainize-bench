const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createServer } = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { verify } = require('../verify-hf-training-record');

const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => Buffer.from(JSON.stringify(value));

function fixture() {
  const publisher = `0x${'1'.repeat(40)}`;
  const txHash = `0x${'2'.repeat(64)}`;
  const genesisHash = `0x${'3'.repeat(64)}`;
  const nativePath = `/apps/knowledge/market/lessons/${publisher}/job-1`;
  const files = { input: Buffer.from('source bytes'), upload: Buffer.from('mapped bytes'),
    canonical: Buffer.from('{"prompt":"private question","answer":"private answer"}\n') };
  const source = { kind: 'huggingface', repository: 'owner/dataset', revision: 'a'.repeat(40),
    inputSha256: hash(files.input), inputBytes: files.input.length,
    sha256: hash(files.upload), bytes: files.upload.length };
  files.source = json(source);
  const receipt = { version: 1, kind: 'huggingface-import', source_file: 'source.json',
    source_file_sha256: hash(files.source), repository: source.repository, source_revision: source.revision,
    input_sha256: source.inputSha256, upload_sha256: source.sha256,
    dataset_id: 'dataset-1', dataset_sha256: hash(files.canonical), accepted_rows: 1, node_url: 'http://localhost:3410',
    job: { id: 'job-1', dataset_id: 'dataset-1', dataset_sha256: hash(files.canonical) } };
  files.receipt = json(receipt);
  const status = { kind: 'job', node: 'http://localhost:3410/', job: { id: 'job-1',
    dataset: { id: 'dataset-1', sha256: hash(files.canonical) },
    chain_submissions: [{ status: 'READY', outcome: 'submitted', path: nativePath, txHash, submittedAt: 100 }] } };
  files.status = json(status);
  const value = { status: 'READY', node: publisher, job: 'job-1', dataset_id: 'dataset-1',
    dataset_sha256: hash(files.canonical), submitted_at: 100, rows: 1, model_id: 'owner/model', backend: 'gradient' };
  const block = { number: 7, hash: `0x${'4'.repeat(64)}`, timestamp: 250,
    transactions: [{ hash: txHash, address: publisher, tx_body: { operation: { type: 'SET_VALUE', ref: nativePath, value } } }] };
  const info = { is_executed: true, is_finalized: true, number: 7, receipt: { code: 0 } };
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'ain_getBlockByNumber') return params.number === 0 ? { hash: genesisHash } : block;
    assert.equal(method, 'ain_getTransactionByHash');
    assert.equal(params.hash, txHash);
    return info;
  };
  return { input: { version: 1, publisher, genesisHash }, files, receipt, source, status, info, block, value, rpc, calls };
}

test('links three distinct byte hashes to a finalized READY record without claiming integration', async () => {
  const data = fixture();
  const result = await verify(data.input, data.files, data.rpc);
  assert.equal(result.bindingVerified, true);
  assert.equal(result.integrationVerified, false);
  assert.equal(result.latencyMs, 150);
  assert.equal(result.modelIdReported, 'owner/model');
  assert.equal(result.datasetId, 'dataset-1');
  assert.equal(new Set([result.inputSha256, result.uploadSha256, result.datasetSha256]).size, 3);
  assert.equal(JSON.stringify(result).includes('private question'), false);
  assert.equal(JSON.stringify(result).includes('localhost'), false);
  assert.equal(data.calls.length, 5);
  assert.ok(data.calls.filter(call => call.method === 'ain_getBlockByNumber').every(call => call.params.getFullTransactions === true));
});

for (const name of ['source', 'input', 'upload', 'canonical']) {
  test(`rejects changed ${name} bytes before RPC`, async () => {
    const data = fixture();
    data.files[name] = Buffer.from('{}');
    await assert.rejects(verify(data.input, data.files, data.rpc));
    assert.equal(data.calls.length, 0);
  });
}

for (const [name, mutate] of [
  ['dataset node', data => { data.status.node = 'http://different-node:3410'; }],
  ['job ID', data => { data.status.job.id = 'another-job'; }],
  ['dataset hash', data => { data.status.job.dataset.sha256 = 'f'.repeat(64); }],
  ['dataset ID', data => { data.status.job.dataset.id = 'another-dataset'; }],
  ['unconfirmed receipt', data => { data.status.job.chain_submissions[0].outcome = 'unconfirmed'; }],
  ['TRAINING-only receipt', data => { data.status.job.chain_submissions[0].status = 'TRAINING'; }],
  ['ambiguous READY receipt', data => { data.status.job.chain_submissions.push(data.status.job.chain_submissions[0]); }],
  ['publisher path', data => { data.input.publisher = `0x${'9'.repeat(40)}`; }],
]) {
  test(`rejects mismatched ${name}`, async () => {
    const data = fixture();
    mutate(data);
    data.files.status = json(data.status);
    await assert.rejects(verify(data.input, data.files, data.rpc));
    assert.equal(data.calls.length, 0);
  });
}

for (const [name, mutate] of [
  ['failed execution', data => { data.info.receipt.code = 12103; }],
  ['unfinalized execution', data => { data.info.is_finalized = false; }],
  ['missing block membership', data => { data.block.transactions = []; }],
  ['hash-only block membership', data => { data.block.transactions = [data.block.transactions[0].hash]; }],
  ['sender mismatch', data => { data.block.transactions[0].address = `0x${'9'.repeat(40)}`; }],
  ['chain dataset hash', data => { data.value.dataset_sha256 = 'f'.repeat(64); }],
  ['chain status', data => { data.value.status = 'TRAINING'; }],
  ['missing model', data => { delete data.value.model_id; }],
  ['missing backend', data => { delete data.value.backend; }],
  ['impossible row count', data => { data.value.rows = 2; }],
  ['submission clock', data => { data.value.submitted_at = 99; }],
]) {
  test(`rejects ${name}`, async () => {
    const data = fixture();
    mutate(data);
    await assert.rejects(verify(data.input, data.files, data.rpc));
  });
}

test('rejects chain switching and changed containing blocks on final read', async () => {
  for (const changedNumber of [0, 7]) {
    const data = fixture();
    let reads = 0;
    await assert.rejects(verify(data.input, data.files, async (method, params) => {
      const result = await data.rpc(method, params);
      if (method === 'ain_getBlockByNumber' && params.number === changedNumber && ++reads === 2) {
        return { ...result, hash: `0x${'f'.repeat(64)}` };
      }
      return result;
    }));
  }
});

test('a stub READY record remains a binding only, never real model integration', async () => {
  const data = fixture();
  data.value.backend = 'stub';
  const result = await verify(data.input, data.files, data.rpc);
  assert.equal(result.backendReported, 'stub');
  assert.equal(result.integrationVerified, false);
});

test('shell entrypoint reads files and RPC, protects output, and returns nonzero on invalid evidence', async () => {
  const data = fixture();
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-chain-binding-'));
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const query = JSON.parse(raw);
      assert.equal(query.params.protoVer, '1.0.0');
      const result = await data.rpc(query.method, query.params);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ result: { code: 0, result } }));
    } catch { response.statusCode = 500; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const manifest = path.join(folder, 'manifest.json');
  const output = path.join(folder, 'result.json');
  const script = path.resolve(__dirname, '../run-m6-verify-huggingface-training-record.sh');
  const invoke = () => promisify(execFile)('bash', [script, manifest, output], { timeout: 15000 });
  try {
    const files = {};
    for (const [name, bytes] of Object.entries(data.files)) {
      files[name] = path.join(folder, name);
      fs.writeFileSync(files[name], bytes);
    }
    fs.writeFileSync(manifest, JSON.stringify({ ...data.input, files, rpcUrl: `http://127.0.0.1:${server.address().port}/json-rpc` }));
    const first = await invoke();
    assert.equal(JSON.parse(first.stdout).bindingVerified, true);
    assert.equal(JSON.parse(first.stdout).integrationVerified, false);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const original = fs.readFileSync(output);
    await assert.rejects(invoke());
    assert.deepEqual(fs.readFileSync(output), original);
    fs.unlinkSync(output);
    fs.writeFileSync(files.canonical, 'private tampered evidence');
    await assert.rejects(invoke(), error => {
      assert.notEqual(error.code, 0);
      assert.equal(error.stdout.includes('bindingVerified'), false);
      assert.equal(error.stderr.includes('private tampered evidence'), false);
      return true;
    });
    assert.equal(fs.existsSync(output), false);
    assert.equal(data.calls.length, 5);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
