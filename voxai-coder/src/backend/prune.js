'use strict';
/**
 * Leaving out what the model no longer needs, in batches.
 *
 * A long session carries every file it ever read and every screenshot it took, and each request
 * sends all of it again until the summary at 80% folds the early turns away (losing detail). Some
 * of it is dead weight: a read of a file that has since been edited or read again, screenshots
 * older than the newest two, a huge build log from twenty steps ago.
 *
 * Rewriting history costs one full-price read (the provider's cache of everything after the first
 * changed message is gone), so it is done rarely, in a batch, and only when it pays: the session
 * is getting full (it puts off the lossy summary) or the model runs on this PC with a small
 * context. Between batches nothing changes, so the cache keeps hitting. The newest turns are
 * never touched.
 *
 * Only the model's copy is shortened: each original is kept in session.prunedStore, and the
 * chat window gets them back (restore), so your history still shows every read and screenshot.
 */
const KEEP_TURNS = 3;        // the last three turns of yours, and everything after them, stay as they are
const KEEP_SHOTS = 2;        // the newest two screenshots stay
const TRIM_OVER = 6000;      // an old output longer than this keeps its start and end
const TRIM_KEEP = 1500;
const SHOT_CHARS = 6000;     // what one screenshot weighs, as text (about 1,500 tokens)
const SHOTS = '[VOX TOOL SCREENSHOTS]';
const SHOT_STUB = '[screenshot left out to save space]';

const textOf = (m) => (typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? (m.content.find((p) => p && p.type === 'text') || {}).text || '' : ''));
const isVox = (m) => /^\[VOX /.test(textOf(m));
const isShots = (m) => m && m.role === 'user' && Array.isArray(m.content) && textOf(m).startsWith(SHOTS) && m.content.some((p) => p && p.type === 'image_url');
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

function stubRead(p) { return `[VOX PRUNED] An earlier read of ${p}, left out to save space: the file has changed or been read again since. Read it again if you need it.`; }
function trimmed(s) {
  return s.slice(0, TRIM_KEEP) + `\n[VOX PRUNED] ${(s.length - 2 * TRIM_KEEP).toLocaleString()} characters of this older output were left out to save space.\n` + s.slice(-TRIM_KEEP);
}

/** What could be left out now: [{ i, kind: 'read'|'trim'|'shots', key, save }]. Changes nothing. */
function plan(messages, { keepTurns = KEEP_TURNS, keepShots = KEEP_SHOTS, store = {} } = {}) {
  const ms = messages || [];
  const turns = ms.map((m, i) => (m && m.role === 'user' && !isVox(m) ? i : -1)).filter((i) => i >= 0);
  if (turns.length <= keepTurns) return [];
  const protectFrom = turns[turns.length - keepTurns];
  const calls = new Map();
  ms.forEach((m, i) => {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) {
      let args = {}; try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch {}
      calls.set(tc.id, { name: tc.function && tc.function.name, args, at: i });
    }
  });
  const changed = new Map(), reads = new Map();
  const add = (map, k, i) => { if (!map.has(k)) map.set(k, []); map.get(k).push(i); };
  for (const c of calls.values()) {
    const p = norm(c.args.path); if (!p) continue;
    if (['write', 'edit', 'patch'].includes(c.name)) add(changed, p, c.at);
    if (c.name === 'read') add(reads, p + '|' + (c.args.offset || '') + '|' + (c.args.limit || ''), c.at);
  }
  const out = [];
  let lastToolId = '';
  ms.forEach((m, i) => {
    if (m && m.role === 'tool') lastToolId = m.tool_call_id || lastToolId;
    if (i >= protectFrom || !m) return;
    if (m.role === 'tool' && typeof m.content === 'string' && !store[m.tool_call_id]) {
      const c = calls.get(m.tool_call_id); if (!c) return;
      const p = norm(c.args.path);
      if (c.name === 'read' && p) {
        const k = p + '|' + (c.args.offset || '') + '|' + (c.args.limit || '');
        const later = (changed.get(p) || []).some((a) => a > c.at) || (reads.get(k) || []).some((a) => a > c.at);
        if (later && m.content.length > 400) out.push({ i, kind: 'read', key: m.tool_call_id, path: c.args.path, save: m.content.length - 200 });
        return;
      }
      if (m.content.length > TRIM_OVER) out.push({ i, kind: 'trim', key: m.tool_call_id, save: m.content.length - 2 * TRIM_KEEP - 120 });
    }
  });
  // Screenshots: the newest keepShots stay (wherever they are); older ones before the protected turns go.
  let seen = 0;
  const shotIdx = ms.map((m, i) => (isShots(m) ? i : -1)).filter((i) => i >= 0);
  for (let k = shotIdx.length - 1; k >= 0; k--) {
    const i = shotIdx[k], m = ms[i];
    const n = m.content.filter((p) => p && p.type === 'image_url').length;
    let prevTool = ''; for (let j = i - 1; j >= 0; j--) if (ms[j] && ms[j].role === 'tool') { prevTool = ms[j].tool_call_id; break; }
    const key = 'shots:' + (prevTool || i);
    if (seen >= keepShots && i < protectFrom && !store[key]) out.push({ i, kind: 'shots', key, save: n * SHOT_CHARS });
    seen += n;
  }
  return out;
}

