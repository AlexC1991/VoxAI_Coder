/**
 * rag — workspace document RAG for large files (chunk + keyword index + retrieve).
 * Inspired by AI_GUI's document_rag.py (BM25-lite). Lets the agent answer from
 * code/docs without re-reading entire files. Stores chunk sidecars under .voxai/rag/.
 */
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const RAG_MIN_CHARS = 12000;       // below this, just read the file directly
const RAG_CHUNK_CHARS = 4000;
const RAG_OVERLAP = 400;
const RAG_TOP_K = 5;
const RAG_MAX_CHUNKS_PER_FILE = 200;

const STOP = new Set(('a an and or but if then else for while do the of to in on at by with from as is are be was were this that it its their our you we they i me my your not no yes so such can will would could should may might must shall have has had been being').split(' '));

function tokenize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ').split(/\s+/).filter((w) => w && w.length > 1 && !STOP.has(w));
}

function chunkByWindow(text) {
  const chunks = [];
  let start = 0;
  const n = text.length;
  while (start < n && chunks.length < RAG_MAX_CHUNKS_PER_FILE) {
    chunks.push({ id: chunks.length, start, text: text.slice(start, start + RAG_CHUNK_CHARS) });
    start += RAG_CHUNK_CHARS - RAG_OVERLAP;
  }
  return chunks;
}

function keywordSet(text, cap = 40) {
  const counts = new Map();
  for (const w of tokenize(text)) counts.set(w, (counts.get(w) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap).map(([w]) => w);
}

function hashOf(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

function sidecarPath(workdir, file) {
  const rel = String(file).replace(/[^A-Za-z0-9/._-]/g, '_');
  return path.join(workdir, '.voxai', 'rag', hashOf(rel) + '.json');
}

async function buildMemory(workdir, file, text) {
  const chunks = chunkByWindow(text).map((c) => ({ ...c, keywords: keywordSet(c.text) }));
  const mem = { file, fileHash: hashOf(text), chunkCount: chunks.length, chunks };
  await fsp.mkdir(path.dirname(sidecarPath(workdir, file)), { recursive: true });
  await fsp.writeFile(sidecarPath(workdir, file), JSON.stringify(mem), 'utf8');
  return mem;
}

async function loadMemory(workdir, file) {
  try { return JSON.parse(await fsp.readFile(sidecarPath(workdir, file), 'utf8')); } catch { return null; }
}

function retrieve(mem, query, topK = RAG_TOP_K) {
  const qs = tokenize(query);
  if (!qs.length || !mem || !mem.chunks) return [];
  const scored = mem.chunks.map((c) => {
    const kws = c.keywords || keywordSet(c.text);
    let score = 0;
    for (const q of qs) if (kws.includes(q)) score += 1;
    // slight boost for earlier chunks when scores tie
    return { c, score: score + (0.0001 / (c.id + 1)) };
  });
  return scored.filter((s) => s.score > 0.0001).sort((a, b) => b.score - a.score).slice(0, topK).map((s) => ({ id: s.c.id, text: s.c.text }));
}

function makeRagTool() {
  return {
    def: {
      type: 'function',
      function: {
        name: 'rag',
        description: 'Retrieve relevant chunks from a large file (12k+ chars) by keyword. Returns up to 5 short excerpts with context. Use before editing/quoting big files: memos, docs, long source. For small files just use read.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to workdir (must exist).' },
            query: { type: 'string', description: 'What you are looking for (keywords).' },
            force_reindex: { type: 'boolean', description: 'Rebuild the index even if cached (optional).' },
          },
          required: ['path', 'query'],
          additionalProperties: false,
        },
      },
    },
    async run(args, ctx) {
      // resolve + ensure inside workdir
      const { resolveIn } = ctx;
      const full = resolveIn(ctx.workdir, args.path);
      let text;
      try { text = await fsp.readFile(full, 'utf8'); }
      catch (e) {
        // Given a folder it said only "cannot read .", and the model tried again the same way.
        if (e && e.code === 'EISDIR') throw new Error(`rag: ${args.path} is a folder. rag searches inside one large file; to search the project, use grep (or search).`);
        if (e && e.code === 'ENOENT') throw new Error(`rag: there is no file ${args.path}. Check the path with glob.`);
        throw new Error(`rag: cannot read ${args.path} (${(e && e.code) || 'error'})`);
      }
      if (text.length < RAG_MIN_CHARS) {
        return { path: args.path, small: true, chars: text.length, note: `file is ${text.length} chars — use read instead`, text: text.slice(0, 6000) };
      }
      let mem = args.force_reindex ? null : await loadMemory(ctx.workdir, args.path);
      if (!mem || mem.fileHash !== hashOf(text)) mem = await buildMemory(ctx.workdir, args.path, text);
      const hits = retrieve(mem, args.query);
      return { path: args.path, chars: text.length, chunksIndexed: mem.chunkCount, hits: hits.map((h) => ({ chunk: h.id, text: h.text })) };
    },
  };
}

module.exports = { makeRagTool, chunkByWindow, tokenize, retrieve, RAG_MIN_CHARS };