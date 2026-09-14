const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
const sha = value => createHash('sha256').update(canonical(value)).digest('hex');
const validTime = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
const hex = value => typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value);
const address = value => typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
function endpoint(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid endpoint');
  return value.replace(/\/+$/, '');
}
function receipt(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'completed_at,id,model_id'
    || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id)
    || typeof value.model_id !== 'string' || !value.model_id.trim() || value.model_id.length > 512
    || !validTime(value.completed_at)) throw new Error('Invalid completion receipt');
  return value;
}

async function reconcile(input, rpc) {
  if (!input || input.version !== 1 || !hex(input.genesisHash) || !Array.isArray(input.nodes) || input.nodes.length !== 5
    || !Array.isArray(input.clientRecords) || !input.clientRecords.length || input.clientRecords.length > 500000
    || !Array.isArray(input.batches) || input.batches.length > 5000) throw new Error('Expected five nodes and bounded receipt evidence');
  const nodes = new Map(input.nodes.map(node => {
    if (!address(node.address)) throw new Error('Invalid expected node address');
    return [endpoint(node.url), node.address.toLowerCase()];
  }));
  if (nodes.size !== 5 || new Set(nodes.values()).size !== 5) throw new Error('Five distinct node endpoints and identities required');
  const clients = new Map();
  for (const record of input.clientRecords) {
    const node = endpoint(record.node_url);
    receipt(record.receipt);
    if (record.version !== 1 || !nodes.has(node) || !validTime(record.client_started_at) || !validTime(record.client_completed_at)
      || record.client_completed_at < record.client_started_at) throw new Error('Invalid client observation');
    const key = `${node}/${record.receipt.id}`;
    if (clients.has(key)) throw new Error('Duplicate client receipt');
    clients.set(key, { ...record, node_url: node });
  }
  if ((await rpc('ain_getBlockByNumber', { number: 0, getFullTransactions: true }))?.hash !== input.genesisHash) throw new Error('Chain identity mismatch');
  const verified = new Map();
  const seenReceipts = new Set();
  const seenTransactions = new Set();
  const errors = [];
  const blocks = new Map();
  for (const exported of input.batches) {
    try {
      const node = endpoint(exported.nodeUrl);
      const expectedAddress = nodes.get(node);
      const batch = exported.batch;
      const match = /^\/apps\/knowledge\/market\/inference_batches\/(0x[a-fA-F0-9]{40})\/([a-f0-9]{64})$/.exec(exported.path ?? '');
      if (!expectedAddress || !match || match[1].toLowerCase() !== expectedAddress || exported.state !== 'submitted'
        || !hex(exported.tx_hash) || !batch || Object.keys(batch).sort().join(',') !== 'finished_at,model_id,receipt_root,request_count,started_at,version'
        || batch.version !== 1 || !validTime(batch.started_at) || !validTime(batch.finished_at) || batch.finished_at <= batch.started_at
        || !Number.isSafeInteger(batch.request_count) || batch.request_count < 1
        || !Array.isArray(exported.receipts) || exported.receipts.length > 5000 || exported.receipts.length !== batch.request_count) throw new Error('Invalid submitted batch');
      if (seenTransactions.has(exported.tx_hash)) throw new Error('Duplicate batch transaction');
      seenTransactions.add(exported.tx_hash);
      for (const item of exported.receipts) {
        receipt(item);
        if (item.model_id !== batch.model_id || item.completed_at < batch.started_at || item.completed_at > batch.finished_at) throw new Error('Receipt outside batch model or interval');
        const key = `${node}/${item.id}`;
        if (seenReceipts.has(key)) throw new Error('Receipt appears in multiple batch positions');
        seenReceipts.add(key);
      }
      const value = { ...batch, node: match[1] };
      if (sha(exported.receipts) !== batch.receipt_root || sha(value) !== match[2]) throw new Error('Receipt commitment or content-addressed path mismatch');
      const info = await rpc('ain_getTransactionByHash', { hash: exported.tx_hash });
      if (!Number.isSafeInteger(info?.number) || info.number < 0 || info.is_finalized !== true || info.is_executed !== true
        || info.receipt?.code !== 0) throw new Error('Successful finalized execution not confirmed');
      const block = await rpc('ain_getBlockByNumber', { number: info.number, getFullTransactions: true });
      if (block?.number !== info.number || !hex(block.hash)) throw new Error('Containing block identity mismatch');
      const transaction = block.transactions?.find(item => item.hash === exported.tx_hash);
      const operation = transaction?.tx_body?.operation;
      if (transaction?.address?.toLowerCase() !== expectedAddress || operation?.type !== 'SET_VALUE'
        || operation.ref !== exported.path || canonical(operation.value) !== canonical(value)) throw new Error('Block membership, signer or native value mismatch');
      if (blocks.has(block.number) && blocks.get(block.number) !== block.hash) throw new Error('Containing block changed during reconciliation');
      blocks.set(block.number, block.hash);
      for (const item of exported.receipts) verified.set(`${node}/${item.id}`, { receipt: item, txHash: exported.tx_hash,
        path: exported.path, blockNumber: block.number, blockHash: block.hash });
    } catch (error) { errors.push({ txHash: hex(exported?.tx_hash) ? exported.tx_hash : null, error: error.message }); }
  }
  for (const [number, hash] of blocks) {
    if ((await rpc('ain_getBlockByNumber', { number, getFullTransactions: number === 0 }))?.hash !== hash) errors.push({ error: 'Containing block changed before verification completed', blockNumber: number });
  }
  const matches = [];
  const missing = [];
  for (const [key, client] of clients) {
    const proof = verified.get(key);
    if (!proof || canonical(proof.receipt) !== canonical(client.receipt)) missing.push({ nodeUrl: client.node_url, receiptId: client.receipt.id });
    else matches.push({ nodeUrl: client.node_url, receiptId: client.receipt.id, clientCompletedAt: client.client_completed_at,
      txHash: proof.txHash, path: proof.path, blockNumber: proof.blockNumber, blockHash: proof.blockHash });
  }
  const coveredNodes = new Set(matches.map(match => match.nodeUrl)).size;
  return { version: 1, scope: 'Client receipt to native finalized transaction reconciliation; not an M4 performance verdict',
    genesisHash: input.genesisHash, expected: clients.size, matched: matches.length, coveredNodes,
    complete: !errors.length && !missing.length && coveredNodes === 5, matches, missing, errors };
}

