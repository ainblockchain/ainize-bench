const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

function endpoint(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) endpoint without embedded credentials or query parameters');
  return url.href.replace(/\/$/, '');
}

function statusArgs(target) {
  return ['--node', target.nodeUrl, 'teach', 'status', target.jobId,
    ...(target.keyFile ? ['--key-file', target.keyFile] : []), '--json'];
}

async function collect(input, readStatus) {
  if (!input || input.version !== 1 || typeof input.runId !== 'string' || !input.runId
    || typeof input.genesisHash !== 'string' || !input.genesisHash || !Array.isArray(input.targets) || input.targets.length !== 70) {
    throw new Error('Provide a chain identity and exactly 70 existing job targets');
  }
  const rpcUrl = endpoint(input.rpcUrl);
  const targets = input.targets.map(target => {
    if (!target || typeof target.jobId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(target.jobId)
      || (target.keyFile !== undefined && (typeof target.keyFile !== 'string' || !path.isAbsolute(target.keyFile)))) {
      throw new Error('Each target needs a job ID and, optionally, an absolute teaching key file path');
    }
    return { nodeUrl: endpoint(target.nodeUrl), jobId: target.jobId, ...(target.keyFile ? { keyFile: target.keyFile } : {}) };
  });
  if (new Set(targets.map(target => `${target.nodeUrl}/${target.jobId}`)).size !== 70) throw new Error('Duplicate job target');
  const jobs = [];
  for (const [index, target] of targets.entries()) {
    let result;
    try { result = await readStatus(target); } catch { throw new Error(`Could not read target ${index + 1}; no complete manifest produced`); }
    const job = result?.job;
    if (result?.kind !== 'job' || result.owner !== true || job?.id !== target.jobId || typeof job.dataset?.id !== 'string' || !job.dataset.id) {
      throw new Error(`Target ${index + 1} did not return its owned dataset-backed job`);
    }
    const receipts = Array.isArray(job.chain_submissions) ? job.chain_submissions.filter(receipt => receipt?.status === 'TRAINING') : [];
    if (receipts.length !== 1) throw new Error(`Target ${index + 1} needs exactly one TRAINING receipt; no later-state fallback`);
    const receipt = receipts[0];
    const match = typeof receipt.path === 'string' && /^\/apps\/knowledge\/market\/lessons\/([^/]+)\/([^/]+)$/.exec(receipt.path);
    if (receipt.outcome !== 'submitted' || !match || match[2] !== target.jobId || typeof receipt.txHash !== 'string' || !receipt.txHash
      || !Number.isSafeInteger(receipt.submittedAt) || receipt.submittedAt <= 0) throw new Error(`Target ${index + 1} has no valid submitted TRAINING receipt`);
    jobs.push({ nodeId: match[1], jobId: target.jobId, datasetId: job.dataset.id,
      path: receipt.path, txHash: receipt.txHash, submittedAt: receipt.submittedAt });
  }
  if (new Set(jobs.map(job => `${job.nodeId}/${job.jobId}`)).size !== 70 || new Set(jobs.map(job => job.txHash)).size !== 70) throw new Error('Duplicate on-chain job or transaction identity');
  return { version: 1, runId: input.runId, rpcUrl, genesisHash: input.genesisHash, collectedAt: Date.now(), jobs };
}

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error('Target list and new manifest output paths required');
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const result = await collect(input, async target => {
    const { stdout } = await promisify(execFile)(process.env.AINIZE_BIN || 'ainize', statusArgs(target), { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ collected: result.jobs.length, outputPath, included: 'not yet checked' }));
}

module.exports = { collect, statusArgs };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
