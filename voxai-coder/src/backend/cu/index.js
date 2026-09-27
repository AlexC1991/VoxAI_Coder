/**
 * cu/index.js — VoxAI Computer Use tool surface (sky-style). Exposes an
 * agent-callable set of tools that let the model read the live screen (text +
 * indexed elements + screenshot) and act on it (click / type / press / scroll /
 * launch), with a fresh state snapshot after each action — Codex "computer use"
 * in miniature.
 *
 * Two backends, selected per call via `backend` (default "browser"):
 *   - "browser": a persistent Chrome/Edge via CDP (fast, headless-friendly, the
 *     primary surface — see cdp.js). Model reads page text + indexed elements.
 *   - "native": the real desktop on Windows via Win32/.NET (list windows,
 *     screenshot, drive mouse/keyboard — see native.js). Model reads window list.
 *
 * Every state/screenshot capture also emits an `image` UI event so the renderer
 * streams the live screenshot straight into the chat thread ("seeing everything
 * happening in real time"), while the model reasons from the accessibility text.
 */

const cdp = require('./cdp');
const native = require('./native');
const desktop = require('./desktop');

/**
 * Which surface a call works on: the browser (the preview) or the Windows desktop. What the call
 * says wins -- `backend`, a url, a program to start, a window to name -- and otherwise the surface
 * this session's last call used. One answer for the tool and for its approval (agent.js), per
 * session: it was one app-wide variable, and the approval assumed "browser" whenever `backend` was
 * left out, so a desktop click could be approved as an action on the website in the preview.
 */
const surfaces = new Map();   // session id -> 'browser' | 'native'
const LAUNCHABLE = /\.(exe|bat|cmd|lnk|msc)$/i;
function surfaceFor(sessionId, name, args) {
  const a = args || {};
  if (a.backend === 'browser' || a.backend === 'native') return a.backend;
  if (a.url) return 'browser';
  if (name === 'cu_launch' && a.nativePath) return LAUNCHABLE.test(String(a.nativePath)) ? 'native' : 'browser';
  if (name === 'cu_focus' || a.window || a.hwnd || a.pid) return 'native';
  return surfaces.get(sessionId || 'default') || 'browser';
}
const ACTION_TOOL = { open: 'cu_launch', state: 'cu_state', click: 'cu_click', type: 'cu_type', press: 'cu_press',
  scroll: 'cu_scroll', screenshot: 'cu_screenshot', list: 'cu_list', focus: 'cu_focus' };
/** The same, for a `computer` call as the model makes it (with `action`). */
const surfaceForAction = (sessionId, action, args) => surfaceFor(sessionId, ACTION_TOOL[action] || '', args);

function emitImage(ctx, dataUrl, title) {
  if (dataUrl && ctx && typeof ctx.emit === 'function') {
    try { ctx.emit({ type: 'image', dataUrl, title: title || 'screen' }); } catch {}
  }
}

