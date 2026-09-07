// The Ainize node, as the runner uses it: log in as operator, put the knowledge on the shared table, take it
// off, and be able to answer "is it on the table right now?" at any moment.
//
// Arms C and D are only meaningful if the patch was actually resident for every item they scored. A vLLM
// restart silently reverts the PLE table (Runtime.verify() re-checks for exactly this reason), so `isApplied`
// is called by run.mjs every 8 items and any chunk that fails is re-applied and re-run.

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

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

  /**
   * What is loaded in the SERVING MODEL, in order — the state that actually decides what an arm measures.
   *
   * `isApplied(id)` answers a question about one patch and says nothing about the table. Arm B was run for
   * seventy minutes against a model carrying arm C's patch because the runner only managed the patch it knew
   * about, and for an arm that needs NO patch it created no client and asked nothing at all. The table is the
   * thing under test; ask about the table.
   */
  async stack() {
    const r = await this.#req('/api/runtime/stack');
    return (r.stack ?? []).map((l) => l.patch_id);
  }

  async setApplied(id, want) {
    if ((await this.isApplied(id)) === want) return { changed: false };
    await this.#req(`/api/patches/${encodeURIComponent(id)}/${want ? 'apply' : 'remove'}`, { method: 'POST', body: {} });
    const now = await this.isApplied(id);
    if (now !== want) throw new Error(`patch ${id}: asked for applied=${want}, node reports ${now}`);
    return { changed: true };
  }

  /**
   * Was this patch produced by a real, FINISHED gradient run on THIS study's corpus?
   *
   * The first version read `backend: "gradient"` off the node. That was theatre: `teach.backend` is a NODE
   * CONFIG field (core/config-schema.ts:44) naming which backend that node's TeachWorker would use, not a
   * property of any patch. It passes for a file dropped into a gradient-configured node and fails for arm C,
   * which is a real gradient run invoked directly with no node involved. A check satisfied by the fake and
   * refused by the genuine article is worse than none, because §9 promises a mechanical guarantee here.
   *
   * The evidence is recipe.json, and the binding is a CANONICAL CORPUS HASH rather than a file hash. The
   * recipe EMBEDS the facts it trained on, so the corpus is included rather than referenced: hashing the
   * sorted `prompt\tanswer` lines of `recipe.facts` and of `data/<run>/trainset.jsonl` gives two independent
   * comparisons — "this patch was trained on these rows" is checkable from the recipe alone, and "these are
   * the study's rows" against the trainset. A raw file hash would have failed on JSON key order, whitespace
   * and .jsonl-versus-array, none of which change the corpus, so a correct patch would have been refused for
   * cosmetic reasons.
   *
   * And it refuses a MID-RUN CHECKPOINT. teach.py writes an interim record with `status: "training"` and no
   * `converged` key, and the final record carries `converged`. A checkpoint from an interrupted run was read
   * as a converged baseline earlier today and nearly became a numerics finding; requiring the key turns that
   * discovery into a guard.
   *
   * Field names below are the ACTUAL keys recipe.json writes. The previous version guessed with `??` chains
   * across several spellings, which is the same optimistic guessing the rule exists to prevent.
   */
  async provenance(id, { recipePath = null, trainsetPath = null, npzPath = null } = {}) {
    const p = await this.patch(id).catch(() => null);
    const entry = p?.entry ?? p ?? {};
    const anchor = entry.anchor ?? {};
    const anchorSha = anchor.patch_sha256 ?? null;
    const out = { patch_id: id, patch_sha256: anchorSha, recipe: recipePath, real_training: false, why: [] };

    if (!recipePath) { out.why.push('no --recipe given; a patch without its recipe cannot be shown to be a real training run'); return out; }
    if (!existsSync(recipePath)) { out.why.push(`recipe not found at ${recipePath}`); return out; }
    let r;
    try { r = JSON.parse(readFileSync(recipePath, 'utf8')); } catch (e) { out.why.push(`recipe is not JSON: ${e.message}`); return out; }

    // A finished run, not a checkpoint.
    if (!('converged' in r)) out.why.push('recipe has no `converged` key — this is a mid-run checkpoint, not a finished run');

    for (const k of ['facts', 'hyper_params', 'model', 'kernel', 'rows', 'step', 'npz', 'trainer'])
      if (r[k] === undefined || r[k] === null) out.why.push(`recipe has no \`${k}\``);

    // The artefact. The recipe records the path the TRAINER saw, which for a containerised run is a path
    // inside the container (`/work/...`) and does not resolve on the host. So the host path may be supplied
    // explicitly — but its BASENAME must match the one the recipe names, otherwise `--npz` would be a way to
    // point the check at an unrelated file and have it pass. The recipe still binds the name; the operator
    // only supplies where it lives.
    if (r.npz) {
      const recipeBase = String(r.npz).split('/').pop();
      let resolved = existsSync(r.npz) ? r.npz : null;
      if (!resolved && npzPath) {
        if (!existsSync(npzPath)) out.why.push(`--npz ${npzPath} does not exist`);
        else if (npzPath.split('/').pop() !== recipeBase) out.why.push(`--npz names ${npzPath.split('/').pop()} but the recipe was written about ${recipeBase}`);
        else resolved = npzPath;
      }
      if (!resolved) out.why.push(`the recipe's npz (${r.npz}) is not readable here and no matching --npz was given — the artefact binding cannot be checked`);
      else {
        out.npz_sha256 = createHash('sha256').update(readFileSync(resolved)).digest('hex');
        if (anchorSha && out.npz_sha256.toLowerCase() !== String(anchorSha).toLowerCase())
          out.why.push(`the npz hashes to ${out.npz_sha256.slice(0, 12)}, the anchor says ${String(anchorSha).slice(0, 12)}`);
      }
    }

    // The corpus: canonical hash of the embedded facts against the study's trainset.
    if (Array.isArray(r.facts) && trainsetPath) {
      if (!existsSync(trainsetPath)) out.why.push(`trainset not found at ${trainsetPath}`);
      else {
        const fromRecipe = NodeClient.corpusHash(r.facts);
        const fromStudy = NodeClient.corpusHash(readFileSync(trainsetPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
        out.corpus_hash = fromRecipe;
        if (fromRecipe !== fromStudy)
          out.why.push(`recipe trained on corpus ${fromRecipe.slice(0, 12)}, this study's trainset is ${fromStudy.slice(0, 12)}`);
      }
    }

    out.backend = out.why.length ? 'unproven' : 'gradient';
    out.real_training = out.why.length === 0;
    out.recipe_summary = out.real_training
      ? { step: r.step, rows: r.rows, converged: r.converged, model: r.model?.id_M ?? r.model, kernel: r.kernel, trainer: r.trainer }
      : null;
    return out;
  }

  /**
   * Canonical corpus hash: sha256 over sorted `prompt\tanswer` lines. Survives key order, whitespace and
   * jsonl-versus-array, none of which change what was trained; a raw file hash survives none of them.
   */
  static corpusHash(rows) {
    const lines = rows
      .map((f) => `${String(f.prompt ?? '').trim()}\t${String(f.answer ?? f.expect ?? '').trim()}`)
      .sort();
    return createHash('sha256').update(lines.join('\n')).digest('hex');
  }
}
