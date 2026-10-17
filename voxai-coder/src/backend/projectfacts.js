'use strict';
/**
 * What the agent is told about the project at the start of a session, kept small.
 *
 *   pickFacts    the project memory facts that matter to this session. Every request carried up
 *                to 60 facts of up to 300 characters (one project: 43 facts, about 3,100 tokens
 *                on every request, whatever the task). Now: the facts most related to the
 *                session's opening request, plus every fact saved during the session; the rest
 *                are one memory search away. Scored against the OPENING request, so the choice
 *                -- and the cached start of every request -- stays the same through the session.
 *
 *   detectCommands  how to test, build and lint this project, from its own files, so "run the
 *                tests" names a command instead of leaving the model to guess one.
 */
const fs = require('fs');
const path = require('path');

const STOP = new Set(('the and for with that this from into have has was were are not but you your our they them then than what when where which while will would should could about after before there their these those just also only some more most very can cant dont does done make made need needs want wants use used using file files code app run runs work works like into onto over under please thanks hello').split(' '));
const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9_.\-/]{3,}/g) || [];
const keyWords = (s) => new Set(words(s).filter((w) => !STOP.has(w)));

/**
 * The facts to show: up to `keep` most related to `query` (ties go to the newer), in their stored
 * order, plus every fact saved after `since`. { shown: facts, more: how many are left out }.
 */
function pickFacts(facts, { query = '', since = '', keep = 12 } = {}) {
  const all = (facts || []).map((f, i) => ({ f, i, text: String((f && f.text) || f || ''), at: String((f && f.at) || '') }));
  if (all.length <= keep) return { shown: all.map((x) => x.f), more: 0 };
  const q = keyWords(query);
  const fresh = since ? all.filter((x) => x.at && x.at > since) : [];
  const freshSet = new Set(fresh.map((x) => x.i));
  const scored = all.filter((x) => !freshSet.has(x.i)).map((x) => {
    const w = keyWords(x.text);
    let s = 0; for (const t of q) if (w.has(t)) s += t.length >= 6 ? 2 : 1;
    return { ...x, s };
  }).sort((a, b) => b.s - a.s || b.i - a.i);
  const chosen = new Set(scored.slice(0, keep).map((x) => x.i));
  for (const x of fresh) chosen.add(x.i);
  const shown = all.filter((x) => chosen.has(x.i)).map((x) => x.f);
  return { shown, more: all.length - shown.length };
}

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/** How to test, build and lint the project: [{ what, command }]. Nothing found, []. */
function detectCommands(workdir) {
  const out = [];
  const add = (what, command) => { if (command && !out.some((x) => x.what === what)) out.push({ what, command }); };
  const pkg = readJson(path.join(workdir, 'package.json'));
  if (pkg && pkg.scripts) {
    const pm = exists(path.join(workdir, 'pnpm-lock.yaml')) ? 'pnpm' : exists(path.join(workdir, 'yarn.lock')) ? 'yarn' : exists(path.join(workdir, 'bun.lockb')) || exists(path.join(workdir, 'bun.lock')) ? 'bun' : 'npm';
    const run = (name) => (pm === 'npm' ? (name === 'test' ? 'npm test' : `npm run ${name}`) : `${pm} ${name === 'test' && pm !== 'bun' ? 'test' : 'run ' + name}`);
    const t = String(pkg.scripts.test || '');
    // npm init's placeholder only fails: "Error: no test specified".
    if (t && !/no test specified/i.test(t)) add('Tests', run('test'));
    for (const name of ['typecheck', 'build', 'lint']) if (pkg.scripts[name]) add(name === 'typecheck' ? 'Type check' : name[0].toUpperCase() + name.slice(1), run(name));
    if (pkg.scripts.dev) add('Dev server', run('dev'));
    else if (pkg.scripts.start) add('Start', run('start'));
  }
  if (exists(path.join(workdir, 'Cargo.toml'))) { add('Tests', 'cargo test'); add('Build', 'cargo build'); }
  if (exists(path.join(workdir, 'go.mod'))) { add('Tests', 'go test ./...'); add('Build', 'go build ./...'); }
  if (exists(path.join(workdir, 'pytest.ini')) || exists(path.join(workdir, 'pyproject.toml')) || exists(path.join(workdir, 'tox.ini')) || exists(path.join(workdir, 'setup.cfg'))) {
    const py = (() => { try { return fs.readFileSync(path.join(workdir, 'pyproject.toml'), 'utf8'); } catch { return ''; } })();
    if (exists(path.join(workdir, 'pytest.ini')) || /pytest/.test(py) || exists(path.join(workdir, 'tests')) || exists(path.join(workdir, 'test'))) add('Tests', 'python -m pytest');
  }
  try {
    const mk = fs.readFileSync(path.join(workdir, 'Makefile'), 'utf8');
    if (/^test\s*:/m.test(mk)) add('Tests', 'make test');
    if (/^build\s*:/m.test(mk)) add('Build', 'make build');
  } catch { /* no Makefile */ }
  try {
    if (fs.readdirSync(workdir).some((f) => /\.(sln|csproj)$/i.test(f))) { add('Tests', 'dotnet test'); add('Build', 'dotnet build'); }
  } catch { /* unreadable */ }
  return out;
}