/** Leave out what `actions` names, keeping each original in `store`. Returns the characters saved. */
function apply(messages, actions, store) {
  let saved = 0;
  for (const a of actions) {
    const m = messages[a.i]; if (!m) continue;
    store[a.key] = m.content;
    if (a.kind === 'read') m.content = stubRead(a.path);
    else if (a.kind === 'trim') m.content = trimmed(m.content);
    else if (a.kind === 'shots') m.content = m.content.map((p) => (p && p.type === 'image_url' ? { type: 'text', text: SHOT_STUB } : p));
    saved += a.save;
  }
  return saved;
}

/**
 * Should a batch go now? Only when it pays for the one full-price read it causes: the session is
 * past 40% of its context (it puts off the summary) and it frees at least 24,000 characters; or
 * on a model on this PC, where room is short, at 8,000.
 */
function worthIt(save, { tokens, limit, local }) {
  if (local) return save >= 8000;
  return save >= 24000 && limit > 0 && tokens >= 0.4 * limit;
}

/** The messages with every original put back, for the chat window. Does not change `messages`. */
function restore(messages, store) {
  if (!store || !Object.keys(store).length) return messages;
  let lastToolId = '';
  return (messages || []).map((m, i) => {
    if (!m) return m;
    if (m.role === 'tool') {
      lastToolId = m.tool_call_id || lastToolId;
      return store[m.tool_call_id] !== undefined ? { ...m, content: store[m.tool_call_id] } : m;
    }
    // A screenshots message, its pictures left out or not.
    if (m.role === 'user' && Array.isArray(m.content) && textOf(m).startsWith(SHOTS)) {
      const k = 'shots:' + (lastToolId || i);
      if (store[k] !== undefined) return { ...m, content: store[k] };
    }
    return m;
  });
}

/** Originals of messages no longer there (a summary folded them away) are dropped. */
function tidy(messages, store) {
  if (!store) return {};
  const keep = new Set();
  let lastToolId = '';
  (messages || []).forEach((m, i) => {
    if (!m) return;
    if (m.role === 'tool') { lastToolId = m.tool_call_id || lastToolId; keep.add(m.tool_call_id); }
    if (m.role === 'user' && textOf(m).startsWith(SHOTS)) keep.add('shots:' + (lastToolId || i));
  });
  const out = {};
  for (const k of Object.keys(store)) if (keep.has(k)) out[k] = store[k];
  return out;
}

module.exports = { plan, apply, worthIt, restore, tidy, KEEP_TURNS, SHOT_STUB };
