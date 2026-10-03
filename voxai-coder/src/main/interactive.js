/**
 * interactive.js — running one of the agent's commands in the app's OWN terminal panel.
 *
 * The shell tool pipes a command's output. With no terminal, a command that asks a
 * question (sudo wanting a password) has nowhere to put the prompt: it reads EOF and
 * fails with "a terminal is required to read the password". Those commands are run on a
 * pty instead — in the terminal panel that is already part of the app, beside the chat,
 * not in a window of its own. You see the command, answer the prompt there, and carry on.
 *
 * Three rules:
 *   1. The user approves the command first, through the app's normal permission bar.
 *      Everything here runs with the user's own privileges.
 *   2. What the user types is NEVER returned to the model. Only the command's ordinary
 *      output goes back, with a plain note that input was requested.
 *   3. The panel is the user's: they can type in it, and Stop closes the command.
 *
 * The command itself is exactly what the shell tool would have run — /bin/sh -c "<command>" —
 * just with a terminal attached.
 */

const os = require('os');
const { ipcMain } = require('electron');

/**
 * Wait for the panel's own answer — and check something is listening at all.
 *
 * A renderer with no panel (a stale page, or a plain browser) simply never replies, so
 * without this the call waits out the full timeout and then says "the terminal panel did not
 * come up" with nothing to act on. This asks the panel to identify itself first, so the
 * failure is a clear sentence rather than a timeout.
 */
function smartProbe(send, thenWaitMs) {
    return new Promise((resolve) => {
        const requestId = 'probe' + Date.now().toString(36);
        const onReady = (_e, m) => {
            if (!m || m.requestId !== requestId) return;
            clearTimeout(t);
            ipcMain.removeListener('term:ready', onReady);
            resolve({ ok: true });
        };
        // A 0ms prepare: the panel answers immediately, without opening or running anything.
        ipcMain.once('term:ready', onReady);
        const t = setTimeout(() => {
            ipcMain.removeListener('term:ready', onReady);
            resolve({ ok: false, error: 'no terminal panel is listening in this window' });
        }, thenWaitMs || 900);
        try { send('term:prepare', { requestId, probe: true }); } catch { /* send reports it */ }
    });
}

const SENSITIVE = /password|passphrase|\[sudo\]|Sorry, try again|Verification code|PIN:/i;

/** Commands currently running in the panel: termId -> state (see runInteractive). */
const active = new Map();

/** Every byte a running command prints, so it can be judged once it ends. */
function noteChunk(id, chunk) {
    const r = active.get(id);
    if (!r) return;
    r.output += chunk;
    if (SENSITIVE.test(chunk)) r.asked = true;
}

/** The command finished: hand its exit code to whoever is waiting. */
function noteExit(id, info) {
    const r = active.get(id);
    if (r && r.settle) r.settle(info || {});
}

/**
 * Run a command in the app's terminal panel and wait for it to finish.
 *
 * `opts`: { cwd, timeoutSecs, terminals, send, isAlive }
 *   terminals  the app's shared TerminalManager
 *   send       (channel, data) => void, delivering to EVERY page that shows the chat.
 *              NOT a BrowserWindow: the chat lives in a WebContentsView, so the window's own
 *              webContents carries none of these and the panel never appeared. main.js passes
 *              allRenderers().send — the same helper the rest of the app broadcasts with.
 * Returns { ok, exitCode, output, timedOut, cancelled, userTyped, wasAsked, note }.
 */
