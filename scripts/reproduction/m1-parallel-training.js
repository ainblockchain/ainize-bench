const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function endpoint(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Endpoint must be HTTP(S), without credentials or query parameters');
  return url.href.replace(/\/$/, '');
}

function validate(input) {
  if (!input || input.version !== 1 || typeof input.runId !== 'string' || !input.runId
    || typeof input.genesisHash !== 'string' || !input.genesisHash || !Array.isArray(input.datasets) || input.datasets.length !== 70) {
    throw new Error('Provide a chain identity and exactly 70 dataset assignments');
  }
  const rpcUrl = endpoint(input.rpcUrl);
  const datasets = input.datasets.map(dataset => {
    if (!dataset || typeof dataset.datasetId !== 'string' || !UUID.test(dataset.datasetId)
      || typeof dataset.keyFile !== 'string' || !path.isAbsolute(dataset.keyFile)
      || (dataset.effort !== undefined && !['quick', 'balanced', 'thorough'].includes(dataset.effort))) {
      throw new Error('Each dataset needs an existing Dataset ID, node URL and absolute pre-created teaching key file path');
    }
    return { nodeUrl: endpoint(dataset.nodeUrl), datasetId: dataset.datasetId,
      keyFile: dataset.keyFile, effort: dataset.effort ?? 'balanced' };
  });
  if (new Set(datasets.map(dataset => `${dataset.nodeUrl}/${dataset.datasetId}`)).size !== 70) throw new Error('Duplicate dataset assignment');
  return { version: 1, runId: input.runId, rpcUrl, genesisHash: input.genesisHash, datasets };
}

function trainArgs(dataset) {
  return ['--node', dataset.nodeUrl, 'teach', dataset.datasetId, '--key-file', dataset.keyFile, '--effort', dataset.effort, '--json'];
}

async function launch(input, invoke, saveReceipt = () => {}) {
  const config = validate(input);
  const startedAt = Date.now();
  const receipts = await Promise.all(config.datasets.map(async (dataset, index) => {
    const dispatchedAt = Date.now();
    let receipt;
    try {
      const response = await invoke(dataset);
      if (response?.dataset_id !== dataset.datasetId || typeof response.job?.id !== 'string' || !UUID.test(response.job.id)) throw new Error('Unexpected job response');
      receipt = { index, nodeUrl: dataset.nodeUrl, datasetId: dataset.datasetId, jobId: response.job.id,
        dispatchedAt, acknowledgedAt: Date.now(), outcome: 'accepted' };
    } catch {
      receipt = { index, nodeUrl: dataset.nodeUrl, datasetId: dataset.datasetId, dispatchedAt,
        observedAt: Date.now(), outcome: 'unconfirmed', error: 'Submission failed or response was not confirmed. Check existing jobs before retrying.' };
    }
    await saveReceipt(receipt);
    return receipt;
  }));
  const accepted = receipts.filter(receipt => receipt.outcome === 'accepted');
  const distinctJobs = new Set(accepted.map(receipt => `${receipt.nodeUrl}/${receipt.jobId}`)).size;
  const submissionComplete = accepted.length === 70 && distinctJobs === 70;
  const targets = submissionComplete ? { version: 1, runId: config.runId, rpcUrl: config.rpcUrl, genesisHash: config.genesisHash,
    targets: receipts.map(receipt => ({ nodeUrl: receipt.nodeUrl, jobId: receipt.jobId, keyFile: config.datasets[receipt.index].keyFile })) } : null;
  return { report: { version: 1, runId: config.runId, startedAt, finishedAt: Date.now(),
    attempted: 70, accepted: accepted.length, distinctJobs, submissionComplete,
    trainingConcurrencyVerified: false, receipts }, targets };
}

async function main() {
  const [inputPath, directory] = process.argv.slice(2);
  if (!inputPath || !directory) throw new Error('Dataset list and new evidence directory required');
  const config = validate(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
  for (const keyFile of new Set(config.datasets.map(dataset => dataset.keyFile))) {
    const stat = fs.statSync(keyFile);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Teaching key files must exist and be private (chmod 600)');
  }
  fs.mkdirSync(directory, { mode: 0o700 });
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const result = await launch(config, async dataset => {
    const { stdout } = await promisify(execFile)(process.env.AINIZE_BIN || 'ainize', trainArgs(dataset), { timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  }, receipt => write(`submission-${receipt.index}.json`, receipt));
  write('submissions.json', result.report);
  if (result.targets) write('targets.json', result.targets);
  console.log(JSON.stringify({ accepted: result.report.accepted, submissionComplete: result.report.submissionComplete,
    trainingConcurrencyVerified: false, directory }));
  if (!result.report.submissionComplete) process.exitCode = 1;
}

module.exports = { launch, validate, trainArgs };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
