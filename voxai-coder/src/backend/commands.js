/**
 * Slash commands typed in the message box: what each means, in one place.
 *
 *   /goal <done means>   keep working until a separate check says it is met (goal.js)
 *   /review [focus]      review the changes not committed yet; read-only, nothing edited
 *   /init                study the project and write AGENTS.md, read into every session
 *   /rewind              undo the file changes of the agent's last run (checkpoints.js)
 *   /loop [every] <task> run a task again every so often while the app is open; /loop stop
 *
 * The message the agent gets for /review and /init starts with "[VOX CMD] <what was
 * typed>", so a reopened session shows the command, not the instructions behind it.
 */

const COMMANDS = [
  { name: 'goal', args: '<what done means>', about: 'Keep working until a separate check says it is done' },
  { name: 'review', args: '[what to focus on]', about: 'Review the changes not committed yet; nothing is edited' },
  { name: 'init', args: '', about: 'Study the project and write AGENTS.md, which every session reads' },
  { name: 'rewind', args: '', about: 'Undo the file changes from the agent’s last run' },
  { name: 'loop', args: '[5m] <task> · stop', about: 'Run a task again every so often while the app is open' },
];

/** { name, rest } for a known command, else null. "/goal" is handled by goal.js. */
function parseCommand(text) {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (!COMMANDS.some((c) => c.name === name)) return null;
  return { name, rest: String(m[2] || '').trim() };
}

function reviewPrompt(focus) {
  return `[VOX CMD] /review${focus ? ' ' + focus : ''}\n\n`
    + 'Review the changes in this project that are not committed yet'
    + (focus ? `, focusing on: ${focus}` : '') + '. '
    + 'Start with git status and git diff, and read any new files in full. If this is not a git repository, review the files '
    + 'changed in this session instead, and say that is what you reviewed. '
    + 'Look for bugs, wrong behaviour, security problems, missing error handling, missing tests, and anything that does not fit '
    + 'the rest of the code. Report findings most serious first; for each give file:line, what is wrong, why it matters and a '
    + 'concrete fix. If you find nothing serious, say so plainly. This is a review only: do not change any files.';
}

function initPrompt() {
  return '[VOX CMD] /init\n\n'
    + 'Study this project and write AGENTS.md in its root: the notes a coding agent needs at the start of every session here. '
    + 'Look at the files, the package or build files, the tests and the README before writing. Include: what the project is '
    + '(two or three lines); how to install, build, run and test it (the exact commands, checked by running the quick ones); '
    + 'the layout of the code (the main folders and what lives where); conventions to follow (language, style, naming, how '
    + 'errors and tests are done); and anything easy to get wrong. Keep it under about 120 lines, plain and specific -- no '
    + 'generic advice. If AGENTS.md already exists, update it rather than starting over, and keep what is still true. '
    + 'VoxAI reads this file into every session in this folder.';
}

/** "5m", "30s", "2h", "every 10 minutes" at the start of a /loop -> { ms, task }. Default 10 minutes. */
function parseLoop(rest) {
  const t = String(rest || '').trim();
  if (/^(stop|off|clear|cancel|end|none)$/i.test(t)) return { stop: true };
  const m = /^(?:every\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b[,:]?\s*/i.exec(t);
  let ms = 10 * 60 * 1000;
  let task = t;
  if (m) {
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    ms = n * (u.startsWith('h') ? 3600000 : u.startsWith('m') ? 60000 : 1000);
    task = t.slice(m[0].length).trim();
  }
  ms = Math.min(24 * 3600000, Math.max(60000, Math.round(ms)));   // one minute to a day
  return { ms, task };
}

function every(ms) {
  if (ms % 3600000 === 0) return `${ms / 3600000} h`;
  if (ms % 60000 === 0) return `${ms / 60000} min`;
  return `${Math.round(ms / 1000)} s`;
}

function loopPrompt(task, n) {
  return `[VOX CMD] /loop ${task}\n\n(Run ${n} of a repeating task: do it now, report briefly, and do not start anything that keeps running.)\n${task}`;
}

module.exports = { COMMANDS, parseCommand, reviewPrompt, initPrompt, parseLoop, loopPrompt, every };
