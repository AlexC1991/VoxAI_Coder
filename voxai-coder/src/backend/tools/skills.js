/**
 * skills — instructions for a particular tool, service or kind of work, loaded when a
 * task needs them. A skill is a folder with SKILL.md (Codex / Claude / Goose
 * convention; index.md or README.md also work) whose front matter gives a `name` and a
 * one-line `description` -- the line the agent reads to decide whether to load it.
 *
 * Where skills come from, first match wins by name:
 *   1. the project:      <project>/.voxai/skills
 *   2. yours:            <userData>/skills   (Settings > Skills opens it)
 *   3. built in:         resources/skills, shipped with the app
 *   4. Claude Code:      ~/.claude/skills
 *   5. Codex:            ~/.codex/skills
 *
 * It used to read only (4) and (5), list names without descriptions, and nothing told
 * the agent skills existed, so none was ever loaded. A skill's reference files (the
 * official Cloudflare skill points into 321 of them) were out of reach too: `read` is
 * confined to the project.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const MAX_SKILL_BYTES = 300 * 1024;
// A skill is read in parts this size. Tool results are cut at the user's limit (8,000
// characters by default), which dropped the middle of any longer skill; agent.js lets
// a skill part through whole.
const PART_CHARS = 24000;
const BUILT_IN = path.join(__dirname, '..', '..', '..', 'resources', 'skills');

function candidateRoots({ workdir, userData } = {}) {
  const home = os.homedir();
  const roots = [
    workdir ? { dir: path.join(workdir, '.voxai', 'skills'), source: 'project' } : null,
    userData ? { dir: path.join(userData, 'skills'), source: 'yours' } : null,
    { dir: BUILT_IN, source: 'built in' },
    { dir: path.join(home, '.claude', 'skills'), source: 'Claude Code' },
    { dir: path.join(home, '.codex', 'skills'), source: 'Codex' },
    process.env.VOXAI_SKILLS_DIR ? { dir: path.resolve(process.env.VOXAI_SKILLS_DIR), source: 'VOXAI_SKILLS_DIR' } : null,
  ];
  return roots.filter(Boolean);
}

/** The `name:` and `description:` from a skill file's front matter. */
function frontMatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === '|' || v === '>' || v === '>-' || v === '|-') {
      // A block: the indented lines that follow.
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      v = block.join(' ');
    }
    out[kv[1]] = v.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  }
  return out;
}

const ENTRY_FILES = ['SKILL.md', 'skill.md', 'index.md', 'README.md'];

async function isDir(p) { try { return (await fsp.stat(p)).isDirectory(); } catch { return false; } }

