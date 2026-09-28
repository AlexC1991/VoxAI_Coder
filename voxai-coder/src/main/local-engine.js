'use strict';
/**
 * Models on this PC.
 *
 * VoxAI runs llama.cpp's own llama-server -- the Vulkan build, the same ggml backend Alex's
 * VoxAI_Chat_API is built on -- and talks to it like any OpenAI-style endpoint: streaming,
 * native tool calls (jinja templates), and the prompt cache kept between turns. The Chat API
 * itself is an in-process Python class with no HTTP server and no tool calls, so it cannot be
 * called from here; what it knows is reused instead:
 *   - its hardware handshake (threads from physical cores, the GPU backend), and
 *   - VoxAI_ModelMaker's offload sidecars (<model>.offload.json: GPU layers, context and the
 *     memory they take, per VRAM size), which plan each load when they are there.
 * Without a sidecar llama-server sizes the load itself (--fit).
 *
 * The engine is downloaded once, pinned to one build and checked against its published
 * SHA-256, into %LOCALAPPDATA%\voxai-coder-engine\<build>. Model ids are "local/<file name>".
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const ENGINE = {
  build: 'b11223',
  file: 'llama-b11223-bin-win-vulkan-x64.zip',
  sha256: 'b450e71cfb2204955db784590af51b3f81fbc3bde0c5687f7a85c89edc977fd4',
  bytes: 33062159,
};
ENGINE.url = `https://github.com/ggml-org/llama.cpp/releases/download/${ENGINE.build}/${ENGINE.file}`;

// An agent's prompt and tools alone are ~8k tokens: below 16k a local model has no room to work.
const MIN_CTX = 16384, WANT_CTX = 32768;

const isLocalModel = (id) => /^local\//.test(String(id || ''));
const fileOf = (id) => String(id || '').replace(/^local\//, '');

/** "qwen2.5-coder-7b-instruct-q4_k_m.gguf" -> "Qwen2.5 Coder 7B Instruct (Q4_K_M)". */
function labelOf(file) {
  const base = String(file).replace(/\.gguf$/i, '').replace(/(\d)_(\d)/g, '$1.$2');   // qwen2_5 -> qwen2.5
  const q = /[._-](i?q\d[\w]*|f16|f32|bf16)$/i.exec(base);
  const name = (q ? base.slice(0, q.index) : base).split(/[-_]+/).filter(Boolean)
    .map((w) => (/^\d+(\.\d+)?[bm]$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
  return name + (q ? ` (${q[1].toUpperCase()})` : '');
}

/** "  Vulkan0: AMD Radeon RX 6600 (8176 MiB, 7378 MiB free)" -> devices. */
function parseDevices(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]+\d+):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)/.exec(line);
    if (m) out.push({ id: m[1], name: m[2], totalMiB: Number(m[3]), freeMiB: Number(m[4]) });
  }
  return out;
}

/**
 * How to load one model: GPU layers and context, from its sidecar when it has one. The sidecar's
 * profile for this card's VRAM gives the layers; the context grows from the sidecar's (8k) toward
 * 32k while its own memory figures say it still fits in what is free. No sidecar: --fit.
 */
