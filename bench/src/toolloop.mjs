// Arms B and D: the tool loop, and the evidence it must leave behind.
//
// §3 is the whole of this file's design. The temptation is to give the tool arm a small budget and a bad
// prompt and then celebrate; the thesis dies the moment a judge can say "you strawmanned The Graph". So the
// budget is generous and *recorded* (if the median item uses two calls the budget was never the binding
// constraint, and the summary has to say so), the tool results are passed through verbatim up to the declared
// ceiling, and every fact the scorer needs to assign a miss to a named channel (§6) is written into the
// transcript here rather than re-derived later from prose.

export const BUDGET = { toolCalls: 8, turns: 10, wallMs: 90_000, toolResultTokens: 4000 };

/** vLLM's own words when the request no longer fits. Not a transport failure and never retried as one. */
export const isContextOverflow = (err) => /maximum context length/i.test(String(err ?? ''));

/**
 * Keep the request inside the window by evicting the OLDEST tool results first, replacing each with a marker
 * the model can read. This exists because per-result truncation is not enough: each result is capped at 4 000
 * tokens, but eight of them plus the schema dump overflow 8 192 together, and the naive outcome is a 400 that
 * looks like a transport error — which §6 excludes from the accuracy denominator. That would quietly delete
 * arm B's most characteristic failure from the measurement. Running out of window is a MISS with its own
 * channel (`context_exhausted`), not a missing datum.
 */
export async function fitMessages(vllm, messages, { reserve, ceiling }) {
  const size = async (m) => (await vllm.countTokens(m.map((x) => `${x.role}: ${x.content ?? ''}`).join('\n'))).tokens;
  let evictions = 0;
  let total = await size(messages);
  const limit = ceiling - reserve;
  for (let i = 0; total > limit && i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'tool' || m.content?.startsWith('… evicted')) continue;
    const was = (await vllm.countTokens(m.content ?? '')).tokens;
    m.content = `… evicted, ${was} tokens of an earlier tool result were dropped to fit the context window`;
    evictions++;
    total = await size(messages);
  }
  return { total, evictions, fits: total <= limit };
}