async function runInteractive(command, opts = {}) {
    const terminals = opts.terminals;
    const send = typeof opts.send === 'function' ? opts.send : null;
    if (!terminals || !send) {
        return { ok: false, error: 'the terminal panel is not reachable from this window' };
    }

    // Is anything actually listening on the other end? Without this, a panel that is not
    // mounted (a plain browser, a stale renderer) waits out the full timeout and then reports
    // "did not come up" with nothing to go on.
    const noPanel = smartProbe(send, 900);

    const cwd = opts.cwd && String(opts.cwd) ? String(opts.cwd) : os.homedir();
    const limitMs = Math.max(5, Math.min(600, Number(opts.timeoutSecs) || 120)) * 1000;
    const requestId = 'it' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    let finish;
    const done = new Promise((r) => { finish = r; });
    const state = { id: '', output: '', asked: false, userTyped: false, timedOut: false, cancelled: false, finished: false, exitCode: null };

    // ---- 1. ask the panel to come forward and show what is about to run ----
    let waitTimer = null;
    let offReady = null;
    const readyFor = (rid) => new Promise((resolve) => {
        const onReady = (_e, m) => {
            if (!m || m.requestId !== rid) return;
            clearTimeout(waitTimer);
            resolve({ ok: true });
        };
        waitTimer = setTimeout(() => resolve({
            ok: false,
            error: 'the terminal panel did not answer in time. It may not be loaded in this window '
                + '(the panel script runs when the chat page loads).',
        }), 4000);
        const { ipcMain } = require('electron');
        ipcMain.on('term:ready', onReady);
        offReady = () => ipcMain.removeListener('term:ready', onReady);
    });

    try { send('term:prepare', { requestId, command, cwd }); }
    catch { return { ok: false, error: 'the app window could not be reached' }; }

    const ready = await Promise.race([readyFor(requestId), noPanel]);
    if (!ready.ok) return { ok: false, error: ready.error };
    if (offReady) offReady();

    // ---- 2. start the command on a pty and bind the panel to it ----
        const opened = terminals.open({
            cwd,
            cols: 100, rows: 24,
            // The shell the agent's other commands run in. On Windows, cmd's own command line as
            // one string: node-pty quotes an argument list its own way, which cmd does not read.
            shellOverride: process.platform === 'win32'
                ? ['cmd.exe', `/d /s /c "${command}"`]
                : ['/bin/sh', ['-c', command]],
        });
    if (!opened || !opened.ok) {
        try { send('term:failed', { requestId, error: (opened && opened.error) || 'unknown reason' }); } catch { /* gone */ }
        return { ok: false, error: (opened && opened.error) || 'could not start the command' };
    }
    state.id = opened.id;

    const settle = (extra) => {
        if (state.finished) return;
        state.finished = true;
        clearTimeout(timer);
        active.delete(state.id);
        // Let the panel go back to being an ordinary shell.
        try { send('term:done', { requestId, id: state.id, exitCode: state.exitCode, cancelled: state.cancelled }); } catch { /* gone */ }
        if (state._offReady) state._offReady();
        if (extra) Object.assign(state, extra);
        finish({
            ok: !state.cancelled && state.exitCode === 0,
            exitCode: state.exitCode,
            output: scrub(state.output),
            timedOut: state.timedOut,
            cancelled: state.cancelled,
            userTyped: state.userTyped,
            wasAsked: state.asked,
            note: state.cancelled ? 'The user stopped this command.'
                : state.timedOut ? `Gave up after ${Math.round(limitMs / 1000)}s.`
                    : (state.asked && state.exitCode !== 0) ? 'It asked for input; see the output above.'
                        : '',
        });
    };

    // A pty exits when the command ends — /bin/sh -c has nothing left to do — so this is
    // the reliable "it finished" signal, and it carries the exit code.
    state.settle = (info) => {
        if (typeof info.exitCode === 'number') state.exitCode = info.exitCode;
        settle();
    };
    active.set(state.id, state);

    const timer = setTimeout(() => { state.timedOut = true; try { terminals.close(state.id); } catch { /* gone */ } settle(); }, limitMs);

    try { send('term:bind', { requestId, id: state.id, command, cwd }); } catch { /* gone */ }

    return done;
}

/**
 * What goes back to the model.
 *
 * A command that asked for a password also echoed the prompt, and a program that forgot
 * to turn echo off could echo the password itself. Only the command's ordinary output is
 * wanted, so control sequences are stripped and the transcript is trimmed to its tail —
 * that is where a command says whether it worked.
 */
function scrub(text) {
    const clean = String(text || '')
        .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')   // window-title sequences
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')             // colours, cursor moves
        .replace(/\x1b[=>]/g, '')
        .replace(/\r/g, '');
    const lines = clean.split('\n').map((l) => l.replace(/\s+$/, ''));
    const kept = lines.slice(-120).join('\n').trim();
    return kept.length > 8000 ? kept.slice(-8000) : kept;
}

module.exports = { runInteractive, noteChunk, noteExit, scrub };