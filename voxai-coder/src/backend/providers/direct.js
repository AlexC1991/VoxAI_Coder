'use strict';
/**
 * Models straight from their maker, with the user's own key, instead of through OpenRouter
 * (Settings > Account, both optional): Claude models with an Anthropic key, OpenAI's own models
 * with an OpenAI key. Everything else -- and these too without a key -- still goes through
 * OpenRouter. openrouter.js asks routeOf() first and hands the call over; the answer comes back in
 * its shape, so nothing above the provider changes.
 *
 * What it costs is worked out here from the catalogue's prices: neither API says. The usage is
 * marked `direct`, so the app does not take it off the OpenRouter balance.
 */
const keys = { get: () => ({}), priceOf: () => null };

/** main.js: where to read the keys (decrypted, current) and the catalogue's prices. */
function configure({ getKeys, priceOf } = {}) {
  if (typeof getKeys === 'function') keys.get = getKeys;
  if (typeof priceOf === 'function') keys.priceOf = priceOf;
}

// OpenAI's own models. gpt-oss is OpenAI's open-weight family, served by others, not by OpenAI's API.
const OPENAI_OWN = /^openai\/(?!gpt-oss)(gpt-|o\d|chatgpt|codex)/i;
/** 'anthropic' | 'openai' | null for a model id, given the keys that are set. */
function routeOf(model) {
  const id = String(model || '');
  let k = {};
  try { k = keys.get() || {}; } catch { k = {}; }
  if (k.anthropic && /^anthropic\/claude/i.test(id)) return 'anthropic';
  if (k.openai && OPENAI_OWN.test(id)) return 'openai';
  return null;
}
const priceOf = (model) => { try { return keys.priceOf(model) || null; } catch { return null; } };

/** OpenAI: the same chat-completions format, without OpenRouter's extras. */
// VOX_OPENAI_HOST: a stand-in for tests.
const OPENAI_HOST = process.env.VOX_OPENAI_HOST || 'https://api.openai.com';
const openaiModel = (id) => String(id || '').replace(/^openai\//i, '').replace(/:[\w-]+$/, '');
const OPENAI_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
function openaiCost(usage, price) {
  if (!price || price.promptCents == null || price.completionCents == null || !usage) return 0;
  const cached = Number(usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
  const fresh = Math.max(0, (Number(usage.prompt_tokens) || 0) - cached);
  const read = price.cacheReadCents != null ? Number(price.cacheReadCents) : Number(price.promptCents) * 0.1;
  return (fresh * Number(price.promptCents) + cached * read + (Number(usage.completion_tokens) || 0) * Number(price.completionCents)) / 100;
}
function openaiBody(opts, stream) {
  const or = require('./openrouter');
  const r = or.reasoningParam(opts.reasoningEffort || 'default', opts.reasoningSpec, opts.model).reasoning;
  let effort = r && r.effort ? r.effort : (r && r.enabled === false ? 'none' : null);
  if (effort === 'max') effort = 'xhigh';
  return {
    model: openaiModel(opts.model),
    messages: stripRaw(opts.messages),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    max_completion_tokens: Number(opts.maxTokens) || 16384,
    ...(opts.tools && opts.tools.length ? { tools: opts.tools } : {}),
    ...(effort && OPENAI_EFFORTS.includes(effort) ? { reasoning_effort: effort } : {}),
    // Routes a session's requests to the same cache (OpenAI caches long prefixes by itself).
    ...(opts.sessionId ? { prompt_cache_key: String(opts.sessionId) } : {}),
  };
}
async function openaiPost(body, apiKey, signal) {
  let res;
  try {
    res = await fetch(OPENAI_HOST + '/v1/chat/completions', {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    const err = new Error('Could not reach OpenAI: ' + ((e && e.message) || e)); err.retryable = true; throw err;
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try { msg = (JSON.parse(text).error || {}).message || text; } catch { /* not JSON */ }
    const s = res.status;
    const say = s === 401 ? 'OpenAI did not accept the API key. Check it in Settings > Account.'
      : s === 429 && /quota|billing/i.test(msg) ? 'The OpenAI account behind the key in Settings > Account is out of credit or quota.'
        : s === 429 ? 'OpenAI is rate-limiting this key for now.'
          : s >= 500 ? 'OpenAI is busy or failing right now.' : `${String(msg).slice(0, 300)} (OpenAI ${s})`;
    const err = new Error(say); err.status = s; err.retryable = s >= 500 || (s === 429 && !/quota|billing/i.test(msg));
    throw err;
  }
  return res;
}

/** A turn Anthropic sent back (kept for its thinking) means nothing to any other API. */
function stripRaw(messages) {
  return (Array.isArray(messages) ? messages : []).map((m) => {
    if (!m || !m._anthropic) return m;
    const { _anthropic, ...rest } = m;   // eslint-disable-line no-unused-vars
    return rest;
  });
}

async function chatCompletions(opts) {
  const route = routeOf(opts.model);
  const k = keys.get() || {};
  if (route === 'anthropic') return require('./anthropic').chatCompletions(opts, { apiKey: k.anthropic, price: priceOf(opts.model) });
  if (route === 'openai') {
    const res = await openaiPost(openaiBody(opts, true), k.openai, opts.signal);
    const out = await require('./openrouter').consumeSSE(res.body, opts.onEvent);
    if (out.usage) out.usage = { ...out.usage, cost: openaiCost(out.usage, priceOf(opts.model)), direct: 'openai' };
    return out;
  }
  throw new Error('voxai: no direct route for ' + opts.model);
}

async function chatOnce(opts) {
  const route = routeOf(opts.model);
  const k = keys.get() || {};
  if (route === 'anthropic') return require('./anthropic').chatOnce(opts, { apiKey: k.anthropic, price: priceOf(opts.model) });
  if (route === 'openai') {
    const res = await openaiPost({ ...openaiBody({ ...opts, maxTokens: opts.maxTokens || 64 }, false) }, k.openai, opts.signal);
    const j = await res.json();
    if (j.usage) j.usage = { ...j.usage, cost: openaiCost(j.usage, priceOf(opts.model)), direct: 'openai' };
    return j;
  }
  throw new Error('voxai: no direct route for ' + opts.model);
}

module.exports = { configure, routeOf, chatCompletions, chatOnce, stripRaw, openaiModel, openaiBody, openaiCost, OPENAI_OWN };
