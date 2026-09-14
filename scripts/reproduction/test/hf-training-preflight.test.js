const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createServer } = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('training launcher refuses stub or busy nodes before creating a client or submitting work', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-training-preflight-'));
  const bin = path.join(folder, 'bin');
  const cli = path.join(folder, 'cli');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(cli, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cli, 'src/bin.ts'), '');
  const trace = path.join(folder, 'docker-calls');
  fs.writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$DOCKER_TRACE"\nif [[ "$1" == image && "$2" == inspect ]]; then exit 0; fi\nexit 99\n', { mode: 0o700 });
  let scenario;
  let requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.setHeader('content-type', 'application/json');
    const policy = { enabled: true, backend: scenario === 'stub' ? 'stub' : 'gradient', trainer: 'ready', queue: { depth: scenario === 'queued' ? 1 : 0 } };
    const info = { runtime: { available: true, hook: true, applied: scenario === 'applied' ? ['existing-patch'] : [],
      queue: { running: scenario === 'running' ? { label: 'existing operation' } : null, waiting: 0, lock: null } } };
    if (request.url === '/api/info') response.end(JSON.stringify(info));
    else if (request.url === '/api/teach/policy') response.end(JSON.stringify(policy));
    else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (scenario of ['stub', 'queued', 'applied', 'running']) {
      requests = [];
      fs.writeFileSync(trace, '');
      const output = path.join(folder, scenario);
      await assert.rejects(promisify(execFile)('bash', [path.resolve(__dirname, '../run-m6-huggingface-training.sh'),
        output, 'https://huggingface.co/datasets/owner/questions', 'a'.repeat(40), 'data.jsonl'], {
        timeout: 15000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_TRACE: trace,
          AINIZE_CLI_SOURCE: cli, AINIZE_CLI_IMAGE: `sha256:${'a'.repeat(64)}`,
          AINIZE_NODE_URL: `http://127.0.0.1:${server.address().port}` },
      }), error => {
        assert.notEqual(error.code, 0);
        assert.match(error.stderr, /No teaching request sent/);
        return true;
      });
      assert.equal(requests.length, 2);
      assert.ok(requests.every(request => request.method === 'GET'));
      assert.deepEqual(fs.readFileSync(trace, 'utf8').trim().split('\n'), [`image inspect sha256:${'a'.repeat(64)}`]);
      assert.equal(fs.existsSync(path.join(output, 'cli-home')), false);
      assert.equal(fs.existsSync(path.join(output, 'preflight.json')), false);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
