/**
 * browser — drive a hidden Electron BrowserWindow (real web control) from the
 * agent. browser_open loads a URL and returns page text+title; browser_act runs
 * a JS action (click selector / type text / scroll); browser_screenshot saves a
 * PNG to the workdir. Falls back gracefully when not running under Electron
 * (returns an actionable error so the model can use web_fetch instead).
 */
const fs = require('fs');
const path = require('path');

function electronAvailable() {
  if (!process.versions || !process.versions.electron) return false; // real Electron runtime only
  try {
    const { BrowserWindow } = require('electron');
    return typeof BrowserWindow === 'function';
  } catch { return false; }
}

function makeBrowserTool({ resolveIn, checkPermission, workdir }) {
  let winRef = null;

  async function getWin() {
    if (winRef && !winRef.isDestroyed()) return winRef;
    const { BrowserWindow } = require('electron');
    winRef = new BrowserWindow({
      width: 1280, height: 800, show: false,
      webPreferences: { offscreen: false, contextIsolation: true, nodeIntegration: false },
    });
    return winRef;
  }

  return {
    defs: [
      {
        type: 'function',
        function: {
          name: 'browser_open',
          description: 'Open a hidden browser window to a page and return its title + visible text (truncated). Requires Electron.',
          parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser_act',
          description: 'Run an action in the open page: click(selector), type(selector,text), scroll(y). Electron only.',
          parameters: {
            type: 'object',
            properties: { action: { type: 'string', enum: ['click', 'type', 'scroll'] }, selector: { type: 'string' }, text: { type: 'string' }, y: { type: 'number' } },
            required: ['action'], additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'browser_screenshot',
          description: 'Capture the open page to a PNG under .voxai/shots/<name>.png and return the path. Electron only.',
          parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
        },
      },
    ],
    async run(name, args, ctx) {
      if (!electronAvailable()) return { ok: false, error: 'browser tools require the Electron app runtime — use web_fetch instead' };
      const { BrowserWindow } = require('electron');
      const w = await getWin();
      if (name === 'browser_open') {
        const url = String(args.url || '');
        if (!/^(https?|file):\/\//i.test(url)) return { ok: false, error: 'browser_open needs an http(s):// or file:// URL' };
        await checkPermission('web-fetch', url);
        await w.loadURL(url);
        const res = await w.webContents.executeJavaScript(`({ title: document.title, text: (document.body && document.body.innerText || '').slice(0, 24000) })`);
        return { ok: true, url, title: res.title, text: res.text };
      }
      if (name === 'browser_act') {
        const a = args.action;
        if (a === 'click' && args.selector) {
          const ok = await w.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (!el) return false; el.click(); return true; })()`);
          return { ok, action: a, selector: args.selector };
        }
        if (a === 'type' && args.selector && args.text != null) {
          const ok = await w.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (!el) return false; el.focus(); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(el, ${JSON.stringify(String(args.text))}); el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
          return { ok, action: a, selector: args.selector };
        }
        if (a === 'scroll') {
          const y = Number(args.y || 0);
          await w.webContents.executeJavaScript(`window.scrollTo(0, ${y});`);
          return { ok: true, action: a, y };
        }
        return { ok: false, error: 'browser_act bad args' };
      }
      if (name === 'browser_screenshot') {
        const shotName = (String(args.name || 'shot').replace(/[^\w.-]/g, '_') + '.png');
        const dir = path.join(ctx.workdir, '.voxai', 'shots');
        fs.mkdirSync(dir, { recursive: true });
        const img = await w.webContents.capturePage();
        const file = path.join(dir, shotName);
        const png = img.toPNG();
        fs.writeFileSync(file, png);
        // capturePage() on a view that is hidden, zero-sized, or still painting
        // returns an EMPTY image. Writing that and reporting ok:true told the model
        // it had a screenshot of the page; it then assured the user the page was
        // "confirmed showing" on the strength of a 0-byte file. A capture tool that
        // cannot prove it captured anything must say so.
        const bytes = png.length;
        if (!bytes) {
          return {
            ok: false,
            error: 'screenshot captured 0 bytes — the view is not rendering (hidden, zero-sized, or not yet painted). '
              + 'Do not treat this as proof the page is displayed.',
            path: path.relative(ctx.workdir, file).replace(/\\/g, '/'),
            bytes: 0,
          };
        }
        return { ok: true, path: path.relative(ctx.workdir, file).replace(/\\/g, '/'), bytes };
      }
      throw new Error('unknown browser tool');
    },
  };
}

module.exports = { makeBrowserTool, electronAvailable };