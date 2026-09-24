/**
 * memory — durable per-project facts stored in a JSON sidecar under the workdir
 * (.voxai/memory.json). Inspired by Codex's ~/.codex/memories and AI_GUI's
 * conversation-memory. Searchable by substring/keyword; persists across sessions.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAX_FACTS = 500;

function memoryFile(workdir) {
  return path.join(workdir, '.voxai', 'memory.json');
}

async function loadMemory(workdir) {
  try {
    const raw = await fsp.readFile(memoryFile(workdir), 'utf8');
    const o = JSON.parse(raw);
    return Array.isArray(o.facts) ? o.facts : [];
  } catch { return []; }
}

async function saveMemory(workdir, facts) {
  await fsp.mkdir(path.dirname(memoryFile(workdir)), { recursive: true });
  await fsp.writeFile(memoryFile(workdir), JSON.stringify({ facts }, null, 2), 'utf8');
}

function makeMemoryTool({ resolveIn }) {
  return {
    def: {
      type: 'function',
      function: {
        name: 'memory',
        description: 'Persistent project memory. Actions: add (store fact(s)), list (all facts), search (find by keywords), forget (remove matching facts). Stored in .voxai/memory.json and survives across sessions. Use for durable decisions, conventions, and architecture notes — not one-off chatter.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'list', 'search', 'forget'] },
            facts: { type: 'array', items: { type: 'string' }, description: 'For action=add: facts to store.' },
            query: { type: 'string', description: 'For search/forget: keyword(s) to match.' },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },
    },
    async run(args, ctx) {
      const facts = await loadMemory(ctx.workdir);
      const action = args.action || 'list';
      if (action === 'add') {
        const inFacts = Array.isArray(args.facts) ? args.facts : (args.facts ? [String(args.facts)] : []);
        if (!inFacts.length) throw new Error('memory add requires facts[]');
        for (const f of inFacts) {
          const s = String(f).trim();
          if (!s) continue;
          if (!facts.some((x) => x.text === s)) facts.push({ text: s, at: new Date().toISOString() });
        }
        while (facts.length > MAX_FACTS) facts.shift();
        await saveMemory(ctx.workdir, facts);
        return { action: 'add', stored: inFacts.length, total: facts.length };
      }
      if (action === 'list') {
        return { action: 'list', total: facts.length, facts: facts.map((f) => f.text) };
      }
      if (action === 'search') {
        const q = String(args.query || '').toLowerCase();
        if (!q) return { action: 'search', facts: [] };
        const hits = facts.filter((f) => f.text.toLowerCase().includes(q)).map((f) => f.text);
        return { action: 'search', query: args.query, hits };
      }
      if (action === 'forget') {
        const q = String(args.query || '').toLowerCase();
        if (!q) throw new Error('memory forget requires query');
        const before = facts.length;
        const kept = facts.filter((f) => !f.text.toLowerCase().includes(q));
        await saveMemory(ctx.workdir, kept);
        return { action: 'forget', removed: before - kept.length, total: kept.length };
      }
      throw new Error('unknown memory action');
    },
  };
}

module.exports = { makeMemoryTool, memoryFile, loadMemory, saveMemory };