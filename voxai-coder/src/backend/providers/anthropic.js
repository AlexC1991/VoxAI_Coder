'use strict';
/**
 * Claude models straight from Anthropic, billed to the user's own Anthropic key (Settings >
 * Account) instead of OpenRouter. providers/direct.js routes "anthropic/..." models here when that
 * key is set; the answer comes back in the same shape openrouter.js chatCompletions gives, so the
 * agent loop, helpers and sub-agents need nothing new.
 *
 * Through the official SDK (@anthropic-ai/sdk), the Messages API:
 *   - streaming, with text, thinking and tool calls forwarded as they arrive;
 *   - adaptive thinking on the models that have it (4.6 and later), shown as a summary, its depth
 *     set by the session's effort (output_config.effort) -- no thinking budgets, no sampling
 *     settings and no forced tool choice, which the newest models refuse;
 *   - automatic prompt caching (top-level cache_control): each request reads the conversation so
 *     far from the cache and writes only what is new, for 5 minutes or an hour;
 *   - server-side refusal fallbacks on the newest models: a request their safeguards decline is
 *     answered by another Claude model instead of failing.
 *
 * Thinking blocks. A turn's thinking is sent back unchanged while its tool loop goes on (the API
 * needs it there). VoxAI edits older history -- it prunes old tool output and summarises long
 * sessions -- and Claude no longer accepts thinking whose earlier history was edited, so only the
 * current run's turns (after the last user message, which nothing edits mid-run) are sent with
 * theirs; older turns go as plain text and tool calls. eager_input_streaming is left off: the UI
 * does not stream tool arguments, and with it on the server stops checking the tool input JSON,
 * which this agent would then have to re-check itself.
 */
const { Anthropic } = require('@anthropic-ai/sdk');

const clients = new Map();   // key -> client
function clientFor(apiKey) {
  let c = clients.get(apiKey);
  // The agent loop retries busy or failing providers itself (and tells the user); two more silent
  // retries inside the SDK would only stretch a wait nobody can see.
  if (!c) { c = new Anthropic({ apiKey, maxRetries: 0 }); clients.set(apiKey, c); if (clients.size > 4) clients.delete(clients.keys().next().value); }
  return c;
}

/** "anthropic/claude-opus-5.5" (OpenRouter's catalogue) -> "claude-opus-5-5" (Anthropic's). */
function apiModel(id) {
  return String(id || '').replace(/^anthropic\//i, '').replace(/:[\w-]+$/, '').replace(/\./g, '-');
}
// Adaptive thinking and effort: the 4.6 family and later (Haiku 4.5 and older take neither).
const ADAPTIVE = /^claude-(fable|mythos|opus|sonnet|haiku)-(5|[5-9]-\d|4-[6-9])\b/;
// Server-side refusal fallbacks, "default" form (the API picks the model by the refusal's category).
const FALLBACKS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The session's effort for output_config, or null for the model's own default. */
function effortOf(choice) {
  const c = String(choice || 'default').toLowerCase();
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(c)) return c;
  if (c === 'none' || c === 'minimal') return 'low';   // thinking cannot be turned off on the newest models
  return null;
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;
function partsToBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const out = [];
  for (const p of Array.isArray(content) ? content : []) {
    if (!p) continue;
    if (p.type === 'text' && p.text) out.push({ type: 'text', text: p.text });
    else if (p.type === 'image_url' && p.image_url) {
      const url = String(p.image_url.url || p.image_url || '');
      const m = DATA_URL.exec(url);
      if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      else if (/^https?:/i.test(url)) out.push({ type: 'image', source: { type: 'url', url } });
    }
  }
  return out;
}
const parseArgs = (s) => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };

/**
 * A turn as Anthropic sent it, ready to send back: blocks before the last fallback marker other
 * than text are dropped (the declined attempt's thinking and tool calls), the marker itself too,
 * and each tool_use takes the id the agent gave its call (it renames duplicates), in order.
 */
function replayBlocks(raw, toolCalls) {
  const blocks = Array.isArray(raw) ? raw : [];
  let cut = -1;
  blocks.forEach((b, i) => { if (b && b.type === 'fallback') cut = i; });
  const kept = blocks.filter((b, i) => b && b.type !== 'fallback' && (i > cut || b.type === 'text'));
  const uses = kept.filter((b) => b.type === 'tool_use');
  if (uses.length !== toolCalls.length) return null;
  let k = 0;
  return kept.map((b) => (b.type === 'tool_use' ? { ...b, id: toolCalls[k++].id } : b));
}

