const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createServer } = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { reconcile, sha } = require('../reconcile-inference-receipts');

function fixture() {
  const nodes = Array.from({ length: 5 }, (_, index) => ({ url: `http://node-${index}.example`, address: `0x${String(index + 1).repeat(40)}` }));
  const clientRecords = nodes.map((node, index) => ({ version: 1, node_url: node.url, client_started_at: 900, client_completed_at: 2100,
    receipt: { id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, model_id: 'owner/model', completed_at: 1500 } }));
  const batches = nodes.map((node, index) => {
    const receipts = [structuredClone(clientRecords[index].receipt)];
    const batch = { version: 1, model_id: 'owner/model', request_count: 1, started_at: 1000, finished_at: 2000, receipt_root: sha(receipts) };
    return { nodeUrl: node.url, state: 'submitted', receipts, batch,
      path: `/apps/knowledge/market/inference_batches/${node.address}/${sha({ ...batch, node: node.address })}`,
      tx_hash: `0x${String(index + 1).repeat(64)}` };
  });
  const blocks = batches.map((batch, index) => ({ number: index + 1, hash: `0x${(index + 6).toString(16).repeat(64)}`,
    transactions: [{ hash: batch.tx_hash, address: nodes[index].address,
      tx_body: { operation: { type: 'SET_VALUE', ref: batch.path, value: { ...batch.batch, node: nodes[index].address } } } }] }));
  const info = batches.map((_, index) => ({ number: index + 1, is_finalized: true, is_executed: true, receipt: { code: 0 } }));
  const input = { version: 1, genesisHash: '0x' + 'a'.repeat(64), nodes, clientRecords, batches };
  const rpc = async (method, params) => {
    if (method === 'ain_getTransactionByHash') return info[batches.findIndex(batch => batch.tx_hash === params.hash)];
    if (method !== 'ain_getBlockByNumber') throw new Error('Unexpected RPC method');
    if (params.number === 0) assert.equal(params.getFullTransactions, true, 'Genesis reads must preserve cached transaction bodies');
    return params.number === 0 ? { number: 0, hash: input.genesisHash } : blocks[params.number - 1];
  };
  return { input, blocks, info, rpc };
}

test('block-zero batches preserve full genesis reads through final recheck', async () => {
  const { input, blocks, info, rpc } = fixture();
  Object.assign(blocks[0], { number: 0, hash: input.genesisHash });
  info[0].number = 0;
  let genesisReads = 0;
  const result = await reconcile(input, async (method, params) => {
    if (method === 'ain_getBlockByNumber' && params.number === 0) {
      assert.equal(params.getFullTransactions, true);
      genesisReads++;
      return blocks[0];
    }
    return rpc(method, params);
  });
  assert.equal(result.complete, true);
  assert.equal(genesisReads, 3);
});

test('joins five nodes by exact receipts and native successful finalized transactions without a TPS claim', async () => {
  const { input, rpc } = fixture();
  const result = await reconcile(input, rpc);
  assert.equal(result.complete, true);
  assert.equal(result.matched, 5);
  assert.equal(result.coveredNodes, 5);
  assert.equal(result.tps, undefined);
  assert.equal(result.matches[0].path, input.batches[0].path);
});

test('receipt tampering, duplicate batches and content-address changes cannot pass', async () => {
  for (const change of [
    context => { context.input.batches[0].receipts[0].completed_at++; },
    context => { context.input.batches.push(structuredClone(context.input.batches[0])); },
    context => { context.input.batches[0].path = context.input.batches[0].path.slice(0, -1) + 'x'; },
    context => { context.input.batches[0].nodeUrl = context.input.nodes[1].url; },
    context => { context.input.batches[0].state = 'unconfirmed'; },
  ]) {
    const context = fixture(); change(context);
    const result = await reconcile(context.input, context.rpc);
    assert.equal(result.complete, false);
    assert.ok(result.errors.length);
  }
});

