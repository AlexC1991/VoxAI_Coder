/**
 * terminal.js — a real interactive shell inside the app.
 *
 * A pty per terminal, so anything that asks for a password (sudo, ssh, git) can prompt
 * and be answered *in the panel*. That is the point of it: the agent can run a command
 * that needs typing, hand it to you, and never see what you type.
 *
 * Deliberate security choices:
 *   - Nothing here is sent to the model. main.js keeps the pty's input away from the
 *     agent loop entirely; the panel is yours.
 *   - Output is a stream of strings, never buffered into a tool result.
 *
 * Only loaded when a terminal is actually opened, so a missing native module cannot
 * break the rest of the app.
 */

const os = require('os');
const path = require('path');

let pty = null;
let loadError = '';
function loadPty() {
    if (pty || loadError) return pty;
    try {
        // eslint-disable-next-line global-require
        pty = require('node-pty');
    } catch (e) {
        loadError = String(e.message || e);
    }
    return pty;
}

/** Is the terminal available on this machine, and why not if it is not. */
function available() {
    return { ok: Boolean(loadPty()), error: loadError };
}

/**
 * The user's real shell, and a sensible login environment. On Linux, bash and zsh start as
 * login shells (-l): an AppImage started from the menu inherits the desktop's bare
 * environment, and only a login shell reads ~/.profile, where nvm, pyenv and a user's PATH
 * additions usually live.
 */
function shellInfo() {
    const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
    const args = [];
    if (process.platform === 'win32') args.push('-NoLogo');
    else if (/(bash|zsh)$/.test(shell)) args.push('-l');
    return { shell, args };
}

class TerminalManager {
    constructor({ onData, onExit } = {}) {
        this.terms = new Map();          // id -> { proc, cols, rows, cwd, shell }
        this.nextId = 1;
        this.onData = typeof onData === 'function' ? onData : () => {};
        this.onExit = typeof onExit === 'function' ? onExit : () => {};
    }

    /**
     * Open a shell. `cwd` defaults to the session's folder when given, so a terminal opens
     * where the work is happening rather than always in $HOME.
     */
    open({ cwd, cols = 80, rows = 24, env = {}, shellOverride = null } = {}) {
        const mod = loadPty();
        if (!mod) return { ok: false, error: loadError || 'the terminal backend is unavailable' };

        // A specific program instead of the user's login shell: interactive.js runs one
        // command this way, with a terminal attached, rather than an interactive shell.
        const over = Array.isArray(shellOverride) && shellOverride[0] ? shellOverride : null;
        const { shell, args } = over ? { shell: over[0], args: over[1] == null ? [] : over[1] } : shellInfo();
        const here = (cwd && String(cwd)) || os.homedir();
        const id = `term${this.nextId++}`;

        let proc;
        try {
            proc = mod.spawn(shell, args, {
                name: 'xterm-256color',
                cols: Math.max(20, Number(cols) || 80),
                rows: Math.max(5, Number(rows) || 24),
                cwd: here,
                env: {
                    ...process.env,
                    ...env,
                    TERM: 'xterm-256color',
                    COLORTERM: 'truecolor',
                    // Stop tools assuming a dumb pipe: this is a real terminal.
                    VOXAI_TERMINAL: '1',
                    // A command that CAN prompt will, instead of failing for want of a tty.
                    ...(over ? { SUDO_ASKPASS: '', SUDO_PROMPT: 'VoxAI: password for %p: ' } : {}),
                },
            });
        } catch (e) {
            return { ok: false, error: `could not start ${shell}: ${String(e.message || e)}` };
        }

        proc.onData((chunk) => this.onData(id, chunk));
        proc.onExit(({ exitCode, signal }) => {
            this.terms.delete(id);
            this.onExit(id, { exitCode, signal });
        });

        this.terms.set(id, { proc, cols, rows, cwd: here, shell });
        return { ok: true, id, shell, cwd: here };
    }

    write(id, data) {
        const t = this.terms.get(id);
        if (!t) return { ok: false, error: 'no such terminal' };
        try { t.proc.write(String(data)); return { ok: true }; }
        catch (e) { return { ok: false, error: String(e.message || e) }; }
    }

    /** Keep the shell's idea of its size in step with the panel, or full-screen tools misdraw. */
    resize(id, cols, rows) {
        const t = this.terms.get(id);
        if (!t) return { ok: false, error: 'no such terminal' };
        const c = Math.max(20, Number(cols) || 80);
        const r = Math.max(5, Number(rows) || 24);
        try { t.proc.resize(c, r); t.cols = c; t.rows = r; return { ok: true }; }
        catch (e) { return { ok: false, error: String(e.message || e) }; }
    }

    close(id) {
        const t = this.terms.get(id);
        if (!t) return { ok: true };
        try { t.proc.kill(); } catch { /* already gone */ }
        this.terms.delete(id);
        return { ok: true };
    }

    closeAll() {
        for (const id of [...this.terms.keys()]) this.close(id);
    }

    list() {
        return [...this.terms.entries()].map(([id, t]) => ({
            id, shell: t.shell, cwd: t.cwd, cols: t.cols, rows: t.rows,
        }));
    }
}

module.exports = { TerminalManager, available, shellInfo };