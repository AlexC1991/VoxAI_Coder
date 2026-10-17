'use strict';
/**
 * Models from Hugging Face, for Settings > Local models.
 *
 * Search its public catalogue for GGUF builds, list a model's files (one per quantisation,
 * split models as one), and download one into the models folder. Every part is checked
 * against the SHA-256 Hugging Face publishes for it (its LFS oid), the way the engine is
 * checked against llama.cpp's; a file without one is not downloaded. A download stopped
 * part-way keeps its ".part" file and picks up where it left off next time.
 *
 * Public models need no account. A gated one (a licence to accept on the site) is refused by
 * Hugging Face, and that is said in words.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// VOX_HF_BASE: the tests point this at a local server.
const HF = process.env.VOX_HF_BASE || 'https://huggingface.co';
const REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
const SPLIT = /-(\d{5})-of-(\d{5})\.gguf$/i;
const QUANT = /(?:^|[._-])(i?q\d(?:_[a-z0-9]+)*|fp?16|bf16|fp?32)(?=[._-]|$)/i;

/** "qwen2.5-coder-7b-instruct-q4_k_m.gguf" -> "Q4_K_M". */
function quantOf(file) {
  const base = path.posix.basename(String(file)).replace(SPLIT, '.gguf').replace(/\.gguf$/i, '');
  const m = QUANT.exec(base);
  return m ? m[1].toUpperCase() : '';
}

async function getJson(url, signal) {
  const r = await fetch(url, { signal, headers: { Accept: 'application/json', 'User-Agent': 'voxai-coder' } });
  if (r.status === 401 || r.status === 403) throw new Error('Hugging Face needs you to sign in and accept this model’s licence on its site first.');
  if (!r.ok) throw new Error('Hugging Face answered ' + r.status + '.');
  return r.json();
}

/** GGUF models matching `query`, most downloaded first. */
async function search(query, { limit = 30 } = {}) {
  const q = String(query || '').trim().slice(0, 100);
  const url = `${HF}/api/models?filter=gguf&sort=downloads&direction=-1&limit=${limit}` + (q ? '&search=' + encodeURIComponent(q) : '');
  const list = await getJson(url);
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && REPO.test(String(m.id || '')) && !m.private)
    .map((m) => {
      const lic = (m.tags || []).find((t) => /^license:/.test(t));
      return { id: m.id, downloads: Number(m.downloads) || 0, likes: Number(m.likes) || 0, updated: m.lastModified || m.createdAt || '', license: lic ? lic.slice(8) : '' };
    });
}

