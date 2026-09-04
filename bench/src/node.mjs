// The Ainize node, as the runner uses it: log in as operator, put the knowledge on the shared table, take it
// off, and be able to answer "is it on the table right now?" at any moment.
//
// Arms C and D are only meaningful if the patch was actually resident for every item they scored. A vLLM
// restart silently reverts the PLE table (Runtime.verify() re-checks for exactly this reason), so `isApplied`
// is called by run.mjs every 8 items and any chunk that fails is re-applied and re-run.

export class NodeClient {
  constructor({ base = process.env.BENCH_NODE ?? 'http://localhost:3422', password = process.env.BENCH_NODE_PASSWORD } = {}) {
    this.base = base.replace(/\/$/, ''); this.password = password; this.token = null;
  }

  async #req(path, { method = 'GET', body, auth = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    const r = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(600_000) });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
    if (!r.ok) throw Object.assign(new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 300)}`), { status: r.status, body: j });
    return j;
  }

  async login() {
    if (!this.password) throw new Error('BENCH_NODE_PASSWORD is not set — arms C and D need the operator routes');
    const j = await this.#req('/api/auth/login', { method: 'POST', body: { password: this.password }, auth: false });
    this.token = j.token;
    if (!this.token) throw new Error('login returned no token');
    return this.token;
  }

  info() { return this.#req('/api/info'); }
  patch(id) { return this.#req(`/api/patches/${encodeURIComponent(id)}`); }

  async isApplied(id) { return (await this.patch(id)).applied === true; }

  async setApplied(id, want) {
    if ((await this.isApplied(id)) === want) return { changed: false };
    await this.#req(`/api/patches/${encodeURIComponent(id)}/${want ? 'apply' : 'remove'}`, { method: 'POST', body: {} });
    const now = await this.isApplied(id);
    if (now !== want) throw new Error(`patch ${id}: asked for applied=${want}, node reports ${now}`);
    return { changed: true };
  }

  /**
   * Was this patch produced by a real gradient run or by the teach stub? The stub rule (§9) is mechanical, so
   * this must never guess optimistically: anything it cannot positively identify as GRADIENT is treated as a
   * stub and the run is marked DRYRUN.
   */
  async provenance(id) {
    const p = await this.patch(id).catch(() => null);
    const entry = p?.entry ?? p ?? {};
    const anchor = entry.anchor ?? {};
    const hay = JSON.stringify({ anchor, teach: entry.teach ?? null, backend: entry.backend ?? null }).toLowerCase();
    const gradient = /"backend"\s*:\s*"gradient"/.test(hay);
    const stub = /"backend"\s*:\s*"stub"/.test(hay);
    return {
      patch_id: id,
      patch_sha256: anchor.patch_sha256 ?? null,
      backend: gradient ? 'gradient' : stub ? 'stub' : 'unknown',
      real_training: gradient,
    };
  }
}
