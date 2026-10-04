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
 * An error response, said the way a person needs it.
 *
 * They reached the user as "OpenRouter 402: {"error":{"message":"Insufficient
 * credits…"}}" -- raw JSON to dig through for what happened and what to do. Found in
 * a live run. `retryable` marks the ones that pass on their own (rate limits, a busy
 * or failing provider), which the agent retries before giving up.
 */
function responseError(status, text) {
  let msg = '', meta = null;
  try { const j = JSON.parse(text); msg = String((j.error && j.error.message) || j.message || ''); meta = j.error && j.error.metadata; } catch { msg = ''; }
  if (!msg) msg = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const provider = meta && meta.provider_name ? meta.provider_name : '';
  let raw = '';
  if (meta && meta.raw) { try { const r = JSON.parse(meta.raw); raw = (r.error && (r.error.message || r.error.type)) || r.type || ''; } catch { raw = String(meta.raw).slice(0, 120); } }
  let say;
  // 403 is also OpenRouter refusing one model or one request (only on listed apps, flagged by
  // moderation) while the key works for everything else: a 403 is said as a key problem only
  // when its message is about the key. A 401 always is.
  const aboutKey = !msg || msg === '{}' || /api key|credential|unauthori[sz]ed|user not found|no auth/i.test(msg);
  if (status === 401 || (status === 403 && aboutKey)) say = 'OpenRouter did not accept the API key. Check it in Settings, under Account.';
  else if (status === 403) say = `OpenRouter refused this request${provider ? ` (${provider})` : ''}: ${msg}${raw && raw !== msg ? ` (${raw})` : ''}. Other models may still work; pick another one or try again later.`;
  else if (status === 402) say = 'Your OpenRouter account is out of credits. Add credits at openrouter.ai/settings/credits, then send again.';
  else if (status === 429) say = `OpenRouter is rate-limiting requests right now${msg ? ` (${msg}${raw && raw !== msg ? `: ${raw}` : ''})` : ''}. Wait a moment and send again.`;
  else if (status === 400 && /context length|too many tokens|maximum context/i.test(msg)) say = `This conversation is too long for the model (${msg}) Compact it with the button at the top, or pick a model with a larger context.`;
  else if (status === 404 && /no endpoints/i.test(msg)) say = `No provider is serving this model right now (${msg}) Pick another model.`;
  else if (status >= 500) say = `The model's provider${provider ? ` (${provider})` : ''} had a problem${raw ? `: ${raw}` : (msg ? `: ${msg}` : '')}. Try again in a moment.`;
  else say = `OpenRouter ${status}: ${msg || 'the request was refused'}`;
  const err = new Error(say);
  err.status = status;
  err.retryable = status === 429 || status === 408 || status >= 500;
  return err;
}

/**
 * fetch() that says what went wrong when the network does.
 *
 * With OpenRouter out of reach, the run ended on "Something went wrong — fetch
 * failed": no word of what failed or what to do. A Stop (an abort) passes through
 * untouched, so it still reads as a stop. Found in a live run.
 */
