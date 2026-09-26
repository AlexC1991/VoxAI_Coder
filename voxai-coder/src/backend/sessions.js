/**
 * VoxAI session store — JSONL per session on disk (own format, not Goose's sqlite).
 *
 * Goose keeps sessions in a sqlite DB (sessions.db). We deliberately use plain
 * JSONL files (<userData>/sessions/<id>.jsonl) so sessions are human-inspectable,
 * trivially exportable, and diffable. Migration path: a future importer can read
 * Goose's sqlite and emit these files.
 *
 * File layout:
 *   {"kind":"meta","id","title","workdir","model","createdAt","updatedAt"}
 *   {"kind":"message", message:{role, content, ...}}
 *   {"kind":"usage", usage:{input_tokens, output_tokens, cache_read_tokens,
 *                           cache_write_tokens, cost, at}}
 *     one line per completed agent run (the run's OpenRouter usage totals)
 *   {"kind":"todos", todos:[...]}
 *
 * Fix 1 (benchmark): usage/cost history is persisted the same way Goose keeps its
 * usage_ledger, so a restart does not lose per-run cost and cache telemetry.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

function sessionsDir(userData) {
  return path.join(userData, 'sessions');
}

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${crypto.randomBytes(3).toString('hex')}`;
}

function createSession({ workdir, model, title, parentId }) {
  return {
    id: newId(),
    title: title || 'New session',
    // Set on a sub-agent's own session: it belongs to the conversation that started
    // it and is not a session of its own in the sidebar.
    parentId: parentId || null,
    workdir,
    model,
    messages: [],
    todos: [],
    usage: [],          // per-run ledger {input, output, cacheRead, cacheWrite, cost, at}
    stats: {            // accumulated totals (mirrors usage_ledger in goose)
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      runs: 0,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function saveSession(userData, session) {
  session.updatedAt = new Date().toISOString();
  const dir = sessionsDir(userData);
  await fsp.mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({ kind: 'meta', id: session.id, title: session.title, workdir: session.workdir, model: session.model, ...(session.parentId ? { parentId: session.parentId } : {}), createdAt: session.createdAt, updatedAt: session.updatedAt }),
    ...session.messages.map((m) => JSON.stringify({ kind: 'message', message: m })),
    ...(session.usage || []).map((u) => JSON.stringify({ kind: 'usage', usage: u })),
    // Where runs stopped at a limit or failed, so a reopened session says so.
    ...(session.stops || []).map((st) => JSON.stringify({ kind: 'stop', stop: st })),
    JSON.stringify({ kind: 'todos', todos: session.todos }),
  ];
  await fsp.writeFile(path.join(dir, `${session.id}.jsonl`), lines.join('\n'), 'utf8');
  return session;
}

/**
 * Append one run's usage record to a session and roll it into session.stats.
 * Safe to call with a partial record (some fields missing).
 */
function recordUsage(session, usage) {
  const u = usage || {};
  const details = u.prompt_tokens_details || {};
  const rec = {
    input: Number(u.prompt_tokens ?? u.input ?? usage.inputTokens ?? 0),
    output: Number(u.completion_tokens ?? u.output ?? usage.outputTokens ?? 0),
    cacheRead: Number(u.cache_read_input_tokens ?? u.cacheRead ?? usage.cacheReadTokens ?? details.cached_tokens ?? 0),
    cacheWrite: Number(u.cache_write_input_tokens ?? u.cacheWrite ?? usage.cacheWriteTokens ?? 0),
    cost: Number(u.total_cost ?? u.cost ?? usage.cost ?? 0),
    at: new Date().toISOString(),
  };
  if (typeof session.usage !== 'object' || !Array.isArray(session.usage)) session.usage = [];
  session.usage.push(rec);
  const s = session.stats || (session.stats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, runs: 0 });
  s.inputTokens = (s.inputTokens || 0) + rec.input;
  s.outputTokens = (s.outputTokens || 0) + rec.output;
  s.cacheReadTokens = (s.cacheReadTokens || 0) + rec.cacheRead;
  s.cacheWriteTokens = (s.cacheWriteTokens || 0) + rec.cacheWrite;
  s.cost = (s.cost || 0) + rec.cost;
  s.runs = (s.runs || 0) + 1;
  return rec;
}

async function loadSession(userData, id) {
  const raw = await fsp.readFile(path.join(sessionsDir(userData), `${id}.jsonl`), 'utf8');
  const session = { id, title: 'session', workdir: '', model: '', messages: [], todos: [], usage: [], stats: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, runs: 0 } };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.kind === 'meta') Object.assign(session, { title: o.title, workdir: o.workdir, model: o.model, parentId: o.parentId || null, createdAt: o.createdAt, updatedAt: o.updatedAt });
    else if (o.kind === 'message') session.messages.push(o.message);
    else if (o.kind === 'usage') session.usage.push(o.usage);
    else if (o.kind === 'todos') session.todos = o.todos;
    else if (o.kind === 'stop') (session.stops || (session.stops = [])).push(o.stop);
  }
  // rebuild accumulated stats for older sessions that predate the ledger
  session.stats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, runs: session.usage.length };
  for (const u of session.usage) {
    session.stats.inputTokens += u.input || 0;
    session.stats.outputTokens += u.output || 0;
    session.stats.cacheReadTokens += u.cacheRead || 0;
    session.stats.cacheWriteTokens += u.cacheWrite || 0;
    session.stats.cost += u.cost || 0;
  }
  return session;
}