async function findSkills(where = {}) {
  const out = [];
  const seen = new Set();
  for (const root of candidateRoots(where)) {
    let names = [];
    try { names = await fsp.readdir(root.dir); } catch { continue; }
    for (const name of names.sort()) {
      if (name.startsWith('.') || seen.has(name)) continue;
      const dir = path.join(root.dir, name);
      if (!(await isDir(dir))) continue;
      const entry = ENTRY_FILES.find((f) => fs.existsSync(path.join(dir, f)));
      if (!entry) continue;
      let head = '';
      try { head = (await fsp.readFile(path.join(dir, entry), 'utf8')).slice(0, 4000); } catch {}
      const fm = frontMatter(head);
      seen.add(name);
      out.push({ name, description: String(fm.description || '').replace(/\s+/g, ' ').trim(), source: root.source, root: dir, entry });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Every file in a skill's folder, as paths relative to it (for `file`). */
async function listFiles(root, max = 400) {
  const out = [];
  const walk = async (dir, rel) => {
    let names = [];
    try { names = (await fsp.readdir(dir)).sort(); } catch { return; }
    for (const n of names) {
      if (out.length >= max || n.startsWith('.')) continue;
      const p = path.join(dir, n), r = rel ? rel + '/' + n : n;
      if (await isDir(p)) await walk(p, r);
      else out.push(r);
    }
  };
  await walk(root, '');
  return out;
}

/**
 * A skill's instructions, a part at a time (`part`, from 1), or one of its own files
 * (`file`, relative to the skill's folder -- nothing outside it).
 */
async function loadSkill(name, where = {}, { part = 1, file = '' } = {}) {
  const s = (await findSkills(where)).find((x) => x.name === name);
  if (!s) return null;
  let target = path.join(s.root, s.entry);
  if (file) {
    const abs = path.resolve(s.root, String(file));
    const rel = path.relative(s.root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: `"${file}" is not inside the ${name} skill's folder.` };
    if (await isDir(abs)) {
      const files = (await listFiles(abs, 200)).map((f) => rel.replace(/\\/g, '/') + '/' + f);
      return { ok: true, name, folder: rel.replace(/\\/g, '/'), files };
    }
    target = abs;
  }
  let st;
  try { st = await fsp.stat(target); } catch { return { ok: false, error: `The ${name} skill has no file "${file}". Its files are listed when you load it.` }; }
  if (st.size > MAX_SKILL_BYTES) return { ok: false, error: `${file || s.entry} is ${st.size.toLocaleString()} bytes, too big to load.` };
  const text = await fsp.readFile(target, 'utf8');
  const parts = Math.max(1, Math.ceil(text.length / PART_CHARS));
  const n = Math.min(Math.max(1, Math.floor(Number(part) || 1)), parts);
  const out = {
    ok: true, name, source: s.source,
    file: file ? String(file).replace(/\\/g, '/') : s.entry,
    content: text.slice((n - 1) * PART_CHARS, n * PART_CHARS),
  };
  if (parts > 1) out.part = `${n} of ${parts}` + (n < parts ? ` -- load again with part ${n + 1} for the rest` : '');
  // The first time, what else the skill has, so its references can be opened with `file`.
  if (!file && n === 1) {
    const files = (await listFiles(s.root)).filter((f) => f !== s.entry);
    if (files.length) {
      out.files = files.length > 150
        ? [...new Set(files.map((f) => f.split('/').slice(0, 2).join('/') + (f.split('/').length > 2 ? '/' : '')))]
        : files;
      out.howToOpen = 'Open one with action "load", this name and `file` (a folder lists what is in it).';
    }
  }
  return out;
}

/** The index the agent reads at the start of a run: one line per skill that says what it is for. */
async function skillsIndex(where = {}, max = 40) {
  const skills = (await findSkills(where)).filter((s) => s.description);
  if (!skills.length) return '';
  const lines = skills.slice(0, max).map((s) => `- ${s.name}: ${s.description.length > 200 ? s.description.slice(0, 197) + '...' : s.description}`);
  return `[SKILLS] Instructions for particular tools, services and kinds of work. When a task touches one, `
    + `load it first with the skill tool (action "load", name) and follow it; its reference files open with \`file\`.\n`
    + lines.join('\n')
    + (skills.length > max ? `\n(${skills.length - max} more: skill action "list")` : '');
}

function makeSkillsTool(where = {}) {
  return {
    defs: [
      {
        type: 'function',
        function: {
          name: 'skills_list',
          description: 'List the skills available: name, what each is for, and where it comes from (the project, yours, built in, Claude Code, Codex).',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      {
        type: 'function',
        function: {
          name: 'skill_load',
          description: 'Load a skill by name and follow it. Long skills come in parts (`part`); a skill\'s own reference files open with `file`.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              part: { type: 'integer', description: 'Which part of a long skill, from 1.' },
              file: { type: 'string', description: 'One of the skill\'s own files or folders, relative to it (e.g. "references/workers/README.md").' },
            },
            required: ['name'], additionalProperties: false,
          },
        },
      },
    ],
    async run(name, args, ctx) {
      const w = { workdir: (ctx && ctx.workdir) || where.workdir, userData: (ctx && ctx.userData) || where.userData };
      if (name === 'skills_list') {
        const skills = await findSkills(w);
        return { count: skills.length, skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source })) };
      }
      if (name === 'skill_load') {
        const s = await loadSkill(String(args.name || ''), w, { part: args.part, file: args.file });
        if (!s) return { ok: false, error: `No skill called "${args.name}". Use action "list" to see them.` };
        return s;
      }
      throw new Error('unknown skills tool');
    },
  };
}

module.exports = { makeSkillsTool, findSkills, loadSkill, skillsIndex, frontMatter, candidateRoots, PART_CHARS };
