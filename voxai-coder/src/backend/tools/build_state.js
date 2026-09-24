/**
 * build_state — the durable "where is this build up to" record.
 *
 * Deliberately NOT retrieval. A session needs three different things and they are
 * often conflated:
 *   1. durable project memory  (.voxai/memory.json)      — conventions, decisions
 *   2. build state             (.voxai/build_state.json) — THIS FILE: what is done,
 *                                                          in progress, blocked, next
 *   3. retrieval               (rag / search_memory)     — anything else, on demand
 *
 * (1) and (2) change between sessions, not between turns, so they are read once at
 * session start and inlined into the system prompt — where they sit inside the
 * cached prefix and cost almost nothing after the first call. (3) stays a tool, so
 * its volatile output lands at the END of the transcript where volatility is free.
 *
 * Three properties matter here, none of which an embedding index has: the content is
 * DETERMINISTIC (same bytes every read, so it caches), INSPECTABLE (open the file and
 * correct it by hand), and BOUNDED (it cannot grow into a context problem).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAX_ITEMS = 40;
const MAX_ITEM_CHARS = 300;

function stateFile(workdir) {
  return path.join(workdir, '.voxai', 'build_state.json');
}

function emptyState() {
  return { task: '', updated: null, done: [], in_progress: '', blocked: [], next: [], decisions: [] };
}

function clampList(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => x != null && String(x).trim())
    .map((x) => String(x).trim().slice(0, MAX_ITEM_CHARS))
    .slice(-MAX_ITEMS);
}

function normalize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    task: String(s.task || '').slice(0, 500),
    updated: s.updated || null,
    done: clampList(s.done),
    in_progress: String(s.in_progress || '').slice(0, MAX_ITEM_CHARS),
    blocked: clampList(s.blocked),
    next: clampList(s.next),
    decisions: clampList(s.decisions),
  };
}

async function loadBuildState(workdir) {
  try {
    return normalize(JSON.parse(await fsp.readFile(stateFile(workdir), 'utf8')));
  } catch { return emptyState(); }
}

async function saveBuildState(workdir, state) {
  const next = normalize(state);
  next.updated = new Date().toISOString();
  await fsp.mkdir(path.dirname(stateFile(workdir)), { recursive: true });
  await fsp.writeFile(stateFile(workdir), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function isEmptyState(s) {
  return !s || (!s.task && !s.in_progress && !s.done.length && !s.next.length
    && !s.blocked.length && !s.decisions.length);
}

/** Render for the system prompt. Stable text — it must not change between turns. */
function formatBuildState(s) {
  if (isEmptyState(s)) return '';
  const lines = ['[BUILD STATE] (from .voxai/build_state.json — update it with the build_state tool)'];
  if (s.task) lines.push(`Current task: ${s.task}`);
  if (s.in_progress) lines.push(`In progress: ${s.in_progress}`);
  if (s.done.length) lines.push(`Done: ${s.done.join('; ')}`);
  if (s.blocked.length) lines.push(`Blocked: ${s.blocked.join('; ')}`);
  if (s.next.length) lines.push(`Next: ${s.next.join('; ')}`);
  if (s.decisions.length) lines.push(`Standing decisions: ${s.decisions.join('; ')}`);
  if (s.updated) lines.push(`(last updated ${s.updated})`);
  return lines.join('\n');
}

function makeBuildStateTool() {
  return {
    def: {
      type: 'function',
      function: {
        name: 'build_state',
        description:
          'Read or update the durable record of where this build is up to (.voxai/build_state.json). '
          + 'It is loaded into your context automatically at the start of every session, so keeping it '
          + 'current is how future sessions know what happened. '
          + 'Call action="set" before you finish a task: record what you completed, what is still in '
          + 'progress, anything blocked, and the agreed next steps. Use "merge" to append to the lists '
          + 'without replacing them. Keep entries short and factual.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['get', 'set', 'merge'] },
            task: { type: 'string', description: 'One line: the task currently being worked on.' },
            in_progress: { type: 'string', description: 'What is half-finished right now.' },
            done: { type: 'array', items: { type: 'string' }, description: 'Completed items.' },
            blocked: { type: 'array', items: { type: 'string' }, description: 'Things that cannot proceed, and why.' },
            next: { type: 'array', items: { type: 'string' }, description: 'Agreed next steps.' },
            decisions: { type: 'array', items: { type: 'string' }, description: 'Standing decisions future sessions must respect.' },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },
    },
    async run(args, ctx) {
      const action = args.action || 'get';
      const cur = await loadBuildState(ctx.workdir);
      if (action === 'get') return { action: 'get', state: cur };

      const incoming = {
        task: args.task !== undefined ? args.task : cur.task,
        in_progress: args.in_progress !== undefined ? args.in_progress : cur.in_progress,
        done: args.done !== undefined ? args.done : cur.done,
        blocked: args.blocked !== undefined ? args.blocked : cur.blocked,
        next: args.next !== undefined ? args.next : cur.next,
        decisions: args.decisions !== undefined ? args.decisions : cur.decisions,
      };
      if (action === 'merge') {
        const uniq = (a, b) => [...new Set([...(a || []), ...(b || [])].map((x) => String(x).trim()).filter(Boolean))];
        incoming.done = uniq(cur.done, args.done);
        incoming.blocked = uniq(cur.blocked, args.blocked);
        incoming.next = uniq(cur.next, args.next);
        incoming.decisions = uniq(cur.decisions, args.decisions);
      }
      const saved = await saveBuildState(ctx.workdir, incoming);
      return { action, state: saved };
    },
  };
}

module.exports = {
  makeBuildStateTool, loadBuildState, saveBuildState, formatBuildState, stateFile, isEmptyState,
};
