/**
 * team -- spending less on an expensive model.
 *
 *   A  Team: the session's (expensive) model plans and reviews; a cheap "coder" runs as its
 *      sub-agent and does the hands-on work -- edits, commands, checks. Its choice is saved
 *      with the session (sess.coderModel).
 *   B  Data-sharing models: cheaper (or free) because the maker may train on what you send.
 *      Meta's "-contributor" tier says so outright ("your prompts and outputs may be used to
 *      improve Meta's products"); free ":free" models may. OpenRouter's catalogue does not
 *      mark any of this, so it is read from the model's name -- and a project has to be
 *      shared on purpose, once, before one is used in it.
 */

/** Output at or above this ($ per 1M tokens) is "expensive": Opus, Sonnet, GPT-5, Gemini Pro. */
const EXPENSIVE_OUT_PER_M = 5;
const outPerM = (cap) => (cap && cap.completionCents != null ? Number(cap.completionCents) * 1e4 : null);
const isExpensive = (cap) => { const o = outPerM(cap); return o != null && o >= EXPENSIVE_OUT_PER_M; };

// Who a model's data goes to, by its maker's prefix.
const MAKER = { meta: 'Meta', 'meta-llama': 'Meta', poolside: 'Poolside', nvidia: 'NVIDIA', google: 'Google', qwen: 'Alibaba (Qwen)',
  thinkingmachines: 'Thinking Machines', cohere: 'Cohere', inclusionai: 'inclusionAI', liquid: 'Liquid AI', 'dots-studio': 'dots.studio',
  mistralai: 'Mistral', deepseek: 'DeepSeek', openai: 'OpenAI', anthropic: 'Anthropic', 'z-ai': 'Z.ai', moonshotai: 'Moonshot' };

/**
 * Does this model share what you send with its maker? { how: 'yes' | 'may', who } or null.
 * 'yes': a contributor tier -- sharing is the deal. 'may': a free model, whose providers may
 * log or train on it.
 */
function sharesData(id, cap) {
  const s = String(id || '').toLowerCase();
  if (!s) return null;
  const prefix = s.split('/')[0];
  const who = MAKER[prefix] || (prefix ? prefix.charAt(0).toUpperCase() + prefix.slice(1) : 'the model\'s maker');
  if (/-contributor(\b|$)|:contributor$/.test(s)) return { how: 'yes', who };
  // Anonymous "stealth" models: their prompts and replies are logged for the lab behind them.
  if (prefix === 'stealth') return { how: 'yes', who: 'the unnamed lab behind it' };
  if (/:free$/.test(s)) return { how: 'may', who };
  // Nothing to pay at all (a free model without ":free" in its name): someone is paid in data.
  const price = (c, k) => (c ? Number(c[k + 'Cents'] != null ? c[k + 'Cents'] : c[k]) : NaN);
  if (cap && price(cap, 'prompt') === 0 && price(cap, 'completion') === 0) return { how: 'may', who };
  return null;
}