/** Truncate at a JSON array boundary so the model sees valid JSON, and say so where it can read it. */
export function truncateToolResult(text, tokens, limit = BUDGET.toolResultTokens) {
  if (tokens <= limit) return { text, truncated: false, rows: null, keptRows: null };
  const cut = Math.max(1, Math.floor((text.length * limit) / tokens));
  const head = text.slice(0, cut);
  const lastClose = Math.max(head.lastIndexOf('},'), head.lastIndexOf('}\n'), head.lastIndexOf('}'));
  const body = lastClose > 0 ? head.slice(0, lastClose + 1) : head;
  const rows = (text.match(/\{/g) || []).length;
  const keptRows = (body.match(/\{/g) || []).length;
  return { text: `${body}\n… truncated, ${keptRows} of ${rows} rows`, truncated: true, rows, keptRows };
}

const asJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** The deployment/subgraph id a tool call aimed at, whatever argument name it arrived under. */
export function callTarget(name, args) {
  const a = args ?? {};
  return a.deployment_id ?? a.subgraph_id ?? a.ipfs_hash ?? a.contract_address ?? null;
}

export async function runToolLoop({ vllm, mcp, systemPrompt, question, offline = false, budget = BUDGET }) {
  const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: question }];
  const turns = [];
  const ev = {
    tool_calls: 0, tool_bytes_in: 0, retries: 0, context_truncated: false,
    budget_exhausted: false, tool_targets: [], tool_results: [], tool_errors: 0,
    model_ms: 0, forced_final: false, offline,
    context_exhausted: false, context_evictions: 0, prompt_tokens_peak: 0,
  };
  const t0 = Date.now();
  let final = null;

  for (let turn = 0; turn < budget.turns; turn++) {
    const overBudget = ev.tool_calls >= budget.toolCalls || Date.now() - t0 > budget.wallMs;
    if (overBudget && !ev.budget_exhausted) {
      // One last turn, forced to answer with whatever it has. Never scored as an abstention by accident:
      // the forcing is recorded, so a summary can separate "declined" from "ran out of room".
      ev.budget_exhausted = true; ev.forced_final = true;
      messages.push({ role: 'user', content: 'Answer now with the value you have. Reply with the value alone.' });
    }
    const tools = ev.forced_final ? undefined : mcp.toolSchemas;
    // Fit before asking, so the common case never reaches the 400 at all.
    const fit = await fitMessages(vllm, messages, { reserve: (vllm.maxTokens ?? 256) + 256, ceiling: vllm.maxModelLen ?? 8192 });
    ev.context_evictions += fit.evictions;
    ev.prompt_tokens_peak = Math.max(ev.prompt_tokens_peak, fit.total);
    if (fit.evictions) ev.context_exhausted = true;
    let r = await vllm.turn({ messages, tools });
    if (r.error && isContextOverflow(r.error)) {
      // The window is full even after eviction. This is a miss, not an error: force the final turn with the
      // tool schemas withdrawn (they are themselves ~2 000 tokens) and let the model answer from what it read.
      ev.context_exhausted = true;
      if (!ev.forced_final) {
        ev.forced_final = true;
        messages.push({ role: 'user', content: 'Answer now with the value you have. Reply with the value alone.' });
        await fitMessages(vllm, messages, { reserve: (vllm.maxTokens ?? 256) + 256, ceiling: vllm.maxModelLen ?? 8192 });
        r = await vllm.turn({ messages, tools: undefined });
      }
      if (r.error && isContextOverflow(r.error)) {
        turns.push({ turn, error: r.error, ms: r.ms, context_overflow: true });
        return { final: '', error: null, context_overflow: true, turns, ev, wall_ms: Date.now() - t0 };
      }
    }
    if (r.error) {
      // §3: one retry on a transport error. Never a retry because the answer was wrong, and never for a
      // context overflow — that would fail identically and burn 90 s doing it.
      ev.retries++;
      r = await vllm.turn({ messages, tools });
      if (r.error) { turns.push({ turn, error: r.error, ms: r.ms }); return { final: null, error: r.error, turns, ev, wall_ms: Date.now() - t0 }; }
    }
    ev.model_ms += r.ms;
    turns.push({ turn, request: r.request, response: r.response, ms: r.ms, usage: r.usage, finish_reason: r.finishReason });

    if (!r.toolCalls?.length || ev.forced_final) { final = r.content ?? ''; break; }

    messages.push(r.message);
    for (const call of r.toolCalls) {
      const args = asJson(call.function?.arguments ?? '') ?? {};
      const name = call.function?.name ?? '';
      const target = callTarget(name, args);
      ev.tool_calls++;
      ev.tool_targets.push({ name, target, args });
      let out;
      if (offline) {
        // The declared fault injection (§6). Nothing is fabricated — no fake rows, no synthetic subgraph.
        out = { text: 'HTTP 503: the data service is unavailable.', isError: true, ms: 0 };
      } else {
        out = await mcp.callTool(name, args);
      }
      if (out.isError) ev.tool_errors++;
      const { tokens } = await vllm.countTokens(out.text ?? '');
      const t = truncateToolResult(out.text ?? '', tokens);
      if (t.truncated) ev.context_truncated = true;
      ev.tool_bytes_in += (out.text ?? '').length;
      // The FULL result is committed, not the truncated one: `ignored_result` and `had_it_and_still_wrong`
      // are decided against what the server actually returned.
      ev.tool_results.push({ name, target, full: out.text ?? '', truncated: t.truncated, rows: t.rows, kept_rows: t.keptRows, is_error: !!out.isError, ms: out.ms });
      messages.push({ role: 'tool', tool_call_id: call.id, content: t.text });
    }
  }
  return { final, error: null, turns, ev, wall_ms: Date.now() - t0 };
}
