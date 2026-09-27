/**
 * spawn — sub-agent orchestration.
 *
 * A sub-agent is not a special construct: it is another instance of the SAME agent
 * loop with its own message list, its own tool surface and its own budget. The
 * parent invokes it as an ordinary tool and gets one report back.
 *
 * The point is context isolation. A worker can burn tens of thousands of tokens
 * reading a subsystem and hand back a few hundred; the parent's context — the
 * scarce, cache-warm resource — grows by the few hundred. If the worker's transcript
 * ever reached the parent, the whole exercise would be an expensive no-op.
 *
 * What makes delegation actually REDUCE the parent's work rather than relocate it is
 * the receipt. A worker that edits eight files and returns "I updated the auth
 * module" forces the parent to re-read the tree to find out what happened. So every
 * run returns `files_changed` with paths, operations and verification status —
 * facts, not narration.
 *
 * Roles scope the tool surface rather than describing a persona. An `explore` agent
 * that CANNOT write differs in kind from one merely asked not to; a role implemented
 * as prompt text is a suggestion, and models decline suggestions.
 *
 * Sessions persist, so a finished worker can be resumed with a follow-up instead of
 * re-spawned from cold — keeping both its context and its warm provider cache.
 */
const { createSession, saveSession, loadSession } = require('../sessions');
const bg = require('../background');

// Role -> tool surface + framing. Keep this list SHORT. Named seats feel like
// architecture and behave like a fixed pipeline; add one only when you can say what
// it does better than `explore`.
// web_fetch / web_search change nothing on disk, so read-only workers get them: without
// them an `explore` agent could not research anything outside the repo at all.
const READ_TOOLS = ['read', 'grep', 'glob', 'search', 'rag', 'doc_rag', 'lsp', 'fs', 'todo', 'web_fetch', 'web_search'];
const WRITE_TOOLS = READ_TOOLS.concat(['write', 'edit', 'patch', 'shell', 'node_repl', 'memory']);

const ROLES = {
  explore: {
    tools: READ_TOOLS,
    access: 'ask',           // read-only: nothing mutating can be auto-approved
    brief: 'You are a read-only research agent. Investigate thoroughly, then report findings with '
      + 'exact file paths, line numbers and symbol names — the caller cannot see your transcript, so '
      + 'anything you do not state explicitly is lost. You cannot modify files.',
  },
  build: {
    tools: WRITE_TOOLS,
    access: null,            // inherits the parent's access level
    brief: 'You are an implementation agent. Make the change you were asked for, verify it (run the '
      + 'tests or a syntax check), and report exactly which files you changed and how. Stay strictly '
      + 'inside the scope you were given — another agent may be working nearby.',
  },
  review: {
    tools: READ_TOOLS,
    access: 'ask',
    brief: 'You are a read-only review agent. Report concrete problems with file:line references and '
      + 'a one-line statement of what breaks. Do not restate what the code does correctly.',
  },
};
const DEFAULT_ROLE = 'build';

/**
 * A worker's task, short, for its label and for approvals. Models open a task with setup
 * for the worker ("You are in a Windows environment using cmd.exe...", "Your working
 * directory is ..."), and an approval that led with that said nothing about the task.
 * Leading setup sentences are skipped; the rest is cut to `max`.
 */
