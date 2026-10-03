/**
 * terminal.js (tool) — the agent's way to use the app's terminal panel, and to run a
 * command that has to ask something.
 *
 * The panel itself is older than this file: it is a real pty in a docked column that the
 * USER can also open and type into. What was missing was an agent-facing surface, so the
 * only way in was a special case hard-wired into the shell tool. This gives it the same
 * shape as the browser tool: its own defs[], its own run(name, args, ctx) dispatcher, and
 * its own place in the registry.
 *
 * Why that matters, beyond tidiness:
 *   - the shell tool silently *swapped* a piped command for a pty one. `sudo apt update`
 *     was not what ran; a panel command was. The model never saw that, and could not tell
 *     afterwards which had happened.
 *   - `sudo -n` (the never-prompt form) could not be run at all.
 *   - a command that blocks on a prompt could not be started deliberately, on purpose.
 *
 * Now the routing is stated instead of hidden. A plain `shell` call runs on pipes, as it
 * always did. `terminal_run` runs it on the panel's pty, where a prompt can be answered.
 *
 * What the user types in the panel is NEVER returned to the model — only the command's own
 * output, plus the fact that input was asked for. See main/interactive.js.
 */

const WIN = process.platform === 'win32';
const INTERACTIVE_HINT = WIN ? 'an ssh login, npm login, gh auth login, gpg' : 'sudo, ssh, gpg';
const EXAMPLE = WIN ? '"ssh me@myserver", "npm login"' : '"sudo apt update", an apt/git authentication prompt';
const SHELL_NOTE = WIN ? 'A shell call that would wait on such a prompt is refused rather than quietly rerouted. ' : 'Putting sudo in a shell call is refused rather than quietly rerouted, so this is the only way to run one deliberately. ';

function makeTerminalTool({ interactive }) {
  const has = typeof interactive === 'function';

  return {
    defs: [
      {
        type: 'function',
        function: {
          name: 'terminal_run',
          description: 'Run a command in the app\'s docked terminal panel, where a prompt can be answered, '
            + 'and wait for it to finish. Use this instead of shell when the command will ask for input '
            + `(${INTERACTIVE_HINT}) or needs a real terminal — for example ${EXAMPLE}, `
            + 'or a program that checks isatty. The user sees the command and types any '
            + 'password themselves; whatever they type never reaches you. ' + SHELL_NOTE
            + 'Returns { ok, exitCode, output, timedOut, cancelled, note } — output is the command\'s own output.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'The command to run, as you would type it in a shell.' },
              timeout_secs: { type: 'number', description: 'Give up after this many seconds (default 120, max 600).' },
            },
            required: ['command'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'terminal_state',
          description: 'Whether the app\'s terminal panel is available, and which shells are open in it. '
            + 'Useful before asking the user to run something there by hand.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    ],

    async run(name, args, ctx) {
      if (name === 'terminal_state') {
        return {
          ok: has,
          available: has,
          note: has
            ? 'The terminal panel is available: terminal_run runs a command in it.'
            : 'No terminal panel in this app window, so terminal_run is unavailable. Use shell instead; '
              + 'a command needing a prompt will not be able to run.',
        };
      }

      if (name === 'terminal_run') {
        if (!has) {
          return { ok: false, error: 'the terminal panel is not available in this app window — use shell, '
            + 'and note that a command needing a password prompt cannot run without a terminal' };
        }
        const command = String(args.command == null ? '' : args.command);
        if (!command.trim()) return { ok: false, error: 'terminal_run needs a command' };

        // It runs with the user's own privileges on purpose, so it is approved like any
        // other shell command — the user sees the full text before anything starts.
        await ctx.checkPermission('shell', command);
        return interactive(command, { cwd: ctx.workdir, timeoutSecs: args.timeout_secs });
      }

      throw new Error('unknown terminal tool');
    },
  };
}

module.exports = { makeTerminalTool };
