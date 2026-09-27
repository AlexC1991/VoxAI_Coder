/**
 * Publish the installer that `npm run dist` just built, so installed copies update.
 *
 *   npm run release -- --notes "What changed, in a sentence or two" [--dry-run]
 *
 * 1. Signs update.json (version, installer name, size, SHA-512, notes) with the
 *    release key made by `npm run release-key`.
 * 2. Saves a version to the public CodeRook project voxai-coder-releases (README and
 *    CHANGELOG only -- the code stays in the private voxai-coder project), names it
 *    v<version>, and attaches the installer and update.json to it.
 * 3. Reads the public update feed back to confirm installed copies can see it.
 *
 * --dry-run does step 1 and prints the rest.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync } = require('child_process');
const { signManifest, verifyManifest, FEED, PROJECT } = require('../src/main/updater.js');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = flag('--dry-run');
const notes = String(opt('--notes') || '').trim();
const RELEASES_DIR = process.env.VOX_RELEASES_DIR || path.join(ROOT, '..', '..', PROJECT);
const PRIV = process.env.VOX_RELEASE_KEY
  || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'voxai-coder-release', 'update-key.pem');

const die = (msg) => { console.error('release: ' + msg); process.exit(1); };
if (!notes) die('say what changed: npm run release -- --notes "..."');
if (notes.length > 600) die('keep --notes under 600 characters (' + notes.length + ')');

const version = pkg.version;
const file = `VoxAI-Coder-Setup-${version}.exe`;
const installer = path.join(ROOT, 'release', file);
if (!fs.existsSync(installer)) die(`${installer} is missing; run npm run dist first`);
if (fs.statSync(installer).mtimeMs < fs.statSync(path.join(ROOT, 'package.json')).mtimeMs) die('the installer is older than package.json; run npm run dist again');
if (!fs.existsSync(PRIV)) die(`no release key at ${PRIV}; run npm run release-key once`);

// ---- 1. the signed manifest
const bytes = fs.readFileSync(installer);
// Only a finished build. 0.2.27 went out as a 172 KB installer: the build had stopped
// part-way through NSIS, and signing it made the feed "check out" against the broken
// file. electron-builder writes latest.yml last, with the installer's size and hash, so
// a build that did not finish has none -- or one that does not match.
{
  const yml = path.join(ROOT, 'release', 'latest.yml');
  if (!fs.existsSync(yml)) die('release/latest.yml is missing, so the build did not finish; run npm run dist again');
  const t = fs.readFileSync(yml, 'utf8');
  const ySize = Number((/^\s*size:\s*(\d+)/m.exec(t) || [])[1]);
  const ySha = ((/^sha512:\s*'?([^'\n]+)'?/m.exec(t) || [])[1] || '').trim();
  const sha = crypto.createHash('sha512').update(bytes).digest('base64');
  if (ySize !== bytes.length || ySha !== sha) die(`the installer (${bytes.length} bytes) does not match what the build recorded in latest.yml (${ySize} bytes); run npm run dist again`);
  if (bytes.length < 20 * 1024 * 1024) die(`the installer is only ${bytes.length} bytes, far too small to be the app; run npm run dist again`);
}
const m = {
  app: 'voxai-coder', version, file, size: bytes.length,
  sha512: crypto.createHash('sha512').update(bytes).digest('base64'),
  notes, releasedAt: new Date().toISOString(),
};
m.sig = signManifest(m, fs.readFileSync(PRIV, 'utf8'));
// The app checks with the public key it ships; check with that same one here, so a
// key mix-up fails now instead of on every installed copy.
if (!verifyManifest(m, fs.readFileSync(path.join(ROOT, 'resources', 'update-key.pem'), 'utf8'))) {
  die('the signature does not verify with resources/update-key.pem: the key pair does not match');
}
const manifestPath = path.join(ROOT, 'release', 'update.json');
fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
console.log(`signed ${file} (${(m.size / 1048576).toFixed(1)} MB) as ${version}`);

// ---- 2. the public releases project
fs.mkdirSync(RELEASES_DIR, { recursive: true });
// The project page has no releases list, so the installer is linked from here: its public
// address, which needs no sign-in (checked on a fresh download). The name alone left a
// visitor on another PC with nothing to click.
const dl = `${FEED}/${encodeURIComponent(file)}`;
const mb = (fs.statSync(installer).size / 1048576).toFixed(0);
const readme = `# VoxAI Coder

Releases of VoxAI Coder, a desktop coding agent for Windows.

**[Download VoxAI Coder ${version} for Windows](${dl})** (${file}, ${mb} MB) and run it.
After that the app keeps itself up to date: it checks here, downloads new versions in
the background and offers to restart when one is ready.

Direct link: ${dl}

Every release carries \`update.json\`, signed with the project's release key. The app
installs only updates whose signature and checksum match.

The source code is not published here.
`;
fs.writeFileSync(path.join(RELEASES_DIR, 'README.md'), readme);
const logPath = path.join(RELEASES_DIR, 'CHANGELOG.md');
const prev = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').replace(/^# Changes\s*/, '') : '';
if (!prev.includes(`## ${version} `)) {
  fs.writeFileSync(logPath, `# Changes\n\n## ${version} (${m.releasedAt.slice(0, 10)})\n\n${notes}\n\n${prev}`.replace(/\n{3,}/g, '\n\n'));
}

