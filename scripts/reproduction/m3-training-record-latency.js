const fs = require('node:fs');
const path = require('node:path');

async function measure(manifest, rpc) {
  if (!manifest || manifest.version !== 1 || !manifest.runId || !manifest.genesisHash || !Array.isArray(manifest.jobs) || manifest.jobs.length !== 70) {
    throw new Error('Metric 1 manifest must identify exactly 70 training jobs and their chain');
  }
  for (const job of manifest.jobs) {
    if (!job || !['nodeId', 'jobId', 'datasetId', 'path', 'txHash'].every(key => typeof job[key] === 'string' && job[key].length > 0)
      || job.nodeId.includes('/') || job.jobId.includes('/')
      || job.path !== `/apps/knowledge/market/lessons/${job.nodeId}/${job.jobId}`
      || !Number.isSafeInteger(job.submittedAt) || job.submittedAt <= 0) throw new Error('Incomplete or inconsistent metric 1 submission evidence');
  }
  if (new Set(manifest.jobs.map(job => `${job.nodeId}/${job.jobId}`)).size !== 70
    || new Set(manifest.jobs.map(job => job.txHash)).size !== 70) throw new Error('Duplicate jobs or transaction hashes');
  const genesis = await rpc('ain_getBlockByNumber', { number: 0 });
  if (genesis?.hash !== manifest.genesisHash) throw new Error('Metric 1 chain identity mismatch');
  const records = [];
  for (const job of manifest.jobs) {
    try {
      const info = await rpc('ain_getTransactionByHash', { hash: job.txHash });
      if (!Number.isSafeInteger(info?.number) || info.number < 0) throw new Error('Transaction not included');
      if (info.is_executed !== true || info.is_finalized !== true || info.receipt?.code !== 0) {
        throw new Error('Successful finalized execution not confirmed');
      }
      const block = await rpc('ain_getBlockByNumber', { number: info.number, getFullTransactions: true });
      if (block?.number !== info.number || typeof block.hash !== 'string' || !block.hash) throw new Error('Containing block identity mismatch');
      const transaction = block?.transactions?.find(item => item.hash === job.txHash);
      const operation = transaction?.tx_body?.operation;
      if (!operation || operation.type !== 'SET_VALUE' || operation.ref !== job.path) throw new Error('Block membership or record path mismatch');
      const value = operation.value;
      if (!value || value.status !== 'TRAINING' || value.dataset_id !== job.datasetId
        || value.submitted_at !== job.submittedAt) throw new Error('Training state, dataset or submission timestamp mismatch');
      if (!Number.isSafeInteger(block.timestamp) || block.timestamp < job.submittedAt) throw new Error('Invalid block clock');
      records.push({ ...job, includedAt: block.timestamp, blockNumber: block.number, blockHash: block.hash, latencyMs: block.timestamp - job.submittedAt });
    } catch (error) {
      records.push({ ...job, error: error.message });
    }
  }
  const blocks = new Map();
  for (const record of records) {
    if (record.error) continue;
    try {
      if (!blocks.has(record.blockNumber)) {
        blocks.set(record.blockNumber, await rpc('ain_getBlockByNumber', { number: record.blockNumber }));
      }
      const current = blocks.get(record.blockNumber);
      if (current?.number !== record.blockNumber || current.hash !== record.blockHash) {
        throw new Error('Containing block changed before measurement completed');
      }
    } catch (error) {
      record.error = error.message;
      delete record.latencyMs;
    }
  }
  const included = records.filter(record => record.latencyMs !== undefined);
  const complete = included.length === 70;
  return { version: 1, runId: manifest.runId, genesisHash: manifest.genesisHash, measuredAt: Date.now(),
    expected: 70, included: included.length, unresolved: 70 - included.length, complete,
    averageMs: complete ? included.reduce((total, record) => total + record.latencyMs, 0) / 70 : null,
    definition: 'reported submission to block inclusion for one matching TRAINING transaction per metric 1 job', records };
}

async function main() {
  const [manifestPath, outputPath] = process.argv.slice(2);
  if (!manifestPath || !outputPath) throw new Error('Manifest and output paths required');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const endpoint = new URL(manifest.rpcUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Invalid RPC URL');
  const rpc = async (method, params) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { protoVer: '1.0.0', ...params } }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body = await response.json();
    if (body.error || body.result?.code) throw new Error('RPC rejected request');
    return body.result && 'result' in body.result ? body.result.result : body.result;
  };
  const result = await measure(manifest, rpc);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, outputPath);
  console.log(JSON.stringify({ included: result.included, expected: 70, averageMs: result.averageMs, complete: result.complete, outputPath }));
  if (!result.complete) process.exitCode = 1;
}

module.exports = { measure };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
