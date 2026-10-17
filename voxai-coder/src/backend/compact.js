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
const MAX_SUMMARY_CHARS = 14000;  // the most a recap takes; a small context gets less (compactSession)

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

/*
 * The recap. It used to take the first user message as "the goal": after one compaction that
 * message WAS the previous recap, so each recap nested the last one, cut to 400 characters, until
 * a session's whole memory was 480 characters of "[VOX COMPACTED CONTEXT] ### Prior session
 * context (compacted) Goal/direction: [VOX COMPACTED CONTEXT] ..." and nothing of what the user
 * asked. It also skipped requests sent with attachments, counted the app's own notes ([VOX PLAN],
 * [VOX GOAL]) as requests, filled up with the OLDEST tool output, and never said which files were
 * done -- so the model lost what the user wanted, redid finished steps and went round in loops.
 *
 * Now: the user's requests in their own words (the newest marked current), carried forward from
 * the previous recap rather than nested in it; the files changed; the plan; the newest progress
 * notes and failures; and where the detail still is. Still free and local: no model call.
 */
const RECAP_HEAD = '### Earlier in this session (summarised; the newest messages follow below)';
const SEC_REQUESTS = "The user's requests, in their words (oldest first):";
const SEC_FILES = 'Files changed so far:';
const SEC_PLAN = 'The plan:';
const SEC_PROGRESS = 'Progress so far (newest last):';
const SEC_PROBLEMS = 'Problems hit (newest last):';

/** A user message's own words, or '' for the app's notes. Steering and commands are the user's. */
function userWords(content) {
  const parts = typeof content === 'string' ? [content]
    : Array.isArray(content) ? content.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')) : [];
  const images = Array.isArray(content) ? content.filter((p) => p && p.type === 'image_url').length : 0;
  const own = parts.map((t) => t.trim()).filter((t) => t && !/^\[VOX FILES\]/.test(t));
  let text = own.join('\n\n').trim();
  if (/^\[VOX STEER\]/.test(text)) text = text.replace(/^\[VOX STEER\]\s*The user sent this while you were working:\s*/, '(sent while you were working) ');
  else if (/^\[VOX CMD\]/.test(text)) text = text.split('\n')[0].replace(/^\[VOX CMD\]\s*/, '');
  else if (/^\[VOX[^\]]*\]/.test(text)) return '';
  if (!text) return '';
  return images ? `${text} (with ${images} ${images === 1 ? 'picture' : 'pictures'})` : text;
}

/** The sections of a recap this compactor wrote earlier (an old nested one yields nothing). */
function readRecap(text) {
  const out = { requests: [], files: [], progress: [], problems: [] };
  if (!String(text).includes(RECAP_HEAD)) return out;
  let section = '';
  for (const line of String(text).split('\n')) {
    if (line === SEC_REQUESTS) section = 'requests';
    else if (line === SEC_FILES) section = 'files';
    else if (line === SEC_PROGRESS) section = 'progress';
    else if (line === SEC_PROBLEMS) section = 'problems';
    else if (line === SEC_PLAN || line.startsWith('###') || line.startsWith('Carry on')) section = '';
    else if (section === 'requests' && /^\d+\. /.test(line)) out.requests.push(line.replace(/^\d+\. (\[current\] )?/, ''));
    else if (section === 'requests' && out.requests.length && line.startsWith('   ')) out.requests[out.requests.length - 1] += '\n' + line.slice(3);
    else if (section === 'files' && line.trim()) out.files.push(...line.split(', ').map((f) => f.trim()).filter((f) => f && !/^\(\+\d+ more\)$/.test(f)));
    else if ((section === 'progress' || section === 'problems') && line.startsWith('- ')) out[section].push(line.slice(2));
  }
  return out;
}

/** A tool call's arguments, parsed. */
function callArgs(call) {
  try { return JSON.parse((call.function && call.function.arguments) || '{}') || {}; } catch { return {}; }
}

