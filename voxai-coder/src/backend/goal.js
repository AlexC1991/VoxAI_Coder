/**
 * /goal -- keep working until a condition is met.
 *
 * Modelled on Claude Code's /goal (code.claude.com/docs/en/goal): the model doing the
 * work never marks its own homework. When a run ends, a separate call reads the goal
 * and the transcript and answers met / not met / impossible. "Not met" comes back with
 * what is missing, and that is the next run's message. The loop itself lives in
 * main.js (runs are started there); what it decides is here, where it can be tested.
 *
 * It stops when: the goal is met or impossible, the user stops or clears it, a run
 * fails, the goal's own spend limit is reached, or the agent answers three times in a
 * row without doing anything (no tool calls) -- the no-progress guard.
 */
const { chatOnce } = require('./providers/openrouter');

const CLEAR_WORDS = /^(clear|stop|off|reset|none|cancel)$/i;
const IDLE_LIMIT = 3;

/** What a typed "/goal ..." means: { op: 'set', condition } | { op: 'clear' } | { op: 'show' } | null. */
function parseGoalCommand(text) {
  const m = /^\/goal(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const rest = String(m[1] || '').trim();
  if (!rest) return { op: 'show' };
  if (CLEAR_WORDS.test(rest)) return { op: 'clear' };
  return { op: 'set', condition: rest };
}

function newGoal(condition, atMessage) {
  return { condition: String(condition).slice(0, 2000), status: 'active', paused: false, setAt: new Date().toISOString(),
    fromMessage: atMessage || 0, runs: 0, tools: 0, spent: 0, idle: 0, checks: [] };
}

const textOf = (c) => (typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ') : '');
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

/**
 * The part of the conversation the checker reads: since the goal was set, newest kept
 * when it is long. Tool calls and their results are the evidence, so they stay; the
 * pictures do not (a screenshot's text description does).
 */
function goalTranscript(messages, fromIndex = 0, maxChars = 40000) {
  const out = [];
  for (const m of (messages || []).slice(Math.max(0, fromIndex))) {
    if (!m) continue;
    if (m.role === 'user') {
      const t = textOf(m.content);
      if (/^\[VOX (TOOL SCREENSHOTS|COMPACTED)/.test(t)) continue;
      out.push((/^\[VOX GOAL\]/.test(t) ? 'GOAL CHECK: ' : 'USER: ') + clip(t.replace(/^\[VOX GOAL\]\s*/, ''), 1500));
    } else if (m.role === 'assistant') {
      const t = textOf(m.content);
      if (t.trim()) out.push('AGENT: ' + clip(t, 1500));
      for (const c of m.tool_calls || []) {
        out.push(`TOOL CALL ${c.function && c.function.name}: ${clip(c.function && c.function.arguments, 400)}`);
      }
    } else if (m.role === 'tool') {
      out.push('TOOL RESULT: ' + clip(textOf(m.content), 700));
    }
  }
  let text = out.join('\n');
  if (text.length > maxChars) text = '[earlier part left out]\n' + text.slice(text.length - maxChars);
  return text;
}

const CHECK_PROMPT = 'You check whether a coding agent has met a goal. You get the goal, some numbers about the work so far, '
  + 'and the latest part of the agent\'s transcript: its messages, the tool calls it made and what those tools returned.\n'
  + 'Judge by EVIDENCE in tool results: command output, test results, file contents, git or cbx output, what a screenshot '
  + 'description says. The agent\'s own words ("done", "committed", "it works", "tests pass") are not evidence unless a tool '
  + 'result shows it. A step the goal asks for that no tool result shows is NOT met.\n'
  + 'If the goal names its own limit ("or stop after 20 turns", "within $2", "for an hour"), use the numbers to decide it.\n'
  + 'Answer with JSON only: {"verdict":"met"|"not_met"|"impossible","reason":"..."}.\n'
  + '- not_met: the reason says exactly what is still missing or unproven, written as an instruction the agent can act on.\n'
  + '- impossible: only when the goal cannot be reached at all here (for example it needs something the agent has no way '
  + 'to get), not merely because it is hard or unfinished.\n'
  + '- met: the reason names the evidence.';

/** One check. Never throws: { verdict, reason, cost, error? }. */
async function evaluateGoal({ apiKey, host, model, goal, messages, signal, chat = chatOnce }) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(goal.setAt || Date.now())) / 60000));
  const numbers = `Runs so far: ${goal.runs}. Tool calls: ${goal.tools}. Spent: $${Number(goal.spent || 0).toFixed(2)}. Minutes since the goal was set: ${mins}.`;
  try {
    const r = await chat({
      apiKey, host, model, signal, maxTokens: 600, extra: { usage: { include: true } },
      messages: [
        { role: 'system', content: CHECK_PROMPT },
        { role: 'user', content: `GOAL: ${goal.condition}\n${numbers}\n\nTRANSCRIPT:\n${goalTranscript(messages, goal.fromMessage)}` },
      ],
    });
    const text = String((r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '');
    const cost = Number(r && r.usage && (r.usage.cost || r.usage.total_cost)) || 0;
    const m = /\{[\s\S]*\}/.exec(text);
    let o = null;
    try { o = m ? JSON.parse(m[0]) : null; } catch { o = null; }
    const verdict = o && ['met', 'not_met', 'impossible'].includes(o.verdict) ? o.verdict : null;
    if (!verdict) return { verdict: null, reason: 'the check gave no clear answer', cost, error: true };
    return { verdict, reason: clip(o.reason || '', 600), cost };
  } catch (e) {
    return { verdict: null, reason: String((e && e.message) || e).slice(0, 300), cost: 0, error: true };
  }
}

