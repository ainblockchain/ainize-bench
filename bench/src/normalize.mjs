/**
 * Deterministic answer normalisation and comparison for the four-arm benchmark.
 *
 * Every headline number in graph/bench is produced by THIS file — no LLM judge, no human pass. Given a
 * committed transcript and a committed questions.jsonl, anyone can re-derive every table without a GPU,
 * without an API key, and without us. That is the whole point: a sceptical judge should be able to
 * disagree with our scoring rules by reading them, and to re-score under their own rules by editing one file.
 *
 * Verdicts (one per (arm, item, repeat)):
 *   hit        the normalised answer equals the truth under this answer_type's rule
 *   wrong      a confident answer that is not the truth
 *   ambiguous  the answer contains several candidates of the right shape, one of which is the truth
 *              (a "shotgun" answer — counted as a MISS in the headline, reported in its own column)
 *   abstain    the model said it does not know (never counted as wrong; this is the honesty metric)
 *   error      transport/timeout/empty — excluded from accuracy denominators, reported as its own rate
 */

/** An answer that declines. Deliberately narrow: a hedge that still commits to a value is NOT an abstention. */
const ABSTAIN = /\b(unknown|i (?:do not|don't) know|cannot determine|can(?:not|'t) answer|no data|not available|insufficient (?:data|information))\b/i;

/** Trailing chat furniture that must not defeat an exact match. */
function strip(s) {
  return String(s ?? '')
    .replace(/^\s*(?:the\s+)?answer\s*(?:is)?\s*[:\-]\s*/i, '')
    .replace(/[\s"'`*.,;]+$/g, '')
    .trim();
}

export const ADDRESS_RE = /0x[0-9a-fA-F]{40}/g;

/** Normalisers per answer_type. Each returns the comparable form, or null when the answer has no value of that shape. */
export const normalize = {
  /** 40 hex chars, case-insensitive (EIP-55 checksum casing is not part of the claim). */
  address(text) {
    const all = [...String(text ?? '').matchAll(ADDRESS_RE)].map((m) => m[0].toLowerCase());
    return all.length ? { value: all[0], candidates: [...new Set(all)] } : null;
  },
  /** Ticker/enum: upper-cased, non-alphanumerics dropped. WETH == weth == "WETH". */
  symbol(text) {
    const t = strip(text).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return t ? { value: t, candidates: [t] } : null;
  },
  enum(text) { return normalize.symbol(text); },
  /** Integers: thousands separators, currency marks and units dropped; the FIRST integer in the answer wins. */
  integer(text) {
    const all = [...String(text ?? '').matchAll(/-?\d[\d,_ ]*/g)]
      .map((m) => m[0].replace(/[,_ ]/g, ''))
      .filter((x) => /^-?\d+$/.test(x));
    return all.length ? { value: all[0], candidates: [...new Set(all)] } : null;
  },
  /** Decimals: scientific notation and %/$ accepted; compared with a relative tolerance, not exactly. */
  decimal(text) {
    const all = [...String(text ?? '').matchAll(/-?\d[\d,_ ]*(?:\.\d+)?(?:[eE][-+]?\d+)?/g)]
      .map((m) => Number(m[0].replace(/[,_ ]/g, '')))
      .filter((x) => Number.isFinite(x));
    return all.length ? { value: all[0], candidates: [...new Set(all)] } : null;
  },
  /** ISO date, exact to the day. */
  date(text) {
    const m = String(text ?? '').match(/\d{4}-\d{2}-\d{2}/);
    return m ? { value: m[0], candidates: [m[0]] } : null;
  },
};

/** Relative tolerance for `decimal`. Values are frozen at the pinned block, so this covers formatting only. */
export const DECIMAL_REL_TOL = 0.01;

/**
 * Score one answer against one truth.
 * `answer_type` is declared per item in questions.jsonl by the GENERATOR, never chosen after seeing the answer.
 * `list<T>`: headline is exact set equality; Jaccard travels alongside as `partial`, and is never blended in.
 */
export function scoreOne(answerText, item) {
  const raw = String(answerText ?? '');
  if (!raw.trim()) return { verdict: 'error', reason: 'empty answer' };
  if (ABSTAIN.test(raw)) return { verdict: 'abstain', partial: 0 };

  const type = item.answer_type;
  if (type.startsWith('list<')) {
    const inner = type.slice(5, -1);
    const norm = normalize[inner];
    if (!norm) return { verdict: 'error', reason: `unknown element type ${inner}` };
    // Split on the separators a model actually uses, then normalise each element.
    const got = new Set(raw.split(/[,;\n•]|\band\b/i).map((p) => norm(p)?.value).filter((v) => v != null).map(String));
    const want = new Set(item.truth.map((v) => norm(String(v))?.value).filter((v) => v != null).map(String));
    const inter = [...got].filter((x) => want.has(x)).length;
    const union = new Set([...got, ...want]).size;
    const partial = union ? inter / union : 0;
    return { verdict: partial === 1 ? 'hit' : 'wrong', partial, got: [...got], want: [...want] };
  }

  const norm = normalize[type];
  if (!norm) return { verdict: 'error', reason: `unknown answer_type ${type}` };
  const got = norm(raw);
  if (!got) return { verdict: 'wrong', partial: 0, reason: `no ${type} in answer`, got: null };

  const wantN = norm(String(item.truth));
  if (!wantN) throw new Error(`item ${item.id}: truth "${item.truth}" is not a valid ${type}`);
  const want = wantN.value;

  const eq = type === 'decimal'
    ? (a) => (want === 0 ? a === 0 : Math.abs(a - want) / Math.abs(want) <= DECIMAL_REL_TOL)
    : (a) => a === want;

  if (eq(got.value)) return { verdict: 'hit', partial: 1, got: got.value };
  // The truth appears, but not as the answer: the model listed several candidates of the right shape.
  if (got.candidates.some(eq)) return { verdict: 'ambiguous', partial: 0, got: got.value, candidates: got.candidates };
  return { verdict: 'wrong', partial: 0, got: got.value };
}

/** Wilson 95% interval for a proportion — what every accuracy cell in the summary carries. */
export function wilson(hits, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = hits / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

/**
 * Exact McNemar test on the paired outcomes of two arms over the SAME items. Paired is the right test here:
 * every arm answers every question, so the discordant pairs carry all the information and the power is far
 * higher than an unpaired two-proportion test on the same n.
 * Returns { b, c, p } where b = "arm1 right, arm2 wrong", c = the reverse.
 */
export function mcnemar(pairs) {
  let b = 0, c = 0;
  for (const [x, y] of pairs) { if (x && !y) b++; else if (!x && y) c++; }
  const n = b + c;
  if (!n) return { b, c, p: 1 };
  // two-sided exact binomial against p=0.5
  const logC = (nn, k) => { let s = 0; for (let i = 0; i < k; i++) s += Math.log(nn - i) - Math.log(i + 1); return s; };
  let tail = 0;
  const k = Math.min(b, c);
  for (let i = 0; i <= k; i++) tail += Math.exp(logC(n, i) - n * Math.LN2);
  return { b, c, p: Math.min(1, 2 * tail) };
}