function planLoad(sidecar, device, threads) {
  const args = [];
  if (threads > 0) args.push('-t', String(threads));
  const profiles = sidecar && sidecar.profiles;
  if (profiles && device) {
    const gb = Math.floor((device.totalMiB + 512) / 1024);
    const tiers = Object.keys(profiles).map((k) => [k, Number((/vram_(\d+)gb/.exec(k) || [])[1])]).filter(([, n]) => n > 0 && n <= gb).sort((a, b) => b[1] - a[1]);
    const p = tiers.length ? profiles[tiers[0][0]] : null;
    if (p && p.fits !== false) {
      const kv = Number(sidecar.kv_cache_mb_per_1k) || 0;
      const base = Number(p.n_ctx) || 8192;
      let ctx = Math.max(base, MIN_CTX);
      for (const want of [WANT_CTX, 24576, MIN_CTX]) {
        const extra = kv * Math.max(0, want - base) / 1024;
        const onGpu = p.n_gpu_layers === -1 ? (Number(p.vram_used_mb) || 0) + extra : 0;
        if (want <= base || onGpu <= device.freeMiB * 0.9) { ctx = Math.max(want, base); break; }
      }
      args.push('-ngl', String(p.n_gpu_layers === -1 ? 999 : p.n_gpu_layers), '-c', String(ctx));
      return { args, ctx, how: `sidecar ${tiers[0][0]}: ${p.n_gpu_layers === -1 ? 'all layers on the GPU' : p.n_gpu_layers + ' layers on the GPU'}, ${ctx} context` };
    }
  }
  args.push('--fit', 'on', '--fit-ctx', String(MIN_CTX));
  return { args, ctx: 0, how: 'sized by llama-server to the memory that is free (--fit)' };
}

/**
 * A model's layer count, from its GGUF header ("<arch>.block_count"). Read from the first few MB:
 * the architecture keys come before the tokenizer's long arrays. 0 when it cannot tell.
 */
function ggufLayers(file) {
  let buf;
  try { const fd = fs.openSync(file, 'r'); buf = Buffer.alloc(4 * 1024 * 1024); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd); buf = buf.subarray(0, n); } catch { return 0; }
  if (buf.toString('latin1', 0, 4) !== 'GGUF') return 0;
  let o = 24;   // magic, version, tensor count
  const kvCount = Number(buf.readBigUInt64LE(16));
  const size = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
  const str = () => { const n = Number(buf.readBigUInt64LE(o)); o += 8; const s = buf.toString('utf8', o, o + n); o += n; return s; };
  const skip = (t) => {
    if (t === 8) { str(); return; }
    if (t === 9) { const et = buf.readUInt32LE(o); o += 4; const n = Number(buf.readBigUInt64LE(o)); o += 8; if (et === 8) for (let i = 0; i < n; i++) str(); else o += n * (size[et] || 0); return; }
    o += size[t] || 0;
  };
  try {
    for (let i = 0; i < kvCount && o < buf.length - 16; i++) {
      const key = str(); const t = buf.readUInt32LE(o); o += 4;
      if (/\.block_count$/.test(key) && (t === 4 || t === 5)) return buf.readUInt32LE(o);
      skip(t);
    }
  } catch { /* ran past what was read */ }
  return 0;
}