let readBytes = 0;
function read(file) {
  const size = fs.statSync(file).size;
  readBytes += size;
  if (size > 64 * 1024 * 1024 || readBytes > 128 * 1024 * 1024) throw new Error('Evidence exceeds 64 MiB per file or 128 MiB total');
  return fs.readFileSync(file, 'utf8');
}
async function main() {
  const [manifestFile, outputFile] = process.argv.slice(2);
  if (!manifestFile || !outputFile || fs.existsSync(outputFile)) throw new Error('Manifest and new output file required');
  const manifest = JSON.parse(read(manifestFile));
  const resolve = file => path.resolve(path.dirname(manifestFile), file);
  if (!Array.isArray(manifest.clientFiles) || manifest.clientFiles.length !== 60 || new Set(manifest.clientFiles.map(resolve)).size !== 60
    || !Array.isArray(manifest.batchFiles) || manifest.batchFiles.length > 5000) throw new Error('Exactly 60 distinct worker files and bounded batch exports required');
  const clientRecords = manifest.clientFiles.flatMap(file => {
    const content = read(resolve(file));
    if (content && !content.endsWith('\n')) throw new Error('Incomplete client receipt line');
    return content.split('\n').filter(Boolean).map(line => JSON.parse(line));
  });
  const batches = manifest.batchFiles.flatMap(item => {
    const exported = JSON.parse(read(resolve(item.file)));
    if (!Array.isArray(exported.entries) || exported.entries.length !== 1) throw new Error('Export one batch with --receipts per file');
    return exported.entries.map(entry => ({ ...entry, nodeUrl: item.nodeUrl }));
  });
  const url = endpoint(manifest.rpcUrl);
  const rpc = async (method, params) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, protoVer: '1.0.0' } }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body = await response.json();
    if (body.error || body.result?.code) throw new Error('RPC rejected verification request');
    return body.result && 'result' in body.result ? body.result.result : body.result;
  };
  const result = await reconcile({ ...manifest, clientRecords, batches }, rpc);
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ complete: result.complete, expected: result.expected, matched: result.matched, coveredNodes: result.coveredNodes }));
  if (!result.complete) process.exitCode = 1;
}
module.exports = { reconcile, canonical, sha };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