function taskSummary(task, max = 90) {
  const t = String(task || '').replace(/\s+/g, ' ').trim();
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Z(`"'])/);
  const setup = /^(you are|you're|you have|you will be|your (current )?(working )?(directory|folder|cwd|shell|environment|workdir)|the (current )?(working )?(directory|folder|shell|workdir)|working (directory|folder)|this is (a )?windows|on windows|use cmd|context:|note:|background:|environment:)/i;
  let i = 0;
  while (i < parts.length - 1 && setup.test(parts[i])) i++;
  const s = parts.slice(i).join(' ');
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}
const endSentence = (s) => (/[.!?…]$/.test(s) ? s : s + '.');
const SUB_TIMEOUT_FLOOR_MS = 10000;

function makeSpawnTool({ runner, agentOpts, userData, live, emit }) {
  const isSubAgent = Boolean(agentOpts && agentOpts.isSubAgent);

  function broadcast(subId, ev, meta) {
    if (typeof emit !== 'function') return;
    try { emit(Object.assign({ type: 'sub', subId, ev, at: Date.now() }, meta || {})); } catch {}
  }

  const taskSchema = {
    type: 'object',
    properties: {
      // The fields are described once, at the top level of spawn_agent: every word here is
      // paid at the head of every request.
      task: { type: 'string' },
      role: { type: 'string', enum: Object.keys(ROLES) },
      model: { type: 'string' },
      maxTurns: { type: 'integer' },
      timeoutMs: { type: 'integer' },
    },
    required: ['task'],
    additionalProperties: false,
  };

  async function runOne(task, budgetShare, onStart) {
    if (isSubAgent) {
      return { ok: false, error: 'sub-agents cannot spawn further sub-agents (recursion guard)' };
    }
    if (!runner) return { ok: false, error: 'sub-agent runner unavailable' };

    let roleName = ROLES[task.role] ? task.role : DEFAULT_ROLE;

    // Resume an existing worker rather than starting cold: its context and its warm
    // provider cache both survive, so a follow-up costs a fraction of a re-spawn.
    let sub = null;
    let resumed = false;
    if (task.resume) {
      try {
        sub = await loadSession(userData, String(task.resume));
        resumed = !!(sub && Array.isArray(sub.messages));
      } catch { /* fall through */ }
      if (!resumed) {
        return { ok: false, error: `cannot resume sub-agent "${task.resume}" — no such session. Spawn a new one.` };
      }
      // A resumed worker keeps the role it was started with. Resuming without naming
      // one fell back to "build", so a read-only reviewer came back able to write
      // files -- and did, leaving scratch files in the project. Found in a live run.
      const orig = /^subagent:(\w+)$/.exec(String(sub.title || ''));
      if (orig && ROLES[orig[1]]) roleName = orig[1];
    }
    const role = ROLES[roleName];
    if (!sub) {
      sub = createSession({
        workdir: agentOpts.workdir || 'C:/',
        model: task.model || agentOpts.defaultSubModel || agentOpts.model,
        title: `subagent:${roleName}`,
        parentId: agentOpts.sessionId || null,
      });
    }

    const events = [];
    let timedOut = false;
    const t0 = Date.now();
    // The limit in Settings is a ceiling. The model may ask for LESS, never more: with
    // the limit at 10 s it passed timeoutMs 120000 and a 40 s job ran to the end.
    // Found in a live run.
    const userLimit = Number(agentOpts.defaultSubTimeoutMs) > 0 ? Number(agentOpts.defaultSubTimeoutMs)
      : (Number(process.env.VOX_SUBAGENT_TIMEOUT_MS) > 0 ? Number(process.env.VOX_SUBAGENT_TIMEOUT_MS) : 300000);
    const requestedTimeout = Number(task.timeoutMs) > 0 ? Math.min(Number(task.timeoutMs), userLimit) : userLimit;
    // Floor it. A sub-agent cannot do anything useful in under ten seconds -- the first
    // token alone routinely takes longer -- so a smaller figure is a units mistake, and
    // honouring it kills every worker before it starts (which is what happened).
    // (Injectable only so a test can exercise the abort path without waiting 10 s.)
    const floor = Number.isFinite(Number(agentOpts.subTimeoutFloorMs)) ? Number(agentOpts.subTimeoutFloorMs) : SUB_TIMEOUT_FLOOR_MS;
    const timeoutMs = Math.max(floor, requestedTimeout);
    let timer = null;

    // Each sub-run owns its own controller. Cancellation flows one way only: a parent
    // abort cascades to the child, never the reverse. (The timer previously called
    // abort() on the PARENT's AbortSignal — which has no such method, so the timeout
    // did nothing, and wiring it up naively would have killed the parent run and every
    // sibling in a fan-out.)
    const subCtl = new AbortController();
    const parentSignal = agentOpts.signal;
    const onParentAbort = () => { try { subCtl.abort(); } catch {} };
    if (parentSignal) {
      if (parentSignal.aborted) onParentAbort();
      else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }

    const prompt = resumed
      ? String(task.task || '')
      : `${role.brief}\n\nTASK:\n${String(task.task || '')}`;

    try {
      const gen = runner({
        session: sub,
        userText: prompt,
        apiKey: agentOpts.apiKey,
        host: agentOpts.host,
        model: task.model || sub.model || agentOpts.defaultSubModel || agentOpts.model,
        reasoningEffort: agentOpts.reasoningEffort,
        // The catalogue entry describes the parent's model; a worker on another model
        // gets "unknown", which sends nothing rather than a level it may not take.
        reasoningSpec: (task.model || sub.model || agentOpts.defaultSubModel || agentOpts.model) === agentOpts.model
          ? agentOpts.reasoningSpec : undefined,
        // A read-only role is enforced by the TOOL SURFACE, and its access level is
        // pinned low so nothing mutating could be auto-approved even if it leaked in.
        access: role.access || agentOpts.access || 'full',
        allowTools: role.tools,
        maxTokens: agentOpts.maxTokens || 16384,
        maxTurns: Number(task.maxTurns) > 0 ? Number(task.maxTurns)
          : (Number(agentOpts.defaultSubMaxTurns) > 0 ? Number(agentOpts.defaultSubMaxTurns) : 25),
        signal: subCtl.signal,
        // A worker asks YOU, through the run that started it, whatever the mode says to ask.
        // It used to answer itself yes, so from "Ask first" a worker could run any command or
        // edit nobody approved. With no one to ask (no parent prompt), the answer is no.
        askPermission: async (q) => (typeof agentOpts.askPermission === 'function'
          ? agentOpts.askPermission({ ...q, note: `From a sub-agent (${roleName}): ${endSentence(taskSummary(task.task, 90))}` + (q && q.note ? ' ' + q.note : '') })
          : false),
        userData,
        live,
        budgetUsd: budgetShare,
        priceIn: agentOpts.priceIn || 0,
        // Workers follow the parent's web-search setting (off means off for them too).
        webSearch: agentOpts.webSearch || null,
        // The parent's vision flag describes the PARENT's model. A worker on a
        // different model inherits nothing -- unknown, so screenshots get described
        // rather than sent to something that may not read them.
        modelVision: (task.model || sub.model || agentOpts.defaultSubModel || agentOpts.model) === agentOpts.model
          ? (agentOpts.modelVision === undefined ? null : agentOpts.modelVision) : null,
        priceOut: agentOpts.priceOut || 0,
        visionHelper: agentOpts.visionHelper || '',
        checkModel: agentOpts.checkModel || '',
        checkReasoningSpec: agentOpts.checkReasoningSpec,
        cacheTtl: agentOpts.cacheTtl || '',
        checkpointFrom: agentOpts.checkpointSession || null,
        contextLimit: agentOpts.contextLimit,
        compactThreshold: agentOpts.compactThreshold,
        hardFraction: agentOpts.hardFraction,
        isSubAgent: true,
      });
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => { timedOut = true; try { subCtl.abort(); } catch {} }, timeoutMs);
      }
      // Hand the caller a cancellation handle as soon as the run is live.
      if (typeof onStart === 'function') { try { onStart({ subId: sub.id, controller: subCtl }); } catch {} }
      // Announce WHAT this worker is, once. Without it the UI had nothing to label
      // the card with but the names of the tools it happened to call, so five
      // concurrent workers were five identical anonymous boxes.
      broadcast(sub.id, 'start', { role: roleName, label: taskSummary(task.task, 90) });
      const TERMINAL = ['done', 'error', 'cancelled', 'limit_reached', 'budget_reached'];
      for await (const ev of gen) {
        events.push(ev);
        if (ev.type === 'token') broadcast(sub.id, 'token', { text: ev.text });
        else if (ev.type === 'tool_start') broadcast(sub.id, 'tool_start', { name: ev.name, args: ev.args || {} });
        else if (ev.type === 'tool_end') broadcast(sub.id, 'tool_end', { name: ev.name, ok: ev.ok || false, result: ev.result });
        else if (ev.type === 'usage') broadcast(sub.id, 'usage', { usage: ev.usage || {} });
        else if (TERMINAL.includes(ev.type)) broadcast(sub.id, ev.type, { content: ev.content || ev.message || null });
        if (TERMINAL.includes(ev.type)) break;
      }
      try { await saveSession(userData, sub); } catch {}
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      if (timer) clearTimeout(timer);
      if (parentSignal) { try { parentSignal.removeEventListener('abort', onParentAbort); } catch {} }
    }

    const done = events.find((e) => e.type === 'done');
    const err = events.find((e) => e.type === 'error');
    const budgetHit = events.find((e) => e.type === 'budget_reached');
    const limitHit = events.find((e) => e.type === 'limit_reached');
    const toolCount = events.filter((e) => e.type === 'tool_start').length;

    // The receipt. Latest operation per path wins, so a file edited three times
    // appears once in its final state rather than three times.
    const changed = new Map();
    for (const e of events) {
      if (!e.mutated || !e.mutated.path) continue;
      changed.set(e.mutated.path, {
        path: e.mutated.path,
        tool: e.mutated.tool,
        verified: e.mutated.verified || null,
        ...(e.mutated.bytes !== undefined ? { bytes: e.mutated.bytes } : {}),
        ...(e.mutated.edits !== undefined ? { edits: e.mutated.edits } : {}),
        ...(e.mutated.match !== undefined ? { match: e.mutated.match } : {}),
      });
    }
    const filesChanged = [...changed.values()];

    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const e of events) if (e.type === 'usage') {
      const u = e.usage || {};
      usage.input += Number(u.prompt_tokens) || 0;
      usage.output += Number(u.completion_tokens) || 0;
      usage.cacheRead += Number(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || Number(u.cache_read_input_tokens) || 0;
      usage.cacheWrite += Number(u.cache_write_input_tokens) || 0;
      usage.cost += Number(u.total_cost) || Number(u.cost) || 0;
    }

    // Why it stopped. The parent cannot tell a complete answer from a truncated one
    // unless we say so — and treating a truncated report as finished is how half-done
    // work gets marked complete.
    let stopReason = 'completed';
    if (timedOut) stopReason = 'timeout';
    else if (budgetHit) stopReason = 'budget';
    else if (limitHit) stopReason = 'turn_limit';
    else if (err) stopReason = 'error';
    else if (!done) stopReason = 'incomplete';

    const failedVerify = filesChanged.filter((f) => f.verified === 'failed');

    // One sentence explaining a non-completion, used for BOTH `error` and the result
    // text. A timeout takes precedence over a late `done`: once we have declared the
    // run dead the parent must not act on its answer as if it were authoritative.
    const statusText = timedOut ? `sub-agent timed out after ${Math.round(timeoutMs / 1000)}s`
      : (budgetHit ? `sub-agent stopped at its spend limit: ${budgetHit.message}`
        : (limitHit ? `sub-agent stopped at its turn limit: ${limitHit.message}`
          : (err ? err.message
            : (!done ? 'sub-agent ended without a final answer' : ''))));

    const answer = done ? String(done.content || '').slice(0, 12000) : '';

    return {
      ok: stopReason === 'completed',
      subId: sub.id,           // pass back as `resume` to ask this worker a follow-up
      role: roleName,
      resumed,
      stopReason,
      complete: stopReason === 'completed',
      tools: toolCount,
      elapsedMs: Date.now() - t0,
      files_changed: filesChanged,
      ...(failedVerify.length ? { needs_attention: failedVerify.map((f) => f.path) } : {}),
      usage,
      ...(statusText ? { error: statusText } : {}),
      // Partial work is still work — surface whatever the worker managed to say, but
      // never let it hide the fact that the run did not finish cleanly.
      result: stopReason === 'completed' ? answer
        : `${statusText}${answer ? `\n\nPartial output before stopping:\n${answer}` : ''}`,
    };
  }

  /**
   * Kick a sub-run off and return a handle straight away.
   *
   * We wait only long enough for the worker's session to exist — the sub-run itself
   * is registered, not awaited. Returning a placeholder id instead would hand the
   * model something it cannot later use with `resume` or cancel.
   */
  async function dispatchBackground(task, budgetShare, ctx) {
    const sessionId = (ctx && ctx.session && ctx.session.id) || (agentOpts && agentOpts.sessionId) || 'default';
    const label = String(task.task || '').replace(/\s+/g, ' ').slice(0, 60);

    let resolveStart;
    const started = new Promise((res) => { resolveStart = res; });
    const promise = runOne(task, budgetShare, (h) => resolveStart(h));

    // If runOne bails before starting (recursion guard, bad resume id) it resolves
    // without ever calling onStart — surface that as a normal failed result.
    const handle = await Promise.race([
      started,
      promise.then((r) => (r && r.subId ? { subId: r.subId, controller: null } : { failed: r })),
    ]);
    if (handle && handle.failed) return handle.failed;

    bg.start(sessionId, {
      subId: handle.subId,
      label,
      promise,
      controller: handle.controller,
    });

    return {
      ok: true,
      status: 'running',
      subId: handle.subId,
      role: ROLES[task.role] ? task.role : DEFAULT_ROLE,
      label,
      note: 'Started in the background. Continue with other work — the report will be delivered to you '
        + 'automatically when it finishes, and this run will not end while it is still going.',
    };
  }

  return {
    defs: [
      {
        type: 'function',
        function: {
          name: 'spawn_agent',
          description:
            'Hand a self-contained sub-task to a separate agent and get a report back (files_changed, stopReason, cost, subId). '
            + 'It sees NOTHING of this conversation, so the task must stand alone. Use it for work that would flood your context '
            + '(broad searches, an unfamiliar subsystem, a noisy test run) or a well-scoped edit you can describe precisely; '
            + 'not for one or two calls you can make yourself. '
            + '`tasks` runs several at once (give them separate files); `resume` (a subId) asks that worker a follow-up; '
            + '`background: true` lets you carry on, and its report arrives when done. Not available inside a sub-agent.',
          parameters: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'Self-contained instruction for a single sub-agent.' },
              tasks: { type: 'array', items: taskSchema, description: 'Several tasks at once, instead of `task` (each item takes the fields below).' },
              role: { type: 'string', enum: Object.keys(ROLES), description: 'explore/review are read-only; build can modify files. Default build.' },
              resume: { type: 'string', description: 'A subId from an earlier spawn_agent result: continue that worker, with `task` as the follow-up.' },
              background: { type: 'boolean', description: 'Return now; the report arrives when it finishes. Leave false when you need the answer next.' },
              model: { type: 'string', description: 'Optional model override.' },
              maxTurns: { type: 'integer', description: 'Optional max tool-turns (default 25).' },
              timeoutMs: { type: 'integer', description: 'Optional shorter limit in ms (never past the one in Settings).' },
            },
            additionalProperties: false,
          },
        },
      },
    ],
    async run(name, args, ctx) {
      if (!runner) return { ok: false, error: 'sub-agent runner unavailable' };

      // An UNSET budget means the embedder never wired budgets — fall through to the
      // sub-run's own default cap. An explicit 0 means genuinely exhausted, and refuses.
      const raw = agentOpts.budgetRemaining;
      const unset = raw === undefined || raw === null || raw === '';
      const remaining = Number(raw);
      const pot = unset ? undefined : (Number.isFinite(remaining) && remaining > 0 ? remaining : 0);
      const exhausted = !unset && !(pot > 0);

      const wantsFanOut = name === 'spawn_parallel' || (Array.isArray(args.tasks) && args.tasks.length);
      if (wantsFanOut) {
        const tasks = Array.isArray(args.tasks) ? args.tasks : [];
        if (!tasks.length) return { ok: false, error: 'spawn_agent fan-out requires a non-empty tasks[]' };
        if (exhausted) return { ok: false, error: 'no spend budget remaining for sub-agents' };
        const share = unset ? undefined : pot / tasks.length;
        // A top-level role/model applies to every task unless the task overrides it.
        const merged = tasks.map((t) => ({ role: args.role, model: args.model, ...t }));
        if (args.background) {
          const started = await Promise.all(merged.map((t) => dispatchBackground(t, share, ctx)));
          return {
            ok: true,
            status: 'running',
            started: started.map((x) => ({ subId: x.subId, role: x.role, label: x.label })),
            note: `${started.length} agents started in the background. Carry on; their reports will arrive as they finish.`,
          };
        }
        const results = await Promise.all(merged.map((t) => runOne(t, share)));
        const okCount = results.filter((r) => r.ok).length;
        const allChanged = results.flatMap((r) => r.files_changed || []);
        const attention = results.flatMap((r) => r.needs_attention || []);
        return {
          ok: okCount === results.length,
          execution_summary: { total_tasks: tasks.length, successful_tasks: okCount, failed_tasks: results.length - okCount },
          files_changed: allChanged,
          ...(attention.length ? { needs_attention: attention } : {}),
          task_results: results,
        };
      }

      if (!String(args.task || '').trim()) {
        return { ok: false, error: 'spawn_agent needs either `task` (a self-contained instruction) or `tasks[]`.' };
      }
      if (exhausted) return { ok: false, error: 'no spend budget remaining for sub-agents' };
      if (args.background) return dispatchBackground(args, pot, ctx);
      return runOne(args, pot);
    },
  };
}

module.exports = { makeSpawnTool, taskSummary, ROLES, READ_TOOLS, WRITE_TOOLS, SUB_TIMEOUT_FLOOR_MS };