// cbx runs with node directly -- no shell, so the notes need no quoting.
function cbxEntry() {
  const root = execSync('npm root -g').toString().trim();
  const cpkg = JSON.parse(fs.readFileSync(path.join(root, '@coderook', 'cli', 'package.json'), 'utf8'));
  const bin = typeof cpkg.bin === 'string' ? cpkg.bin : (cpkg.bin.cbx || Object.values(cpkg.bin)[0]);
  return path.join(root, '@coderook', 'cli', bin);
}
// Attach first, name last. A download on a save nobody can see stays hidden until
// the save is named, so the feed switches to the new release with its installer and
// its signed manifest already in place. Named first, the feed briefly offered a
// release whose files were not there yet.
const steps = [
  ['submit', '--name', PROJECT, '-m', `${version}: ${notes}`.slice(0, 240)],
  ['attach', installer],
  ['attach', manifestPath],
  ['release', `v${version}`, '--notes', notes],
];
if (DRY) {
  console.log(`dry run -- would run in ${RELEASES_DIR}:`);
  for (const s of steps) console.log('  cbx ' + s.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '));
  process.exit(0);
}
const entry = cbxEntry();
for (const s of steps) {
  console.log('> cbx ' + s[0] + ' ' + (s[1] || ''));
  // The 110 MB installer upload timed out part-way twice running (0.2.53, 0.2.54), after
  // the save had gone through, and the release had to be finished by hand. An attach is
  // safe to repeat, so it gets two more tries; the save and the naming run once.
  const tries = s[0] === 'attach' ? 3 : 1;
  for (let t = 1; ; t++) {
    try { execFileSync(process.execPath, [entry, ...s], { cwd: RELEASES_DIR, stdio: 'inherit' }); break; }
    catch (e) {
      if (t >= tries) throw e;
      console.log(`  that failed; trying again (${t + 1} of ${tries})`);
    }
  }
}

// ---- 3. what installed copies will see
// Read the feed back the way an installed copy does -- anonymously, uncached -- and run
// the same checks it runs. Anything short of all of them is a failed release.
(async () => {
  const { matchesFeed } = require('../src/main/updater.js');
  try {
    const res = await fetch(`${FEED}/latest.yml?t=${Date.now()}`, { cache: 'no-store' });
    const text = await res.text();
    if (res.status === 404) die(`the feed answers 404: ${PROJECT} is private. Make it public on coderook.com.`);
    const files = [...text.matchAll(/- url: '?([^'\n]+?)'?\s+sha512: '?([^'\n]+?)'?\s+size: (\d+)/g)].map((x) => ({ url: x[1], sha512: x[2], size: Number(x[3]) }));
    const fv = (/^version: '?([^'\n]+?)'?$/m.exec(text) || [])[1];
    const mres = await fetch(`${FEED}/update.json?t=${Date.now()}`, { cache: 'no-store', redirect: 'follow' });
    const pm = await mres.json();
    const ok = {
      version: fv === version,
      signature: verifyManifest(pm, fs.readFileSync(path.join(ROOT, 'resources', 'update-key.pem'), 'utf8')),
      matches: matchesFeed(pm, { version: fv, files }),
      installer: pm.sha512 === m.sha512 && pm.size === m.size,
    };
    const bad = Object.keys(ok).filter((k) => !ok[k]);
    if (bad.length) die(`the feed does not check out (${bad.join(', ')}): installed copies would not take this release`);
    console.log(`\nThe feed offers ${version}: signature, manifest and installer all check out.`);
  } catch (e) { die('could not read the feed back: ' + e.message); }
})();
