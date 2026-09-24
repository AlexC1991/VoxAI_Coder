/**
 * VoxAI backend — OpenRouter provider client.
 *
 * Original Node implementation (fetch + SSE). No third-party code is included here.
 *
 * Provenance note: earlier revisions of this header cited specific Rust source files
 * in goose (Apache-2.0, now aaif-goose/goose). Those citations were not accurate —
 * only the compiled distribution was available at the time, so no goose source was
 * ever read. The endpoint shape, the `HTTP-Referer`/`X-Title` headers and the
 * `vendor/model` id format are OpenRouter's public API, not goose's work.
 *
 * Behaviours since adopted after reading the upstream provider, and why:
 *   - session_id/user for sticky routing (cache survives the turn)
 *   - per-model cache breakpoints rather than a blanket on/off
 *   - provider.require_parameters so a request is never routed somewhere that
 *     silently drops the tools array
 *   - transforms: middle-out as an overflow net
 * Still not implemented: Gemini `$ref` schema sanitising, and round-tripping
 * `reasoning_details` back into the request for reasoning models.
 */

const DEFAULT_HOST = 'https://openrouter.ai';

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.host]
 * @param {string} opts.model            e.g. 'anthropic/claude-sonnet-4.5'
 * @param {Array}  opts.messages         OpenAI-style [{role, content, tool_calls?, tool_call_id?}]
 * @param {Array}  [opts.tools]          OpenAI-style [{type:'function', function:{name, description, parameters}}]
 * @param {string} [opts.reasoningEffort] 'instant'|'brief'|'balanced'|'deep'|'exhaustive' → mapped to max_tokens budget hint
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {AbortSignal} [opts.signal]
 * @param {(delta:{token?:string, toolCallDelta?:object, done?:boolean, raw?:object})=>void} [opts.onEvent]
 * @returns {Promise<{content:string, toolCalls:Array<{id:string,name:string,arguments:string}>, usage:object, raw:object}>}
 */