/** A project's key for its sharing consent: its folder, compared without case or trailing slash. */
const projectKey = (workdir) => String(workdir || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();

/** OpenRouter's refusals, said so the user can act on them. '' when it is something else. */
function explainProviderError(message, model) {
  const m = String(message || '');
  const sh = sharesData(model);
  if (/No endpoints found matching your data policy|matching your (guardrail restrictions and )?data policy|model training violation/i.test(m)) {
    return `${model} only runs when your OpenRouter account allows providers that may train on your data, and yours does not (the safe default). `
      + 'Turn that on at openrouter.ai/settings/privacy (it is your OpenRouter account, not VoxAI), or pick another model.';
  }
  // A free model's 429 is one of three things, and only one of them lasts until tomorrow.
  const raw = m.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (sh && sh.how === 'may' && /free-models-per-day|daily limit/i.test(m)) {
    return `The free limit for ${model} is used up for today (50 requests a day, or 1,000 once your OpenRouter account has bought $10 of credit). `
      + `Carry on with the paid version of the model, or another one. (OpenRouter: ${raw})`;
  }
  if (sh && sh.how === 'may' && /free-models-per-min/i.test(m)) {
    return `Too many requests to free models this minute (OpenRouter allows 20 a minute). Wait a minute and send again. (OpenRouter: ${raw})`;
  }
  if (sh && sh.how === 'may' && /\b429\b|rate.?limit/i.test(m)) {
    return `${model} is busy right now: its provider is turning away free requests (everyone shares a small free allowance). `
      + `Wait a minute and send again, or pick another model. (OpenRouter: ${raw})`;
  }
  return '';
}

/**
 * Team's one hard rule: the planner does not write the code itself. Told only in words, Opus and
 * Sonnet as planners wrote every file themselves and the coder was never called, so Team cost
 * what the planner alone costs. A small fix (a few lines) is still the planner's to make, up to
 * about 40 lines a run in all: refused one big write, a planner wrote the same file ten lines at a
 * time. Once the coder has failed twice the planner may take over.
 * `st` is the run's { coderFails, written }; '' when the call may go ahead.
 */
const TEAM_SMALL_CHARS = 600, TEAM_SMALL_LINES = 12, TEAM_RUN_LINES = 40;
// Testing in the browser is the coder's too: a Sonnet planner took nine screenshots itself to check
// a stopwatch page, and those, read at the planner's price, were most of the run's cost. It keeps
// a few looks of its own for a last check.
const TEAM_RUN_LOOKS = 3, TEAM_RUN_LOOKS_BLIND = 8;   // a coder that cannot see leaves the looking to the planner
const BROWSER_TOOLS = new Set(['computer', 'browser_open', 'browser_act', 'browser_screenshot']);
function teamGuard(name, args, st) {
  const run = st && typeof st === 'object' ? st : { coderFails: Number(st) || 0, written: 0 };
  if ((run.coderFails || 0) >= 2) return '';
  const a = args || {};
  if (BROWSER_TOOLS.has(name)) {
    if ((run.looks || 0) < (run.blindCoder ? TEAM_RUN_LOOKS_BLIND : TEAM_RUN_LOOKS)) { run.looks = (run.looks || 0) + 1; return ''; }
    return refuse(run, 'TEAM: testing in the browser is the coder\'s job, not yours (each screenshot you read costs many times more). Call spawn_agent (role "build") '
      + 'with what to open, what to click and what should happen, and ask it to report what it saw. Do not retry this call.');
  }
  let text = null;
  if (name === 'write') text = String(a.content || '');
  else if (name === 'edit') text = String(a.after != null ? a.after : (a.new_string || ''));
  else if (name === 'patch') text = (Array.isArray(a.edits) ? a.edits : []).map((e) => String((e && e.new) || '')).join('\n');
  if (text === null) return '';
  const lines = text.split('\n').length;
  const small = text.length <= TEAM_SMALL_CHARS && lines <= TEAM_SMALL_LINES;
  if (small && (run.written || 0) + lines <= TEAM_RUN_LINES) { run.written = (run.written || 0) + lines; return ''; }
  const why = small ? `you have already written ${run.written} lines yourself in this run, and splitting work into small pieces does not change whose it is`
    : `this ${name} is ${lines} lines`;
  return refuse(run, `TEAM: ${why}; that is the coder's job, not yours. Call spawn_agent (role "build") and tell the coder `
    + 'which file to change, what to change, and how to check it. Make only small fixes (a few lines) yourself. Do not retry this call.');
}
/**
 * A refusal, said more plainly each time: told once, a planner still tried the browser four more
 * times, each a turn at its own price. spawn_agent resets the count (agent.js).
 */
function refuse(run, msg) {
  run.refused = (run.refused || 0) + 1;
  if (run.refused < 2) return msg;
  return `TEAM: refused ${run.refused} times in a row. Stop trying to do this yourself: your next call must be spawn_agent (role "build") with the task. `
    + 'Every write, edit, patch or browser action like this one will be refused the same way. ' + msg.replace(/^TEAM: /, '');
}

/**
 * The planner's standing orders when a coder is set. Kept short: every token of it is paid
 * at the planner's price on every turn (it sits in the cached head, so mostly at the read price).
 */
function teamPrompt(coderModel, coderVision) {
  if (!coderModel) return '';
  // A coder that cannot read images builds a UI it never sees: the planner, which can, is its eyes.
  const eyes = coderVision === false
    ? '- The coder cannot see images: it reads a page\'s text but not how it looks. The looking is yours: after each step that changes what is on screen, open it in the browser, use it, and send the coder exact fixes (what is wrong, where, what it should be). You have a few more looks for this.'
    : '- The coder tests in the browser and reports what it saw. Use one look of your own at the end, then finish: a short summary, no extra plan updates or notes.';
  return `\n\nTEAM: you are the lead, and a cheaper coder model (${coderModel}) does the hands-on work. You plan and review; it edits files and runs commands.
- Look at what you need, then write a short numbered plan.
- Give each step to the coder with spawn_agent (role "build"; the coder model is already chosen): say exactly what to change, in which files, how to check it, and what good looks like (the details that make it feel right, e.g. for a game the ball speeding up and angling off the paddle). Name files; do not paste whole files.
- Keep steps small: one feature or one file at a time, something the coder can finish and check in about 15 actions. Several short steps you look at in between beat one long one you wait on.
- For the next step, continue the same coder: spawn_agent with resume set to its subId and the new task. It keeps what it has read; a new coder starts over and reads everything again at your cost. Start a new one only for unrelated work.
- Trust its report. Do not re-read whole files it wrote, list folders or tidy up after it: every turn of yours re-sends your whole context at your price. Read only the part in question when something is wrong, then send it back with the specific fix. If a step fails twice, do it yourself.
- Make one- or two-line fixes yourself rather than handing them over. A bigger write, edit or patch from you is refused: that is the coder's.
${eyes}
- Keep your own messages short. Your tokens cost many times the coder's.`;
}

/** Roughly what a run would have cost with the coder doing most of the tokens (the hint). */
function teamEstimate(cost, plannerCap, coderCap) {
  const avg = (c) => (c ? (Number(c.promptCents) * 0.8 + Number(c.completionCents) * 0.2) : null);
  const p = avg(plannerCap), q = avg(coderCap);
  if (!(cost > 0) || !(p > 0) || q == null) return null;
  // The planner keeps about a third of the tokens (reading, planning, reviewing); the coder
  // does the rest at its own prices.
  return cost * 0.35 + cost * 0.65 * (q / p);
}

module.exports = { EXPENSIVE_OUT_PER_M, outPerM, isExpensive, sharesData, projectKey, explainProviderError, teamPrompt, teamGuard, teamEstimate };