/** A model's GGUF files, smallest first: { key, name, quant, size, parts: [{ path, size, sha256 }] }. */
async function files(repo) {
  if (!REPO.test(String(repo || ''))) throw new Error('That is not a Hugging Face model name (owner/name).');
  const tree = await getJson(`${HF}/api/models/${repo}/tree/main?recursive=true`);
  const groups = new Map(), whole = new Set();
  for (const f of Array.isArray(tree) ? tree : []) {
    if (!f || f.type !== 'file' || !/\.gguf$/i.test(f.path) || /mmproj/i.test(f.path)) continue;
    const key = f.path.replace(SPLIT, '.gguf');
    if (!SPLIT.test(f.path)) whole.add(key);
    // A split set is its own entry: some publish the same model whole and in parts (Qwen does),
    // and the two were added together into one file twice the size.
    const gk = SPLIT.test(f.path) ? key + '#parts' : key;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push({ path: f.path, size: Number((f.lfs && f.lfs.size) || f.size) || 0, sha256: String((f.lfs && f.lfs.oid) || '') });
  }
  // Offered whole and in parts: the whole file, one download instead of several.
  for (const gk of [...groups.keys()]) if (gk.endsWith('#parts') && whole.has(gk.slice(0, -6))) groups.delete(gk);
  return [...groups.entries()].map(([gk, parts]) => {
    const key = gk.replace(/#parts$/, '');
    parts.sort((a, b) => a.path.localeCompare(b.path));
    return { key, name: path.posix.basename(parts[0].path), quant: quantOf(key), size: parts.reduce((n, p) => n + p.size, 0), parts };
  }).sort((a, b) => a.size - b.size);
}

/**
 * One download at a time. State goes out through onState:
 * { repo, key, name, total, got, state: downloading|verifying|done|error|cancelled, error }.
 */
function createDownloader({ onState = () => {}, onDone = () => {} } = {}) {
  let job = null, lastEmit = 0;
  const view = () => (job ? { repo: job.repo, key: job.key, name: job.name, total: job.total, got: job.got, state: job.state, error: job.error } : null);
  const emit = (force) => {
    const now = Date.now();
    if (!force && now - lastEmit < 250) return;
    lastEmit = now;
    try { onState(view()); } catch {}
  };

  async function start({ repo, key, dir }) {
    if (job && (job.state === 'downloading' || job.state === 'verifying')) throw new Error('A model is already downloading. Wait for it, or cancel it.');
    if (!dir || !fs.existsSync(dir)) throw new Error('Choose the folder your models go in first.');
    const g = (await files(repo)).find((x) => x.key === key);
    if (!g) throw new Error('That file is no longer on Hugging Face.');
    if (!g.parts.every((p) => /^[0-9a-f]{64}$/i.test(p.sha256))) throw new Error('Hugging Face lists no checksum for this file, so it was not downloaded.');
    try {
      const sf = fs.statfsSync(dir);
      const free = Number(sf.bavail) * Number(sf.bsize);
      if (free < g.size * 1.02 + 200 * 1048576) throw new Error(`Not enough space in ${dir}: it needs ${gb(g.size)} and ${gb(free)} is free.`);
    } catch (e) { if (/Not enough space/.test(e.message)) throw e; }
    job = { repo, key: g.key, name: g.name, total: g.size, got: 0, state: 'downloading', error: '', ac: new AbortController(), dir };
    emit(true);
    run(job, g);
    return view();
  }

  async function run(j, g) {
    try {
      let done = 0;
      for (const p of g.parts) {
        const dest = path.join(j.dir, path.posix.basename(p.path));
        // Already here and the right size: a finished earlier download.
        try { if (fs.statSync(dest).size === p.size) { done += p.size; j.got = done; emit(); continue; } } catch {}
        const part = dest + '.part';
        let hash = crypto.createHash('sha256'), have = 0;
        // Picking up a stopped download: what is there is hashed first.
        try {
          if (fs.statSync(part).size <= p.size) { for await (const c of fs.createReadStream(part)) { hash.update(c); have += c.length; } }
          else fs.rmSync(part, { force: true });
        } catch { /* no part yet */ }
        const url = `${HF}/${j.repo}/resolve/main/${p.path.split('/').map(encodeURIComponent).join('/')}`;
        const res = await fetch(url, { signal: j.ac.signal, redirect: 'follow', headers: { 'User-Agent': 'voxai-coder', ...(have ? { Range: `bytes=${have}-` } : {}) } });
        if (res.status === 401 || res.status === 403) throw new Error('Hugging Face needs you to sign in and accept this model’s licence on its site first.');
        if (!res.ok || !res.body) throw new Error('The download failed (Hugging Face answered ' + res.status + ').');
        // The server ignored the range: start that part again.
        if (have && res.status !== 206) { hash = crypto.createHash('sha256'); have = 0; }
        const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
        try {
          for await (const chunk of res.body) {
            hash.update(chunk);
            if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
            have += chunk.length;
            j.got = done + have;
            emit();
          }
        } finally { await new Promise((r) => out.end(r)); }
        if (have !== p.size) throw new Error('The download stopped early. Download it again to pick up where it left off.');
        j.state = 'verifying'; emit(true);
        if (hash.digest('hex') !== p.sha256.toLowerCase()) {
          try { fs.rmSync(part, { force: true }); } catch {}
          throw new Error('The file did not match the checksum Hugging Face publishes, so it was removed. Try again.');
        }
        fs.renameSync(part, dest);
        done += p.size;
        j.state = 'downloading';
      }
      j.got = j.total; j.state = 'done'; emit(true);
      try { onDone(view()); } catch {}
    } catch (e) {
      if (j.ac.signal.aborted) j.state = 'cancelled';
      else { j.state = 'error'; j.error = String((e && e.message) || e); }
      emit(true);
    }
  }

  return {
    start,
    state: view,
    /** Stop the download; its .part file stays, so starting it again resumes. */
    cancel: () => { if (job && (job.state === 'downloading' || job.state === 'verifying')) job.ac.abort(); return view(); },
  };
}

function gb(n) { return (Number(n) / 1073741824).toFixed(1) + ' GB'; }

module.exports = { search, files, createDownloader, quantOf, SPLIT, REPO };