async function chatCompletions(opts) {
  const {
    apiKey, host = DEFAULT_HOST, model, messages, tools,
    reasoningEffort = 'balanced', maxTokens = 16384, temperature,
    signal, onEvent, providerSort = null, sessionId = null,
  } = opts;
  if (!apiKey) throw new Error('voxai: OpenRouter API key missing');
  if (!model) throw new Error('voxai: model id missing');

  const body = {
    model,
    // Prompt caching is PREFIX-based: the provider matches from byte 0 and stops at
    // the first difference. applyCacheBreakpoints marks the stable head so the
    // system prompt + tool schemas (~4.5k tokens here) are read from cache instead
    // of re-billed every turn. No-op on providers that cache automatically.
    messages: applyCacheBreakpoints(messages, model),
    stream: true,
    max_tokens: maxTokens,
    // usage accounting (token counts, cost, prompt_tokens_details.cached_tokens) is
    // returned automatically now; stream_options appends it as a final chunk.
    stream_options: { include_usage: true },
    ...(temperature !== undefined ? { temperature } : {}),
    ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
    // Sticky routing. Without this OpenRouter derives its routing key by HASHING the
    // opening messages — which in an agent loop change every turn, so consecutive
    // turns can land on different upstreams and throw away the cache. Expires after
    // ~10 min idle.
    ...(sessionId ? { session_id: String(sessionId), user: String(sessionId) } : {}),
    // Server-side middle-out compression instead of a hard context-overflow 400.
    // Our own compactor should fire long before this; it is the last safety net.
    // NOTE: it drops messages from the MIDDLE, which can in principle separate an
    // assistant tool_calls message from its role:'tool' results. That risk is worth
    // taking only because the alternative at that point is a failed request.
    // Disable with VOX_DISABLE_TRANSFORMS=1.
    ...(process.env.VOX_DISABLE_TRANSFORMS ? {} : { transforms: ['middle-out'] }),
    // Provider routing. `sort: 'throughput'` is deliberately NOT set by default:
    // it makes OpenRouter rotate the upstream per request, which busts the
    // server-side prefix cache — measured 0% cache-read vs ~100% without it on
    // identical traffic. Set VOX_PROVIDER_SORT=throughput to trade that for latency.
    provider: {
      // Only route to upstreams that support EVERY parameter we sent — above all
      // `tools`. Without this a request can be silently routed to a provider that
      // drops the tools array, and the model answers in prose forever, which is
      // indistinguishable from "this model can't call tools".
      require_parameters: true,
      // NOTE: allow_fallbacks is deliberately left at OpenRouter's default (true).
      // require_parameters already guarantees any fallback also supports tools, so
      // the silent-tool-drop risk is gone — and forcing false would turn a routine
      // upstream blip into a hard failure mid-run.
      ...(providerSort || process.env.VOX_PROVIDER_SORT
        ? { sort: providerSort || process.env.VOX_PROVIDER_SORT }
        : {}),
    },
    // reasoning hint — only send to models that support it, because sending it to
    // arbitrary models can make some providers suppress tool calls and just stream prose.
    ...(supportsReasoning(model) && reasoningEffort && reasoningEffort !== 'instant'
      ? { reasoning: { effort: mapEffort(reasoningEffort) } }
      : {}),
  };

  const res = await fetch(`${host.replace(/\/$/, '')}/api/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://voxai.coder',
      'X-Title': 'VoxAI Coder',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    const err = new Error(`OpenRouter ${res.status}: ${text.slice(0, 1200)}`);
    err.status = res.status;
    throw err;
  }
  return consumeSSE(res.body, onEvent);
}

/**
 * Which caching regime does this model use?
 *   'explicit' — needs cache_control breakpoints in the payload (Anthropic, Qwen).
 *                Without them NOTHING is cached and you pay full input every turn.
 *   'auto'     — the provider caches the prefix server-side with no markers
 *                (OpenAI, DeepSeek, Gemini 2.5+, Groq, Z.AI, xAI, Moonshot).
 * Unknown models default to 'auto': sending no breakpoint can never break a
 * request, whereas sending one to a provider that rejects the array-form content
 * can. Mirrors goose's CacheSemantics::for_model().
 */
function cacheMode(model) {
  const m = String(model || '').toLowerCase();
  if (/(^|\/)anthropic\/|claude/.test(m)) return 'explicit';
  if (/(^|\/)qwen\//.test(m)) return 'explicit';
  return 'auto';
}

// Anthropic allows at most 4 breakpoints per request. We use two:
//   1. end of the system message  -> caches tool schemas + system prompt (never changes)
//   2. end of the last prior turn -> caches the conversation so far (append-only,
//      so each turn hits the previous cache and writes only the delta)
const MAX_BREAKPOINTS = 2;
// Below this there is nothing worth caching (Anthropic's own floor is 1024-4096
// tokens depending on model); chars/4 is the usual estimate.
const MIN_CACHEABLE_CHARS = 4096;

function markPart(content) {
  // cache_control rides on a content PART, so a string body must become an array.
  if (typeof content === 'string') {
    return [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
  }
  if (Array.isArray(content) && content.length) {
    const out = content.map((p) => (typeof p === 'string' ? { type: 'text', text: p } : { ...p }));
    out[out.length - 1] = { ...out[out.length - 1], cache_control: { type: 'ephemeral' } };
    return out;
  }
  return content;
}

function applyCacheBreakpoints(messages, model) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  if (cacheMode(model) !== 'explicit') return messages;
  if (process.env.VOX_DISABLE_CACHE) return messages;

  const approxChars = messages.reduce((n, m) => n + (typeof m.content === 'string'
    ? m.content.length
    : JSON.stringify(m.content || '').length), 0);
  if (approxChars < MIN_CACHEABLE_CHARS) return messages;

  const out = messages.map((m) => ({ ...m }));
  let used = 0;

  // 1. the system message — the stable head, shared by every turn of every run
  const sysIdx = out.findIndex((m) => m.role === 'system');
  if (sysIdx !== -1) {
    out[sysIdx].content = markPart(out[sysIdx].content);
    used += 1;
  }

  // 2. the last message of the existing history, so the append-only conversation
  //    prefix is cached too. Never mark an assistant message that carries
  //    tool_calls: its results follow immediately and the pair must stay together
  //    on the same side of the boundary.
  for (let i = out.length - 1; i >= 0 && used < MAX_BREAKPOINTS; i--) {
    const m = out[i];
    if (m.role === 'system') break;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) continue;
    if (!m.content) continue;
    m.content = markPart(m.content);
    used += 1;
    break;
  }
  return out;
}

function mapEffort(e) {
  // OpenRouter `reasoning.effort`: low|medium|high (xhigh on some). Forge's 5 levels fold in.
  if (e === 'brief') return 'low';
  if (e === 'deep' || e === 'exhaustive') return 'high';
  return 'medium'; // balanced
}

// Heuristic: does this model accept a `reasoning.effort` parameter? Only known
// reasoning-tuned models do. Sending it to others can disable their tool calling.
function supportsReasoning(model) {
  const m = String(model || '').toLowerCase();
  return /\b(o[1-9]|o[0-9]-|o1|o3|o4|gpt-5)|deepseek[-\/]?(r1|reasoner)|thinking|reasoner|claude[-\/]?(.*thinking|3\.7)(\s|$)|gemini[-\/]?(2\.5|thinking)/.test(m)
    && !/coder|codex/.test(m);
}

/** Minimal SSE consumer → accumulates content + tool_calls, forwards deltas. */
async function consumeSSE(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  const toolCalls = new Map(); // index → {id, name, arguments}
  let usage = null;
  let finishReason = null;
  let nextImplicitIndex = 0; // fallback when a provider omits tool_calls[].index

  const emit = (e) => { try { onEvent && onEvent(e); } catch { /* renderer gone */ } };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.usage) usage = json.usage;
      const choice = json.choices && json.choices[0];
      // finish_reason is the model's own termination signal. 'length' means it ran
      // out of max_tokens MID-generation — a truncated answer, or worse a truncated
      // tool-call arguments JSON. Inferring "done" from an empty tool_calls array
      // silently treats that as a clean finish.
      if (choice && choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice && choice.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        emit({ token: delta.content });
      }
      // Reasoning ("thinking") deltas — DeepSeek R1 / reasoning models / OpenRouter
      // send the hidden chain-of-thought here. Surface it separately (Codex/Claude
      // show a collapsible "thinking" block) instead of dropping it.
      const reasoning = delta.reasoning || delta.reasoning_content || delta.reasoning_text;
      if (typeof reasoning === 'string' && reasoning) {
        emit({ reasoning: reasoning });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          // Index may legitimately start at 1 (OpenRouter's Anthropic gateway reuses
          // the content-block index, so a text block takes 0). It may also be absent
          // entirely — defaulting those to 0 merges two parallel calls into one
          // corrupt call, so allocate a fresh slot instead.
          const i = Number.isInteger(tc.index) ? tc.index : nextImplicitIndex++;
          const cur = toolCalls.get(i) || { id: '', name: '', arguments: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function) {
            // name and id ARRIVE WHOLE and are assigned; only arguments are streamed
            // in fragments and concatenated. Appending the name builds "readread"
            // on any provider that repeats it per delta → "unknown tool".
            if (tc.function.name) cur.name = tc.function.name;
            if (tc.function.arguments) cur.arguments += tc.function.arguments;
          }
          toolCalls.set(i, cur);
          emit({ toolCallDelta: { index: i, ...cur } });
        }
      }
    }
  }
  // Emit in index order — Map iteration is insertion order, which diverges from
  // call order whenever fragments interleave.
  const calls = [...toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map((e) => e[1])
    .filter((t) => t.name);
  emit({ done: true });
  return { content, toolCalls: calls, usage, finishReason, raw: {} };
}

/** One-shot non-streaming variant (cheap turns, key test). */
// `extra` merges into the request body (plugins, usage accounting, ...); `signal`
// lets a caller abort. Both optional, so existing callers are unchanged.
async function chatOnce({ apiKey, host = DEFAULT_HOST, model, messages, maxTokens = 64, extra = null, signal = undefined }) {
  const res = await fetch(`${host.replace(/\/$/, '')}/api/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://voxai.coder',
      'X-Title': 'VoxAI Coder',
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: false, ...(extra || {}) }),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 1200)}`);
  return JSON.parse(text);
}

module.exports = { chatCompletions, chatOnce, DEFAULT_HOST, applyCacheBreakpoints, cacheMode };
