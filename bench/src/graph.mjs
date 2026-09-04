/**
 * The Graph decentralized-network gateway client.
 *
 * There is exactly one way to get subgraph data and it needs a key. The hosted service was retired in
 * June 2024; `api.studio.thegraph.com` serves only deployments you own. Verified 2026-09-04: with no key
 * the gateway answers `auth error: missing authorization header`, with a bogus one `auth error: API key
 * not found`. So this module fails loudly and early rather than degrading to anything local — a fabricated
 * row would disqualify the submission and is worse than an incomplete run.
 */
import { createHash } from 'node:crypto';

export const GATEWAY = process.env.GRAPH_GATEWAY ?? 'https://gateway.thegraph.com/api';

export class MissingKeyError extends Error {
  constructor() {
    super(
      'GRAPH_API_KEY is not set.\n' +
      '  Get one free at https://thegraph.com/studio/apikeys/ (Subgraph Studio -> API Keys), then:\n' +
      '    export GRAPH_API_KEY=<key>\n' +
      '  There is no keyless path to live subgraph data and this repo will not substitute a fixture for it.',
    );
    this.name = 'MissingKeyError';
  }
}

export function apiKey() {
  const k = process.env.GRAPH_API_KEY?.trim();
  if (!k) throw new MissingKeyError();
  return k;
}

/** sha256 of the query text — the `query_hash` every fact carries back to the bytes it came from. */
export const queryHash = (q) => createHash('sha256').update(q.trim()).digest('hex');

/** Endpoint for one deployment id (Qm… / 0x… subgraph id both work on this route). */
export const endpointFor = (deploymentId) => `${GATEWAY}/subgraphs/id/${deploymentId}`;

/**
 * One GraphQL request against one deployment.
 *
 * `block` pins the query to block B*: from the moment B* is chosen, every subsequent query in the run is
 * re-issued at that block, so the truth is frozen and anyone with a key can re-derive byte-identical rows
 * forever. That single decision is what makes this benchmark auditable by a stranger, so it is not optional
 * anywhere downstream of `pull.mjs`.
 */
export async function query(deploymentId, text, { block = null, variables = {}, timeoutMs = 45_000, retries = 2 } = {}) {
  const key = apiKey();
  // The pin is injected as a GraphQL variable rather than string-spliced, so the query TEXT (and therefore
  // its hash) is identical at B* and at any later block — a fresh-set pull re-uses the same query_hash.
  const body = { query: text, variables: { ...variables, ...(block == null ? {} : { block: { number: block } }) } };
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = Date.now();
    try {
      const r = await fetch(endpointFor(deploymentId), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const txt = await r.text();
      let j;
      try { j = JSON.parse(txt); } catch { throw new Error(`gateway returned non-JSON (${r.status}): ${txt.slice(0, 200)}`); }
      if (j.errors?.length) {
        const msg = j.errors.map((e) => e.message).join('; ');
        // An auth failure is terminal: retrying a bad key just burns time and hides the real problem.
        if (/auth error/i.test(msg)) throw Object.assign(new Error(`gateway auth rejected: ${msg}`), { terminal: true });
        throw new Error(`gateway GraphQL error: ${msg}`);
      }
      return { data: j.data, ms: Date.now() - t0, status: r.status, deployment_id: deploymentId, query_hash: queryHash(text), block };
    } catch (e) {
      lastErr = e;
      if (e.terminal) throw e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

/** `_meta.block.number` for a deployment — how B* is chosen, and how a fresh pull learns the head. */
export async function head(deploymentId) {
  const r = await query(deploymentId, 'query { _meta { block { number timestamp hash } deployment hasIndexingErrors } }');
  return r.data?._meta ?? null;
}

/**
 * Preflight: does the key work, and is every deployment in the set live and indexed past B*?
 * Called by `preflight.mjs` and by `run.mjs` before a single model token is spent, because discovering a
 * dead deployment three hours into an eight-hour GPU window is the expensive way to learn it.
 */
export async function checkDeployments(ids) {
  const out = [];
  for (const id of ids) {
    try {
      const m = await head(id);
      out.push({ id, ok: !!m, block: m?.block?.number ?? null, indexing_errors: m?.hasIndexingErrors ?? null });
    } catch (e) {
      out.push({ id, ok: false, error: e.message });
    }
  }
  return out;
}
