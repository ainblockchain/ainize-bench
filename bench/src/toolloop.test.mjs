import assert from 'node:assert/strict';
import { truncateToolResult, callTarget, BUDGET, isContextOverflow, fitMessages } from './toolloop.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error(`FAIL ${name}: ${e.message}`); } };

t('short results are untouched', () => {
  const r = truncateToolResult('{"a":1}', 10);
  assert.equal(r.truncated, false);
  assert.equal(r.text, '{"a":1}');
});

t('long results are cut at a brace and carry the marker', () => {
  const rows = Array.from({ length: 100 }, (_, i) => `{"id":"0x${String(i).padStart(4, '0')}","v":${i}}`).join(',');
  const r = truncateToolResult(`[${rows}]`, 8000, 400);
  assert.equal(r.truncated, true);
  assert.equal(r.rows, 100);
  assert.ok(r.keptRows > 0 && r.keptRows < 100, `kept ${r.keptRows}`);
  assert.match(r.text, /… truncated, \d+ of 100 rows$/);
  assert.ok(r.text.slice(0, r.text.indexOf('\n')).endsWith('}'), 'cut lands on a closing brace');
});

t('the marker counts what the model actually saw', () => {
  const rows = Array.from({ length: 10 }, (_, i) => `{"i":${i}}`).join(',');
  const r = truncateToolResult(`[${rows}]`, 1000, 100);
  const stated = Number(r.text.match(/truncated, (\d+) of/)[1]);
  assert.equal(stated, r.keptRows);
});

t('the target is found under every argument name the server uses', () => {
  assert.equal(callTarget('execute_query_by_deployment_id', { deployment_id: '0xabc' }), '0xabc');
  assert.equal(callTarget('execute_query_by_subgraph_id', { subgraph_id: '5zvR' }), '5zvR');
  assert.equal(callTarget('get_schema_by_ipfs_hash', { ipfs_hash: 'Qm1' }), 'Qm1');
  assert.equal(callTarget('get_top_subgraph_deployments', { contract_address: '0xdef', chain: 'mainnet' }), '0xdef');
  assert.equal(callTarget('search_subgraphs_by_keyword', { keyword: 'vault' }), null, 'a search aims at no deployment');
});

t('the budget is the one §3 declares', () => {
  // Raised once, under the rule fixed before the measurement that triggered it. If this assertion fails,
  // the fix is §3 and this line together — never this line alone, and never a second raise.
  assert.deepEqual(BUDGET, { toolCalls: 20, turns: 25, wallMs: 240_000, toolResultTokens: 4000 });
  assert.equal(BUDGET.turns, BUDGET.toolCalls + 5, 'turns are derived from calls, never set independently');
});

t('vLLM context overflow is recognised and is not a transport error', () => {
  assert.equal(isContextOverflow("http 400: {\"error\":{\"message\":\"This model's maximum context length is 8192 tokens...\"}}"), true);
  assert.equal(isContextOverflow('transport: fetch failed'), false);
  assert.equal(isContextOverflow('http 503: upstream'), false);
  assert.equal(isContextOverflow(null), false);
});

const fakeVllm = { maxTokens: 256, maxModelLen: 8192, countTokens: async (s) => ({ tokens: Math.ceil(s.length / 4), exact: false }) };

await (async () => {
  const big = (n) => 'x'.repeat(n * 4);
  const messages = [
    { role: 'system', content: big(100) },
    { role: 'user', content: big(50) },
    { role: 'tool', content: big(3000) },
    { role: 'tool', content: big(3000) },
    { role: 'tool', content: big(3000) },
  ];
  const r = await fitMessages(fakeVllm, messages, { reserve: 512, ceiling: 8192 });
  t('eviction drops the oldest tool results first and leaves a readable marker', () => {
    assert.ok(r.evictions >= 1, `evicted ${r.evictions}`);
    assert.match(messages[2].content, /^… evicted, \d+ tokens/);
    assert.ok(!messages[4].content.startsWith('… evicted'), 'the newest tool result survives');
    assert.equal(messages[0].content.length, big(100).length, 'the system prompt is never evicted');
    assert.equal(messages[1].content.length, big(50).length, 'the question is never evicted');
  });
  t('eviction stops as soon as the request fits', () => {
    assert.ok(r.fits, `total ${r.total} still over`);
    assert.ok(r.evictions < 3, 'it evicted more than it needed to');
  });
  const already = await fitMessages(fakeVllm, messages, { reserve: 512, ceiling: 8192 });
  t('a request that already fits is left alone', () => assert.equal(already.evictions, 0));
})();

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
