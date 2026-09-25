/**
 * Updates from CodeRook.
 *
 * Releases are published to the public project batty-251/voxai-coder-releases (the
 * code stays private in voxai-coder). CodeRook serves an electron-updater feed for
 * it -- latest.yml with each file's size and SHA-512 -- so electron-updater does the
 * checking, downloading and installing.
 *
 * On top of that, every release carries update.json: the version, installer name,
 * size and SHA-512, signed with an Ed25519 key that never leaves the release machine.
 * An update is downloaded only when that signature checks out against the public key
 * shipped in the app AND the manifest agrees with the feed. The feed's own checksum
 * only proves the download matches what the feed says; the signature proves the feed
 * says what we released.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OWNER = 'batty-251';
const PROJECT = 'voxai-coder-releases';
const FEED = `https://api.coderook.com/v1/public/projects/${OWNER}/${PROJECT}/updates`;
const APP = 'voxai-coder';
const FIRST_CHECK_MS = 15 * 1000;
// Each check is one small request (latest.yml). Every 4 hours meant a release made
// while the app was open went unseen for hours -- found in a live test.
const CHECK_EVERY_MS = 30 * 60 * 1000;
const FOCUS_MIN_GAP_MS = 10 * 60 * 1000;    // coming back to the window checks, at most this often
const RETRY_AFTER_ERROR_MS = 5 * 60 * 1000;  // offline, or a release still being published

/**
 * The exact text that is signed -- one field per line in a fixed order, the free-text
 * notes last so nothing in them can pose as another field.
 */
function manifestText(m) {
  return [APP, m.version, m.file, m.size, m.sha512, m.notes || ''].join('\n');
}

function signManifest(m, privateKeyPem) {
  return crypto.sign(null, Buffer.from(manifestText(m)), privateKeyPem).toString('base64');
}

function verifyManifest(m, publicKeyPem) {
  if (!m || typeof m.sig !== 'string' || m.app !== APP) return false;
  try { return crypto.verify(null, Buffer.from(manifestText(m)), publicKeyPem, Buffer.from(m.sig, 'base64')); }
  catch { return false; }
}

/**
 * The signed manifest and the feed must describe the same installer. Every .exe the
 * feed lists has to be the signed one, so the updater cannot be steered to another.
 */
function matchesFeed(m, info) {
  if (!m || !info || String(m.version) !== String(info.version)) return false;
  const exes = (info.files || []).filter((f) => /\.exe$/i.test(decodeURIComponent(String(f.url || ''))));
  if (!exes.length) return false;
  return exes.every((f) => decodeURIComponent(String(f.url)) === m.file && f.sha512 === m.sha512 && Number(f.size) === Number(m.size));
}

/** electron-updater's errors run to several lines of HTTP detail; say what happened. */
function plainError(e) {
  const s = String((e && e.message) || e || '');
  if (/\b404\b/.test(s)) return 'no release found on CodeRook';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|net::/i.test(s)) return 'CodeRook could not be reached';
  if (/sha512 checksum mismatch/i.test(s)) return 'the download did not match its checksum and was discarded';
  return s.split('\n')[0].slice(0, 160);
}

/**
 * A downloaded installer stays in the updater's pending folder after it has been
 * installed -- a second 110 MB copy beside the one the installer keeps for itself.
 * Once the app is running that version (or a later one), the download has done its job.
 */
function clearInstalledDownload(version, log = () => {}, root = process.env.LOCALAPPDATA) {
  // Judged by the installers themselves: the info file it used to read is not always
  // written, and without it nothing was cleared -- one install held 0.2.6 and 0.2.12,
  // 329 MB. Found in a live update. Every installer at or below the running version
  // goes; a newer one waiting to be installed stays.
  try {
    const dir = path.join(root || '', 'voxai-coder-updater', 'pending');
    if (!fs.existsSync(dir)) return false;
    const semver = require(require.resolve('semver', { paths: [path.dirname(require.resolve('electron-updater'))] }));
    let removed = 0, waiting = 0;
    for (const f of fs.readdirSync(dir)) {
      const v = (/(\d+\.\d+\.\d+)\.exe$/i.exec(f) || [])[1];
      if (!v) continue;
      if (semver.gt(v, version)) { waiting++; continue; }
      try { fs.rmSync(path.join(dir, f), { force: true }); removed++; log(`removed the installed ${v} download`); } catch {}
    }
    if (!waiting) fs.rmSync(dir, { recursive: true, force: true });   // nothing left worth keeping
    return removed > 0;
  } catch { return false; }   // unreadable: leave it
}

function publicKey() {
  // A test run may check against a key of its own; a real run only ever uses the shipped one.
  const p = (process.env.VOX_UPDATE_TEST && process.env.VOX_UPDATE_PUBKEY) || path.join(__dirname, '..', '..', 'resources', 'update-key.pem');
  return fs.readFileSync(p, 'utf8');
}

/**
 * Start checking. `send(state)` tells the window; the returned object answers the
 * window's questions. Does nothing in a dev run or the portable build (neither can
 * install), unless VOX_UPDATE_TEST is set -- then it checks, verifies and downloads,
 * as if it were VOX_UPDATE_TEST's version, and never installs.
 */