/**
 * After a run ends: what next? Updates the goal's counters and returns one of
 *   { next: 'check' }                        ask the checker
 *   { next: 'continue', message }            start another run now, without a check
 *   { next: 'pause', reason }                stop the loop; the goal stays set
 * `end` is the run's last event type; `run` = { tools, cost }.
 */
function afterRun(goal, end, run, goalBudgetUsd) {
  goal.runs += 1;
  goal.tools += Number(run.tools) || 0;
  goal.spent += Number(run.cost) || 0;
  if (goal.paused || end === 'cancelled') return { next: 'pause', reason: 'you stopped it' };
  if (end === 'error') return { next: 'pause', reason: 'the run failed' };
  if (goal.spent >= goalBudgetUsd) return { next: 'pause', reason: `its runs have spent $${goal.spent.toFixed(2)}, the $${Number(goalBudgetUsd).toFixed(2)} limit per goal` };
  // Stopped by a limit rather than by itself: nothing to judge yet, carry straight on.
  if (end === 'limit_reached' || end === 'budget_reached') {
    goal.idle = 0;
    return { next: 'continue', message: `[VOX GOAL] Carry on toward the goal: ${goal.condition}` };
  }
  goal.idle = run.tools > 0 ? 0 : goal.idle + 1;
  if (goal.idle >= IDLE_LIMIT) return { next: 'pause', reason: `the agent answered ${IDLE_LIMIT} times in a row without doing anything` };
  return { next: 'check' };
}

/** Record a check on the goal, and say what follows. */
function applyCheck(goal, check) {
  goal.spent += Number(check.cost) || 0;
  goal.checks.push({ at: new Date().toISOString(), verdict: check.verdict, reason: check.reason });
  if (goal.checks.length > 20) goal.checks.splice(0, goal.checks.length - 20);
  if (check.error) return { next: 'pause', reason: `the goal could not be checked: ${check.reason}` };
  if (check.verdict === 'met') { goal.status = 'met'; return { next: 'end' }; }
  if (check.verdict === 'impossible') { goal.status = 'failed'; return { next: 'end' }; }
  return { next: 'continue', message: `[VOX GOAL] Not met yet: ${check.reason}\nKeep going toward the goal: ${goal.condition}` };
}

module.exports = { parseGoalCommand, newGoal, goalTranscript, evaluateGoal, afterRun, applyCheck, IDLE_LIMIT, CHECK_PROMPT };