function createLocalEngine({ baseDir, log = () => {}, onState = () => {} }) {
  // Where the engine lives can change with the settings (beside the models folder), so it is looked up each time.
  const base = () => (typeof baseDir === 'function' ? baseDir() : baseDir);
  const dirOf = () => path.join(base(), ENGINE.build);
  const exeOf = () => path.join(dirOf(), 'llama-server.exe');
  let proc = null, tail = [], cores = 0;
  let st = { state: fs.existsSync(exeOf()) ? 'stopped' : 'missing', model: '', port: 0, ctx: 0, how: '', device: '', error: '', percent: 0, build: ENGINE.build };
  const set = (patch) => { st = { ...st, ...patch }; try { onState(st); } catch {} };

  const run = (args, ms = 30000) => new Promise((resolve) => execFile(exeOf(), args, { cwd: dirOf(), windowsHide: true, timeout: ms }, (_e, out, err) => resolve(String(out || '') + String(err || ''))));

  async function physicalCores() {
    if (cores) return cores;
    cores = await new Promise((resolve) => execFile('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum'],
      { windowsHide: true, timeout: 15000 }, (_e, out) => resolve(Number(String(out || '').trim()) || 0)));
    if (!cores) cores = Math.max(1, Math.round(require('os').cpus().length / 2));
    return cores;
  }

  /** Download the pinned build, check it, unpack it. Progress goes out as state.percent. */
  async function install() {
    if (fs.existsSync(exeOf())) { set({ state: proc ? st.state : 'stopped' }); return true; }
    set({ state: 'installing', percent: 0, error: '' });
    fs.mkdirSync(dirOf(), { recursive: true });
    try {
      const sf = fs.statfsSync(dirOf());
      const free = Number(sf.bavail) * Number(sf.bsize);
      if (free < ENGINE.bytes * 5) { set({ state: 'missing', error: `not enough space on ${path.parse(dirOf()).root} (${Math.round(free / 1048576)} MB free, about ${Math.round((ENGINE.bytes * 4) / 1048576)} MB needed)` }); return false; }
    } catch { /* could not tell: go ahead */ }
    const zip = path.join(dirOf(), ENGINE.file);
    try {
      const res = await fetch(ENGINE.url);
      if (!res.ok || !res.body) throw new Error('download failed (HTTP ' + res.status + ')');
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(zip);
      let got = 0;
      for await (const chunk of res.body) {
        hash.update(chunk); out.write(chunk); got += chunk.length;
        const pct = Math.floor((100 * got) / ENGINE.bytes);
        if (pct !== st.percent) set({ percent: Math.min(99, pct) });
      }
      await new Promise((r) => out.end(r));
      if (hash.digest('hex') !== ENGINE.sha256) throw new Error('the download did not match its published checksum');
      await new Promise((resolve, reject) => execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dirOf()],
        { windowsHide: true, timeout: 120000 }, (e) => (e ? reject(e) : resolve())));
      try { fs.rmSync(zip, { force: true }); } catch {}
      if (!fs.existsSync(exeOf())) throw new Error('llama-server.exe was not in the download');
      log(`engine ${ENGINE.build} installed`);
      set({ state: 'stopped', percent: 100 });
      return true;
    } catch (e) {
      try { fs.rmSync(zip, { force: true }); } catch {}
      set({ state: 'missing', error: String((e && e.message) || e) });
      return false;
    }
  }

  async function devices() { return fs.existsSync(exeOf()) ? parseDevices(await run(['--list-devices'])) : []; }

  /** The .gguf files in a folder (vision projectors aside), each with its sidecar if it has one. */
  function models(folders) {
    const out = [], seen = new Set();
    for (const folder of (Array.isArray(folders) ? folders : [folders]).filter(Boolean)) {
    let files = [];
    try { files = fs.readdirSync(folder).filter((f) => /\.gguf$/i.test(f) && !/mmproj/i.test(f) && !seen.has(f)); } catch { continue; }
    for (const f of files) seen.add(f);
    out.push(...files.map((f) => {
      let sidecar = null;
      try { sidecar = JSON.parse(fs.readFileSync(path.join(folder, f + '.offload.json'), 'utf8')); } catch {}
      let bytes = 0; try { bytes = fs.statSync(path.join(folder, f)).size; } catch {}
      return { id: 'local/' + f, file: f, folder, name: labelOf(f), bytes, sidecar };
    }));
    }
    return out;
  }

  const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- tuning: the GPU split measured on this PC, once per model ----
  // Where a card's usable memory ends is not what it reports: on an RX 6600 the whole 7B "fit"
  // (--fit and the 8 GB profile both said so) yet ran at 5.8 tokens/s, spilled into system RAM,
  // while 26 of its 28 layers ran at 8.5 -- the "sweet spot" Alex's handshake had found by hand.
  const tuneFile = () => path.join(base(), 'tune.json');
  const readTune = () => { try { return JSON.parse(fs.readFileSync(tuneFile(), 'utf8')); } catch { return {}; } };
  const tuneKey = (file, bytes, dev) => [file, bytes, ENGINE.build, dev ? dev.name + ' ' + dev.totalMiB : 'cpu'].join('|');
  /** One load at `ngl` and `ctx`, timed on a request shaped like an agent turn. null if it failed. */
  async function trial(model, ngl, ctx, threads) {
    const port = await freePort();
    const p = spawn(exeOf(), ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-np', '1', '--no-webui', '--fit', 'off',
      '-ngl', String(ngl), '-c', String(ctx), ...(threads ? ['-t', String(threads)] : [])], { cwd: dirOf(), windowsHide: true, stdio: 'ignore' });
    try {
      const t0 = Date.now();
      let up = false;
      while (Date.now() - t0 < 120000) {
        if (p.exitCode !== null) return null;
        try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { up = true; break; } } catch { /* loading */ }
        await sleep(500);
      }
      if (!up) return null;
      const prompt = 'Summarise this in one line.\n' + 'The quick brown fox jumps over the lazy dog near the river bank. '.repeat(60);
      const r = await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: prompt }], max_tokens: 48, temperature: 0 }) })).json();
      const tm = r && r.timings;
      if (!tm || !(tm.prompt_per_second > 0) || !(tm.predicted_per_second > 0)) return null;
      // Seconds for a typical agent turn: ~2,000 new prompt tokens in, ~200 out.
      return { ngl, ctx, pp: Math.round(tm.prompt_per_second), tg: Math.round(tm.predicted_per_second * 10) / 10, turn: 2000 / tm.prompt_per_second + 200 / tm.predicted_per_second };
    } catch { return null; } finally { try { p.kill(); } catch { /* gone */ } await sleep(1000); }
  }
  /** The fastest GPU split for this model on this PC: from all layers down, until it gets slower again. */
  async function tune(folder, file, dev, threads) {
    const model = path.join(folder, file);
    let bytes = 0; try { bytes = fs.statSync(model).size; } catch {}
    const key = tuneKey(file, bytes, dev);
    const saved = readTune()[key];
    if (saved) return saved;
    if (!dev) return null;   // no GPU: nothing to split
    const n = ggufLayers(model) || 32;
    // A model near half the card or more gets 16k of context; a small one 32k.
    const ctx = bytes > dev.totalMiB * 1048576 * 0.45 ? MIN_CTX : WANT_CTX;
    const tries = [999, n - 2, n - 4, n - 6, n - 10, n - 14].filter((x, i, a) => x > 0 && a.indexOf(x) === i);
    let best = null;
    for (const ngl of tries) {
      set({ state: 'tuning', model: file, how: `finding the fastest GPU split for this PC (trying ${ngl === 999 ? 'all' : ngl} of ${n} layers)` });
      const r = await trial(model, ngl, ctx, threads);
      log(`tune ${file}: ${ngl === 999 ? 'all' : ngl} layers -> ${r ? r.pp + ' in, ' + r.tg + ' out tok/s' : 'failed'}`);
      if (r && (!best || r.turn < best.turn)) best = r;
      else if (best && r && r.turn > best.turn * 1.25) break;   // past the best split
    }
    if (!best) return null;
    const all = readTune(); all[key] = { ...best, layers: n, at: new Date().toISOString() };
    try { fs.writeFileSync(tuneFile(), JSON.stringify(all, null, 1)); } catch { /* not kept; tuned again next time */ }
    return all[key];
  }

  /** Load a model (stopping any other); resolves when it answers /health, or rejects with why. */
  async function start(folders, file) {
    if (st.state === 'ready' && st.model === file && proc) return st;
    if (proc) await stop();
    if (!fs.existsSync(exeOf()) && !(await install())) throw new Error('The local engine could not be installed: ' + st.error);
    const m = models(folders).find((x) => x.file === file);
    if (!m) throw new Error('Model not found in your local models folders: ' + file);
    const folder = m.folder;
    const model = path.join(folder, file);
    const devs = await devices();
    const dev = devs.slice().sort((a, b) => b.freeMiB - a.freeMiB)[0] || null;
    const threads = await physicalCores();
    // Alex's ModelMaker plan when the model has one; otherwise the split measured on this PC; --fit last.
    let plan = m && m.sidecar ? planLoad(m.sidecar, dev, threads) : null;
    if (!plan || !plan.ctx) {
      const t = await tune(folder, file, dev, threads);
      if (t) plan = { args: ['-t', String(threads), '--fit', 'off', '-ngl', String(t.ngl), '-c', String(t.ctx)], ctx: t.ctx,
        how: `tuned for this PC: ${t.ngl === 999 ? 'all' : t.ngl} of ${t.layers} layers on the GPU, ${t.ctx.toLocaleString()} context (${t.tg} tokens/s)` };
    }
    if (!plan) plan = planLoad(null, dev, threads);
    const port = await freePort();
    const args = ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-np', '1', '--jinja', '--no-webui', ...plan.args];
    tail = [];
    log(`starting ${file}: ${plan.how}${dev ? ' on ' + dev.name : ' on the CPU'}`);
    set({ state: 'loading', model: file, port, ctx: plan.ctx, how: plan.how, device: dev ? dev.name : 'CPU', error: '' });
    proc = spawn(exeOf(), args, { cwd: dirOf(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (b) => { for (const l of String(b).split(/\r?\n/)) if (l.trim()) { tail.push(l); if (tail.length > 40) tail.shift(); } };
    proc.stdout.on('data', keep); proc.stderr.on('data', keep);
    const mine = proc;
    proc.on('exit', (code) => {
      if (proc !== mine) return;
      proc = null;
      const why = st.state === 'stopping' ? '' : (tail.filter((l) => /error|failed|out of memory|unable/i.test(l)).slice(-2).join(' ') || `the engine stopped (exit ${code})`);
      set({ state: 'stopped', port: 0, error: why });
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 240000) {
      if (!proc || proc !== mine) throw new Error('The local engine stopped while loading: ' + (st.error || tail.slice(-2).join(' ')));
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) {
          // The context it really got (with --fit it chose).
          try { const p = await (await fetch(`http://127.0.0.1:${port}/props`)).json(); const n = Number((p.default_generation_settings || {}).n_ctx || p.n_ctx); if (n) set({ ctx: n }); } catch {}
          // Warm it up before calling it ready. The first run from a new engine folder (or after a
          // restart) crawls at ~1 token/s for minutes while the GPU driver compiles and caches its
          // shaders -- measured on the RX 6600, and in Alex's own first probe (440 s). Paid here,
          // while it says Loading, rather than on your first message.
          set({ how: st.how + ' — warming up' });
          try {
            await fetch(`http://127.0.0.1:${port}/completion`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt: 'Hello', n_predict: 8, cache_prompt: false }), signal: AbortSignal.timeout(600000) });
          } catch { /* warm-up only */ }
          set({ state: 'ready', how: st.how.replace(/ — warming up$/, '') });
          log(`ready: ${file}, ${st.ctx} context`);
          return st;
        }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    await stop();
    throw new Error('The local model took over 4 minutes to load.');
  }

  function stop() {
    if (!proc) { set({ state: fs.existsSync(exeOf()) ? 'stopped' : 'missing', port: 0 }); return Promise.resolve(); }
    const p = proc;
    set({ state: 'stopping' });
    return new Promise((resolve) => {
      const done = () => { resolve(); };
      p.once('exit', done);
      try { p.kill(); } catch { done(); }
      setTimeout(done, 5000);
    });
  }

  return {
    state: () => st,
    url: () => (st.state === 'ready' && st.port ? `http://127.0.0.1:${st.port}` : null),
    installed: () => fs.existsSync(exeOf()),
    engineDir: () => dirOf(),
    install, devices, models, start, stop,
  };
}

module.exports = { createLocalEngine, planLoad, parseDevices, labelOf, ggufLayers, isLocalModel, fileOf, ENGINE, MIN_CTX, WANT_CTX };
