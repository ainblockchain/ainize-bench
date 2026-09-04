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

  async setApplied(id, want) {
    if ((await this.isApplied(id)) === want) return { changed: false };
    await this.#req(`/api/patches/${encodeURIComponent(id)}/${want ? 'apply' : 'remove'}`, { method: 'POST', body: {} });
    const now = await this.isApplied(id);
    if (now !== want) throw new Error(`patch ${id}: asked for applied=${want}, node reports ${now}`);
    return { changed: true };
  }

  /**
   * Was this patch produced by a real gradient run on THIS study's corpus?
   *
   * The first version of this read `backend: "gradient"` off the node. That check was theatre and had to go.
   * `teach.backend` is a NODE CONFIG field (core/config-schema.ts:44) saying which backend that node's
   * TeachWorker would use — it is not a property of any patch. A patch published from a node configured
   * `gradient` reads as gradient however it was actually made, and arm C's patch is trained by invoking
   * train/teach.py directly, so no node trained it and no teach job exists. A flag that passes for a file
   * someone dropped in, and fails for a real gradient run, is worse than no flag: it looks like evidence.
   *
   * What replaces it is the trainer's own recipe.json, BOUND to the two things it must not be separable from:
   *   patch_sha256   the recipe describes the artefact the run is about to apply, not some other one
   *   trainset       the sha256 of data/<run>/trainset.jsonl, so the patch was trained on the study's own
   *                  120 rows rather than on a corpus that merely resembles them
   * Plus the fields only a real run produces — steps taken, rows touched, hyper-parameters, model identity,
   * and the kernel provenance recorded from inside the training process.
   *
   * Anything missing means `real_training: false` and the runner writes results-DRYRUN. The rule stays
   * mechanical; only its evidence changed, from a flag anyone can set to a document bound to the artefact.
   */
  async provenance(id, { recipePath = null, trainsetPath = null } = {}) {
    const p = await this.patch(id).catch(() => null);
    const entry = p?.entry ?? p ?? {};
    const anchor = entry.anchor ?? {};
    const anchorSha = anchor.patch_sha256 ?? null;
    const out = { patch_id: id, patch_sha256: anchorSha, recipe: recipePath, real_training: false, why: [] };

    if (!recipePath) { out.why.push('no --recipe given; a patch without its recipe cannot be shown to be a real training run'); return out; }
    if (!existsSync(recipePath)) { out.why.push(`recipe not found at ${recipePath}`); return out; }
    let r;
    try { r = JSON.parse(readFileSync(recipePath, 'utf8')); } catch (e) { out.why.push(`recipe is not JSON: ${e.message}`); return out; }

    const recipeSha = r.patch_sha256 ?? r.patch?.sha256 ?? null;
    if (!recipeSha) out.why.push('recipe carries no patch_sha256 — it cannot be bound to an artefact');
    else if (anchorSha && recipeSha.toLowerCase() !== String(anchorSha).toLowerCase())
      out.why.push(`recipe describes ${String(recipeSha).slice(0, 12)} but the anchor is ${String(anchorSha).slice(0, 12)} — a recipe for a different patch`);

    if (trainsetPath) {
      if (!existsSync(trainsetPath)) out.why.push(`trainset not found at ${trainsetPath}`);
      else {
        const local = createHash('sha256').update(readFileSync(trainsetPath)).digest('hex');
        const claimed = r.trainset_sha256 ?? r.dataset_sha256 ?? r.trainset?.sha256 ?? null;
        if (!claimed) out.why.push('recipe names no trainset hash — it cannot be shown to be this study\'s corpus');
        else if (claimed.toLowerCase() !== local.toLowerCase())
          out.why.push(`recipe trained on ${String(claimed).slice(0, 12)}, this study's trainset is ${local.slice(0, 12)}`);
      }
    }

    // Fields only a real run produces. Absence is not proof of a stub, but their presence is what the
    // DRYRUN rule is allowed to rely on, and the rule must never guess optimistically.
    for (const [field, val] of [
      ['steps', r.steps ?? r.step ?? r.hyper_params?.max_steps],
      ['rows_touched', r.rows ?? r.rows_touched],
      ['hyper_params', r.hyper_params],
      ['model identity', r.model?.id_M ?? r.model_id],
      ['kernel_provenance', r.kernel_provenance ?? r.kernel],
    ]) if (val === undefined || val === null) out.why.push(`recipe has no ${field}`);

    out.backend = out.why.length ? 'unproven' : 'gradient';
    out.real_training = out.why.length === 0;
    out.recipe_summary = out.real_training
      ? { steps: r.steps ?? r.hyper_params?.max_steps, rows: r.rows ?? r.rows_touched, model: r.model?.id_M ?? r.model_id, kernel: r.kernel_provenance ?? r.kernel }
      : null;
    return out;
  }
}