/** OpenAI-style messages -> { system, messages } for the Messages API. */
function toAnthropic(messages) {
  const all = Array.isArray(messages) ? messages : [];
  const system = [];
  // Where the current run starts: thinking is sent back only after this (see the note at the top).
  let lastUser = -1;
  all.forEach((m, i) => {
    if (m && m.role === 'user' && partsToBlocks(m.content).some((b) => b.type === 'text')) lastUser = i;
  });
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    // Results of parallel tool calls go back in ONE user message, before anything else in it.
    if (last && last.role === role && role === 'user') last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  all.forEach((m, i) => {
    if (!m) return;
    if (m.role === 'system') { const t = typeof m.content === 'string' ? m.content : partsToBlocks(m.content).map((b) => b.text || '').join('\n'); if (t) system.push({ type: 'text', text: t }); return; }
    if (m.role === 'tool') {
      const blocks = typeof m.content === 'string' ? (m.content || '(no output)') : partsToBlocks(m.content);
      push('user', [{ type: 'tool_result', tool_use_id: String(m.tool_call_id || ''), content: blocks && blocks.length ? blocks : '(no output)' }]);
      return;
    }
    if (m.role === 'user') { push('user', partsToBlocks(m.content)); return; }
    if (m.role === 'assistant') {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (i > lastUser && m._anthropic && Array.isArray(m._anthropic.content)) {
        const replay = replayBlocks(m._anthropic.content, calls);
        if (replay && replay.length) { out.push({ role: 'assistant', content: replay }); return; }
      }
      const blocks = partsToBlocks(m.content);
      for (const c of calls) {
        const fn = (c && c.function) || {};
        blocks.push({ type: 'tool_use', id: String(c.id || ''), name: String(fn.name || 'tool'), input: parseArgs(fn.arguments) });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    }
  });
  // The conversation has to open with the user.
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continued)' }] });
  return { system, messages: out };
}

function toolsOf(tools) {
  return (Array.isArray(tools) ? tools : []).map((t) => {
    const f = (t && t.function) || {};
    return { name: f.name, description: f.description || '', input_schema: f.parameters && typeof f.parameters === 'object' ? f.parameters : { type: 'object', properties: {} } };
  }).filter((t) => t.name);
}

/** The request body, shared by the streaming and the one-shot calls. */
function requestOf({ model, messages, tools, reasoningEffort, maxTokens, cacheTtl }) {
  const id = apiModel(model);
  const { system, messages: msgs } = toAnthropic(messages);
  const effort = effortOf(reasoningEffort);
  const params = {
    model: id,
    max_tokens: Math.max(1, Number(maxTokens) || 16384),
    messages: msgs,
    ...(system.length ? { system } : {}),
    ...(tools && tools.length ? { tools: toolsOf(tools) } : {}),
    // Automatic caching: the breakpoint goes on the last block, so each request reads all before it.
    cache_control: cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' },
    ...(ADAPTIVE.test(id) ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
    ...(ADAPTIVE.test(id) && effort ? { output_config: { effort } } : {}),
  };
  const beta = FALLBACKS.test(id);
  if (beta) { params.betas = [FALLBACK_BETA]; params.fallbacks = 'default'; }
  return { params, beta };
}

/** What a step cost, from the catalogue's prices (cents per token): the API does not say. */
function costOf(usage, price, cacheTtl) {
  if (!price || price.promptCents == null || price.completionCents == null) return 0;
  const pin = Number(price.promptCents), pout = Number(price.completionCents);
  const read = price.cacheReadCents != null ? Number(price.cacheReadCents) : pin * 0.1;
  let write = price.cacheWriteCents != null ? Number(price.cacheWriteCents) : pin * 1.25;
  if (cacheTtl === '1h') write = write * (2 / 1.25);   // an hour's write costs 2x input, not 1.25x
  const u = usage || {};
  return ((Number(u.input_tokens) || 0) * pin + (Number(u.cache_read_input_tokens) || 0) * read
    + (Number(u.cache_creation_input_tokens) || 0) * write + (Number(u.output_tokens) || 0) * pout) / 100;
}

/** Anthropic's usage, in the fields the agent and the app already read (OpenRouter's shape). */
function usageOf(u, cost) {
  const read = Number(u && u.cache_read_input_tokens) || 0, write = Number(u && u.cache_creation_input_tokens) || 0;
  return {
    prompt_tokens: (Number(u && u.input_tokens) || 0) + read + write,
    completion_tokens: Number(u && u.output_tokens) || 0,
    prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write },
    cache_write_input_tokens: write,
    cost,
    direct: 'anthropic',   // billed to the Anthropic key: not the OpenRouter balance
  };
}