async function post(host, init) {
  const base = String(host || DEFAULT_HOST).replace(/\/$/, '');
  try {
    return await fetch(`${base}/api/v1/chat/completions`, init);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    const code = (e && e.cause && (e.cause.code || (e.cause.errors && e.cause.errors[0] && e.cause.errors[0].code))) || '';
    const why = {
      ECONNREFUSED: 'the connection was refused', ENOTFOUND: 'the address could not be found',
      EAI_AGAIN: 'the address could not be looked up', ETIMEDOUT: 'the connection timed out',
      ECONNRESET: 'the connection was dropped', UND_ERR_CONNECT_TIMEOUT: 'the connection timed out',
      UND_ERR_SOCKET: 'the connection was dropped', CERT_HAS_EXPIRED: 'its certificate is not valid',
    }[code] || (code ? code
      : /bad port/i.test(String(e && e.cause && e.cause.message)) ? 'that port is blocked for web requests'
      // Without a code, the reason itself: "no response" hid what had actually failed.
      : String((e && e.cause && e.cause.message) || (e && e.message && e.message !== 'fetch failed' ? e.message : '') || 'no response').slice(0, 160));
    const err = new Error(`Could not reach OpenRouter at ${base} (${why}). Check your internet connection`
      + (base === DEFAULT_HOST ? '' : ', or the OpenRouter address in Settings') + ', then send again.');
    err.code = 'unreachable';
    err.retryable = true;   // a dropped connection or a Wi-Fi blip usually passes in seconds
    throw err;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.host]
 * @param {string} opts.model            e.g. 'anthropic/claude-sonnet-4.5'
 * @param {Array}  opts.messages         OpenAI-style [{role, content, tool_calls?, tool_call_id?}]
 * @param {Array}  [opts.tools]          OpenAI-style [{type:'function', function:{name, description, parameters}}]
 * @param {string} [opts.reasoningEffort] 'default' | an OpenRouter effort ('none'…'max') | 'on'
 * @param {object|null} [opts.reasoningSpec] the model's catalogue `reasoning` entry: null when the
 *   catalogue says it cannot reason, undefined when we do not know
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {AbortSignal} [opts.signal]
 * @param {(delta:{token?:string, toolCallDelta?:object, done?:boolean, raw?:object})=>void} [opts.onEvent]
 * @returns {Promise<{content:string, toolCalls:Array<{id:string,name:string,arguments:string}>, usage:object, raw:object}>}
 */
/**
 * Requests to ":free" models today, counted the way OpenRouter counts its free allowance (50 a
 * day, or 1,000 once the account has bought $10 of credit; its day is UTC). Only this app's
 * requests: other apps on the same key are not seen. main.js keeps it on disk (onChange).
 */
const freeUse = { day: '', n: 0, onChange: null };
function noteFree(model) {
  if (!/:free$/i.test(String(model || ''))) return;
  const day = new Date().toISOString().slice(0, 10);
  if (freeUse.day !== day) { freeUse.day = day; freeUse.n = 0; }
  freeUse.n++;
  if (freeUse.onChange) { try { freeUse.onChange({ day: freeUse.day, n: freeUse.n }); } catch {} }
}

/**
 * Models on this PC ("local/<file>", main/local-engine.js): llama-server's OpenAI-style endpoint,
 * with none of OpenRouter's extras (routing, transforms, cache markers, reasoning, cost). main
 * sets localEndpoint.url to a function giving the engine's address, or null while it is not running.
 */
const localEndpoint = { url: () => null };
const isLocal = (model) => /^local\//.test(String(model || ''));

/**
 * The cheaper, slower tier. "(batch)" models are half price but OpenRouter serves them only
 * through its Batch API: answers come back within 24 hours, which no agent turn can wait for,
 * and a chat request for one fails because there is no endpoint to route it to. OpenAI and
 * Google sell the same discount live as a "flex" tier; ":floor" lets a flex endpoint serve
 * when it is the cheapest and falls back to the normal tier (at the normal price) when flex is
 * busy, so a run never fails for it. main sets flexRoute.use to whether the user switched it
 * on for this model.
 */
const flexRoute = { use: () => false };
function wireModel(model) {
  let m = String(model || '');
  if (isLocal(m)) return m;
  m = m.replace(/:batch$/, '');   // an id saved before batch models left the picker
  try { if (flexRoute.use(m)) m += ':floor'; } catch { /* plain model */ }
  return m;
}
async function postLocal(body, signal) {
  const base = typeof localEndpoint.url === 'function' ? localEndpoint.url() : null;
  if (!base) throw Object.assign(new Error('The local model is not running. Start it in Settings → Local models, or pick another model.'), { status: 0 });
  let res;
  try {
    res = await fetch(base + '/v1/chat/completions', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw Object.assign(new Error('The local engine stopped answering. Start it again in Settings → Local models.'), { status: 0 });
  }
  if (!res.ok || (body.stream && !res.body)) {
    const text = await res.text().catch(() => '');
    // 503: still loading, or busy with another request -- that passes.
    throw Object.assign(new Error(`The local model refused the request (HTTP ${res.status}): ${String(text).replace(/\s+/g, ' ').slice(0, 200)}`), { status: res.status, retryable: res.status === 503 });
  }
  return res;
}

/**
 * Watches a local request's real speed through the engine's /slots. Another program using the CPU
 * took the 7B from 13.5 to 0.7 tokens/s: its Team coder sat 15 minutes, wrote nothing, and nobody
 * was told why. Far below the speed measured when tuning (localEndpoint.expected) for 20 s says so
 * once (onSlow); with stopAfterMs, still that slow after that long calls stop.
 */
const READ_CHUNK = 2048;   // llama-server's default batch: how far a prompt's count jumps at a time
function watchLocalSpeed({ onSlow, stop, stopAfterMs = 0 } = {}) {
  const base = typeof localEndpoint.url === 'function' ? localEndpoint.url() : null;
  if (!base) return { stop() {} };
  const every = Number(localEndpoint.slowCheckMs) || 5000;
  let exp = {}; try { exp = (typeof localEndpoint.expected === 'function' && localEndpoint.expected()) || {}; } catch {}
  // Unmeasured (a sidecar plan, or the CPU only): low floors, so a slow PC's usual speed is not "slow".
  const floorOut = exp.tps > 0 ? Math.max(1.5, exp.tps * 0.3) : 1.5;
  const floorIn = exp.pps > 0 ? Math.max(10, exp.pps * 0.15) : 15;
  // Stopping takes far worse: a Team coder at 3.5 of 13.5 tokens/s (Brave busy) was still getting
  // somewhere and was stopped; the starved case was 0.7.
  const starveOut = exp.tps > 0 ? Math.max(0.8, exp.tps * 0.12) : 0.8;
  const starveIn = exp.pps > 0 ? Math.max(5, exp.pps * 0.05) : 5;
  const seen = [];
  let slowSince = 0, told = false, ended = false, busy = false;
  const t = setInterval(async () => {
    if (busy || ended) return;
    busy = true;
    try {
      let s = null;
      try { const r = await fetch(base + '/slots', { signal: AbortSignal.timeout(Math.max(1000, every)) }); s = r.ok ? (await r.json())[0] : null; } catch { /* no reading this time */ }
      if (ended) return;
      if (!s || !s.is_processing) { seen.length = 0; slowSince = 0; return; }
      const nt = (Array.isArray(s.next_token) ? s.next_token[0] : s.next_token) || {};
      const now = { at: Date.now(), task: s.id_task, out: Number(nt.n_decoded) || 0, inDone: Number(s.n_prompt_tokens_processed) || 0 };
      const writing = now.out > 0;
      // Only this request, in this phase: writing over the last ~30 s; reading since it began, as
      // the engine counts a prompt in chunks of up to 2,048 tokens -- a 30B read at 79 tokens/s
      // showed 0 read for 18 s, and was called "reading at 0 tokens/s".
      while (seen.length && (seen[0].task !== now.task || (seen[0].out > 0) !== writing || (writing && now.at - seen[0].at > every * 6.5))) seen.shift();
      seen.push(now);
      const first = seen[0];
      if (now.at - first.at < every * 4) return;
      const span = (now.at - first.at) / 1000;
      const rate = writing ? (now.out - first.out) / span : (now.inDone - first.inDone) / span;
      // Reading is judged generously: as if a whole chunk were already done, unseen.
      const judged = writing ? rate : (now.inDone - first.inDone + READ_CHUNK) / span;
      if (judged >= (writing ? floorOut : floorIn)) { slowSince = 0; return; }
      // Slow but not starved: said, never stopped for.
      if (judged >= (writing ? starveOut : starveIn)) slowSince = 0;
      else if (!slowSince) slowSince = first.at;
      const usual = writing ? exp.tps : exp.pps;
      const info = {
        phase: writing ? 'writing' : 'reading', rate: Math.round(rate * 10) / 10, usual: usual || 0,
        message: (writing ? `The local model is writing at ${Math.round(rate * 10) / 10} tokens/s`
          : `The local model has read its prompt at under ${Math.max(1, Math.round(judged))} tokens/s for ${Math.round(span)} s`)
          + (usual ? ` (${usual} is usual on this PC)` : '')
          + ': something else is using the CPU or graphics card. Close heavy programs, or pick a cloud model.',
      };
      if (!told) { told = true; try { onSlow && onSlow(info); } catch { /* listener gone */ } }
      if (stopAfterMs > 0 && slowSince && now.at - slowSince >= stopAfterMs) { ended = true; clearInterval(t); try { stop && stop(info); } catch { /* already ended */ } }
    } finally { busy = false; }
  }, every);
  return { stop() { ended = true; clearInterval(t); } };
}

/**
 * A local model that writes its tool call as text instead of making one. Qwen2.5-Coder-7B answered
 * a write request with ```xml {{"name": "write", "arguments": {...}}} ```, copying the template's
 * own example. A JSON object naming one of the offered tools, with arguments, is taken as the call.
 */
function recoverToolCalls(result, tools) {
  if (!result || (result.toolCalls && result.toolCalls.length) || !tools || !tools.length) return result;
  const names = new Set(tools.map((t) => t && t.function && t.function.name).filter(Boolean));
  const raw = String(result.content || '');
  // As written first; then with the template's doubled braces undone. Doing that first broke plain
  // JSON, whose objects end in "}}" (the 7B's ```json {"name": "write", "arguments": {...}}```).
  const found = scanToolCalls(raw, names);
  const calls = found.length ? found : scanToolCalls(raw.replace(/\{\{/g, '{').replace(/\}\}/g, '}'), names);
  return calls.length ? { ...result, content: '', toolCalls: calls, finishReason: 'tool_calls' } : result;
}
function scanToolCalls(text, names) {
  const calls = [];
  for (let i = text.indexOf('{'); i >= 0 && i < text.length; i = text.indexOf('{', i + 1)) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) { end = j; break; }
    }
    if (end < 0) break;
    try {
      const o = JSON.parse(text.slice(i, end + 1));
      const args = o && (o.arguments || o.parameters);
      if (o && names.has(o.name) && args && typeof args === 'object') {
        calls.push({ id: 'local_' + Date.now().toString(36) + calls.length, name: o.name, arguments: JSON.stringify(args) });
        i = end;
      }
    } catch { /* not JSON: keep looking */ }
  }
  return calls;
}

