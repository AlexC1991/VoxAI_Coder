/**
 * terminal-panel.js — the docked shell in the renderer.
 *
 * Kept out of index.html's inline script on purpose: it is self-contained, it must
 * degrade quietly when the pty backend is missing, and a separate file is far easier
 * to read and to keep from colliding with the app's own globals.
 *
 * The one rule that matters: keystrokes go straight to the pty through
 * window.voxai.terminal and nothing here is forwarded to the model. A sudo password
 * typed into this panel never leaves the channel.
 */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
        const bridge = () => (window.voxai && window.voxai.terminal) || null;

    let term = null;         // xterm instance
    let fit = null;          // fit addon
    let ptyId = '';          // the shell's id in the main process
    let listeners = [];      // unsubscribe handles
    let opened = false;      // has a pty been started this session
    let runState = null;     // { id, command } while the agent runs a command here

    const panel = () => $('termPanel');
    const holder = () => $('termHolder');

    /** The folder this session works in, so a shell opens where the work is. */
    function sessionCwd() {
        // The page's own session folder. window.WORKDIR was read here but never set, so every
        // shell opened in the home folder rather than the project.
        try {
            if (typeof viewDir === 'function' && typeof actView === 'function') { const d = viewDir(actView()); if (d) return String(d); }
        } catch { /* no session yet */ }
        try {
            if (typeof window.WORKDIR === 'string' && window.WORKDIR) return window.WORKDIR;
        } catch { /* not defined */ }
        return '';
    }

    function setCwdLabel(dir) {
        const el = $('termCwd');
        if (!el) return;
        el.textContent = dir || '';
        el.title = dir || '';
    }

    function note(html) {
        const el = $('termNote');
        if (el) el.innerHTML = html;
    }

    function buildXterm() {
        if (term) return term;
        if (!window.Terminal) {
            note('The terminal renderer did not load, so the panel cannot be shown.');
            return null;
        }
        term = new window.Terminal({
            convertEol: false,
            cursorBlink: true,
            fontSize: 13,
            fontFamily: 'Sometype Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            scrollback: 5000,
            allowProposedApi: true,
            theme: {
                background: '#0d0f12', foreground: '#d7dbe0', cursor: '#f0b429',
                selectionBackground: 'rgba(240,180,41,.28)',
            },
        });
        if (window.FitAddon && window.FitAddon.FitAddon) {
            fit = new window.FitAddon.FitAddon();
            term.loadAddon(fit);
        }
        term.open(holder());
        // Keystrokes go one way, always: user -> whichever pty is bound right now. Set up
        // here rather than in startShell, so a command the agent runs in a panel that was
        // never opened for a shell still takes what the user types.
        term.onData((d) => { const bb = bridge(); if (bb && ptyId) bb.write(ptyId, d); });
        return term;
    }

    function resize() {
        if (!term || !fit) return;
        try { fit.fit(); } catch { /* not laid out yet */ }
        if (ptyId && term.cols && term.rows) {
            const b = bridge();
            if (b) b.resize(ptyId, term.cols, term.rows);
        }
    }

    function attachListeners() {
        if (listeners.length) return;
        const b = bridge();
        if (!b) return;
        listeners.push(b.onData((m) => {
            if (term && m && m.id === ptyId) term.write(m.data);
        }));
        listeners.push(b.onExit((m) => {
            if (!m || m.id !== ptyId) return;
            const code = (m.exitCode === undefined || m.exitCode === null) ? '' : ` (exit ${m.exitCode})`;
            if (term) term.write(`\r\n\x1b[33m[shell closed${code}]\x1b[0m\r\n`);
            ptyId = '';
            opened = false;
        }));
    }

    async function startShell() {
        if (runState) return;                    // the agent's command owns the panel
        const b = bridge();
        if (!b) {
            note('The terminal needs the desktop app (it is not available in a plain browser).');
            return;
        }
        const t = buildXterm();
        if (!t) return;

        if (ptyId) return;                       // already running
        const probe = await b.list();
        if (probe && probe.ok === false) {
            note(`The terminal backend could not start: <b>${String(probe.error || 'unknown reason')}</b>`);
            return;
        }

        const cwd = sessionCwd();
        const r = await b.open({ cwd: cwd || undefined, cols: t.cols || 80, rows: t.rows || 24 });
        if (!r || !r.ok) {
            note(`Could not start a shell: <b>${String((r && r.error) || 'unknown reason')}</b>`);
            return;
        }
        ptyId = r.id;
        opened = true;
        setCwdLabel(r.cwd || cwd);
        attachListeners();
        resize();
        term.focus();
    }

    async function killShell() {
        const b = bridge();
        if (b && ptyId) b.close(ptyId);
        ptyId = '';
        opened = false;
        if (term) term.reset();
    }

    // ---- the agent's own command -------------------------------------------
    //
    // A command that needs a terminal (sudo, an ssh login) is run by main on a pty and
    // shown HERE, in this panel, rather than in a window of its own. Coming forward so
    // the prompt is visible is the whole trick: with the pty the command can ask, and
    // with the panel on screen you can answer.

    function beginRun(msg) {
        runState = { requestId: msg.requestId, command: msg.command };
        note('The agent is running a command here. <b>Type any password it asks for in this panel</b> — it goes straight to the command and is never sent to the model.');
        const t = buildXterm();
        if (t && ptyId) { try { const b = bridge(); if (b) b.close(ptyId); } catch { /* fine */ } ptyId = ''; opened = false; }
        opened = false;
        open();
        const el = $('termCwd');
        if (el) { el.textContent = msg.cwd || ''; el.title = (msg.command || ''); }
        const btns = $('termKill');
        if (btns) btns.textContent = '\u25a0';
        // The panel is up; main may now start the command.
        const b = bridge();
        if (b && b.ready) b.ready({ requestId: msg.requestId });
        setTimeout(() => { if (term) term.focus(); }, 200);
    }

    function bindRun(msg) {
        runState = { requestId: msg.requestId, id: msg.id, command: msg.command };
        ptyId = msg.id;
        opened = true;
        attachListeners();
        if (term) { term.reset(); term.write('\x1b[33m$ ' + String(msg.command || '') + '\x1b[0m\r\n\r\n'); }
        resize();
        setTimeout(() => { if (term) term.focus(); }, 120);
    }

    function endRun() {
        runState = null;
        const btns = $('termKill');
        if (btns) btns.textContent = '\u00d7';
        note('A real shell. Passwords you type here (sudo, ssh) stay in this panel and are never sent to the model.');
        const el = $('termCwd');
        if (el) el.textContent = sessionCwd() || '';
    }

    function open() {
        const p = panel();
        if (!p) return;
        // One dock, one panel: the preview also docks on the right at 42%, so opening both
        // took 84% of the width and squeezed the chat away. Opening the terminal closes the
        // preview (the page keeps loading in main; reopening it is a click).
        try {
            const pp = $('previewPanel');
            if (window.VOX_PREVIEW && window.VOX_PREVIEW.close) window.VOX_PREVIEW.close();
            else if (pp && pp.classList.contains('open')) { const x = $('ppClose'); if (x) x.click(); }
        } catch { /* the terminal must still open if the preview refuses to close */ }
        p.style.display = '';
        // Next frame, so the panel has a width before xterm measures it.
        requestAnimationFrame(() => {
            p.classList.add('open');
            const dv = $('termDivider'); if (dv) dv.classList.add('open');
            resize();
            if (!opened) startShell();
            setTimeout(() => { if (term) { resize(); term.focus(); } }, 260);
        });
    }

    function close() {
        const p = panel();
        if (!p) return;
        p.classList.remove('open');
        const dv = $('termDivider'); if (dv) dv.classList.remove('open');
        setTimeout(() => { if (!p.classList.contains('open')) p.style.display = 'none'; }, 260);
    }

    function toggle() {
        const p = panel();
        if (!p) return;
        if (p.classList.contains('open')) close(); else open();
    }

    // ---- wiring -------------------------------------------------------------

    function wire() {
        // Commands the agent runs in this panel (see beginRun/bindRun above).
        const b0 = bridge();
        if (b0 && b0.onRunPrepare) b0.onRunPrepare(beginRun);
        if (b0 && b0.onRunBind) b0.onRunBind(bindRun);
        if (b0 && b0.onRunDone) b0.onRunDone(endRun);

        const btnHide = $('termHide'); if (btnHide) btnHide.addEventListener('click', close);
        const btnToggle = $('termToggle'); if (btnToggle) btnToggle.addEventListener('click', toggle);
        const btnNew = $('termNew'); if (btnNew) btnNew.addEventListener('click', async () => { await killShell(); open(); });
        const btnKill = $('termKill');
        if (btnKill) btnKill.addEventListener('click', async () => {
            await killShell();
            const b = bridge(); if (b) { const r = await b.open({ cwd: sessionCwd() || undefined, cols: term ? term.cols : 80, rows: term ? term.rows : 24 }); if (r && r.ok) { ptyId = r.id; opened = true; setCwdLabel(r.cwd); if (term) term.reset(); resize(); } }
        });

        // Drag the divider to resize, exactly like the preview panel.
        const dv = $('termDivider');
        if (dv) {
            let dragging = false;
            dv.addEventListener('mousedown', (e) => {
                dragging = true; dv.classList.add('dragging');
                const p = panel(); if (p) p.classList.add('dragging');
                document.body.style.cursor = 'col-resize';
                try { e.preventDefault(); } catch { /* fine */ }
            });
            window.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                const main = $('main') || document.body;
                const rect = main.getBoundingClientRect ? main.getBoundingClientRect() : { left: 0, width: main.clientWidth };
                if (!rect.width) return;
                const rel = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                const frac = Math.min(0.85, Math.max(0.2, rel));
                const p = panel();
                // Terminal sits on the right, so its width is the remainder.
                if (p) p.style.width = ((1 - frac) * 100) + '%';
                if (term && fit) { try { fit.fit(); } catch { /* mid-drag */ } }
            });
            window.addEventListener('mouseup', () => {
                if (!dragging) return;
                dragging = false; dv.classList.remove('dragging');
                const p = panel(); if (p) p.classList.remove('dragging');
                document.body.style.cursor = '';
                resize();
            });
        }

        window.addEventListener('resize', () => { if (panel() && panel().classList.contains('open')) resize(); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();

    window.VOX_TERMINAL = { open, close, toggle, resize, isOpen: () => { const p = panel(); return !!(p && p.classList.contains('open')); } };
})();