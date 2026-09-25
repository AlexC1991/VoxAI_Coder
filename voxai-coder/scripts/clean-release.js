/**
 * Clear the previous build out of release/ before `npm run dist` (npm runs this as
 * `predist`).
 *
 * electron-builder only ever adds to its output folder, so every version left its
 * ~110 MB installer, portable exe and blockmap behind. Nothing needs them: installed
 * copies update from CodeRook, where each release keeps its own installer. Only what
 * the build makes is removed -- anything else in the folder is left alone.
 */
const fs = require('fs');
const path = require('path');

const OUT = process.env.VOX_RELEASE_OUT || path.join(__dirname, '..', 'release');
const BUILT = /\.(exe|blockmap)$|^(latest|builder-debug|builder-effective-config)\.ya?ml$|^update\.json$/i;
const DIRS = new Set(['win-unpacked', 'win-ia32-unpacked', 'win-arm64-unpacked']);

if (!fs.existsSync(OUT)) process.exit(0);
let freed = 0, n = 0;
for (const name of fs.readdirSync(OUT)) {
  const p = path.join(OUT, name);
  const st = fs.statSync(p);
  if (st.isDirectory() ? DIRS.has(name) : BUILT.test(name)) {
    if (!st.isDirectory()) freed += st.size;
    fs.rmSync(p, { recursive: true, force: true });
    n++;
  }
}
if (n) console.log(`cleared the previous build from release/ (${n} items, ${(freed / 1048576).toFixed(0)} MB)`);