/** An API error, said for a person, with the retry flag the agent loop reads. */
function errorOf(e) {
  if (e && e.name === 'AbortError') return e;
  const status = (e && e.status) || 0;
  let msg = (e && e.error && e.error.error && e.error.error.message) || (e && e.message) || 'request failed';
  if (status === 401) msg = 'Anthropic did not accept the API key. Check it in Settings > Account.';
  else if (status === 403) msg = 'Anthropic refused this request for the key in Settings > Account: ' + msg;
  else if (status === 429) msg = 'Anthropic is rate-limiting this key for now.';
  else if (status === 529 || status >= 500) msg = 'Anthropic is busy or failing right now.';
  else if (/credit balance|billing/i.test(msg)) msg = 'The Anthropic account behind the key in Settings > Account is out of credit. ' + msg;
  const err = new Error(`${msg}${status && status < 500 && status !== 401 && status !== 429 ? ` (Anthropic ${status})` : ''}`);
  err.status = status;
  err.retryable = status === 429 || status === 529 || status >= 500 || (e instanceof Anthropic.APIConnectionError);
  return err;
}

/**
 * The streaming call, in openrouter.js chatCompletions' shape: { content, toolCalls, usage,
 * finishReason, raw }. raw.anthropic is the turn as Anthropic sent it, kept on the saved message
 * so its thinking can go back with the tool results.
 */
async function chatCompletions(opts, { apiKey, price }) {
  const { signal, onEvent, cacheTtl = '' } = opts;
  const { params, beta } = requestOf(opts);
  const emit = (e) => { try { onEvent && onEvent(e); } catch { /* renderer gone */ } };
  const client = clientFor(apiKey);
  const api = beta ? client.beta.messages : client.messages;
  // A connection that goes quiet ends as a retryable error, like the OpenRouter stream's watchdog.
  const IDLE_MS = Number(process.env.VOX_STREAM_IDLE_MS) || 180000;
  let stream = null, last = Date.now(), stalled = false;
  const watch = setInterval(() => { if (Date.now() - last > IDLE_MS && stream) { stalled = true; try { stream.abort(); } catch {} } }, 5000);
  const calls = new Map();   // block index -> { id, name, arguments }
  let content = '';
  try {
    stream = api.stream(params, { signal });
    for await (const ev of stream) {
      last = Date.now();
      if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
        const cur = { id: ev.content_block.id, name: ev.content_block.name, arguments: '' };
        calls.set(ev.index, cur);
        emit({ toolCallDelta: { index: ev.index, ...cur } });
      } else if (ev.type === 'content_block_delta' && ev.delta) {
        if (ev.delta.type === 'text_delta' && ev.delta.text) { content += ev.delta.text; emit({ token: ev.delta.text }); }
        else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) emit({ reasoning: ev.delta.thinking });
      }
    }
    const msg = await stream.finalMessage();
    // Tool calls from the final message (inputs whole and parsed), after any fallback boundary.
    let cut = -1;
    msg.content.forEach((b, i) => { if (b.type === 'fallback') cut = i; });
    const toolCalls = msg.content.filter((b, i) => b.type === 'tool_use' && i > cut)
      .map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input || {}) }));
    let text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (msg.stop_reason === 'refusal' && !text.trim()) {
      const d = msg.stop_details || {};
      text = `Claude declined this request${d.category ? ` (${d.category})` : ''}.${d.explanation ? ' ' + d.explanation : ''}`;
      emit({ token: text });
    }
    const finishReason = msg.stop_reason === 'max_tokens' ? 'length' : msg.stop_reason === 'tool_use' ? 'tool_calls' : msg.stop_reason === 'refusal' ? 'refusal' : 'stop';
    emit({ done: true });
    return {
      content: text || content, toolCalls, finishReason,
      usage: usageOf(msg.usage, costOf(msg.usage, price, cacheTtl)),
      raw: { anthropic: { model: msg.model, content: msg.content } },
    };
  } catch (e) {
    if (stalled) { const err = new Error(`The model stopped responding: nothing came back for ${Math.round(IDLE_MS / 60000)} minutes.`); err.retryable = true; err.stalled = true; throw err; }
    if (signal && signal.aborted) { const err = new Error('aborted'); err.name = 'AbortError'; throw err; }
    throw errorOf(e);
  } finally {
    clearInterval(watch);
  }
}

/** The one-shot call (a title, a check, a summary), in chatOnce's OpenAI-style shape. */
async function chatOnce(opts, { apiKey, price }) {
  const { params, beta } = requestOf({ ...opts, maxTokens: opts.maxTokens || 64 });
  const client = clientFor(apiKey);
  try {
    // A small answer: thinking would spend the whole allowance before any text.
    if (params.output_config) delete params.output_config;
    const msg = await (beta ? client.beta.messages : client.messages).create({ ...params, ...(ADAPTIVE.test(params.model) ? { output_config: { effort: 'low' } } : {}) }, { signal: opts.signal });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { choices: [{ message: { role: 'assistant', content: text }, finish_reason: msg.stop_reason }], usage: usageOf(msg.usage, costOf(msg.usage, price, '')) };
  } catch (e) {
    throw errorOf(e);
  }
}

module.exports = { chatCompletions, chatOnce, apiModel, toAnthropic, replayBlocks, requestOf, costOf, usageOf, effortOf };
