/**
 * Compactor — keeps long sessions within context by summarizing older turns.
 *
 * Fix 2 (benchmark): the trigger is now TOKEN-based, not message-count-based.
 * Goose auto-compacts at 80% of the model context limit; we estimate tokens as
 * ~chars/4 and compact when the estimated context exceeds `contextLimit *
 * threshold`. Configurable via env:
 *   VOX_COMPACT_THRESHOLD    (float 0..1, default 0.8 — like GOOSE_AUTO_COMPACT_THRESHOLD)
 *   VOX_COMPACT_KEEP_TOKENS  (tokens to keep verbatim, default 6000)
 *
 * Fix 5 (benchmark): compaction stays a FREE local recap — no extra LLM call.
 * Older messages are folded into ONE user block tagged [VOX COMPACTED CONTEXT]
 * using a key-based summarizer (the model already saw those turns).
 *
 * Stall-hardening (goose post-mortem):
 *   IMPL 1 — sane default context limit (200K, not the 1.31M alias metadata) so
 *            compaction fires EARLY, before requests outgrow what the provider
 *            actually serves reliably.
 *   IMPL 2 — hard safety net: at `contextLimit * hardFraction` (default 90%)
 *            compaction is forced and the keep-window is shrunk progressively so
 *            the next request ALWAYS fits under the hard limit.
 *   IMPL 3 — after compacting, the result is re-estimated; if it still exceeds
 *            the hard limit the keep window shrinks further (self-check).
 */

const COMPACT_KEEP_RECENT = 16;          // fallback guard: always keep this many messages
const MAX_SUMMARY_CHARS = 6000;

function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// IMPL 1: sane working-cap default. 200K is well under what OpenRouter's
// ~deepseek-v4-flash-latest alias claims (1.31M) but above where real sessions
// stay comfortable; the provider demonstrably fails ~650K (goose stall).
function defaultContextLimit() {
  return Math.max(16000, Math.round(envNum('VOX_CONTEXT_LIMIT', 200000)));
}

function defaultThreshold() {
  const t = envNum('VOX_COMPACT_THRESHOLD', 0.8);
  return Math.min(0.99, Math.max(0.0, t));
}

function defaultKeepTokens() {
  return Math.max(512, Math.round(envNum('VOX_COMPACT_KEEP_TOKENS', 6000)));
}

// IMPL 2: hard-overrun fraction. When estimated tokens exceed this fraction of
// the context limit, compaction is FORCED with a shrinking keep window so the
// request never ships over budget.
function defaultHardFraction() {
  const f = envNum('VOX_HARD_LIMIT_FRACTION', 0.9);
  return Math.min(0.99, Math.max(0.5, f));
}

/** Rough tokens from chars — 4 chars/token is the standard estimate. */
// What one image costs a request, roughly -- providers bill a screenshot at about a
// thousand tokens, not by the length of its base64. Counting the characters made a
// run with 13 screenshots read "163% full" and would have summarised the whole
// conversation away. Found in a live run.
const IMAGE_TOKENS = 1200;
function estimateTokens(...parts) {
  let chars = 0;
  let images = 0;
  const skipImages = (_k, v) => {
    if (typeof v === 'string' && v.startsWith('data:image/')) { images++; return ''; }
    return v;
  };
  for (const p of parts) {
    if (typeof p === 'string') {
      if (p.startsWith('data:image/')) images++;
      else chars += p.length;
    } else if (p && typeof p === 'object') {
      try { chars += JSON.stringify(p, skipImages).length; } catch { /* skip */ }
    }
  }
  return Math.ceil(chars / 4) + images * IMAGE_TOKENS;
}

/**
 * Estimate how many tokens session.messages would occupy as an OpenAI request.
 * Approximates the system prompt cost + each message.
 */
function estimateSessionTokens(session, systemPrompt = '') {
  let total = estimateTokens(systemPrompt);
  for (const m of session.messages || []) {
    const c = m.content;
    if (typeof c === 'string') {
      total += estimateTokens(c);
    } else if (Array.isArray(c)) {
      total += estimateTokens(c);
    } else if (c != null) {
      total += 16; // unknown content object — assume a small overhead
    }
    if (m.tool_calls) total += estimateTokens(m.tool_calls);
  }
  return total;
}

/** Walk messages from the tail, return how many newest messages fit `recentTokensMax`. */
function splitPoint(msgs, recentTokensMax, keepMin = COMPACT_KEEP_RECENT) {
  let splitAt = 0;
  let keptChars = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const t = typeof m.content === 'string' ? m.content.length : (Array.isArray(m.content) ? JSON.stringify(m.content).length : 64);
    if (splitAt > 0 && (keptChars / 4) > recentTokensMax) break;
    keptChars += t;
    splitAt += 1;
    if ((msgs.length - splitAt) <= keepMin - 1) break; // always keep at least RECENT msgs
  }
  return splitAt;
}

