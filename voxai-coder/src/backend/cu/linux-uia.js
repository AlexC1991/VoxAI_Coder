/**
 * linux-uia.js — the accessibility layer for Linux, filling uia.js's place.
 *
 * There is no UI Automation here, and no cheap equivalent: AT-SPI would mean a D-Bus
 * client and a per-app toolkit bridge, which is far more than this needs. What X does
 * expose is the widget tree, so elements come from `xwininfo -tree`: real, clickable
 * rectangles with coordinates, but often blank names.
 *
 * That matches how desktop.js uses it -- it treats `elements` as the things an index can
 * point at, and `texts` as extra text for the model -- so an unnamed element is still
 * clickable, which is the part that matters. The same surface as uia.js: `available`,
 * `list(hwnd, find, max, only, near)`, `act(id, action, text)`, `focused()`, `stop()`.
 */

const { spawnSync } = require('child_process');

function run(cmd, args, timeout = 15000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  if (r.error) return { ok: false, err: String(r.error.message || r.error) };
  return { ok: r.status === 0, out: String(r.stdout || ''), err: String(r.stderr || '').trim() };
}

const idOf = (hwnd) => (typeof hwnd === 'string' && /^0x/.test(hwnd))
  ? hwnd : '0x' + Number(hwnd).toString(16);

const TREE_RE = /^\s*(0x[0-9a-fA-F]+)\s+"?([^"]*)"?:\s+\(\s*([^)]*)\)\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/;

class UiaHelper {
    /** Same gate as win-input: is there enough here to bother? */
    get available() {
        try {
            if (process.platform !== 'linux' || !process.env.DISPLAY) return false;
            return run('sh', ['-c', 'command -v xwininfo >/dev/null 2>&1 && echo y'], 8000).out.trim() === 'y';
        } catch { return false; }
    }

    /**
     * The controls inside a window: [{index, type, name, x, y, w, h}] and any text seen.
     * `find` filters by name/type, `max` caps the list -- both as in uia.js.
     */
    async list(hwnd, find = '', max = 60, only = '', near = null) {
        const id = idOf(hwnd);
        const rect = this._windowRect(id);
        const r = run('xwininfo', ['-id', id, '-tree'], 15000);
        if (!r.ok) return { elements: [], texts: [] };

        const elements = [];
        const texts = [];
        for (const line of r.out.split('\n')) {
            const m = line.match(TREE_RE);
            if (!m) continue;
            // Skip the window itself and anything too small to aim at.
            if (m[1].toLowerCase() === id.toLowerCase()) continue;
            const w = parseInt(m[4], 10), h = parseInt(m[5], 10);
            if (w < 4 || h < 4) continue;

            const name = (m[2] || '').trim();
            const type = (m[3] || '').trim() || 'widget';
            if (find && !`${name} ${type}`.toLowerCase().includes(String(find).toLowerCase())) continue;

            const el = {
                index: elements.length,
                type,
                name,
                x: rect.x + parseInt(m[6], 10),
                y: rect.y + parseInt(m[7], 10),
                w, h,
                clickable: true,
            };
            // `near` is a hint in uia.js; keep the ones closest to that point first.
            if (near && Number.isFinite(near.x) && Number.isFinite(near.y)) {
                el._d = Math.hypot(el.x - near.x, el.y - near.y);
            }
            elements.push(el);
            if (name) texts.push(name);
            if (elements.length >= Math.max(1, Number(max) || 60)) break;
        }

        if (near && elements.length && elements[0]._d !== undefined) {
            elements.sort((a, b) => a._d - b._d);
        }
        for (const el of elements) delete el._d;
        // Re-number after any sort so index matches position in the list the model sees.
        elements.forEach((el, i) => { el.index = i; });

        return { elements, texts };
    }

    /** Click a control by its index, the one action uia.act() is used for. */
    async act(id, action, text = '') {
        const hwnd = Number(id);
        const r = await this.list(hwnd, '', 200);
        const el = (r.elements || [])[Number(action)];
        if (!el) return { ok: false, error: 'no control at that index' };
        const { spawnSync: sp } = require('child_process');
        const x = Math.round(el.x + el.w / 2), y = Math.round(el.y + el.h / 2);
        sp('xdotool', ['mousemove', '--sync', String(x), String(y)], { encoding: 'utf8', timeout: 15000 });
        const c = sp('xdotool', ['click', '1'], { encoding: 'utf8', timeout: 15000 });
        return c.status === 0 ? { ok: true } : { ok: false, error: String(c.stderr || '').trim() };
    }

    /** Which window has the keyboard now. */
    async focused() {
        const r = run('xdotool', ['getactivewindow'], 8000);
        if (!r.ok) return null;
        const hwnd = parseInt(r.out.trim(), 10);
        if (!hwnd) return null;
        const n = run('xdotool', ['getwindowname', String(hwnd)], 8000);
        // "Window" capitalised, matching uia.js's own type names ("Button", "Edit").
        // Lowercase would also read as an emitted event name to the renderer test's
        // `type: '<lowercase>'` scan, which flags unhandled UI events.
        return { type: 'Window', name: n.ok ? n.out.trim() : '', hwnd };
    }

    stop() { /* nothing persistent to stop: each call is one xdotool invocation */ }

    _windowRect(id) {
        const r = run('xdotool', ['getwindowgeometry', '--shell', id], 10000);
        if (!r.ok) return { x: 0, y: 0 };
        const g = {};
        for (const line of r.out.split('\n')) {
            const m = line.match(/^([A-Z]+)=(-?\d+)$/);
            if (m) g[m[1]] = parseInt(m[2], 10);
        }
        return { x: g.X || 0, y: g.Y || 0 };
    }
}

module.exports = { UiaHelper };
