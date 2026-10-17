'use strict';
/**
 * A fixed start for every request in a session, so the provider's prompt cache keeps hitting.
 *
 * Every provider caches the start of a request -- Gemini and OpenAI and DeepSeek on their own
 * (Gemini only when 4,096+ tokens match exactly), Claude where we mark it -- and a cached token
 * costs 5 to 25% of a fresh one. The system prompt carries the project's memory, build state,
 * notes and skills, and each message rebuilt it: the agent saving one memory fact changed the
 * system prompt, so the next message re-sent the WHOLE conversation at full price (and on
 * Claude and GPT-6.1 Sol paid a cache write, dearer than plain input, on top).
 *
 * Now the system prompt is frozen for the session. When the project's memory, build state,
 * notes or skills change, or the date does, what changed is told to the model in a short
 * [VOX CONTEXT] note at the end of the conversation, where new text costs nothing extra. The
 * prompt is built afresh only when it has to be: the user changed something the prompt states
 * (permission mode, plan mode, web search, goal, Team, a local model), or the conversation's
 * start changed anyway (it was summarised), which costs a full read regardless.
 */
const crypto = require('crypto');

const DATE_LINE = /Today's date: \d{4}-\d{2}-\d{2}\. /;
const SECTIONS = ['PROJECT NOTES', 'PROJECT MEMORY', 'BUILD STATE', 'SKILLS'];

/** The durable block split into its sections, by heading. */
function sectionsOf(durable) {
  const out = {};
  const text = String(durable || '');
  const heads = [];
  const re = /^\[(PROJECT NOTES|PROJECT MEMORY|BUILD STATE|SKILLS)\]/gm;
  let m;
  while ((m = re.exec(text))) heads.push({ name: m[1], at: m.index });
  heads.forEach((h, i) => { out[h.name] = text.slice(h.at, i + 1 < heads.length ? heads[i + 1].at : text.length).trim(); });
  return out;
}

const factLines = (sec) => String(sec || '').split('\n').filter((l) => /^- /.test(l));

/**
 * What changed between two durable blocks, said to the model. '' when nothing did.
 * Memory gives only the facts added and removed; any other section that changed is given whole.
 */
function durableChanges(was, now, dateWas, dateNow) {
  const a = sectionsOf(was), b = sectionsOf(now);
  const parts = [];
  if (dateWas && dateNow && dateWas !== dateNow) parts.push(`Today's date is now ${dateNow}.`);
  for (const name of SECTIONS) {
    const x = a[name] || '', y = b[name] || '';
    if (x === y) continue;
    if (name === 'PROJECT MEMORY') {
      const before = new Set(factLines(x)), after = new Set(factLines(y));
      const added = [...after].filter((l) => !before.has(l));
      const gone = [...before].filter((l) => !after.has(l));
      if (added.length) parts.push('New in project memory:\n' + added.join('\n'));
      if (gone.length) parts.push('Removed from project memory (no longer true -- do not rely on them):\n' + gone.join('\n'));
      continue;
    }
    parts.push(y ? `The project's ${name.toLowerCase()} changed. It now reads:\n${y}` : `The project's ${name.toLowerCase()} section is gone.`);
  }
  return parts.length ? '[VOX CONTEXT] Since this session\'s instructions were set, the project changed. This replaces what the instructions above say about it:\n\n' + parts.join('\n\n') : '';
}

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

/**
 * The system prompt to send, and a note to add before this run's message, if any.
 *
 * session.promptFrozen = { key, text, told, date, start } is kept with the session:
 *   key   what the prompt says apart from the durable block and the date
 *   text  the prompt as first sent
 *   told  the durable block as the model last heard it (in the prompt or a note)
 *   start a fingerprint of the conversation's first message, to see a summary replace it
 */
function stablePrompt(session, { fresh, head, durable, date }) {
  const key = hash(String(head || '').replace(DATE_LINE, ''));
  const first = (session.messages || [])[0];
  const start = first ? hash(JSON.stringify(first).slice(0, 2000)) : '';
  const fz = session.promptFrozen;
  if (fz && fz.key === key && fz.text && fz.start === start) {
    const note = durableChanges(fz.told, durable, fz.date, date);
    // Recorded as told only once the note is really in the conversation (not on a resume).
    return { systemPrompt: fz.text, note, kept: true, commit: () => { fz.told = durable; fz.date = date; } };
  }
  session.promptFrozen = { key, text: fresh, told: durable, date, start };
  return { systemPrompt: fresh, note: '', kept: false, commit: () => {} };
}

/** After the run's first message is added, the conversation's start is known: record it. */
function noteStart(session) {
  const fz = session.promptFrozen; if (!fz) return;
  const first = (session.messages || [])[0];
  fz.start = first ? hash(JSON.stringify(first).slice(0, 2000)) : '';
}

module.exports = { stablePrompt, noteStart, durableChanges, sectionsOf, DATE_LINE };
