/**
 * Publish the installer that `npm run dist` just built, so installed copies update.
 *
 *   npm run release -- --notes "What changed, in a sentence or two" [--dry-run]
 *
 * 1. Signs update.json (version, installer name, size, SHA-512, notes) with the
 *    release key made by `npm run release-key`.
 * 2. Saves the repository to the CodeRook project voxai-coder (with CHANGELOG.md),
 *    attaches the installer and update.json to that save, and names it v<version> with
 *    its downloads public: the installers and the update feed are served to anybody while
 *    the source keeps its own visibility. One project holds the code and ships the app.
 * 3. Reads the public update feed back to confirm installed copies can see it.
 *
 * --dry-run does step 1 and prints the rest.
 *
 * --bridge also publishes the release to voxai-coder-releases, the second project the
 * installers went to up to 0.2.85. Copies installed before the move still read that feed;
 * the first release on the new one is put there too so they update onto it, and from then
 * on they read the new one. Needed once (0.2.86), not for later releases.
 *
 *   npm run release -- --linux [--dry-run]
 *
 * Adds the Linux AppImage to the release already published for this version (from
 * Windows): signs it into update-linux.json and attaches both to that same release, so
 * one version carries both installers and each platform verifies its own manifest. It
 * reuses that release's notes and leaves the README alone. Run it after the Windows
 * release -- a version with only an AppImage would leave Windows copies waiting on an
 * .exe that never comes. The Linux side's steps are in LINUX-BUILD.md at the repository root.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync } = require('child_process');
const { signManifest, verifyManifest, FEED, PROJECT, OWNER } = require('../src/main/updater.js');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = flag('--dry-run');
const LINUX = flag('--linux');
const BRIDGE = flag('--bridge');
// The project the installers went to up to 0.2.85 (see --bridge).
const LEGACY_PROJECT = 'voxai-coder-releases';
const LEGACY_FEED = FEED.replace('/' + PROJECT + '/', '/' + LEGACY_PROJECT + '/');
// The repository root: the folder linked to the voxai-coder project.
const MAIN_DIR = path.join(ROOT, '..');
let notes = String(opt('--notes') || '').trim();
const RELEASES_DIR = process.env.VOX_RELEASES_DIR || path.join(ROOT, '..', '..', LEGACY_PROJECT);
const PRIV = process.env.VOX_RELEASE_KEY
  || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'voxai-coder-release', 'update-key.pem');

const die = (msg) => { console.error('release: ' + msg); process.exit(1); };

const version = pkg.version;
const file = LINUX ? `VoxAI-Coder-${version}.AppImage` : `VoxAI-Coder-Setup-${version}.exe`;
const feedYml = LINUX ? 'latest-linux.yml' : 'latest.yml';
const manifestName = LINUX ? 'update-linux.json' : 'update.json';
const installerPattern = LINUX ? /\.AppImage$/i : /\.exe$/i;

// cbx runs with node directly -- no shell, so the notes need no quoting.
function cbxEntry() {
  const root = execSync('npm root -g').toString().trim();
  const cpkg = JSON.parse(fs.readFileSync(path.join(root, '@coderook', 'cli', 'package.json'), 'utf8'));
  const bin = typeof cpkg.bin === 'string' ? cpkg.bin : (cpkg.bin.cbx || Object.values(cpkg.bin)[0]);
  return path.join(root, '@coderook', 'cli', bin);
}

// The Linux build joins the release Windows already made: find it, and take its notes.
let releaseNumber = null;
if (LINUX) {
  const out = execFileSync(process.execPath, [cbxEntry(), 'releases', PROJECT], { encoding: 'utf8' }).replace(/\x1b\[[0-9;]*m/g, '');
  const lines = out.split(/\r?\n/);
  const i = lines.findIndex((l) => new RegExp(`^\\s*v(\\d+)\\s+v?${version.replace(/\./g, '\\.')}\\s`).test(l));
  if (i < 0) die(`no release named v${version} on ${PROJECT}; publish the Windows release first`);
  releaseNumber = /^\s*v(\d+)/.exec(lines[i])[1];
  if (!notes) notes = String(lines[i + 1] || '').trim();
}
if (!notes) die('say what changed: npm run release -- --notes "..."');
if (notes.length > 600) die('keep --notes under 600 characters (' + notes.length + ')');

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
  const yml = path.join(ROOT, 'release', feedYml);
  if (!fs.existsSync(yml)) die(`release/${feedYml} is missing, so the build did not finish; run npm run dist again`);
  const t = fs.readFileSync(yml, 'utf8');
  const ySize = Number((/^\s*size:\s*(\d+)/m.exec(t) || [])[1]);
  const ySha = ((/^sha512:\s*'?([^'\n]+)'?/m.exec(t) || [])[1] || '').trim();
  const sha = crypto.createHash('sha512').update(bytes).digest('base64');
  if (ySize !== bytes.length || ySha !== sha) die(`the installer (${bytes.length} bytes) does not match what the build recorded in ${feedYml} (${ySize} bytes); run npm run dist again`);
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
const manifestPath = path.join(ROOT, 'release', manifestName);
fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
console.log(`signed ${file} (${(m.size / 1048576).toFixed(1)} MB) as ${version}`);

if (LINUX) {
  // The installer script people download (scripts/linux-sh.js) must name THIS AppImage: one
  // left over from another build would download a file whose checksum it does not know.
  const sh = path.join(ROOT, 'release', `VoxAI-Coder-${version}-Linux.sh`);
  if (!fs.existsSync(sh)) die(`${sh} is missing; npm run dist:linux makes it (or node scripts/linux-sh.js)`);
  const shSha = (/^SHA512='([0-9a-f]{128})'$/m.exec(fs.readFileSync(sh, 'utf8')) || [])[1];
  if (shSha !== crypto.createHash('sha512').update(bytes).digest('hex')) die(`${path.basename(sh)} was made for a different AppImage; run node scripts/linux-sh.js again`);
  // Attach the AppImage first and its manifest last: until update-linux.json lands, Linux
  // copies see a feed they cannot verify and wait, rather than take an unsigned file. The
  // installer script goes on after the AppImage it downloads.
  const steps = [
    ['attach', installer, releaseNumber, '--project', PROJECT],
    ['attach', sh, releaseNumber, '--project', PROJECT],
    ['attach', manifestPath, releaseNumber, '--project', PROJECT],
  ];
  if (DRY) {
    console.log(`dry run -- would add to release v${releaseNumber} (v${version}):`);
    for (const s of steps) console.log('  cbx ' + s.join(' '));
    process.exit(0);
  }
  const linuxEntry = cbxEntry();
  for (const s of steps) {
    console.log('> cbx attach ' + path.basename(s[1]));
    for (let t = 1; ; t++) {
      try { execFileSync(process.execPath, [linuxEntry, ...s], { stdio: 'inherit' }); break; }
      catch (e) { if (t >= 3) throw e; console.log(`  that failed; trying again (${t + 1} of 3)`); }
    }
  }
}

// ---- 2. the release, on the project that holds the code
// Every cbx call runs with node directly. An attach is safe to repeat and the 110 MB
// installer upload has timed out part-way (0.2.53, 0.2.54), so it gets two more tries;
// a save and a naming run once.
const entry = DRY ? '' : cbxEntry();
function cbxRun(args, cwd) {
  console.log('> cbx ' + args.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ').slice(0, 160));
  const tries = args[0] === 'attach' ? 3 : 1;
  for (let t = 1; ; t++) {
    try { return execFileSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }); }
    catch (e) {
      if (t >= tries) throw e;
      console.log(`  that failed; trying again (${t + 1} of ${tries})`);
    }
  }
}
const say = (out) => { const t = String(out || '').replace(/\x1b\[[0-9;]*m/g, '').trim(); if (t) console.log(t.split(/\r?\n/).slice(-3).map((l) => '  ' + l).join('\n')); };

const title = `${version}: ${notes}`.slice(0, 240);
if (!LINUX) {
  // The changelog travels with the code; each release's notes also go on the release.
  const logPath = path.join(MAIN_DIR, 'CHANGELOG.md');
  const prev = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').replace(/^# Changes\s*/, '') : '';
  const log = prev.includes(`## ${version} `) ? null
    : `# Changes\n\n## ${version} (${m.releasedAt.slice(0, 10)})\n\n${notes}\n\n${prev}`.replace(/\n{3,}/g, '\n\n');
  // Attach first, name last: a download on a save nobody can see stays hidden until the save
  // is named, so the feed switches to the new release with its installer and signed manifest
  // already in place. Named first, the feed briefly offered a release without its files.
  if (DRY) {
    console.log(`dry run -- would ${log ? 'add ' + version + ' to CHANGELOG.md and ' : ''}run in ${MAIN_DIR}:`);
    console.log(`  cbx submit -m ${JSON.stringify(title)}`);
    console.log(`  cbx attach ${file} <that save> --project ${PROJECT}`);
    console.log(`  cbx attach ${manifestName} <that save> --project ${PROJECT}`);
    console.log(`  cbx release v${version} --version <that save> --notes ... --downloads public`);
  } else {
    if (log) fs.writeFileSync(logPath, log);
    say(cbxRun(['submit', '-m', title], MAIN_DIR));
    const newest = cbxRun(['versions', '--limit', '1'], MAIN_DIR).replace(/\x1b\[[0-9;]*m/g, '');
    const n = (/^\s*v(\d+)\s/m.exec(newest) || [])[1];
    if (!n) die('could not tell which save was just made:\n' + newest);
    say(cbxRun(['attach', installer, n, '--project', PROJECT], MAIN_DIR));
    say(cbxRun(['attach', manifestPath, n, '--project', PROJECT], MAIN_DIR));
    say(cbxRun(['release', `v${version}`, '--version', n, '--notes', notes, '--downloads', 'public'], MAIN_DIR));
  }
}