function initUpdater({ app, send, log = () => {} }) {
  const test = process.env.VOX_UPDATE_TEST || '';
  // Test runs may shorten the timers and point at another feed (to test going offline).
  const ms = (name, dflt) => (test && Number(process.env[name]) > 0 ? Number(process.env[name]) : dflt);
  const feed = (test && process.env.VOX_UPDATE_FEED) || FEED;
  const EVERY = ms('VOX_UPDATE_EVERY_MS', CHECK_EVERY_MS);
  const FOCUS_GAP = ms('VOX_UPDATE_FOCUS_MS', FOCUS_MIN_GAP_MS);
  const RETRY = ms('VOX_UPDATE_RETRY_MS', RETRY_AFTER_ERROR_MS);
  const portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  let st = { state: 'off', version: app.getVersion() };
  const set = (patch) => { st = { ...st, ...patch }; try { send(st); } catch {} };

  if ((!app.isPackaged || portable) && !test) {
    st.reason = portable ? 'The portable build does not update itself. Use the installer for updates.' : 'Updates run in the installed app.';
    return { state: () => st, check: async () => st, install: () => false, onFocus: () => {} };
  }

  if (!test) {
    clearInstalledDownload(app.getVersion(), log);
    // Straight after an update the installer that just ran can still hold its file,
    // so the first pass misses it; look again once it has certainly finished.
    setTimeout(() => clearInstalledDownload(app.getVersion(), log), 90 * 1000);
  }
  const { autoUpdater } = require('electron-updater');
  autoUpdater.setFeedURL({ provider: 'generic', url: feed });
  autoUpdater.autoDownload = false;          // only after the signature checks out
  autoUpdater.autoInstallOnAppQuit = !test;  // a downloaded update installs on the next quit
  autoUpdater.disableDifferentialDownload = true;  // the feed has no blockmaps
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  if (test) {
    autoUpdater.forceDevUpdateConfig = true;
    // A source run has no built-in app-update.yml, and the download reads its cache
    // folder's name from it. Give it one, with a cache folder of its own.
    try {
      const cfg = path.join(require('os').tmpdir(), 'voxai-coder-update-test.yml');
      fs.writeFileSync(cfg, `provider: generic\nurl: ${feed}\nupdaterCacheDirName: voxai-coder-updater-test\n`);
      autoUpdater.updateConfigPath = cfg;
    } catch (e) { log('test config not written: ' + e.message); }
    // The same semver electron-updater compares with.
    try {
      const semver = require(require.resolve('semver', { paths: [path.dirname(require.resolve('electron-updater'))] }));
      autoUpdater.currentVersion = semver.parse(test);
    } catch (e) { log('test version not applied: ' + e.message); }
    st.version = test;
  }
  st.state = 'idle';

  let pending = null;   // the verified manifest for the update being downloaded
  let retryTimer = null;
  // Counted from launch: the window appearing is a focus too, and the startup check
  // below already covers it -- otherwise every launch checked twice, 15s apart.
  let lastCheck = Date.now();
  const failed = (e, extra) => {
    set({ state: 'error', error: plainError(e), checkedAt: Date.now(), ...(extra || {}) });
    // Offline, or caught mid-release: try again soon rather than in half an hour.
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; check(); }, RETRY);
  };
  autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: '' }));
  autoUpdater.on('update-not-available', () => set({ state: 'current', checkedAt: Date.now() }));
  autoUpdater.on('update-available', async (info) => {
    try {
      // Never a cached copy: a manifest left over from the last release would read
      // as a mismatch the moment a new one appears.
      const res = await fetch(`${feed}/update.json?t=${Date.now()}`, { redirect: 'follow', cache: 'no-store' });
      if (!res.ok) throw new Error(`update.json: HTTP ${res.status}`);
      const m = await res.json();
      if (!verifyManifest(m, publicKey())) {
        set({ state: 'refused', next: info.version, checkedAt: Date.now(), error: 'This update is not signed with VoxAI Coder\'s release key, so it was not downloaded.' });
        return;
      }
      // Signed by us but describing another release: the feed and the manifest have
      // not caught up with each other yet. Not a forgery -- look again shortly.
      if (!matchesFeed(m, info)) { failed(new Error('the release is still being published'), { next: info.version }); return; }
      pending = m;
      set({ state: 'downloading', next: info.version, percent: 0, notes: m.notes || '' });
      await autoUpdater.downloadUpdate();
    } catch (e) {
      failed(e, { next: info && info.version });
    }
  });
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(Number(p.percent) || 0) }));
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', next: info.version, percent: 100, checkedAt: Date.now(), notes: (pending && pending.notes) || '' }));
  autoUpdater.on('error', (e) => { if (st.state !== 'error') failed(e); });

  const check = async () => {
    // Downloaded and waiting for a restart: checking again would only download it twice.
    if (st.state === 'ready' || st.state === 'downloading' || st.state === 'checking') return st;
    lastCheck = Date.now();
    try { await autoUpdater.checkForUpdates(); } catch (e) { if (st.state !== 'error') failed(e); }
    return st;
  };
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, EVERY);

  return {
    state: () => st,
    check,
    // Back at the window after a while: a release may have landed since.
    onFocus: () => { if (Date.now() - lastCheck >= FOCUS_GAP) check(); },
    install: () => {
      if (st.state !== 'ready' || test) return false;
      // Silent install, then start the new version.
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
      return true;
    },
  };
}

module.exports = { initUpdater, clearInstalledDownload, plainError, manifestText, signManifest, verifyManifest, matchesFeed, FEED, APP, OWNER, PROJECT };
