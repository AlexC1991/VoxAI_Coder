/**
 * patch — unified old→new replacement edits (token-efficient vs full-file write).
 * Inspired by AI_GUI's workspace.patch (gateway/lib/vox_agent_computer).
 * Applies up to N exact replacements; any miss fails the whole patch so the model
 * re-reads instead of corrupting the file.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { markSeen, assertFresh } = require('./freshness');
const { withVerification } = require('./verify');

function countOccurrences(s, sub) {
  let n = 0, i = s.indexOf(sub);
  while (i !== -1) { n += 1; i = s.indexOf(sub, i + sub.length); }
  return n;
}

function makePatchTool({ resolveIn, checkPermission }) {
  return {
    def: {
      type: 'function',
      function: {
        name: 'patch',
        description: 'Apply up to 20 exact old→new text replacements in ONE file. Fails atomically if ANY `old` is not found, so re-read before patching. Cheaper than write for small changes.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to workdir.' },
            edits: {
              type: 'array', minItems: 1, maxItems: 20,
              items: {
                type: 'object',
                properties: {
                  old: { type: 'string', description: 'Exact existing text to replace.' },
                  new: { type: 'string', description: 'Replacement text.' },
                  all: { type: 'boolean', description: 'Replace every occurrence when true (default false = first only).' },
                },
                required: ['old', 'new'],
                additionalProperties: false,
              },
            },
          },
          required: ['path', 'edits'],
          additionalProperties: false,
        },
      },
    },
    async run(args, ctx) {
      await checkPermission('write-file', args.path);
      const full = resolveIn(ctx.workdir, args.path);
      await assertFresh(full, args.path);
      const original = await fsp.readFile(full, 'utf8');
      let text = original;
      const applied = [];
      for (const [i, e] of (args.edits || []).entries()) {
        if (typeof e.old !== 'string' || typeof e.new !== 'string') throw new Error(`patch edit #${i} needs string old/new`);
        if (e.old === '') throw new Error(`patch edit #${i}: old cannot be empty`);
        if (e.all) {
          const count = countOccurrences(text, e.old);
          if (count === 0) throw new Error(`patch edit #${i}: 'old' not found — ${JSON.stringify(e.old.slice(0, 60))}`);
          text = text.split(e.old).join(e.new);
          applied.push({ edit: i, occurrences: count });
        } else {
          const idx = text.indexOf(e.old);
          if (idx === -1) throw new Error(`patch edit #${i}: 'old' not found — ${JSON.stringify(e.old.slice(0, 60))}`);
          text = text.slice(0, idx) + e.new + text.slice(idx + e.old.length);
          applied.push({ edit: i, occurrences: 1 });
        }
      }
      if (text === original) return { path: args.path, edits: 0, message: 'no change (identical text)' };
      await fsp.writeFile(full, text, 'utf8');
      markSeen(full, text);
      return withVerification({ path: args.path, edits: applied.length, oldBytes: Buffer.byteLength(original), newBytes: Buffer.byteLength(text), diffBytes: Buffer.byteLength(text) - Buffer.byteLength(original) }, full, args.path);
    },
  };
}

module.exports = { makePatchTool };