// ---- 2b. the old releases project, once (--bridge)
if (BRIDGE && !LINUX) {
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
  const home = `https://coderook.com/${OWNER}/${PROJECT}`;
  const dl = `${FEED}/${encodeURIComponent(file)}`;
  fs.writeFileSync(path.join(RELEASES_DIR, 'README.md'), `# VoxAI Coder releases have moved

From ${version}, VoxAI Coder is released from its main project: ${home}

**[Download VoxAI Coder ${version} for Windows](${dl})**

Copies installed from here update by themselves: ${version} is published here as well, and
from it on they check the main project.

Linux, building from source and help: https://github.com/AlexC1991/VoxAI_Coder
`);
  const steps = [
    ['submit', '--name', LEGACY_PROJECT, '-m', title],
    ['attach', installer],
    ['attach', manifestPath],
    ['release', `v${version}`, '--notes', notes],
  ];
  if (DRY) {
    console.log(`dry run -- and, for copies still on the old feed, in ${RELEASES_DIR}:`);
    for (const st of steps) console.log('  cbx ' + st.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ').slice(0, 160));
  } else {
    for (const st of steps) say(cbxRun(st, RELEASES_DIR));
  }
}
if (DRY) process.exit(0);

// ---- 3. what installed copies will see
// Read the feed back the way an installed copy does -- anonymously, uncached -- and run
// the same checks it runs. Anything short of all of them is a failed release. Adding the
// Linux build also re-checks the Windows feed, which now lists the AppImage too.
const FEEDS = [
  { yml: 'latest.yml', manifest: 'update.json', installer: /\.exe$/i },
  { yml: 'latest-linux.yml', manifest: 'update-linux.json', installer: /\.AppImage$/i },
].filter((f) => (LINUX ? true : f.yml === feedYml));
(async () => {
  const { matchesFeed } = require('../src/main/updater.js');
  const pub = fs.readFileSync(path.join(ROOT, 'resources', 'update-key.pem'), 'utf8');
  try {
    for (const [base, proj] of [[FEED, PROJECT], ...(BRIDGE && !LINUX ? [[LEGACY_FEED, LEGACY_PROJECT]] : [])])
    for (const f of FEEDS) {
      const res = await fetch(`${base}/${f.yml}?t=${Date.now()}`, { cache: 'no-store' });
      const text = await res.text();
      if (res.status === 404) die(`${proj}'s feed answers 404. Updaters have no account: the project has to be public (cbx visibility public), with the release's downloads public (cbx release --downloads public). The source can stay private.`);
      const files = [...text.matchAll(/- url: '?([^'\n]+?)'?\s+sha512: '?([^'\n]+?)'?\s+size: (\d+)/g)].map((x) => ({ url: x[1], sha512: x[2], size: Number(x[3]) }));
      const fv = (/^version: '?([^'\n]+?)'?$/m.exec(text) || [])[1];
      const mres = await fetch(`${base}/${f.manifest}?t=${Date.now()}`, { cache: 'no-store', redirect: 'follow' });
      const pm = await mres.json();
      const ok = {
        version: fv === version,
        signature: verifyManifest(pm, pub),
        matches: matchesFeed(pm, { version: fv, files }, f.installer),
      };
      // The installer just signed is this platform's; the other one was checked when it shipped.
      if (f.installer.test(file)) ok.installer = pm.sha512 === m.sha512 && pm.size === m.size;
      const bad = Object.keys(ok).filter((k) => !ok[k]);
      if (bad.length) die(`${proj} ${f.yml} does not check out (${bad.join(', ')}): installed copies would not take this release`);
      console.log(`${proj} ${f.yml} offers ${version}: signature, manifest and installer all check out.`);
    }
  } catch (e) { die('could not read the feed back: ' + e.message); }
})();
