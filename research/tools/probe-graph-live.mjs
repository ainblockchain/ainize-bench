#!/usr/bin/env node
// Reachability + credential matrix for The Graph's products, from this machine.
// Every check is live. Nothing here is mocked. Run with or without GRAPH_API_KEY set:
// the point of the script is to record exactly what changes when the key is absent.
//
//   node tools/probe-graph-live.mjs [> evidence/graph-live-probe-<date>.json]

const KEY = process.env.GRAPH_API_KEY || '';
const GATEWAY = 'https://gateway.thegraph.com';
const MCP = 'https://subgraphs.mcp.thegraph.com';
// Uniswap V3 on Ethereum — a stable, high-signal subgraph used only as a liveness target.
const SUBGRAPH_ID = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';
const META = '{ _meta { block { number } } }';

const out = { probedAt: new Date().toISOString(), graphApiKeyPresent: !!KEY, checks: [] };
const record = (o) => { out.checks.push(o); return o; };

async function timed(fn) {
  const t0 = performance.now();
  try { const value = await fn(); return { ms: Math.round(performance.now() - t0), value }; }
  catch (e) { return { ms: Math.round(performance.now() - t0), error: String(e && e.message || e) }; }
}

// ---------- 1. Gateway, GraphQL over HTTPS ----------
async function gatewayPost(name, url, headers) {
  const r = await timed(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ query: META }),
    });
    const body = await res.text();
    return { status: res.status, body: body.slice(0, 300) };
  });
  return record({ product: 'subgraph-gateway', name, url: url.replace(KEY, '<KEY>'), ...r });
}

// ---------- 2. x402: the 402 challenge is unauthenticated ----------
async function x402Challenge() {
  const url = `${GATEWAY}/api/x402/subgraphs/id/${SUBGRAPH_ID}`;
  const r = await timed(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: META }),
    });
    const hdr = res.headers.get('payment-required');
    let challenge = null;
    if (hdr) { try { challenge = JSON.parse(Buffer.from(hdr, 'base64').toString('utf8')); } catch { challenge = '<undecodable>'; } }
    return { status: res.status, challenge };
  });
  return record({ product: 'x402', name: 'payment challenge, no credentials', url, ...r });
}

// ---------- 3. Subgraph MCP over SSE ----------
async function mcpSession(headers) {
  const res = await fetch(`${MCP}/sse`, { headers: { Accept: 'text/event-stream', ...headers } });
  if (!res.ok) throw new Error(`SSE handshake ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', endpoint = null;
  const inbox = new Map();
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (raw.includes('event: endpoint')) { endpoint = data; continue; }
        try { const m = JSON.parse(data); if (m.id != null) inbox.set(m.id, m); } catch { /* keepalive */ }
      }
    }
  })();
  pump.catch(() => {});
  for (let i = 0; i < 200 && !endpoint; i++) await new Promise((r) => setTimeout(r, 25));
  if (!endpoint) throw new Error('no endpoint event');

  let id = 0;
  const rpc = async (method, params) => {
    const my = ++id;
    const t0 = performance.now();
    await fetch(MCP + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: my, method, params }),
    });
    for (let i = 0; i < 800 && !inbox.has(my); i++) await new Promise((r) => setTimeout(r, 25));
    return { ms: Math.round(performance.now() - t0), msg: inbox.get(my) };
  };
  await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'ainize-graph-probe', version: '0.1' },
  });
  await fetch(MCP + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return { rpc, close: () => reader.cancel().catch(() => {}) };
}

async function mcpProbe(label, headers) {
  let s;
  try { s = await mcpSession(headers); }
  catch (e) { return record({ product: 'subgraph-mcp', name: `${label}: handshake`, error: String(e.message) }); }

  const tl = await s.rpc('tools/list');
  record({
    product: 'subgraph-mcp', name: `${label}: tools/list`, ms: tl.ms,
    value: (tl.msg?.result?.tools || []).map((t) => ({
      name: t.name, args: Object.keys(t.inputSchema?.properties || {}),
    })),
  });

  const call = async (name, args) => {
    const r = await s.rpc('tools/call', { name, arguments: args });
    const text = r.msg?.result?.content?.[0]?.text ?? JSON.stringify(r.msg?.error ?? r.msg ?? 'TIMEOUT');
    return record({
      product: 'subgraph-mcp', name: `${label}: ${name}`, ms: r.ms,
      isError: r.msg?.result?.isError ?? null, value: String(text).slice(0, 400),
    });
  };
  await call('search_subgraphs_by_keyword', { keyword: 'uniswap' });
  await call('get_schema_by_subgraph_id', { subgraph_id: SUBGRAPH_ID });
  await call('execute_query_by_subgraph_id', { subgraph_id: SUBGRAPH_ID, query: META });

  // Latency distribution for the arm-B cost model: one MCP round trip, trivial query.
  const lat = [];
  for (let i = 0; i < 10; i++) {
    const r = await s.rpc('tools/call', {
      name: 'execute_query_by_subgraph_id',
      arguments: { subgraph_id: SUBGRAPH_ID, query: META },
    });
    lat.push({ ms: r.ms, isError: r.msg?.result?.isError ?? null });
  }
  const ok = lat.filter((x) => !x.isError).map((x) => x.ms).sort((a, b) => a - b);
  record({
    product: 'subgraph-mcp', name: `${label}: 10x execute_query round-trip latency`,
    value: { samples: lat.map((x) => x.ms), errors: lat.length - ok.length,
      min: ok[0] ?? null, p50: ok[Math.floor(ok.length / 2)] ?? null, max: ok[ok.length - 1] ?? null },
  });
  s.close();
}

// ---------- 4. Substreams ----------
async function substreamsProbe() {
  const url = 'https://spkg.io/streamingfast/ethereum-common-v0.3.1.spkg';
  const r = await timed(async () => {
    const res = await fetch(url, { redirect: 'follow' });
    const buf = await res.arrayBuffer();
    return { status: res.status, bytes: buf.byteLength };
  });
  record({ product: 'substreams', name: 'fetch .spkg package, no credentials', url, ...r });
  record({
    product: 'substreams', name: 'stream from provider (recorded, needs the CLI)',
    note: 'substreams run <pkg> <module> -e mainnet.eth.streamingfast.io:443 — see live-access.md for the two exact refusals without / with a bad token.',
  });
}

await gatewayPost('POST /api/subgraphs/id/<ID>, no Authorization', `${GATEWAY}/api/subgraphs/id/${SUBGRAPH_ID}`, {});
await gatewayPost('POST /api/subgraphs/id/<ID>, invalid Bearer', `${GATEWAY}/api/subgraphs/id/${SUBGRAPH_ID}`, {
  Authorization: 'Bearer deadbeefdeadbeefdeadbeefdeadbeef',
});
if (KEY) {
  await gatewayPost('POST /api/subgraphs/id/<ID>, real Bearer', `${GATEWAY}/api/subgraphs/id/${SUBGRAPH_ID}`, {
    Authorization: `Bearer ${KEY}`,
  });
  await gatewayPost('POST /api/<KEY>/subgraphs/id/<ID> (key-in-path form)', `${GATEWAY}/api/${KEY}/subgraphs/id/${SUBGRAPH_ID}`, {});
}
await x402Challenge();
await mcpProbe(KEY ? 'with GRAPH_API_KEY' : 'no credentials', KEY ? { Authorization: `Bearer ${KEY}` } : {});
await substreamsProbe();

console.log(JSON.stringify(out, null, 2));