function makeComputerUseTool(opts) {
  const showInApp = opts && opts.showInApp;
  const attachAtlas = opts && opts.attachAtlas;
  return {
    defs: [
      {
        type: 'function',
        function: {
          name: 'cu_launch',
          description: 'Computer-use: open a web URL or a local file in the persistent browser, or launch a native app on Windows (a http(s)/file URL in `url`; or a path in `nativePath` — a file is shown in the browser, an .exe is launched). The page is also shown in the in-app Atlas window so the user can see it. Returns the live state (text + indexed elements + screenshot streamed to the UI).',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'Web URL to open (browser backend).' },
              nativePath: { type: 'string', description: 'Native app exe/path to launch (native backend, Windows).' },
              backend: { type: 'string', enum: ['browser', 'native'], description: 'Which surface. Default browser.' },
              headless: { type: 'boolean', description: 'Browser backend: keep the agent automation browser hidden (default true). The page is shown in the Atlas in-app window regardless.' },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cu_state',
          description: 'Computer-use: the current state -- browser: the page text and its numbered elements; native: the numbered controls of one window (buttons, boxes, menus...) and a picture of it. Act on controls by their number (index).',
          parameters: {
            type: 'object',
            properties: {
              backend: { type: 'string', enum: ['browser', 'native'] },
              window: { type: 'string', description: 'native: the window to work in -- part of its title or the app name (e.g. "Notepad"). Remembered, so later calls can leave it out.' },
              find: { type: 'string', description: 'native: only controls whose name or type contains this (e.g. "save", "Edit").' },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cu_click',
          description: 'Computer-use: click an element by its `index` (from cu_state) or at (x, y) coordinates on the live screen/window. Then call cu_state to observe the result.',
          parameters: {
            type: 'object',
            properties: {
              index: { type: 'integer', description: 'Element index from cu_state elements.' },
              x: { type: 'integer' }, y: { type: 'integer' },
              backend: { type: 'string', enum: ['browser', 'native'] },
              button: { type: 'string', enum: ['left', 'right'], description: 'native: right opens a control\'s menu (its items come back numbered).' },
              double: { type: 'boolean', description: 'native: double-click.' },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cu_type',
          description: 'Computer-use: type text -- browser: into the focused field; native: into a control by its index (or the focused one), exactly as given. Does not press Enter.',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string' }, backend: { type: 'string', enum: ['browser', 'native'] } },
            required: ['text'], additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cu_press',
          description: 'Computer-use: press a key or modifier chord (e.g. "Enter", "Tab", "Control+A", "Control+Shift+period").',
          parameters: {
            type: 'object',
            properties: { key: { type: 'string' }, backend: { type: 'string', enum: ['browser', 'native'] } },
            required: ['key'], additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cu_scroll',
          description: 'Computer-use: scroll the page/window by a dx/dy delta (optionally from an element index or x/y point). Positive dy scrolls down; native: dy is wheel notches (3 is one normal scroll).',
          parameters: {
            type: 'object',
            properties: {
              dx: { type: 'integer' }, dy: { type: 'integer' },
              index: { type: 'integer' }, x: { type: 'integer' }, y: { type: 'integer' },
              backend: { type: 'string', enum: ['browser', 'native'] },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cu_screenshot',
          description: 'Computer-use: capture and stream a fresh screenshot of the current browser page, or with backend "native" the Windows desktop or ONE window. Returns the data URL.',
          parameters: {
            type: 'object',
            properties: {
              backend: { type: 'string', enum: ['browser', 'native'] },
              window: { type: 'string', description: 'native: capture just this window -- part of its title or its app name (e.g. "Notepad", "chrome"), the frontmost match. It is captured even when other windows cover it. Leave out window, hwnd and pid for the whole desktop.' },
              hwnd: { type: 'integer', description: 'native: a window handle from list, for one exact window.' },
              pid: { type: 'integer', description: 'native: a process id; captures its frontmost window.' },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cu_list',
          description: 'Computer-use: list current surfaces — browser: the open tabs; native: the open windows (title and app), front to back.',
          parameters: {
            type: 'object',
            properties: { backend: { type: 'string', enum: ['browser', 'native'] } },
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cu_focus',
          description: 'Computer-use (native): bring a window to the front.',
          parameters: {
            type: 'object',
            properties: { backend: { type: 'string', enum: ['native'] }, window: { type: 'string' } },
            required: ['window'], additionalProperties: false,
          },
        },
      },
    ],

    async run(name, args, ctx) {
      // Infer the surface from what was actually passed. A model asked to "open" a
      // local PNG sent { nativePath: "A:\\...\\preview.png" } with no backend; the
      // default was browser, which reads only `url`, so it failed with "needs a url"
      // for a request whose intent was obvious. A file that is not an executable is
      // something to VIEW, so it becomes a file:// URL; an .exe is something to run.
      if (name === 'cu_launch' && !args.url && args.nativePath) {
        const p = String(args.nativePath);
        if (/\.(exe|bat|cmd|lnk|msc)$/i.test(p)) {
          if (!args.backend) args = { ...args, backend: 'native' };
        } else if (args.backend !== 'native') {
          // Relative paths are relative to the project, like every other tool.
          const abs = require('path').resolve((ctx && ctx.workdir) || process.cwd(), p).replace(/\\/g, '/');
          args = { ...args, backend: 'browser', url: 'file:///' + abs.replace(/^\/+/, '') };
        }
      }
      // A path given as the url ("index.html", "dist\\app.html"): that file in the project,
      // when it is there. It went to the browser as-is and landed on about:blank, and the
      // agent then started a web server to show one static page. Found in a live run.
      if (name === 'cu_launch' && args.url && args.backend !== 'native' && !/^[a-z][\w+.-]*:(\/\/|[^\\/])/i.test(String(args.url))) {
        try {
          const abs = require('path').resolve((ctx && ctx.workdir) || process.cwd(), String(args.url));
          if (require('fs').statSync(abs).isFile()) args = { ...args, backend: 'browser', url: 'file:///' + abs.replace(/\\/g, '/').replace(/^\/+/, '') };
        } catch { /* not a file here: left as it was */ }
      }
      if (name === 'cu_launch') {
        // An empty data: URL loads a blank page and reported ok:true -- a success
        // for showing nothing.
        if (/^data:[^,]*,\s*$/i.test(String(args.url || ''))) {
          throw new Error('that data: URL is empty — there is nothing to show. To view a local file, pass its path as nativePath or a file:/// url.');
        }
        // Nothing to open at all. Checked before the backend is chosen, because the
        // default backend is sticky: after one native launch, an empty call went
        // native and tried to launch `undefined`.
        if (!args.url && !args.nativePath) {
          throw new Error('open needs something to open: a url (http(s):// or file:///), or nativePath — a file to view, or an .exe to launch.');
        }
      }
      // What the arguments say beats what the last call did. The surface used to be
      // purely sticky, so after one native launch a plain https:// url was sent to
      // the NATIVE backend and "launched" undefined.
      const sid = (ctx && ctx.session && ctx.session.id) || 'default';
      const backend = surfaceFor(sid, name, args);
      surfaces.set(sid, backend);
      // The Windows desktop: one named window, its controls by number (desktop.js, from Byte).
      const DESKTOP = { cu_state: desktop.state, cu_click: desktop.click, cu_type: desktop.type, cu_press: desktop.press,
        cu_scroll: desktop.scroll, cu_focus: desktop.focus, cu_list: desktop.list };
      if (backend === 'native' && DESKTOP[name]) {
        const r = await DESKTOP[name](args, ctx);
        if (r && r.screenshot) emitImage(ctx, r.screenshot, (r.window && r.window.title) || 'desktop');
        return r;
      }
      // Every browser action works on the preview the user is looking at, not only
      // after an `open`. A page the USER put in the preview, read with `state`,
      // started a separate hidden Chrome on about:blank instead: the agent reported
      // an empty page with the Tip Calculator plainly on screen. Found in a live run.
      if (backend === 'browser' && name !== 'cu_launch' && typeof attachAtlas === 'function') {
        let wc = null;
        try { wc = attachAtlas(); } catch { wc = null; }
        if (!wc) throw new Error('Nothing is open in the preview, so there is no page to ' + ({ cu_screenshot: 'capture', cu_state: 'read', cu_list: 'list' }[name] || 'act on')
          + '. Open one first with action "open" (a url, or a file path), or use backend "native" for the desktop.');
        if (!cdp.attachedTo(wc)) {
          const ar = await cdp.attach(wc);
          if (!ar.ok) throw new Error('could not attach computer-use to the preview: ' + (ar.error || 'unknown'));
        }
      }
      switch (name) {
        case 'cu_launch': {
          if (backend === 'native') {
            // Started, then the windows by name: not a picture of the whole desktop and every window's
            // handle and position, which is more than the next step needs (it reads the one window).
            const r = native.launch(args.nativePath, '');
            if (!r || !r.ok) return { backend, ok: false, error: (r && r.error) || 'Windows could not start it' };
            // Its own now: ending it later by this pid needs no one's say (tools/kills.js).
            if (r.pid) require('../tools/procs').claim(r.pid, ctx && ctx.session && ctx.session.id);
            await new Promise((res) => setTimeout(res, 1500));
            return { backend, ok: true, started: String(args.nativePath), ...(r.pid ? { pid: r.pid } : {}), windows: desktop.list().windows,
              next: 'state with backend "native" and window (its title) to work in it; it may take a moment to appear.' };
          }
          if (!args.url) throw new Error('open needs something to open: a url (http(s):// or file:///), '
            + 'or nativePath — a file to view, or an .exe to launch.');
          let wc = null;
          if (typeof attachAtlas === 'function') { try { wc = attachAtlas(); } catch { wc = null; } }
          if (wc) {
            // Drive the REAL in-app Atlas browser — this is Codex/Claude's model:
            // the automation acts on the very view the user is looking at.
            const ar = await cdp.attach(wc);
            if (!ar.ok) throw new Error('could not attach computer-use to Atlas: ' + (ar.error || 'unknown'));
            if (typeof showInApp === 'function') { try { showInApp(args.url); } catch {} }
            const st = await cdp.navigate(args.url);
            emitImage(ctx, st.screenshot, st.title || args.url);
            return { backend, ok: true, surface: 'atlas', title: st.title, url: st.url, elements: st.elements, text: (st.text || '').slice(0, 12000), screenshot: st.screenshot || null, elementCount: (st.elements || []).length };
          }
          const st = await cdp.launch(args.url, { headless: args.headless !== false });
          // no Atlas available (e.g. non-Electron) — still show in the page if possible
          if (typeof showInApp === 'function') { try { showInApp(args.url); } catch {} }
          emitImage(ctx, st.screenshot, st.title || args.url);
          return { backend, ok: true, surface: 'browser', title: st.title, url: st.url, elements: st.elements, text: (st.text || '').slice(0, 12000), screenshot: st.screenshot || null, elementCount: (st.elements || []).length };
        }
        case 'cu_state': {
          if (backend === 'native') {
            const w = native.listWindows();
            const win = (w.windows || []).find((x) => x.pid && x.w > 200 && x.h > 100);
            const a = win ? native.buildA11y(win.pid) : null;
            const elements = (a && a.elements) || [];
            // capture + stream screenshot (once: it was taken twice, for the thread and the model)
            const shot = native.screenshot(win ? { hwnd: win.hwnd } : 0).dataUrl || null;
            emitImage(ctx, shot, (a && a.title) || 'desktop');
            return {
              backend, surface: 'native',
              windows: w.windows,
              activePid: win ? win.pid : null,
              title: (a && a.title) || (win && (win.title || win.app)) || 'desktop',
              elements,
              elementCount: elements.length,
              screenshot: shot,
            };
          }
          const st = await cdp.getState(true);
          emitImage(ctx, st.screenshot, st.title || st.url);
          return { backend, surface: 'browser', title: st.title, url: st.url, elements: st.elements, text: (st.text || '').slice(0, 12000), screenshot: st.screenshot || null, elementCount: (st.elements || []).length, ...(st.note ? { note: st.note } : {}) };
        }
        case 'cu_click': {
          if (backend === 'native') {
            if (args.index != null) {
              // sky-style: click by a11y element index (invoke/focus+coordinate)
              const w = native.listWindows();
              const win = (w.windows || []).find((x) => x.pid && x.w > 200 && x.h > 100);
              if (!win) throw new Error('native: no target window');
              const r = native.clickElement(win.pid, args.index);
              emitImage(ctx, native.screenshot(win.pid).dataUrl, 'after click');
              return { backend, ok: !!r.ok, method: r.method, index: args.index, error: r.error };
            }
            const r = native.click(args.x, args.y); emitImage(ctx, native.screenshot(0).dataUrl, 'after click'); return { backend, ok: r.ok, x: args.x, y: args.y, error: r.error };
          }
          const r = await cdp.clickInput({ index: args.index, x: args.x, y: args.y });
          const st = await cdp.getState(true); emitImage(ctx, st.screenshot, st.title);
          return { backend, ok: r.ok, x: r.x, y: r.y, result: { title: st.title, text: (st.text || '').slice(0, 6000) } };
        }
        case 'cu_type': {
          if (backend === 'native') { const r = native.typeText(args.text); emitImage(ctx, native.screenshot(0).dataUrl, 'after type'); return { backend, ok: r.ok, error: r.error }; }
          const r = await cdp.typeInput(args.text); return { backend, ok: r.ok };
        }
        case 'cu_press': {
          if (backend === 'native') { const r = native.press(args.key); emitImage(ctx, native.screenshot(0).dataUrl, 'after key'); return { backend, ok: r.ok, error: r.error }; }
          const r = await cdp.pressInput(args.key); return { backend, ok: r.ok };
        }
        case 'cu_scroll': {
          if (backend === 'native') {
            const r = native.scroll(args.x != null ? args.x : -1, args.y != null ? args.y : -1, args.dy || args.dx || 0);
            emitImage(ctx, native.screenshot(0).dataUrl, 'after scroll'); return { backend, ok: r.ok, error: r.error };
          }
          const r = await cdp.scrollInput({ dx: args.dx, dy: args.dy, index: args.index, x: args.x, y: args.y });
          return { backend, ok: r.ok };
        }
        case 'cu_screenshot': {
          if (backend === 'native') {
            const one = !!(args.window || args.hwnd || args.pid);
            const s = await desktop.screenshot(args, ctx);
            if (!s.ok) return { backend, ok: false, screenshot: null, error: s.error };
            emitImage(ctx, s.dataUrl, one ? (s.title || s.app || 'window') : 'desktop');
            return {
              backend, ok: true, screenshot: s.dataUrl,
              ...(one ? { window: { title: s.title, app: s.app, hwnd: s.hwnd, pid: s.pid } } : {}),
              // Where the picture is on screen, so a point in it can be clicked.
              at: { x: s.x, y: s.y, w: s.w, h: s.h },
              coordinates: `Pixel (0,0) of this image is screen point (${s.x}, ${s.y}); add that to a point in the image to click it.`,
              ...(s.note ? { note: s.note } : {}),
            };
          }
          const d = await cdp.screenshot();
          emitImage(ctx, d, 'screen');
          // An empty capture is not a screenshot. Say so rather than returning
          // ok:false with no reason — the model needs to know the view is not
          // rendering, not just that "something failed".
          if (!d) {
            return {
              backend,
              ok: false,
              screenshot: null,
              error: 'screenshot came back empty — the browser view is not rendering (hidden, zero-sized, '
                + 'or not yet painted). Do not report the page as displayed on the strength of this.',
            };
          }
          return { backend, ok: true, screenshot: d };
        }
        case 'cu_list': {
          if (backend === 'native') return { backend, surface: 'native', windows: native.listWindows().windows };
          return { backend, surface: 'browser', tabs: await cdp.list() };
        }
        default:
          throw new Error('unknown computer-use tool: ' + name);
      }
    },
  };
}

module.exports = { makeComputerUseTool, surfaceFor, surfaceForAction, _surfaces: surfaces };
