// A minimal client for The Graph's hosted Subgraph MCP server.
//
// The server speaks the LEGACY HTTP+SSE transport only (verified 2026-09-04: POST /mcp is 404).
// The handshake is: open GET /sse and hold it; the first event is `event: endpoint` carrying a
// /messages?sessionId=… path; every JSON-RPC request is POSTed there and every response comes back
// down the SSE stream, correlated by id. Closing the stream ends the session.
//
// This module is deliberately transport-only. It does not retry on a wrong answer, does not
// reformulate a query and does not summarise a tool result — arm B's fairness (§3) depends on the
// model seeing exactly what the server said.

const BASE = 'https://subgraphs.mcp.thegraph.com';

export class SubgraphMCP {
  #reader; #pending = new Map(); #nextId = 1; #endpoint = null; #closed = false; #pump; #onEndpoint;

  // The key is OPTIONAL, and that is a measured fact, not an oversight: the hosted server answers a full
  // tools/call unauthenticated (verified 2026-09-04 — a keyless session executed a query and got block
  // 25902896 back). Arm B is therefore run WITH the key, because that is what a real integration ships and
  // because the run must be attributable to our own quota; but a keyless client is exactly what a reviewer
  // reproducing this will have, so it must not throw. `authenticated` is recorded in provenance.
  constructor({ apiKey = process.env.GRAPH_API_KEY ?? null, base = BASE } = {}) {
    this.apiKey = apiKey || null;
    this.authenticated = !!this.apiKey;
    this.base = base;
    this.stats = { calls: 0, bytesIn: 0, errors: 0 };
  }

  get #headers() { return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}; }

  async connect({ timeoutMs = 30_000 } = {}) {
    const res = await fetch(this.base + '/sse', { headers: { ...this.#headers, Accept: 'text/event-stream' } });
    if (!res.ok) throw new Error(`MCP /sse ${res.status} ${res.statusText}`);
    this.#reader = res.body.getReader();
    const ready = new Promise((resolve, reject) => {
      this.#onEndpoint = resolve;
      setTimeout(() => reject(new Error('MCP: no endpoint event within timeout')), timeoutMs).unref?.();
    });
    this.#pump = this.#run();
    await ready;
    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ainize-bench', version: '0.1' },
    });
    await this.notify('notifications/initialized');
    this.serverInfo = init.serverInfo;
    this.protocolVersion = init.protocolVersion;
    return init;
  }

  async #run() {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await this.#reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          if (frame.includes('event: endpoint')) { this.#endpoint = data; this.#onEndpoint?.(data); continue; }
          let msg; try { msg = JSON.parse(data); } catch { continue; }
          const p = this.#pending.get(msg.id);
          if (!p) continue;
          this.#pending.delete(msg.id);
          msg.error ? p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code })) : p.resolve(msg.result);
        }
      }
    } catch (err) {
      if (!this.#closed) for (const p of this.#pending.values()) p.reject(err);
    }
  }

  async #post(body) {
    const r = await fetch(this.base + this.#endpoint, {
      method: 'POST', headers: { ...this.#headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.status >= 400) throw new Error(`MCP POST ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }

  notify(method, params = {}) { return this.#post({ jsonrpc: '2.0', method, params }); }

  request(method, params = {}, { timeoutMs = 90_000 } = {}) {
    const id = this.#nextId++;
    const done = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`MCP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs).unref?.();
    });
    // The reply can arrive on the SSE stream BEFORE the POST's own HTTP response returns — the server answers
    // one connection while acknowledging another. Attaching the caller's handler only after #post resolves
    // therefore leaves `done` momentarily unhandled, and a JSON-RPC error in that window (a tool called with a
    // missing argument, which is ordinary arm-B behaviour) crashes the process as an unhandled rejection
    // instead of being caught by callTool. Observed on the second smoke run. A no-op handler makes `done`
    // handled from the instant it exists; the returned promise still rejects for the caller.
    done.catch(() => {});
    return this.#post({ jsonrpc: '2.0', id, method, params }).then(() => done);
  }

  listTools() { return this.request('tools/list').then((r) => r.tools); }

  // Returns the raw content blocks. The caller decides what to do with oversized text — truncation
  // is arm B's business (§3) and is recorded there, not hidden in here.
  async callTool(name, args) {
    this.stats.calls++;
    const t0 = Date.now();
    try {
      const r = await this.request('tools/call', { name, arguments: args });
      const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      this.stats.bytesIn += text.length;
      if (r.isError) this.stats.errors++;
      return { text, isError: !!r.isError, content: r.content, ms: Date.now() - t0 };
    } catch (err) {
      this.stats.errors++;
      return { text: String(err.message), isError: true, content: [], ms: Date.now() - t0, transportError: true };
    }
  }

  async close() { this.#closed = true; try { await this.#reader?.cancel(); } catch {} }
}
