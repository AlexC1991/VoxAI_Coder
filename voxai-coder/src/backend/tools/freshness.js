/**
 * Freshness guard — refuse to write a file that changed since the model last saw it.
 *
 * The model edits from a mental model built when it READ the file. If something else
 * touched it in between (you, in your editor; a formatter; a git operation; a
 * concurrent sub-agent) then an exact-match edit either fails confusingly or, worse,
 * succeeds against content the model never saw and silently clobbers the change.
 *
 * Cheap to implement, and it converts a whole class of silent corruption into a
 * recoverable tool error the model can act on. Modelled on Crush's guard.
 */
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;

// fullPath -> { hash, at }. Process-lifetime; a restart simply means no guard until
// the file is read again, which is the safe direction to fail.
const seen = new Map();

function hashOf(text) {
  return crypto.createHash('sha256').update(text == null ? '' : String(text)).digest('hex');
}

/** Record what the model just saw. Call after every successful read AND write. */
function markSeen(fullPath, text) {
  seen.set(fullPath, { hash: hashOf(text), at: Date.now() });
}

function forget(fullPath) {
  seen.delete(fullPath);
}

/** Has the model read (or written) this file in this app run? */
function wasSeen(fullPath) {
  return seen.has(fullPath);
}

/**
 * Throw if the on-disk content no longer matches what was last read.
 * Silent no-op when the file was never read (nothing to compare against) or does
 * not exist yet (a create, not an overwrite).
 */
async function assertFresh(fullPath, relPath) {
  const rec = seen.get(fullPath);
  if (!rec) return;
  let current;
  try { current = await fsp.readFile(fullPath, 'utf8'); }
  catch { return; } // gone or unreadable — let the operation itself report it
  if (hashOf(current) === rec.hash) return;
  // Drop the stale record so the model's next read re-arms the guard cleanly.
  seen.delete(fullPath);
  throw new Error(
    `${relPath || fullPath} changed on disk since you last read it — your edit was NOT applied. `
    + `Read the file again and redo the change against the current content.`,
  );
}

module.exports = { markSeen, assertFresh, forget, hashOf, wasSeen };
