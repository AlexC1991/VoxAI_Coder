/**
 * Models from Hugging Face (src/main/hf.js), offline: a local server stands in for it.
 * Run: node test/regression-hf.js
 *
 *   [HF] a model's GGUF files, split models as one, smallest first
 *   [HF] a download is checked against the published SHA-256; a bad one is removed
 *   [HF] a stopped download picks up where it left off
 *   [HF] the folder scan lists a split model once, with its full size
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

const ROOT = process.env.VOX_ROOT || path.join(__dirname, '..');
let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  got: ' + JSON.stringify(got)); }
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const bytes = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251));

const FILES = {
  'tiny-coder-q4_k_m.gguf': bytes(3000, 1),
  'tiny-coder-q8_0.gguf': bytes(5000, 2),
  'big/tiny-coder-f16-00001-of-00002.gguf': bytes(4000, 3),
  'big/tiny-coder-f16-00002-of-00002.gguf': bytes(4000, 4),
  'broken-q2_k.gguf': bytes(1000, 5),
  'mmproj-tiny.gguf': bytes(500, 6),
  // Published whole and in parts, as Qwen does: offered once, as the whole file.
  'dup-coder-q6_k.gguf': bytes(6000, 7),
  'dup-coder-q6_k-00001-of-00002.gguf': bytes(3000, 8),
  'dup-coder-q6_k-00002-of-00002.gguf': bytes(3000, 9),
};
const tree = Object.entries(FILES).map(([p, b]) => ({ type: 'file', path: p, size: b.length,
  lfs: { oid: p === 'broken-q2_k.gguf' ? '0'.repeat(64) : sha(b), size: b.length } }))
  .concat([{ type: 'file', path: 'README.md', size: 10 }]);
let ranges = 0;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/models/owner/tiny-GGUF/tree/main') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(tree)); }
  if (u.pathname === '/api/models') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify([{ id: 'owner/tiny-GGUF', downloads: 1234, likes: 5, tags: ['gguf', 'license:mit'] }, { id: 'bad id', downloads: 1 }]));
  }
  const m = /^\/owner\/tiny-GGUF\/resolve\/main\/(.+)$/.exec(u.pathname);
  const body = m && FILES[decodeURIComponent(m[1])];
  if (!body) { res.statusCode = 404; return res.end(); }
  const r = /^bytes=(\d+)-$/.exec(req.headers.range || '');
  if (r) { ranges++; const from = Number(r[1]); res.statusCode = 206; res.setHeader('content-length', body.length - from); return res.end(body.subarray(from)); }
  res.setHeader('content-length', body.length); res.end(body);
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.VOX_HF_BASE = 'http://127.0.0.1:' + server.address().port;
  const hf = require(path.join(ROOT, 'src/main/hf.js'));
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-hf-'));
  console.log('\n[HF] models from Hugging Face');

  const found = await hf.search('tiny');
  check('search keeps real model names, with downloads and licence', found.length === 1 && found[0].id === 'owner/tiny-GGUF' && found[0].license === 'mit' && found[0].downloads === 1234, found);
  const list = await hf.files('owner/tiny-GGUF');
  check('a model\'s GGUF files: no projector, a split model once, whole over parts, smallest first',
    list.map((f) => f.quant + ':' + f.size).join(',') === 'Q2_K:1000,Q4_K_M:3000,Q8_0:5000,Q6_K:6000,F16:8000' && list[3].parts.length === 1 && list[4].parts.length === 2, list.map((f) => [f.quant, f.size, f.parts.length]));
  let threw = ''; try { await hf.files('../etc'); } catch (e) { threw = e.message; }
  check('a name that is not owner/name is refused', /not a Hugging Face model name/.test(threw), threw);

  const seen = [];
  const wait = () => new Promise((resolve) => { const t = setInterval(() => { const s = dl.state(); if (s && !['downloading', 'verifying'].includes(s.state)) { clearInterval(t); resolve(s); } }, 20); });
  const dl = hf.createDownloader({ onState: (s) => seen.push(s && s.state) });

  await dl.start({ repo: 'owner/tiny-GGUF', key: 'tiny-coder-q4_k_m.gguf', dir: DIR });
  let st = await wait();
  check('a download lands in the folder, checked', st.state === 'done' && fs.readFileSync(path.join(DIR, 'tiny-coder-q4_k_m.gguf')).equals(FILES['tiny-coder-q4_k_m.gguf']) && seen.includes('verifying'), st);

  await dl.start({ repo: 'owner/tiny-GGUF', key: 'broken-q2_k.gguf', dir: DIR });
  st = await wait();
  check('a file that does not match its checksum is removed, and says so', st.state === 'error' && /did not match the checksum/.test(st.error) && !fs.existsSync(path.join(DIR, 'broken-q2_k.gguf')) && !fs.existsSync(path.join(DIR, 'broken-q2_k.gguf.part')), st);

  // A download stopped half way: the .part is there; starting again asks for the rest only.
  fs.writeFileSync(path.join(DIR, 'tiny-coder-q8_0.gguf.part'), FILES['tiny-coder-q8_0.gguf'].subarray(0, 2000));
  ranges = 0;
  await dl.start({ repo: 'owner/tiny-GGUF', key: 'tiny-coder-q8_0.gguf', dir: DIR });
  st = await wait();
  check('a stopped download picks up where it left off', st.state === 'done' && ranges === 1 && fs.readFileSync(path.join(DIR, 'tiny-coder-q8_0.gguf')).equals(FILES['tiny-coder-q8_0.gguf']), { st, ranges });

  await dl.start({ repo: 'owner/tiny-GGUF', key: 'big/tiny-coder-f16.gguf', dir: DIR });
  st = await wait();
  check('a split model downloads every part', st.state === 'done' && fs.existsSync(path.join(DIR, 'tiny-coder-f16-00001-of-00002.gguf')) && fs.existsSync(path.join(DIR, 'tiny-coder-f16-00002-of-00002.gguf')), st);

  threw = ''; try { await dl.start({ repo: 'owner/tiny-GGUF', key: 'tiny-coder-q4_k_m.gguf', dir: path.join(DIR, 'nope') }); } catch (e) { threw = e.message; }
  check('no folder, no download', /Choose the folder/.test(threw), threw);

  const LE = require(path.join(ROOT, 'src/main/local-engine.js'));
  const eng = LE.createLocalEngine({ baseDir: path.join(DIR, '.engine') });
  const ms = eng.models([DIR]);
  const big = ms.find((m) => /f16/i.test(m.file));
  check('the folder lists a split model once, with its full size and a clean name', ms.length === 3 && big && big.file === 'tiny-coder-f16-00001-of-00002.gguf' && big.bytes === 8000 && big.name === 'Tiny Coder (F16)', ms.map((m) => [m.file, m.bytes, m.name]));

  server.close();
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
