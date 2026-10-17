'use strict';
/**
 * What each model family does that changes what a request costs, in one place.
 *
 * OpenRouter's catalogue gives prices, context, thinking levels and capabilities, and those are
 * always read from it. It does not say how a family caches, or where its price jumps for long
 * requests; that is here, from the providers' docs and published tests (October 2026):
 *
 *   cache       'explicit': the request marks what to cache (Claude, Qwen); 'auto': the
 *               provider caches a repeated start by itself (OpenAI from 1,024 tokens, Gemini 4
 *               only on an exact 4,096+ token match, DeepSeek, Grok).
 *   cacheMin    the shortest start the provider caches, in tokens.
 *   writeDear   a cache WRITE costs more than plain input (Claude 1.25x; GPT-6.1 Sol $2.50 vs
 *               $2/M): a missed cache costs extra, not just the discount.
 *   priceTier   above this many input tokens the provider bills the WHOLE request at a higher
 *               rate (OpenAI past 272k, Grok past 200k), so requests are kept under it.
 *   effortBreaksCache  changing the thinking level can invalidate the cached conversation
 *               (Anthropic's docs for thinking settings; OpenAI unless sent as their update item),
 *               so the level stays fixed for a run.
 *
 * A family not listed gets the safe defaults: automatic caching, no tier.
 */
const FAMILIES = [
  { family: 'claude', test: /(^|\/)anthropic\/|claude/i, cache: 'explicit', cacheMin: 1024, writeDear: true, priceTier: 0, effortBreaksCache: true },
  { family: 'qwen', test: /(^|\/)qwen\//i, cache: 'explicit', cacheMin: 1024, writeDear: false, priceTier: 0, effortBreaksCache: false },
  { family: 'openai', test: /(^|\/)openai\/|(^|\/)gpt-|(^|\/)o\d/i, cache: 'auto', cacheMin: 1024, writeDear: true, priceTier: 272000, effortBreaksCache: true },
  { family: 'gemini', test: /(^|\/)google\/|gemini/i, cache: 'auto', cacheMin: 4096, writeDear: false, priceTier: 0, effortBreaksCache: false },
  { family: 'grok', test: /(^|\/)x-ai\/|grok/i, cache: 'auto', cacheMin: 1024, writeDear: false, priceTier: 200000, effortBreaksCache: false },
  { family: 'deepseek', test: /(^|\/)deepseek\//i, cache: 'auto', cacheMin: 64, writeDear: false, priceTier: 0, effortBreaksCache: false },
];
const DEFAULT = { family: 'other', cache: 'auto', cacheMin: 1024, writeDear: false, priceTier: 0, effortBreaksCache: false };

/** The profile for a model id (an OpenRouter id, "~alias", or "local/<file>"). */
function profileOf(modelId) {
  const id = String(modelId || '').replace(/^~/, '').toLowerCase();
  if (/^local\//.test(id)) return { ...DEFAULT, family: 'local', cache: 'auto' };
  const f = FAMILIES.find((x) => x.test.test(id));
  if (!f) return { ...DEFAULT };
  const { test, ...p } = f;
  return p;
}

/**
 * The most a request may hold for this model before its price jumps: a little under the tier,
 * so the summary at "must summarise" lands before it. 0 = no tier.
 */
function tierCap(modelId) {
  const t = profileOf(modelId).priceTier;
  return t > 0 ? Math.floor(t * 0.95) : 0;
}

/** `limit` (the context size in Settings) kept under the model's price tier. */
function capContext(limit, modelId) {
  const cap = tierCap(modelId);
  const n = Number(limit) || 0;
  // Unset (0) stays unset: the 200k default is at or under every tier, and summarising starts
  // at 80% of it, well before.
  return cap && n > cap ? cap : n;
}

module.exports = { profileOf, tierCap, capContext, FAMILIES };