/** The [PROJECT COMMANDS] section, or ''. */
function commandsSection(workdir) {
  const c = detectCommands(workdir);
  if (!c.length) return '';
  return '[PROJECT COMMANDS] Found in the project\'s own files. Use these to check your work, rather than guessing a command:\n'
    + c.map((x) => `- ${x.what}: ${x.command}`).join('\n');
}

// What a project is, at a glance: its folders, its key files, the frameworks it uses and the
// start of its README -- so a session starts working instead of spending its first steps
// listing and opening files. Only things that rarely change (no file counts, no git status),
// so the session's fixed prompt is not disturbed every time a file is added.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'release', 'coverage', '.next', '.nuxt', 'target', 'venv', '.venv', '__pycache__', '.idea', '.vscode', '.voxai', '.cache', 'tmp', 'temp', 'vendor']);
const KEY_FILE = /^(package\.json|tsconfig(\.\w+)?\.json|vite\.config\.\w+|next\.config\.\w+|astro\.config\.\w+|svelte\.config\.\w+|webpack\.config\.\w+|electron-builder\.\w+|wrangler\.(toml|json|jsonc)|cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt|setup\.py|makefile|cmakelists\.txt|dockerfile|docker-compose\.ya?ml|readme(\.\w+)?|agents\.md|claude\.md|\.env\.example|index\.html|manage\.py|gemfile|pom\.xml|build\.gradle(\.kts)?|\w+\.sln|\w+\.csproj)$/i;
const STACK = ['react', 'next', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', 'astro', 'solid-js', 'angular', '@angular/core', 'electron', 'vite', 'webpack', 'express', 'fastify', 'hono', 'koa', 'typescript', 'tailwindcss', 'three', 'phaser', 'pixi.js', 'prisma', 'drizzle-orm', 'mongoose', 'jest', 'vitest', 'mocha', 'playwright', '@playwright/test', 'cypress', 'wrangler', 'react-native', 'expo'];

function overviewSection(workdir, { local = false } = {}) {
  let ents = [];
  try { ents = fs.readdirSync(workdir, { withFileTypes: true }); } catch { return ''; }
  const dirs = ents.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')).map((e) => e.name + '/').sort().slice(0, 25);
  const files = ents.filter((e) => e.isFile() && KEY_FILE.test(e.name)).map((e) => e.name).sort();
  if (!dirs.length && !files.length) return '';
  const lines = [`[PROJECT OVERVIEW] ${path.basename(workdir)}, at a glance (from its files when the session started; read them for detail):`];
  if (dirs.length) lines.push('Folders: ' + dirs.join(', '));
  if (files.length) lines.push('Key files: ' + files.join(', '));
  const pkg = readJson(path.join(workdir, 'package.json'));
  if (pkg) {
    const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
    const stack = STACK.filter((d) => deps[d]);
    if (stack.length) lines.push('Uses: ' + stack.join(', '));
    if (pkg.description) lines.push('About: ' + String(pkg.description).slice(0, 200));
  }
  if (!local) {
    const readme = files.find((f) => /^readme(\.md|\.txt)?$/i.test(f));
    if (readme) {
      try {
        const text = fs.readFileSync(path.join(workdir, readme), 'utf8')
          .split(/\r?\n/).filter((l) => l.trim() && !/^\s*(!\[|<img|\[!\[|<p align|<\/?div)/i.test(l)).slice(0, 8).join(' ').replace(/\s+/g, ' ').slice(0, 500);
        if (text) lines.push('README begins: ' + text);
      } catch { /* unreadable */ }
    }
  }
  return lines.join('\n');
}

module.exports = { pickFacts, detectCommands, commandsSection, overviewSection };
