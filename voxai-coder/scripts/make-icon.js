/**
 * Renders the VoxAI Coder mark -- the gold prompt in a rounded square from the title
 * bar -- into resources/icon.png (256px) and resources/icon.ico (16-256px).
 *
 *   npx electron scripts/make-icon.js
 *
 * Run it with Electron so Chromium draws the SVG; no image libraries needed. An .ico
 * is a small header and directory followed by PNG images, so it is written by hand.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'resources');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// Same drawing as the title-bar mark (24-unit grid): a rounded square and a ">".
// On a dark tile so it reads on a light taskbar as well as a dark one. Small sizes
// get a heavier stroke, or the lines vanish at 16px.
function svg(size) {
  const sw = size <= 24 ? 2.4 : size <= 48 ? 2.1 : 1.8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
  <rect x="0.5" y="0.5" width="23" height="23" rx="5.5" fill="#0e0e10"/>
  <rect x="3.6" y="3.6" width="16.8" height="16.8" rx="3.4" fill="none" stroke="#c8a961" stroke-width="${sw}"/>
  <polyline points="8.6 8.8 11.8 12 8.6 15.2" fill="none" stroke="#c8a961" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

// One window for every size: a second window's data: URL load failed intermittently.
let win = null;
async function render(size) {
  if (!win) {
    win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
    await win.loadURL('about:blank');
  }
  await win.webContents.executeJavaScript(
    'document.body.style.margin = "0"; document.body.style.background = "transparent"; document.body.innerHTML = ' + JSON.stringify(svg(size)) + '; 1');
  await new Promise((r) => setTimeout(r, 200));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return img.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

function ico(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);      // 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, dir, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const pngs = [];
  for (const size of SIZES) pngs.push({ size, data: await render(size) });
  fs.writeFileSync(path.join(OUT, 'icon.png'), pngs[pngs.length - 1].data);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(pngs));
  if (win) win.destroy();
  console.log('wrote', SIZES.join(', '), 'px to', OUT);
  app.quit();
});
