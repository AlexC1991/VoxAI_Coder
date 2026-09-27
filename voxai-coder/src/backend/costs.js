/**
 * costs -- where a run's money went, for the "Worked for" line.
 *
 * OpenRouter bills one total per call. The run keeps its token counts by kind (fresh
 * input, input read from the cache, input written to the cache, output with its
 * thinking) and what the extras cost (Auto's checks, sub-agents, web search, screenshot
 * descriptions). The model's share of the bill is split across the kinds by the model's
 * own prices, so the parts always add up to what was actually charged.
 */

/**
 * $ per token for a catalogue entry (cents x100 per token, as main.js stores it). The
 * cache prices fall back to the usual ratios when the catalogue does not list them:
 * reads at a tenth of input, writes at input (x1.25 where writes are billed, Anthropic).
 * With the hour-long Claude cache (opts.hour) writes cost twice the input price.
 */
function pricesOf(cap, model, opts = {}) {
  const c = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) / 100 : null);
  const inp = c(cap && cap.promptCents);
  const out = c(cap && cap.completionCents);
  if (inp == null || out == null) return null;
  const explicit = /(^|\/)anthropic\/|claude/i.test(String(model || ''));
  return {
    in: inp,
    out,
    read: c(cap.cacheReadCents) != null ? c(cap.cacheReadCents) : inp * 0.1,
    write: explicit && opts.hour ? inp * 2 : (c(cap.cacheWriteCents) != null ? c(cap.cacheWriteCents) : inp * (explicit ? 1.25 : 1)),
  };
}

/**
 * ru: the run's usage ({ input, output, cacheRead, cacheWrite, reasoning, cost,
 * subIn, subOut, subCR, extras: { label: $ } }). price: pricesOf(...) or null.
 * Returns { parts: [{ key, label, tokens, cost, thinking? }], extras: [{ label, cost }] }.
 */
function breakdown(ru, price) {
  const r = ru || {};
  const n = (v) => Math.max(0, Number(v) || 0);
  const inTok = n(r.input) - n(r.subIn);
  const read = Math.min(inTok, n(r.cacheRead) - n(r.subCR));
  const write = Math.min(Math.max(0, inTok - read), n(r.cacheWrite));
  const fresh = Math.max(0, inTok - read - write);
  const out = Math.max(0, n(r.output) - n(r.subOut));
  const extras = Object.entries(r.extras || {}).map(([label, cost]) => ({ label, cost: n(cost) })).filter((e) => e.cost > 0);
  const extraCost = extras.reduce((s, e) => s + e.cost, 0);
  const modelCost = Math.max(0, n(r.cost) - extraCost);
  const p = price || { in: 1, out: 4, read: 0.1, write: 1 };   // shape only, when prices are unknown
  const parts = [
    { key: 'fresh', label: 'Fresh input', tokens: fresh, w: fresh * p.in },
    { key: 'cached', label: 'Cached input', tokens: read, w: read * p.read },
    { key: 'written', label: 'Cache writes', tokens: write, w: write * p.write },
    { key: 'output', label: 'Output', tokens: out, w: out * p.out, thinking: Math.min(out, n(r.reasoning)) },
  ];
  const wsum = parts.reduce((s, x) => s + x.w, 0);
  for (const x of parts) { x.cost = wsum > 0 ? modelCost * (x.w / wsum) : 0; delete x.w; }
  return { parts: parts.filter((x) => x.tokens > 0), extras };
}

module.exports = { breakdown, pricesOf };