/** Build the recap from the messages being folded away (no API call). */
function buildRecap(old, opts = {}) {
  const cap = Math.max(2500, Number(opts.maxChars) || MAX_SUMMARY_CHARS);
  const requests = [], files = [], progress = [], problems = [];
  for (const m of old) {
    if (m.role === 'user') {
      const raw = typeof m.content === 'string' ? m.content : '';
      if (/^\[VOX COMPACTED CONTEXT\]/.test(raw)) {
        const prev = readRecap(raw);
        requests.push(...prev.requests); files.push(...prev.files);
        progress.push(...prev.progress); problems.push(...prev.problems);
        continue;
      }
      const words = userWords(m.content);
      if (words.length > 1) requests.push(words);
    } else if (m.role === 'assistant') {
      const said = typeof m.content === 'string' ? m.content.replace(/\s+/g, ' ').trim() : '';
      if (said) progress.push(said.length > 300 ? said.slice(0, 299) + '…' : said);
      for (const call of m.tool_calls || []) {
        const name = call.function && call.function.name, a = callArgs(call);
        if (/^(write|edit|patch)$/.test(name) && a.path) files.push(String(a.path));
        else if (name === 'fs' && (a.destination || a.path) && a.action !== 'stat') files.push(String(a.destination || a.path));
      }
    } else if (m.role === 'tool' && typeof m.content === 'string' && /^\s*DENIED_OR_ERROR:/.test(m.content)) {
      const why = m.content.replace(/^\s*DENIED_OR_ERROR:\s*/, '').replace(/\s+/g, ' ').trim();
      problems.push(why.length > 200 ? why.slice(0, 199) + '…' : why);
    }
  }
  const uniqueFiles = [...new Set(files.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')))];
  const plan = Array.isArray(opts.todos) ? opts.todos.filter(Boolean) : [];

  // Room goes to the requests first (newest kept whole), then the rest, newest first.
  const fit = (items, max) => items.map((t) => (t.length > max ? t.slice(0, max - 1) + '…' : t));
  // The first request (how the session began) and the newest stay; the middle ones go first.
  const reqBudget = Math.floor(cap * 0.55);
  const size = (items) => items.reduce((n, t) => n + t.length, 0);
  let reqs = fit(requests, 2500), left = 0;
  while (reqs.length > 2 && size(reqs) > reqBudget) { reqs.splice(1, 1); left++; }
  if (reqs.length === 2 && size(reqs) > reqBudget) reqs[0] = fit([reqs[0]], 600)[0];
  if (reqs.length && size(reqs) > reqBudget) reqs[reqs.length - 1] = fit([reqs[reqs.length - 1]], Math.max(800, reqBudget - size(reqs.slice(0, -1))))[0];
  const lines = [RECAP_HEAD];
  if (reqs.length) {
    lines.push(SEC_REQUESTS);
    reqs.forEach((r, i) => {
      const [first, ...rest] = r.split('\n');
      lines.push(`${i + 1}. ${i === reqs.length - 1 ? '[current] ' : ''}${first}`, ...rest.map((l) => '   ' + l));
      if (i === 0 && left) lines.push(`   (${left} later ${left === 1 ? 'request' : 'requests'} in between are not shown)`);
    });
  }
  if (uniqueFiles.length) {
    const shown = uniqueFiles.slice(-60);
    lines.push('', SEC_FILES, shown.join(', ') + (uniqueFiles.length > shown.length ? `, (+${uniqueFiles.length - shown.length} more)` : ''));
  }
  if (plan.length) {
    lines.push('', SEC_PLAN, ...plan.slice(0, 20).map((t) => `${t.done ? '[done]' : '[open]'} ${String(t.text || '').slice(0, 160)}`));
  }
  const head = lines.join('\n');
  const tailNote = '\nCarry on with the [current] request from where the newest messages below leave off: do not redo what is done. '
    + 'This summary is short; read the files, your progress notes (build_state) and project memory again rather than guessing.';
  let room = cap - head.length - tailNote.length;
  const pick = (items, max) => {
    const out = [];
    for (let i = items.length - 1; i >= 0 && out.length < max; i--) {
      const line = '- ' + items[i];
      if (room - line.length - 1 < 0) break;
      room -= line.length + 1;
      out.unshift(line);
    }
    return out;
  };
  const shownProblems = pick(problems, 5);
  const shownProgress = pick(progress, 15);
  const body = [head];
  if (shownProgress.length) body.push('', SEC_PROGRESS, ...shownProgress);
  if (shownProblems.length) body.push('', SEC_PROBLEMS, ...shownProblems);
  return (body.join('\n') + '\n' + tailNote).slice(0, cap);
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
    // About a seventh of the room the conversation may use, so a 16k local model keeps space to work.
    const recap = buildRecap(old, { maxChars: Math.min(MAX_SUMMARY_CHARS, Math.floor(budget * 4 * 0.15)), todos: session.todos });
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