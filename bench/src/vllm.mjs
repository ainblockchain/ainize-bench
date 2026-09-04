// The single model client every arm goes through.
//
// Why all four arms share this file rather than arms A and C going through the node's POST /api/chat:
// §2 requires identical sampling in every arm, and Market.chat() cannot express it — chatInner builds
// `{ maxTokens, thinking }` and never forwards `sampling`, so an arm run through the node would silently get
// DEFAULT_CHAT_SAMPLING (stop sequences + the repetition guard) while arms B and D, which need a raw tool loop,
// would not. Comparing a stopped arm against an unstopped one is exactly the asymmetry §2 forbids. So the
// runner drives :8002 directly for all four arms and manages the patch table itself (§4), which is what arm D
// already had to do; run.mjs asserts the table state every 8 items instead of inheriting Market.chat()'s lock.
//
// The one non-obvious flag: `chat_template_kwargs.enable_thinking` MUST be false. Measured 2026-09-04 on this
// deployment: with thinking left at its default, a tool-armed request spent all 200 completion tokens on
// reasoning (`reasoning_tokens: 200`), returned empty content and finish_reason "length" — no tool call at all.
// The same request with thinking off emitted the tool call in 79 tokens. An arm B run without this flag would
// have produced "the model does not use its tools", which is a strawman caused by our own request body.

const DEFAULT_BASE = process.env.BENCH_MODEL_API ?? 'http://localhost:8002';

export class VLLM {
  constructor({ base = DEFAULT_BASE, model = null, maxTokens = 256, timeoutMs = 120_000 } = {}) {
    this.base = base; this.model = model; this.maxTokens = maxTokens; this.timeoutMs = timeoutMs;
    this.tokenizeOk = null; // null = not probed yet
  }

  async ready() {
    const r = await fetch(`${this.base}/v1/models`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`model server ${this.base}: ${r.status}`);
    const j = await r.json();
    this.model ??= j.data?.[0]?.id;
    this.maxModelLen = j.data?.[0]?.max_model_len ?? null;
    if (!this.model) throw new Error(`model server ${this.base} lists no model`);
    return { model: this.model, maxModelLen: this.maxModelLen };
  }

  /** Exact token count when vLLM exposes /tokenize; a declared char/4 estimate otherwise. Never silently mixed. */
  async countTokens(text) {
    if (this.tokenizeOk !== false) {
      try {
        const r = await fetch(`${this.base}/tokenize`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, prompt: text }), signal: AbortSignal.timeout(20_000),
        });
        if (r.ok) { const j = await r.json(); if (typeof j.count === 'number') { this.tokenizeOk = true; return { tokens: j.count, exact: true }; } }
        this.tokenizeOk = false;
      } catch { this.tokenizeOk = false; }
    }
    return { tokens: Math.ceil(text.length / 4), exact: false };
  }

  /**
   * One turn. `tools` undefined = no tool schemas are declared at all (arms A and C), which is not the same as
   * declaring tools the model may ignore — §6's side-effect table depends on that distinction being real.
   * Sampling is the §2 uniform setting: temperature 0, top_p 1, no stop sequences, no penalties, no guard.
   */
  async turn({ messages, tools, maxTokens = this.maxTokens }) {
    const body = {
      model: this.model, messages, max_tokens: maxTokens, temperature: 0, top_p: 1,
      chat_template_kwargs: { enable_thinking: false },
    };
    if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
    const t0 = Date.now();
    let res, text;
    try {
      res = await fetch(`${this.base}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      return { error: `transport: ${err.message}`, ms: Date.now() - t0, request: body };
    }
    if (!res.ok) return { error: `http ${res.status}: ${text.slice(0, 300)}`, ms: Date.now() - t0, request: body };
    let j; try { j = JSON.parse(text); } catch { return { error: `non-json response: ${text.slice(0, 200)}`, ms: Date.now() - t0, request: body }; }
    const c = j.choices?.[0];
    return {
      message: c?.message ?? null,
      content: c?.message?.content ?? '',
      toolCalls: c?.message?.tool_calls ?? [],
      finishReason: c?.finish_reason ?? null,
      usage: j.usage ?? null,
      ms: Date.now() - t0,
      request: body,
      response: j,
    };
  }
}