test('block membership, signer, execution and finalization must all match', async () => {
  for (const change of [
    context => { context.blocks[0].transactions = []; },
    context => { context.blocks[0].transactions[0].address = context.input.nodes[1].address; },
    context => { context.blocks[0].transactions[0].tx_body.operation.value.request_count = 99; },
    context => { context.info[0].receipt.code = 12103; },
    context => { context.info[0].is_finalized = false; },
    context => { context.info[0].is_executed = false; },
  ]) {
    const context = fixture(); change(context);
    const result = await reconcile(context.input, context.rpc);
    assert.equal(result.complete, false);
    assert.equal(result.matched, 4);
    assert.equal(result.missing.length, 1);
  }
});

test('changed chain, duplicate clients and missing node coverage do not pass', async () => {
  let context = fixture();
  await assert.rejects(reconcile(context.input, async () => ({ hash: 'other' })), /Chain identity/);
  context = fixture(); context.input.clientRecords.push(structuredClone(context.input.clientRecords[0]));
  await assert.rejects(reconcile(context.input, context.rpc), /Duplicate client/);
  context = fixture(); context.input.clientRecords.pop();
  assert.equal((await reconcile(context.input, context.rpc)).complete, false);
  context = fixture(); context.input.clientRecords[0].receipt.completed_at++;
  const result = await reconcile(context.input, context.rpc);
  assert.equal(result.matched, 4);
  assert.equal(result.complete, false);
});

test('a changed containing block at the final check invalidates the reconciliation', async () => {
  const { input, rpc } = fixture();
  const result = await reconcile(input, async (method, params) => {
    const value = await rpc(method, params);
    if (method === 'ain_getBlockByNumber' && params.number > 0 && !params.getFullTransactions) return { ...value, hash: 'changed' };
    return value;
  });
  assert.equal(result.complete, false);
  assert.equal(result.errors.length, 5);
});

test('shell entrypoint reads sixty distinct worker files and CLI exports without sending transactions', async () => {
  const context = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ainize-receipt-reconcile-'));
  let requests = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const bytes of request) body += bytes;
    const message = JSON.parse(body);
    assert.ok(['ain_getBlockByNumber', 'ain_getTransactionByHash'].includes(message.method));
    requests++;
    const result = await context.rpc(message.method, message.params);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result } }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const clientFiles = Array.from({ length: 60 }, (_, index) => {
      const filename = `worker-${index}.jsonl`;
      fs.writeFileSync(path.join(directory, filename), index < 5 ? JSON.stringify(context.input.clientRecords[index]) + '\n' : '');
      return filename;
    });
    const batchFiles = context.input.batches.map((batch, index) => {
      const file = `batch-${index}.json`;
      fs.writeFileSync(path.join(directory, file), JSON.stringify({ entries: [batch] }));
      return { nodeUrl: batch.nodeUrl, file };
    });
    const manifest = path.join(directory, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ version: 1, genesisHash: context.input.genesisHash,
      rpcUrl: `http://127.0.0.1:${server.address().port}/json-rpc`, nodes: context.input.nodes, clientFiles, batchFiles }));
    const output = path.join(directory, 'result.json');
    const args = [path.resolve(__dirname, '../run-m4-reconcile-inference-receipts.sh'), manifest, output];
    const result = await promisify(execFile)('bash', args, { timeout: 15000 });
    assert.equal(JSON.parse(result.stdout).matched, 5);
    assert.equal(JSON.parse(fs.readFileSync(output)).complete, true);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const previousRequests = requests;
    await assert.rejects(promisify(execFile)('bash', args, { timeout: 15000 }), /new output file required/);
    assert.equal(requests, previousRequests);
    context.info[0].receipt.code = 12103;
    const failedOutput = path.join(directory, 'failed.json');
    await assert.rejects(promisify(execFile)('bash', [args[0], manifest, failedOutput], { timeout: 15000 }));
    assert.equal(JSON.parse(fs.readFileSync(failedOutput)).complete, false);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
