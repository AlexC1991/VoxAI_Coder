/**
 * fsops — filesystem parity tools (stat / mkdir / move / remove / search).
 * Parity with AI_GUI's workspace.stat/mkdir/move/remove/search. All paths are
 * workdir-jailed via resolveIn. Removal of directories requires recursive=true
 * and a permission check (write-file).
 */
const fsp = require('fs').promises;
const path = require('path');

function makeFsOpsTool({ resolveIn, checkPermission }) {
  async function inDir(p) {
    const full = resolveIn(p.workdir, p.path || '.');
    const st = await fsp.stat(full);
    return {
      path: p.path || '.',
      absolute: full,
      kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
      size: st.size,
      mtimeMs: st.mtimeMs,
      mode: st.mode,
    };
  }

  return {
    defs: [
      {
        type: 'function',
        function: {
          name: 'stat',
          description: 'Inspect a file or directory (kind, size, mtime).',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
        },
      },
      {
        type: 'function',
        function: {
          name: 'mkdir',
          description: 'Create a directory (recursive with parents=true).',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, parents: { type: 'boolean' } },
            required: ['path'], additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'move',
          description: 'Move/rename a file or directory within the workdir.',
          parameters: {
            type: 'object',
            properties: { source: { type: 'string' }, destination: { type: 'string' } },
            required: ['source', 'destination'], additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'remove',
          description: 'Remove a file, or a directory (recursive=true). It goes to the Recycle Bin, so it can be restored.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
            required: ['path'], additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'search',
          description: 'Search file names OR file contents for a query (case-insensitive substring). Include optional extension filter like *.js.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' }, include: { type: 'string' } },
            required: ['query'], additionalProperties: false,
          },
        },
      },
    ],
    async run(name, args, ctx) {
      const p = { ...args, workdir: ctx.workdir };
      if (name === 'stat') return inDir(p);
      if (name === 'mkdir') {
        await checkPermission('write-file', args.path);
        const full = resolveIn(ctx.workdir, args.path);
        await fsp.mkdir(full, { recursive: !!args.parents });
        return { path: args.path, ok: true };
      }
      if (name === 'move') {
        await checkPermission('write-file', args.source);
        await checkPermission('write-file', args.destination);
        const src = resolveIn(ctx.workdir, args.source);
        const dst = resolveIn(ctx.workdir, args.destination);
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.rename(src, dst);
        return { from: args.source, to: args.destination, ok: true };
      }
      if (name === 'remove') {
        await checkPermission('write-file', args.path);
        const full = resolveIn(ctx.workdir, args.path);
        const st = await fsp.lstat(full);
        if (st.isDirectory() && !args.recursive) throw new Error('remove: directory needs recursive=true');
        // To the Recycle Bin, not erased: a wrong remove of someone's source files could
        // not be undone. Outside Electron (tests, a plain node run) there is no bin.
        let trash = null;
        try { const e = require('electron'); trash = e && e.shell && typeof e.shell.trashItem === 'function' ? e.shell : null; } catch { trash = null; }
        if (trash) {
          await trash.trashItem(full);
          return { path: args.path, ok: true, recycled: true, note: 'Moved to the Recycle Bin; it can be restored from there.' };
        }
        if (st.isDirectory()) await fsp.rm(full, { recursive: true });
        else await fsp.unlink(full);
        return { path: args.path, ok: true };
      }
      if (name === 'search') {
        const q = String(args.query || '').toLowerCase();
        const hits = [];
        const wantExt = args.include ? new RegExp('^' + String(args.include).replace(/\./g, '\\.').replace(/\*/g, '.*') + '$') : null;
        async function walk(dir, depth) {
          if (depth > 10 || hits.length > 200) return;
          let ents = [];
          try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            if (e.name === 'node_modules' || e.name === '.git' || e.name === '.voxai') continue;
            const full = path.join(dir, e.name);
            const rel = path.relative(ctx.workdir, full).replace(/\\/g, '/');
            if (e.isDirectory()) { await walk(full, depth + 1); continue; }
            if (wantExt && !wantExt.test(e.name)) continue;
            if (e.name.toLowerCase().includes(q)) { hits.push({ file: rel, name: true }); continue; }
            try {
              const st = await fsp.stat(full);
              if (st.size > 512 * 1024) continue;
              const text = await fsp.readFile(full, 'utf8');
              if (text.toLowerCase().includes(q)) hits.push({ file: rel, content: true });
            } catch {}
          }
        }
        await walk(ctx.workdir, 0);
        return { query: args.query, hits: hits.slice(0, 200) };
      }
      throw new Error('unknown fsop');
    },
  };
}

module.exports = { makeFsOpsTool };