async function chatCompletions(opts) {
  if (isLocal(opts && opts.model)) {
    const { model, messages, tools, maxTokens = 16384, temperature, signal, onEvent, slowStopMs = 0 } = opts;
    // Its own abort, so a request too slow to finish can be ended here and say why.
    const own = new AbortController();
    const onOuter = () => own.abort();
    if (signal) { if (signal.aborted) own.abort(); else signal.addEventListener('abort', onOuter, { once: true }); }
    let tooSlow = null;
    const watch = watchLocalSpeed({
      onSlow: (info) => {
        try { onEvent && onEvent({ slow: info }); } catch { /* listener gone */ }
        try { typeof localEndpoint.onSlow === 'function' && localEndpoint.onSlow(info); } catch { /* no window */ }
      },
      stopAfterMs: slowStopMs,
      stop: (info) => { tooSlow = info; own.abort(); },
    });
    try {
      const res = await postLocal({
        model, messages, stream: true, stream_options: { include_usage: true },
        max_tokens: Math.min(maxTokens, 8192),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(tools && tools.length ? { tools } : {}),
      }, own.signal);
      // Reading a long prompt on this PC can take minutes before the first token: a longer wait.
      return recoverToolCalls(await consumeSSE(res.body, onEvent, 600000), tools);
    } catch (e) {
      if (tooSlow && !(signal && signal.aborted)) {
        throw Object.assign(new Error(`${tooSlow.message} Stopped after ${Math.round(slowStopMs / 60000) || 1} min at that speed.`), { status: 0, localSlow: tooSlow });
      }
      throw e;
    } finally {
      watch.stop();
      if (signal) signal.removeEventListener('abort', onOuter);
    }
  }
  const {
    apiKey, host = DEFAULT_HOST, model, messages, tools,
    reasoningEffort = 'default', reasoningSpec, maxTokens = 16384, temperature,
    signal, onEvent, providerSort = null, sessionId = null,
    // '1h': Claude keeps the cache for an hour (writes cost 2x input instead of 1.25x).
    cacheTtl = '',
  } = opts;
  if (!apiKey) throw new Error('voxai: OpenRouter API key missing');
  if (!model) throw new Error('voxai: model id missing');

  const body = {
    model: wireModel(model),
    // Prompt caching is PREFIX-based: the provider matches from byte 0 and stops at
    // the first difference. applyCacheBreakpoints marks the stable head so the
    // system prompt + tool schemas (~4.5k tokens here) are read from cache instead
    // of re-billed every turn. No-op on providers that cache automatically.
    messages: applyCacheBreakpoints(messages, model, cacheTtl),
    stream: true,
    max_tokens: maxTokens,
    // usage accounting (token counts, cost, prompt_tokens_details.cached_tokens) is
    // returned automatically now; stream_options appends it as a final chunk.
    stream_options: { include_usage: true },
    ...(temperature !== undefined ? { temperature } : {}),
    // No tool_choice: "auto" is already what a request with tools means, and naming it made
    // OpenRouter drop every provider that does not take the field ("No endpoints found that
    // support the provided 'tool_choice' value" on nemotron-3-nano-omni:free).
    ...(tools && tools.length ? { tools } : {}),
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
    // reasoning — only what this model's catalogue entry says it accepts. Sending it to
    // a model that cannot reason can make some providers suppress tool calls.
    ...reasoningParam(reasoningEffort, reasoningSpec, model),
  };

  const res = await post(host, {
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
    throw responseError(res.status, text);
  }
  noteFree(model);
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

function markPart(content, ttl) {
  const cc = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  // cache_control rides on a content PART, so a string body must become an array.
  if (typeof content === 'string') {
    return [{ type: 'text', text: content, cache_control: cc }];
  }
  if (Array.isArray(content) && content.length) {
    const out = content.map((p) => (typeof p === 'string' ? { type: 'text', text: p } : { ...p }));
    out[out.length - 1] = { ...out[out.length - 1], cache_control: cc };
    return out;
  }
  return content;
}

function applyCacheBreakpoints(messages, model, ttl) {
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
    out[sysIdx].content = markPart(out[sysIdx].content, ttl);
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
    m.content = markPart(m.content, ttl);
    used += 1;
    break;
  }
  return out;
}

// OpenRouter's effort scale, least to most.
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// Settings saved before levels came from the catalogue.
const OLD_EFFORTS = { instant: 'none', brief: 'low', balanced: 'default', deep: 'high', exhaustive: 'xhigh' };

/** A saved reasoning choice in today's vocabulary: 'default', 'on', or an effort. */
function normalizeReasoning(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  if (s === 'default' || s === 'on' || EFFORTS.includes(s)) return s;
  if (s in OLD_EFFORTS) return OLD_EFFORTS[s];
  return 'default';
}

/** The supported effort closest to `want`; ties go to the higher one. */
function nearestEffort(list, want) {
  if (!list || !list.length) return null;
  if (list.includes(want)) return want;
  const wi = EFFORTS.indexOf(want);
  let best = list[0];
  let bd = Infinity;
  for (const k of list) {
    const d = Math.abs(EFFORTS.indexOf(k) - wi);
    if (d < bd || (d === bd && EFFORTS.indexOf(k) > EFFORTS.indexOf(best))) { bd = d; best = k; }
  }
  return best;
}

/**
 * The `reasoning` field for one request, from the saved choice and the model's
 * catalogue entry ({supported_efforts, default_effort, default_enabled, mandatory}).
 *
 * The old version guessed from the model id which models could reason, and missed
 * most of them -- DeepSeek V4 Flash among them -- so the chip changed nothing.
 */
function reasoningParam(choice, spec, model) {
  const c = normalizeReasoning(choice);
  if (c === 'default') return {};
  if (spec === undefined) {
    // No catalogue yet: only the models the old guess knew, and only an effort.
    return supportsReasoning(model) && EFFORTS.includes(c) && c !== 'none' ? { reasoning: { effort: c } } : {};
  }
  if (!spec) return {};                                   // the catalogue says it cannot reason
  const efforts = (Array.isArray(spec.supported_efforts) ? spec.supported_efforts : []).filter((e) => EFFORTS.includes(e));
  if (c === 'none') {
    if (spec.mandatory) return {};
    return efforts.includes('none') ? { reasoning: { effort: 'none' } } : { reasoning: { enabled: false } };
  }
  if (c === 'on' || !efforts.length) return spec.mandatory ? {} : { reasoning: { enabled: true } };
  const e = nearestEffort(efforts.filter((x) => x !== 'none'), c);
  return e ? { reasoning: { effort: e } } : {};
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
async function consumeSSE(body, onEvent, idleMs) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  const toolCalls = new Map(); // index → {id, name, arguments}
  let usage = null;
  let finishReason = null;
  let nextImplicitIndex = 0; // fallback when a provider omits tool_calls[].index

  const emit = (e) => { try { onEvent && onEvent(e); } catch { /* renderer gone */ } };

  // A provider that hangs mid-request: OpenRouter keeps the connection open with ": PROCESSING"
  // comments, so nothing ever timed out and the run waited for ever (a Muse Spark coder sat on
  // "Thinking" for 8+ minutes with the whole game's code attached). No real data -- text,
  // thinking, a tool call, usage -- for this long ends the request as a retryable error.
  const IDLE_MS = Number(process.env.VOX_STREAM_IDLE_MS) || idleMs || 180000;
  let lastReal = Date.now();
  const stall = () => {
    try { reader.cancel(); } catch { /* already closed */ }
    const e = new Error(`The model stopped responding: nothing came back for ${IDLE_MS >= 120000 ? Math.round(IDLE_MS / 60000) + ' minutes' : Math.round(IDLE_MS / 1000) + ' seconds'}.`);
    e.retryable = true; e.stalled = true;
    return e;
  };
  // Checked two ways: a timer for a connection that goes quiet, and after every chunk for one
  // that keeps sending keep-alives (each of those would otherwise restart the timer).
  const readOrStall = () => new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (Date.now() - lastReal < IDLE_MS) return;
      clearInterval(t);
      reject(stall());
    }, Math.min(5000, IDLE_MS));
    reader.read().then((r) => { clearInterval(t); resolve(r); }, (e) => { clearInterval(t); reject(e); });
  });

  for (;;) {
    const { done, value } = await readOrStall();
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
      lastReal = Date.now();
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
    if (Date.now() - lastReal >= IDLE_MS) throw stall();
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
  if (isLocal(model)) return JSON.parse(await (await postLocal({ model, messages, max_tokens: maxTokens, stream: false }, signal)).text());
  const res = await post(host, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://voxai.coder',
      'X-Title': 'VoxAI Coder',
    },
    body: JSON.stringify({ model: wireModel(model), messages, max_tokens: maxTokens, stream: false, ...(extra || {}) }),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw responseError(res.status, text);
  noteFree(model);
  return JSON.parse(text);
}

module.exports = { chatCompletions, chatOnce, responseError, freeUse, localEndpoint, flexRoute, wireModel, isLocal, recoverToolCalls, watchLocalSpeed, DEFAULT_HOST, applyCacheBreakpoints, cacheMode, reasoningParam, normalizeReasoning, nearestEffort, EFFORTS };
