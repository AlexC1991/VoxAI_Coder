/**
 * docrag — document RAG: extract text from txt/md/csv/json/pdf/docx/xlsx,
 * chunk + keyword-index, retrieve top-K. Dependency-free:
 *  - docx/xlsx: minimal ZIP central-directory reader + zlib inflate (document.xml / sharedStrings+sheet)
 *  - pdf: best-effort text extraction from content streams (FlateDecode)
 *  - everything else: plain UTF-8 read
 */
const fsp = require('fs').promises;
const path = require('path');
const zlib = require('zlib');

const MIN_CHARS = 6000;
const CHUNK = 4000;
const OVERLAP = 400;
const TOP_K = 5;

function tokenize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ').split(/\s+/).filter((w) => w.length > 1);
}

// ---- minimal zip reader (central directory) ----
function readZipEntries(buf) {
  // find End-Of-Central-Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const cdCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = {};
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    // local header: name + extra, then data
    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    try {
      entries[name.replace(/\\/g, '/')] = method === 8 ? zlib.inflateRawSync(raw) : raw;
    } catch { /* skip */ }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function xmlToText(xml) {
  return String(xml || '')
    .replace(/<w:p[ >]/g, '\n')
    .replace(/<w:tab[^>]*\/>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{2,}/g, '\n').trim();
}

async function extractText(file, ext, buf) {
  if (/\.(txt|md|markdown|csv|json|log|ts|js|jsx|tsx|py|html|css)$/i.test(ext)) {
    return buf.toString('utf8');
  }
  if (/\.docx$/i.test(ext)) {
    const entries = readZipEntries(buf);
    const doc = entries['word/document.xml'];
    if (doc) return xmlToText(doc.toString('utf8'));
    throw new Error('docx missing word/document.xml');
  }
  if (/\.xlsx$/i.test(ext)) {
    const entries = readZipEntries(buf);
    const shared = entries['xl/sharedStrings.xml'] ? xmlToText(entries['xl/sharedStrings.xml'].toString('utf8')).split('\n').map(s => s.trim()).filter(Boolean) : [];
    const sheet = Object.keys(entries).find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
    if (sheet) return xmlToText(entries[sheet].toString('utf8')) + '\n' + shared.slice(0, 500).join(' | ');
    return shared.slice(0, 500).join(' | ');
  }
  if (/\.pdf$/i.test(ext)) {
    const s = buf.toString('latin1');
    // extract text between BT..ET blocks, decode hex strings
    const chunks = [];
    const re = /\((?:\\(?:[nrt()\\]|[0-9]{1,3})|[^()\\])*\)/g;
    let m;
    while ((m = re.exec(s))) {
      let t = m[0].slice(1, -1)
        .replace(/\\n/g, '\n').replace(/\\r/g, '\n').replace(/\\t/g, ' ')
        .replace(/\\([nrt()\\])/g, '$1').replace(/\\(\d{1,3})/g, (_, c) => String.fromCharCode(parseInt(c, 8)));
      if (t.trim()) chunks.push(t);
      if (chunks.join(' ').length > 200000) break;
    }
    return chunks.join(' ').replace(/ {2,}/g, ' ');
  }
  throw new Error('unsupported document type');
}

function simpleChunk(text) {
  const chunks = [];
  if (!text.length) return chunks;
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + CHUNK));
    start += CHUNK - OVERLAP;
  }
  return chunks;
}

function makeDocRagTool({ resolveIn, checkPermission }) {
  return {
    defs: [
      {
        type: 'function',
        function: {
          name: 'doc_rag',
          description: 'Extract text from a document (txt/md/csv/json/pdf/docx/xlsx), chunk it, and retrieve the most relevant chunks for a query. Use for docs and spreadsheets.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, query: { type: 'string' } },
            required: ['path', 'query'], additionalProperties: false,
          },
        },
      },
    ],
    async run(name, args, ctx) {
      const full = resolveIn(ctx.workdir, args.path);
      const ext = path.extname(args.path).toLowerCase();
      let buf;
      try { buf = await fsp.readFile(full); }
      catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      if (buf.length > 20 * 1024 * 1024) return { ok: false, error: 'file too large (>20MB)' };
      let text;
      try { text = await extractText(args.path, ext, buf); }
      catch (e) { return { ok: false, error: String(e && e.message || e), ext }; }
      if (text.length < MIN_CHARS) {
        return { path: args.path, small: true, chars: text.length, text: text.slice(0, 8000) };
      }
      const chunks = simpleChunk(text).map((c, i) => ({ id: i, text: c, kws: new Set(tokenize(c).slice(0, 40)) }));
      const qs = tokenize(args.query || '');
      const scored = chunks.map((c) => {
        let score = 0;
        for (const q of qs) if (c.kws.has(q)) score += 1;
        return { c, score: score + 0.0001 / (c.id + 1) };
      }).filter((s) => s.score > 0.0001).sort((a, b) => b.score - a.score).slice(0, TOP_K);
      return {
        path: args.path, ext, chars: text.length, chunks: chunks.length,
        hits: scored.map((s) => ({ id: s.c.id, text: s.c.text.slice(0, 2400) })),
      };
    },
  };
}

module.exports = { makeDocRagTool, extractText, readZipEntries };