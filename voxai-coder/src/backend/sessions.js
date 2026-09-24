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

function createSession({ workdir, model, title }) {
  return {
    id: newId(),
    title: title || 'New session',
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
    JSON.stringify({ kind: 'meta', id: session.id, title: session.title, workdir: session.workdir, model: session.model, createdAt: session.createdAt, updatedAt: session.updatedAt }),
    ...session.messages.map((m) => JSON.stringify({ kind: 'message', message: m })),
    ...(session.usage || []).map((u) => JSON.stringify({ kind: 'usage', usage: u })),
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
    if (o.kind === 'meta') Object.assign(session, { title: o.title, workdir: o.workdir, model: o.model, createdAt: o.createdAt, updatedAt: o.updatedAt });
    else if (o.kind === 'message') session.messages.push(o.message);
    else if (o.kind === 'usage') session.usage.push(o.usage);
    else if (o.kind === 'todos') session.todos = o.todos;
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

async function listSessions(userData, limit = 50) {
  const dir = sessionsDir(userData);
  try { await fsp.mkdir(dir, { recursive: true }); } catch { /* noop */ }
  let files = [];
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const metas = [];
  for (const f of files) {
    try {
      const first = (await fsp.readFile(path.join(dir, f), 'utf8')).split('\n')[0];
      const o = JSON.parse(first);
      if (o.kind === 'meta') metas.push({ id: o.id, title: o.title, workdir: o.workdir, model: o.model, updatedAt: o.updatedAt });
    } catch { /* skip corrupt */ }
  }
  metas.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return metas.slice(0, limit);
}

async function deleteSession(userData, id) {
  await fsp.unlink(path.join(sessionsDir(userData), `${id}.jsonl`));
}

/** Serialize a session as JSONL text (for export). */
function exportSession(session) {
  const lines = [
    JSON.stringify({ kind: 'meta', id: session.id, title: session.title, workdir: session.workdir, model: session.model, createdAt: session.createdAt, updatedAt: session.updatedAt }),
    ...(session.messages || []).map((m) => JSON.stringify({ kind: 'message', message: m })),
    ...(session.usage || []).map((u) => JSON.stringify({ kind: 'usage', usage: u })),
    JSON.stringify({ kind: 'todos', todos: session.todos || [] }),
  ];
  return lines.join('\n');
}

module.exports = { createSession, saveSession, loadSession, listSessions, deleteSession, sessionsDir, recordUsage, exportSession };
