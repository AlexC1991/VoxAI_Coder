'use strict';
/**
 * Is the run going round in circles? The loop check in agent.js catches the SAME call three
 * times. A model that does not know what it is doing varies the call instead -- a slightly
 * different edit to the same file that fails again, the same failing command with a flag
 * changed, step after step of reading without changing anything -- and every attempt re-sends
 * the whole conversation. This watches for those, per run, and returns a short note to add to
 * the tool result: stop varying it, look again, change approach, or ask the user.
 *
 *   a file whose change fails (text not found, does not parse, an error) 3 times, then 5
 *   the same command failing the same way 3 times
 *   15 steps in a row that only look (read, search, list...) without changing anything, once
 */
const FILE_TOOLS = new Set(['write', 'edit', 'patch']);
const LOOKING = new Set(['read', 'glob', 'grep', 'search', 'rag', 'doc_rag', 'lsp', 'web_fetch', 'web_search', 'skill', 'memory', 'agents', 'terminal_state', 'node_repl']);
const CHANGING = new Set(['write', 'edit', 'patch', 'fs', 'worktree', 'snapshot']);
const LIMITS = { file: 3, fileHard: 5, command: 3, idle: 15 };

const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
// Numbers vary between attempts (line numbers, timings, pids); the failure is the same.
const shape = (s) => String(s || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);

function createStuckWatch(limits = {}) {
  const L = { ...LIMITS, ...limits };
  const fileFails = new Map();
  const cmdFails = new Map();
  let idle = 0, idleSaid = false;

  /** After a tool call: '' or a note for the model. outcome = { ok, error, result }. */
  function after(name, args, outcome) {
    const notes = [];
    const a = args || {}, o = outcome || {};
    const p = String(a.path || a.file || a.file_path || '');
    if (FILE_TOOLS.has(name) && p) {
      if (!o.ok) {
        const n = (fileFails.get(p) || 0) + 1;
        fileFails.set(p, n);
        const why = firstLine(o.error).slice(0, 200);
        if (n === L.file) notes.push(`[stuck check] Changing ${p} has now failed ${n} times${why ? ` (last: ${why})` : ''}. Stop trying variations. Read the file again as it is now -- your idea of it is out of date -- work out why the change does not apply, and take a different approach.`);
        else if (n === L.fileHard) notes.push(`[stuck check] Changing ${p} has failed ${n} times. Stop working on this file: tell the user what you were trying to do, what keeps failing, and ask how they want to go on.`);
      } else fileFails.delete(p);
    }
    if (name === 'shell' && o.ok && o.result && typeof o.result.exit === 'number') {
      const cmd = shape(a.command);
      if (o.result.exit !== 0) {
        const sig = cmd + '|' + shape(firstLine(o.result.stderr) || firstLine(o.result.stdout));
        const n = (cmdFails.get(sig) || 0) + 1;
        cmdFails.set(sig, n);
        if (n === L.command) notes.push(`[stuck check] This command has failed the same way ${n} times (exit ${o.result.exit}). Running it again will not change that: read the error, fix its cause first, or try a different way -- and if it needs something only the user can give, ask them.`);
      } else for (const k of [...cmdFails.keys()]) if (k.startsWith(cmd + '|')) cmdFails.delete(k);
    }
    if (o.ok && CHANGING.has(name)) idle = 0;
    else if (name === 'ask_user' || name === 'ask_confirm') idle = 0;
    else if (LOOKING.has(name)) {
      idle++;
      if (idle === L.idle && !idleSaid) {
        idleSaid = true;
        notes.push(`[progress check] ${idle} steps of looking without changing anything. If you know enough, make the change now; if you are unsure what the user wants, ask them with ask_user instead of reading further.`);
      }
    }
    return notes.join('\n\n');
  }
  return { after };
}

module.exports = { createStuckWatch, LIMITS };
