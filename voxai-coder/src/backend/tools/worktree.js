/**
 * worktree — isolated git worktree management (create / status / merge / discard).
 * Inspired by AI_GUI's workspace.worktree.* (vox_agent_computer) and Codex sandboxing.
 * Lets the agent patch in an isolated checkout, then commit+merge or discard.
 * Runs git via execFile with a strict command allowlist (no arbitrary shell).
 */
const { execFile } = require('child_process');
const path = require('path');
const fsp = require('fs').promises;

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { reject(new Error((stderr || err.message || 'git failed').slice(0, 1200))); return; }
      resolve(String(stdout || '').trim());
    });
  });
}

function isRepo(workdir) {
  return require('fs').existsSync(path.join(workdir, '.git'));
}

function makeWorktreeTool() {
  return {
    def: {
      type: 'function',
      function: {
        name: 'worktree',
        description: 'Git worktree isolation for the session project. Actions: create (new branch + worktree at .voxai/wt/<name>), status (list worktrees), merge (commit branch and merge into main), discard (delete branch + worktree). Only works if the workdir is a git repo. Commit with a message via `message`.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'status', 'merge', 'discard'] },
            name: { type: 'string', description: 'Worktree/branch name (create/discard).' },
            message: { type: 'string', description: 'Commit message for merge.' },
            base: { type: 'string', description: 'Base branch to branch from (default: current).' },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },
    },
    async run(args, ctx) {
      const root = ctx.workdir;
      if (!isRepo(root)) return { ok: false, error: 'workdir is not a git repository' };
      const action = args.action;
      const wtRoot = path.join(root, '.voxai', 'wt');
      const name = String(args.name || 'agent-task').replace(/[^A-Za-z0-9_./-]/g, '').slice(0, 60);

      if (action === 'status') {
        const out = await git(['worktree', 'list', '--porcelain'], root);
        // group into entries
        const entries = [];
        let cur = null;
        for (const line of out.split('\n')) {
          if (line.startsWith('worktree ')) { if (cur) entries.push(cur); cur = { path: line.slice(9) }; }
          else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
          else if (line.startsWith('branch ')) cur.branch = line.slice(7);
          else if (line.startsWith('bare')) cur.bare = true;
        }
        if (cur) entries.push(cur);
        return { ok: true, worktrees: entries.map((w) => ({ path: w.path, branch: w.branch, head: w.head })) };
      }

      if (action === 'create') {
        let base = String(args.base || '').trim();
        if (!base) {
          try { base = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root); }
          catch { base = 'main'; }  // unborn HEAD (empty repo) → branch from main
        }
        const wtPath = path.join(wtRoot, name);
        await fsp.mkdir(wtRoot, { recursive: true });
        try {
          await git(['worktree', 'add', '-b', name, wtPath, base], root);
        } catch (e) {
          // branch may exist; try without -b, else create main first
          try { await git(['worktree', 'add', wtPath, name], root); }
          catch (e2) {
            await git(['checkout', '-b', base], root).catch(() => {});
            await git(['worktree', 'add', '-b', name, wtPath, base], root);
          }
        }
        return { ok: true, branch: name, path: wtPath, base };
      }

      if (action === 'merge') {
        // commit everything in the worktree branch, checkout main, merge
        const wtPath = path.join(wtRoot, name);
        const mainBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
        await git(['-C', wtPath, 'add', '-A'], root);
        const status = await git(['-C', wtPath, 'status', '--porcelain'], root);
        if (status) {
          await git(['-C', wtPath, 'commit', '-m', String(args.message || `agent: ${name}`).slice(0, 200)], wtPath);
        }
        await git(['checkout', mainBranch], root);
        await git(['merge', name, '--no-edit'], root);
        // clean up worktree
        try { await git(['worktree', 'remove', wtPath, '--force'], root); } catch {}
        try { await git(['branch', '-d', name], root); } catch {}
        return { ok: true, merged: name, into: mainBranch, hadChanges: !!status };
      }

      if (action === 'discard') {
        const wtPath = path.join(wtRoot, name);
        try { await git(['worktree', 'remove', wtPath, '--force'], root); } catch {}
        try { await git(['branch', '-D', name], root); } catch {}
        return { ok: true, discarded: name };
      }

      throw new Error('unknown worktree action');
    },
  };
}

module.exports = { makeWorktreeTool };