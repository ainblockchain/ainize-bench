const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const transactionHash = value => typeof value === 'string' && /^0x[a-f0-9]{64}$/i.test(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

function endpoint(value) {
  const url = new URL(value);
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'Use an HTTP(S) endpoint without credentials or query parameters');
  return url.href.replace(/\/$/, '');
}

async function verify(input, files, rpc) {
  assert.equal(input.version, 1);
  assert.ok(transactionHash(input.genesisHash), 'Expected chain genesis required');
  assert.match(input.publisher, /^0x[a-fA-F0-9]{40}$/);
  const source = JSON.parse(files.source);
  const receipt = JSON.parse(files.receipt);
  const status = JSON.parse(files.status);
  assert.equal(source.kind, 'huggingface');
  assert.equal(receipt.version, 1);
  assert.equal(receipt.kind, 'huggingface-import');
  assert.equal(receipt.source_file, 'source.json');
  assert.equal(hash(files.source), receipt.source_file_sha256, 'Source metadata hash mismatch');
  assert.match(source.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(source.revision, /^[a-f0-9]{40}$/);
  assert.equal(source.repository, receipt.repository);
  assert.equal(source.revision, receipt.source_revision);
  for (const [name, sourceHash, receiptHash, bytes] of [
    ['input', source.inputSha256, receipt.input_sha256, source.inputBytes],
    ['upload', source.sha256, receipt.upload_sha256, source.bytes],
  ]) {
    assert.ok(digest(sourceHash));
    assert.equal(sourceHash, receiptHash, `${name} receipt hash mismatch`);
    assert.equal(hash(files[name]), sourceHash, `${name} bytes mismatch`);
    assert.equal(files[name].length, bytes, `${name} byte count mismatch`);
  }
  assert.ok(identifier(receipt.dataset_id) && digest(receipt.dataset_sha256));
  assert.equal(hash(files.canonical), receipt.dataset_sha256, 'Canonical dataset hash mismatch');
  const rows = files.canonical.toString('utf8').trim().split('\n').filter(line => line.trim());
  assert.ok(Number.isSafeInteger(receipt.accepted_rows) && receipt.accepted_rows > 0);
  assert.equal(rows.length, receipt.accepted_rows, 'Canonical row count mismatch');
  for (const line of rows) JSON.parse(line);
  assert.equal(status.kind, 'job');
  assert.equal(endpoint(status.node), endpoint(receipt.node_url), 'Dataset node mismatch');
  const job = status.job;
  assert.ok(identifier(job?.id) && receipt.job, 'Training admission receipt required');
  assert.equal(job.id, receipt.job.id);
  for (const binding of [receipt.job, { dataset_id: job.dataset?.id, dataset_sha256: job.dataset?.sha256 }]) {
    assert.equal(binding.dataset_id, receipt.dataset_id, 'Job dataset ID mismatch');
    assert.equal(binding.dataset_sha256, receipt.dataset_sha256, 'Job dataset hash mismatch');
  }
  const ready = job.chain_submissions?.filter(entry => entry.status === 'READY');
  assert.ok(Array.isArray(ready) && ready.length === 1, 'Exactly one READY submission required; no TRAINING or latest-TX fallback');
  const submission = ready[0];
  const nativePath = `/apps/knowledge/market/lessons/${input.publisher}/${job.id}`;
  assert.equal(submission.path, nativePath);
  assert.equal(submission.outcome, 'submitted');
  assert.ok(transactionHash(submission.txHash));
  assert.ok(Number.isSafeInteger(submission.submittedAt) && submission.submittedAt > 0);
  const genesis = await rpc('ain_getBlockByNumber', { number: 0, getFullTransactions: true });
  assert.equal(genesis?.hash, input.genesisHash, 'Chain identity mismatch');
  const info = await rpc('ain_getTransactionByHash', { hash: submission.txHash });
  assert.equal(info?.is_executed, true);
  assert.equal(info?.is_finalized, true);
  assert.equal(info?.receipt?.code, 0, 'Successful execution required');
  assert.ok(Number.isSafeInteger(info.number) && info.number >= 0);
  const block = await rpc('ain_getBlockByNumber', { number: info.number, getFullTransactions: true });
  assert.equal(block?.number, info.number);
  assert.ok(transactionHash(block.hash));
  const matches = block.transactions?.filter(entry => entry?.hash === submission.txHash);
  assert.ok(Array.isArray(matches) && matches.length === 1, 'Exact full-block membership required');
  const transaction = matches[0];
  assert.equal(transaction.address?.toLowerCase(), input.publisher.toLowerCase(), 'Publisher signature address mismatch');
  const operation = transaction.tx_body?.operation;
  assert.equal(operation?.type, 'SET_VALUE');
  assert.equal(operation.ref, nativePath);
  const value = operation.value;
  assert.equal(value?.status, 'READY');
  assert.equal(value.node, input.publisher);
  assert.equal(value.job, job.id);
  assert.equal(value.dataset_id, receipt.dataset_id);
  assert.equal(value.dataset_sha256, receipt.dataset_sha256);
  assert.equal(value.submitted_at, submission.submittedAt);
  assert.ok(Number.isSafeInteger(value.rows) && value.rows > 0 && value.rows <= receipt.accepted_rows);
  assert.ok(typeof value.model_id === 'string' && value.model_id.trim() && value.model_id.length <= 512, 'Recorded model ID required');
  assert.ok(typeof value.backend === 'string' && value.backend.length > 0, 'Recorded backend required');
  assert.ok(Number.isSafeInteger(block.timestamp) && block.timestamp >= submission.submittedAt);
  const finalBlock = await rpc('ain_getBlockByNumber', { number: block.number, getFullTransactions: true });
  assert.equal(finalBlock?.hash, block.hash, 'Containing block changed');
  const finalGenesis = await rpc('ain_getBlockByNumber', { number: 0, getFullTransactions: true });
  assert.equal(finalGenesis?.hash, input.genesisHash, 'Chain identity changed');
  return { version: 1, bindingVerified: true, checkedAt: Date.now(), genesisHash: input.genesisHash,
    repository: source.repository, revision: source.revision, sourceFileSha256: receipt.source_file_sha256,
    inputSha256: receipt.input_sha256, uploadSha256: receipt.upload_sha256, datasetId: receipt.dataset_id,
    datasetSha256: receipt.dataset_sha256, acceptedRows: receipt.accepted_rows, trainedRowsReported: value.rows,
    jobId: job.id, publisher: input.publisher, path: nativePath, txHash: submission.txHash,
    blockNumber: block.number, blockHash: block.hash, modelIdReported: value.model_id, backendReported: value.backend,
    latencyMs: block.timestamp - submission.submittedAt,
    integrationVerified: false,
    scope: 'Local HF file hashes and job bindings match a finalized native READY write on the selected RPC. Not independent HF provenance, GPU training, model revision, patch application, inference or metric 6 completion proof.' };
}

async function main() {
  const [inputFile, outputFile] = process.argv.slice(2);
  assert.ok(inputFile && outputFile, 'Input manifest and new result file required');
  assert.ok(!fs.existsSync(outputFile), 'Choose a new result file');
  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const url = endpoint(input.rpcUrl);
  const files = {};
  for (const name of ['source', 'receipt', 'input', 'upload', 'canonical', 'status']) {
    const filename = input.files?.[name];
    assert.ok(typeof filename === 'string' && path.isAbsolute(filename), `Absolute ${name} file path required`);
    const stat = fs.statSync(filename);
    assert.ok(stat.isFile() && stat.size <= 64 * 1024 * 1024, 'Evidence files must be regular files at most 64 MiB');
    files[name] = fs.readFileSync(filename);
  }
  const rpc = async (method, params) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, protoVer: '1.0.0' } }), signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200, 'RPC HTTP failure');
    const body = await response.json();
    assert.ok(!body.error && !body.result?.code, 'RPC rejected query');
    return body.result && Object.hasOwn(body.result, 'result') ? body.result.result : body.result;
  };
  const result = await verify(input, files, rpc);
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ bindingVerified: true, integrationVerified: false, txHash: result.txHash, outputFile }));
}

module.exports = { verify };
if (require.main === module) main().catch(() => {
  console.error('HF training record binding could not be verified. No successful result written; inspect local hashes, job receipts and RPC evidence. No training or publication was requested.');
  process.exitCode = 1;
});
