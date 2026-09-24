/**
 * skills — load skill instructions from the user's installed skill dirs.
 * Reads ~/.codex/skills, ~/.claude/skills and app-user skills. A skill is a
 * directory containing SKILL.md (Codex/Goose convention) or a folder with
 * index.md/README.md (Claude convention). Exposes skills_list / skill_load.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const MAX_SKILL_BYTES = 300 * 1024;

function candidateRoots() {
  const home = os.homedir();
  const roots = [
    path.join(home, '.codex', 'skills'),
    path.join(home, '.claude', 'skills'),
    process.env.VOXAI_SKILLS_DIR ? path.resolve(process.env.VOXAI_SKILLS_DIR) : null,
  ];
  if (process.env.VOXAI_SKILLS_DIR && process.platform === 'win32') {
    // npm-style global skills
    const p = process.execPath;
    const base = path.dirname(path.dirname(path.dirname(p)));
    roots.push(path.join(base, 'skills'));
  }
  return roots.filter(Boolean);
}

async function findSkills() {
  const out = [];
  const seen = new Set();
  for (const root of candidateRoots()) {
    let entries = [];
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      const entryFile = ['SKILL.md', 'index.md', 'README.md', 'skill.md'].find(
        (f) => fs.existsSync(path.join(dir, f))
      );
      if (!entryFile) continue;
      const key = e.name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: key, root: dir, entry: entryFile, source: root });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function loadSkill(name, root) {
  const maybe = root || (await findSkills()).find((s) => s.name === name);
  if (!maybe) return null;
  const file = path.join(maybe.root, maybe.entry);
  const st = await fsp.stat(file);
  if (st.size > MAX_SKILL_BYTES) return { name, truncated: true, size: st.size };
  const text = await fsp.readFile(file, 'utf8');
  // also collect sibling files that look like instructions (small .md)
  const extras = [];
  let files = [];
  try { files = await fsp.readdir(maybe.root); } catch {}
  for (const f of files.sort()) {
    if (f === maybe.entry) continue;
    if (/\.(md|markdown|txt|mdc)$/i.test(f)) {
      const fp = path.join(maybe.root, f);
      try {
        const st2 = await fsp.stat(fp);
        if (st2.size <= 100 * 1024) extras.push({ file: f, content: await fsp.readFile(fp, 'utf8') });
      } catch {}
    }
  }
  return { name: maybe.name, entry: maybe.entry, content: text, extras };
}

function makeSkillsTool() {
  return {
    defs: [
      {
        type: 'function',
        function: {
          name: 'skills_list',
          description: 'List available skills (from ~/.codex/skills and ~/.claude/skills) with their entry file.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      {
        type: 'function',
        function: {
          name: 'skill_load',
          description: 'Load a skill by name (see skills_list) and return its instructions. Use before working in that domain.',
          parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
        },
      },
    ],
    async run(name, args) {
      if (name === 'skills_list') {
        const skills = await findSkills();
        return { count: skills.length, skills: skills.map((s) => ({ name: s.name, entry: s.entry })) };
      }
      if (name === 'skill_load') {
        const s = await loadSkill(String(args.name || ''));
        if (!s) return { ok: false, error: 'skill not found — run skills_list' };
        return s;
      }
      throw new Error('unknown skills tool');
    },
  };
}

module.exports = { makeSkillsTool, findSkills, loadSkill };