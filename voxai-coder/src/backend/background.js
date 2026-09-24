/**
 * background — registry for sub-agents running outside the parent's turn.
 *
 * A foreground dispatch blocks the parent until the worker finishes: simple, and
 * correct when the parent has nothing else to do. But a Director that wants to fan
 * three workers out and keep reading in the meantime cannot afford to sit idle
 * through each one in turn.
 *
 * Background dispatch returns a handle immediately and the run continues. The
 * completion has to reach the parent somehow, and there is no protocol slot for it:
 * the `spawn_agent` tool call was already answered ("started"), so the report cannot
 * arrive as a role:"tool" message. It is delivered instead as a clearly-framed
 * message at the END of the transcript — the append-only position, which costs
 * nothing in cache terms and keeps the assistant/tool pairing intact.
 *
 * The invariant that makes this safe: a run never ENDS with work still in flight.
 * The agent loop waits for outstanding background agents before it finishes, so a
 * result can never be silently dropped on the floor.
 */

// sessionId -> { running: Map<subId, rec>, done: rec[] }
const registry = new Map();

function bucket(sessionId) {
  const key = String(sessionId || 'default');
  if (!registry.has(key)) registry.set(key, { running: new Map(), done: [] });
  return registry.get(key);
}

/**
 * Register an in-flight sub-run. `promise` must RESOLVE with the worker's result
 * object — never reject — so a crash lands in the queue as a failed report rather
 * than an unhandled rejection that takes the process with it.
 */
function start(sessionId, { subId, label, promise, controller }) {
  const b = bucket(sessionId);
  const rec = { subId, label: label || '', startedAt: Date.now(), controller, result: null };
  b.running.set(subId, rec);
  Promise.resolve(promise)
    .then((result) => { rec.result = result; })
    .catch((e) => {
      rec.result = { ok: false, subId, stopReason: 'error', error: String((e && e.message) || e), files_changed: [] };
    })
    .finally(() => {
      rec.finishedAt = Date.now();
      b.running.delete(subId);
      b.done.push(rec);
    });
  return rec;
}

function runningCount(sessionId) {
  return bucket(sessionId).running.size;
}

function listAll(sessionId) {
  const b = bucket(sessionId);
  return {
    running: [...b.running.values()].map((r) => ({
      subId: r.subId, label: r.label, elapsedMs: Date.now() - r.startedAt, status: 'running',
    })),
    completed: b.done.map((r) => ({
      subId: r.subId, label: r.label, status: 'completed',
      stopReason: r.result && r.result.stopReason, delivered: !!r.delivered,
    })),
  };
}

/** Take every finished-but-undelivered result. Each is handed over exactly once. */
function drain(sessionId) {
  const b = bucket(sessionId);
  const out = [];
  for (const rec of b.done) {
    if (rec.delivered) continue;
    rec.delivered = true;
    out.push(rec);
  }
  return out;
}

/** Resolve once nothing is in flight, or the timeout elapses. */
async function waitForAll(sessionId, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  while (runningCount(sessionId) > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
  }
  return runningCount(sessionId) === 0;
}

function cancel(sessionId, subId) {
  const b = bucket(sessionId);
  const rec = b.running.get(subId);
  if (!rec) return false;
  try { rec.controller && rec.controller.abort(); } catch {}
  return true;
}

function cancelAll(sessionId) {
  const b = bucket(sessionId);
  let n = 0;
  for (const rec of b.running.values()) {
    try { rec.controller && rec.controller.abort(); n += 1; } catch {}
  }
  return n;
}

function clear(sessionId) {
  registry.delete(String(sessionId || 'default'));
}

/** Render a completed run as the message the parent will actually read. */
function formatCompletion(rec) {
  const r = rec.result || {};
  const lines = [`[BACKGROUND AGENT FINISHED] ${rec.subId}${rec.label ? ` — ${rec.label}` : ''}`];
  lines.push(`status: ${r.stopReason || (r.ok ? 'completed' : 'failed')}`);
  if (Array.isArray(r.files_changed) && r.files_changed.length) {
    lines.push('files changed:');
    for (const f of r.files_changed.slice(0, 40)) {
      lines.push(`  ${f.path} (${f.tool}${f.verified ? `, ${f.verified}` : ''})`);
    }
  }
  if (Array.isArray(r.needs_attention) && r.needs_attention.length) {
    lines.push(`NEEDS ATTENTION: ${r.needs_attention.join(', ')}`);
  }
  if (r.error) lines.push(`error: ${r.error}`);
  if (r.result) lines.push('', 'report:', String(r.result).slice(0, 8000));
  lines.push('', 'This is an automated completion notice, not a new instruction from the user. '
    + 'Take it into account and carry on with the task you were already working on.');
  return lines.join('\n');
}

module.exports = {
  start, drain, listAll, runningCount, waitForAll, cancel, cancelAll, clear, formatCompletion,
};