/**
 * Is this a sub-agent's working session rather than a conversation? Newer ones carry
 * parentId; older ones only their "subagent" / "subagent:<role>" title.
 */
function isSubSession(meta) {
  return !!(meta && (meta.parentId || /^subagent(:|$)/.test(String(meta.title || ''))));
}

/**
 * Does the conversation end on a question nobody answered (the app closed while the
 * agent was asking)? Reads only the last turn: its trailing tool results and the
 * assistant message whose calls they answer.
 */
function endsOnQuestion(lines) {
  const answered = new Set();
  for (let i = lines.length - 1; i > 0; i--) {
    if (!lines[i].startsWith('{"kind":"message"')) continue;     // usage, stops, todos
    let m;
    try { m = JSON.parse(lines[i]).message || {}; } catch { return false; }
    if (m.role === 'tool') { answered.add(m.tool_call_id); continue; }
    return m.role === 'assistant' && Array.isArray(m.tool_calls)
      && m.tool_calls.some((c) => c && c.function && (c.function.name === 'ask_user' || c.function.name === 'ask_confirm') && !answered.has(c.id));
  }
  return false;
}

/** Conversations, newest first; with { subs: true }, sub-agent sessions instead. */
async function listSessions(userData, limit = 50, { subs = false } = {}) {
  const dir = sessionsDir(userData);
  try { await fsp.mkdir(dir, { recursive: true }); } catch { /* noop */ }
  let files = [];
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const metas = [];
  for (const f of files) {
    try {
      const lines = (await fsp.readFile(path.join(dir, f), 'utf8')).split('\n');
      const o = JSON.parse(lines[0]);
      // Sub-agent sessions stay on disk (a worker can be resumed) but are not listed
      // as conversations: each fan-out used to add one "session" per worker.
      if (o.kind === 'meta' && isSubSession(o) === subs) metas.push({ id: o.id, title: o.title, workdir: o.workdir, model: o.model, parentId: o.parentId || null, updatedAt: o.updatedAt, asking: endsOnQuestion(lines) });
    } catch { /* skip corrupt */ }
  }
  metas.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return metas.slice(0, limit);
}

/**
 * Sessions whose conversation mentions `query`: what you asked and what the agent
 * answered, not tool output and not the app's own notes. The sidebar search matched
 * titles only, so a session was findable only by its first message.
 * Returns [{ id, snippet, hits }], most hits first.
 */
async function searchSessions(userData, query, limit = 40) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const dir = sessionsDir(userData);
  let files = [];
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const out = [];
  for (const f of files) {
    let raw;
    try { raw = await fsp.readFile(path.join(dir, f), 'utf8'); } catch { continue; }
    if (!raw.toLowerCase().includes(q)) continue;            // cheap reject first
    let meta = null, hits = 0, snippet = '';
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.kind === 'meta') { meta = o; continue; }
      if (o.kind !== 'message' || !o.message) continue;
      const m = o.message;
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const text = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ') : '';
      if (!text || /^\[VOX /.test(text)) continue;
      const at = text.toLowerCase().indexOf(q);
      if (at === -1) continue;
      hits++;
      if (!snippet) {
        const a = Math.max(0, at - 40), b = Math.min(text.length, at + q.length + 60);
        // Read as text: no markdown marks ("**", backticks, heading hashes) in the line.
        snippet = (a ? '…' : '') + text.slice(a, b).replace(/\*\*|__|`+|^#+\s*/gm, '').replace(/\s+/g, ' ').trim() + (b < text.length ? '…' : '');
      }
    }
    if (hits && meta && !isSubSession(meta)) out.push({ id: meta.id, snippet, hits });
  }
  out.sort((a, b) => b.hits - a.hits);
  return out.slice(0, limit);
}

async function deleteSession(userData, id) {
  await fsp.unlink(path.join(sessionsDir(userData), `${id}.jsonl`));
}

/** Serialize a session as JSONL text (for export). */
function exportSession(session) {
  const lines = [
    JSON.stringify({ kind: 'meta', id: session.id, title: session.title, workdir: session.workdir, model: session.model, ...(session.parentId ? { parentId: session.parentId } : {}), createdAt: session.createdAt, updatedAt: session.updatedAt }),
    ...(session.messages || []).map((m) => JSON.stringify({ kind: 'message', message: m })),
    ...(session.usage || []).map((u) => JSON.stringify({ kind: 'usage', usage: u })),
    ...(session.stops || []).map((st) => JSON.stringify({ kind: 'stop', stop: st })),
    JSON.stringify({ kind: 'todos', todos: session.todos || [] }),
  ];
  return lines.join('\n');
}

module.exports = { createSession, saveSession, loadSession, listSessions, searchSessions, endsOnQuestion, deleteSession, sessionsDir, recordUsage, exportSession, isSubSession };
