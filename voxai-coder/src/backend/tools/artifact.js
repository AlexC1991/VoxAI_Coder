/**
 * artifact — publish reviewable artifacts (changed_file / log / screenshot /
 * validation) with content hash + receipt, mirroring AI_GUI's artifact.publish.
 * Stores copies under <userData>/artifacts/<sessionId>/ and emits an 'artifact'
 * event so the UI can render a review strip.
 */
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function makeArtifactTool({ resolveIn, userData, emit }) {
  return {
    defs: [
      {
        type: 'function',
        function: {
          name: 'artifact_publish',
          description: 'Publish a workspace file as a reviewable artifact: changed_file, log, screenshot, or validation. Copies it under user artifacts with a content hash and receipt. Use at milestones so the UI can show what changed.',
          parameters: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['changed_file', 'log', 'screenshot', 'validation'] },
              path: { type: 'string' },
              title: { type: 'string' },
              summary: { type: 'string' },
              status: { type: 'string', enum: ['created', 'updated', 'passed', 'failed', 'needs_work'] },
            },
            required: ['kind', 'path'], additionalProperties: false,
          },
        },
      },
    ],
    async run(name, args, ctx) {
      const full = resolveIn(ctx.workdir, args.path);
      const buf = await fsp.readFile(full);
      const hash = sha256(buf);
      const meta = {
        id: `art_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
        kind: args.kind,
        path: String(args.path),
        title: args.title || args.path,
        summary: args.summary || '',
        status: args.status || 'created',
        hash,
        bytes: buf.length,
        at: new Date().toISOString(),
        sessionId: (ctx.session && ctx.session.id) || '?',
      };
      const dir = path.join(userData || '.', 'artifacts', meta.sessionId);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, meta.id + '_' + path.basename(args.path)), buf);
      if (emit) { try { emit({ type: 'artifact', artifact: meta }); } catch {} }
      return { ok: true, receipt: meta };
    },
  };
}

module.exports = { makeArtifactTool, sha256 };