/** Build the terse recap from the oldest messages (no API call). */
function buildRecap(old) {
  const summaryBlocks = [];
  let userGoal = '';
  let chars = 0;
  for (const m of old) {
    if (chars >= MAX_SUMMARY_CHARS) break;
    const c = m.content;
    if (m.role === 'user' && typeof c === 'string') {
      const t = c.trim();
      if (t && t.length > 4) {
        if (userGoal) summaryBlocks.push({ kind: 'user', text: t.slice(0, 400) });
        else userGoal = t.slice(0, 400);
        chars += t.length;
      }
    } else if (m.role === 'assistant' && typeof c === 'string' && c && !m.tool_calls) {
      const t = c.trim().slice(0, 300);
      if (t) { summaryBlocks.push({ kind: 'assistant', text: t }); chars += t.length; }
    } else if (m.role === 'tool' && typeof c === 'string' && c) {
      let line = c.replace(/\s+/g, ' ').trim();
      if (line.length > 160) line = line.slice(0, 160) + '…';
      summaryBlocks.push({ kind: 'tool', text: line });
      chars += line.length;
    }
  }
  let recap = '### Prior session context (compacted)\n';
  if (userGoal) recap += `Goal/direction: ${userGoal}\n\n`;
  for (const b of summaryBlocks.slice(0, 40)) {
    if (b.kind === 'user') recap += `- User asked: ${b.text}\n`;
    else if (b.kind === 'assistant') recap += `- Done: ${b.text}\n`;
    else recap += `- Tool: ${b.text}\n`;
  }
  return recap.slice(0, MAX_SUMMARY_CHARS);
}

/**
 * Compact session.messages in place when estimated tokens exceed the limit.
 * Returns diagnostics including estimatedBefore/After, budget, hardLimit, and
 * whether the compacted session fits under the hard limit.
 *
 * Process (no extra LLM call):
 *  1. If under `threshold` of context and not forced → no-op.
 *  2. Otherwise fold oldest messages into a recap, keeping ~25% of the budget
 *     as recent messages by default.
 *  3. IMPL 3 self-check: re-estimate the result. If it still exceeds the hard
 *     limit, re-run with a tighter keep window (15% → 8% → 4% → 2%) until it
 *     fits, or until only the recap + COMPACT_KEEP_RECENT messages remain.
 */
function compactSession(session, opts = {}) {
  const contextLimit = Number(opts.contextLimit) > 0 ? Number(opts.contextLimit) : defaultContextLimit();
  const threshold = opts.threshold != null ? Number(opts.threshold) : defaultThreshold();
  const keepTokens = opts.keepTokens != null ? Number(opts.keepTokens) : defaultKeepTokens();
  const hardFraction = opts.hardFraction != null ? Number(opts.hardFraction) : defaultHardFraction();
  const systemPrompt = opts.systemPrompt || '';
  // Fewer may be kept when asked: a model on this PC with a 16k context could not fit even 16.
  const keepMin = Number(opts.keepRecent) > 0 ? Number(opts.keepRecent) : COMPACT_KEEP_RECENT;

  const msgs = session.messages || [];
  const estimatedBefore = opts.estimatedBefore != null ? opts.estimatedBefore : estimateSessionTokens(session, systemPrompt);

  const budget = Math.floor(contextLimit * threshold);
  const hardLimit = Math.floor(contextLimit * hardFraction);
  const overBudget = estimatedBefore > budget;
  const overHard = estimatedBefore > hardLimit;
  const needsCompact = opts.force || overBudget || overHard;

  if (!needsCompact) {
    return { compacted: false, estimatedBefore, budget, hardLimit, reason: 'under-budget', fitsHardLimit: estimatedBefore <= hardLimit };
  }
  if (msgs.length <= keepMin + 2) {
    return { compacted: false, estimatedBefore, budget, hardLimit, reason: 'too-few-messages', fitsHardLimit: estimatedBefore <= hardLimit };
  }

  // Keep-window fractions tried in order. Over the hard limit, start tighter and
  // keep shrinking until the result fits (IMPL 2 + 3).
  const keepFractions = [0.25, 0.15, 0.08, 0.04, 0.02];

  let best = null;
  for (const frac of keepFractions) {
    const effectiveKeepTokens = Math.max(256, Math.floor(budget * frac));
    let splitAt = splitPoint(msgs, effectiveKeepTokens, keepMin);
    // Never keep a tool result whose call was folded away: a request that starts with one is
    // refused by models that check. (Compacting mid-run, for a model on this PC, can cut there.)
    while (splitAt > 0 && msgs[msgs.length - splitAt] && msgs[msgs.length - splitAt].role === 'tool') splitAt--;
    if (splitAt <= 0) break;
    const old = msgs.slice(0, msgs.length - splitAt);
    const recent = msgs.slice(msgs.length - splitAt);
    const recap = buildRecap(old);
    const compacted = [
      { role: 'user', content: `[VOX COMPACTED CONTEXT]\n${recap}` },
      ...recent,
    ];
    const estimatedAfter = estimateSessionTokens({ messages: compacted }, systemPrompt);
    const fits = estimatedAfter <= hardLimit;
    best = {
      compacted: true,
      dropped: old.length,
      keptRecent: recent.length,
      summaryChars: recap.length,
      estimatedBefore,
      estimatedAfter,
      budget,
      hardLimit,
      keepFraction: frac,
      reason: overHard ? 'hard-overrun' : (opts.force ? 'forced' : 'over-budget'),
      fitsHardLimit: fits,
      compactedMessages: compacted,
    };
    if (fits) {
      session.compactedAt = new Date().toISOString();
      session.messages = compacted;
      session.stops = [];   // their positions were in the old numbering
      best.session = session;
      return best;
    }
    // else try the next, tighter fraction
  }

  // Tightest pass still didn't fit — ship the tightest anyway so the next
  // request is as small as we can make it (never silently send oversized).
  if (best) {
    session.compactedAt = new Date().toISOString();
    session.messages = best.compactedMessages;
    session.stops = [];
    best.session = session;
    delete best.compactedMessages;
    return best;
  }
  return { compacted: false, estimatedBefore, budget, hardLimit, reason: 'no-split', fitsHardLimit: estimatedBefore <= hardLimit };
}

module.exports = { compactSession, estimateSessionTokens, estimateTokens, COMPACT_KEEP_RECENT, MAX_SUMMARY_CHARS, defaultContextLimit, defaultHardFraction };