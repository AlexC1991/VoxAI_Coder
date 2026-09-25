/**
 * sandbox — policy enforcement layer. Grants/denies tools per access level,
 * blocks dangerous shell patterns always, and reports worktree-isolation state.
 * Enforced by the agent loop (ctx.checkToolAllowed) before every tool call.
 */

// New canonical keys (stored in settings) + user-facing labels + migration.
// Old keys map to the new canonical form so previously-saved settings keep working.
const ACCESS_LEVELS = ['ask', 'edit', 'test', 'full'];
// The names the app shows (index.html ACCESS_LABELS), so what the agent tells the user
// to pick is what the menu says.
const ACCESS_LABELS = {
  ask: 'Ask first',
  edit: 'Edit files',
  test: 'Edit and test',
  // Like Claude Code's auto mode: edits and tests run as in "test", and anything that
  // would ask goes to a safety check first (agent.js autoCheck). Not on the ladder of
  // ACCESS_LEVELS: it is a different way of deciding, not a bigger allowance.
  auto: 'Auto',
  full: 'Full access',
};
// Old value -> new canonical value (migration for previously-saved settings)
const ACCESS_OLD = {
  'ask each time': 'ask',
  'edit files freely': 'edit',
  'edit + run tests': 'test',
  'full access': 'full',
};
function normalizeAccess(a) {
  if (a in ACCESS_OLD) return ACCESS_OLD[a];
  if (a in ACCESS_LABELS) return a;
  // label -> key fallback (if a label was saved by mistake)
  for (const k of Object.keys(ACCESS_LABELS)) if (ACCESS_LABELS[k] === a) return k;
  return 'ask'; // safe default = most restrictive
}
const labelFor = (a) => ACCESS_LABELS[normalizeAccess(a)] || 'Ask before changes';

// tool -> lowest access level that allows automatic execution (no prompt).
//
// Tools that fold several operations behind an `action` argument are keyed as
// "tool:action" so a read-only op keeps its read-only permission level. The plain
// tool name is the fallback when no action-specific entry exists. Without this,
// folding (e.g. stat + mkdir + move + remove -> fs) would force every member up to
// the most restrictive level in the group.
const AUTO_LEVEL = {
  read: 0, glob: 0, grep: 0, stat: 0, search: 0, todo: 0, skills_list: 0, skill_load: 0,
  mcp_list_tools: 0, doc_rag: 0, web_fetch: 1, web_search: 1,
  write: 1, edit: 1, patch: 1, mkdir: 1, move: 1, remove: 1, lsp: 0, memory: 1,
  worktree: 1, snapshot: 0, node_repl: 1, spawn_agent: 2, artifact_publish: 0,
  browser_open: 3, browser_act: 3, browser_screenshot: 3, shell: 3, mcp_call: 3,
  ask_user: 0, ask_confirm: 0, build_state: 1,
  agents: 0, 'agents:cancel': 0, 'agents:wait': 0,

  // folded surfaces
  fs: 1,
  'fs:stat': 0,
  'fs:mkdir': 1, 'fs:move': 1, 'fs:remove': 1,
  // Restoring writes files back over what is there now: a change, like any edit. It ran
  // without asking under "Ask first". Saving and listing change nothing.
  'snapshot:restore': 1, 'snapshot:create': 0, 'snapshot:list': 0,
  skill: 0, 'skill:list': 0, 'skill:load': 0,
  mcp: 3, 'mcp:list_tools': 0, 'mcp:call': 3,
  computer: 3,
};
// tools that are NEVER auto-allowed below 'full access' (always prompt at lower levels)
const ALWAYS_PROMPT = ['browser_open', 'browser_act', 'browser_screenshot', 'spawn_agent', 'spawn_parallel', 'mcp_call',
  'cu_launch', 'cu_state', 'cu_click', 'cu_type', 'cu_press', 'cu_scroll', 'cu_screenshot', 'cu_list',
  'computer', 'mcp:call'];

/**
 * Resolve the policy key for a call. A folded tool carries its operation in an
 * argument, so the name alone is not enough to decide whether the call is a read
 * or a mutation.
 */
function policyKey(name, args) {
  const act = args && (args.action || args.op);
  if (act) {
    const scoped = `${name}:${String(act)}`;
    if (scoped in AUTO_LEVEL || ALWAYS_PROMPT.includes(scoped)) return scoped;
  }
  return name;
}

// dangerous shell patterns blocked at every level
const DANGEROUS = [
  /rm\s+(-[a-z]*r|-r[a-z]*|--recursive)\s+[\/\\](?!voxai)/i, // rm -rf / (root)
  /^\s*(del|rmdir|rd)\s+\/?[a-z]:[\\\/]/i,
  /format\s+[a-z]:/i,
  /diskpart/i,
  /reg\s+delete/i,
  /shutdown\s+(\/s|-s)/i,
  /taskkill\s+\/f\s+\/im\s+(explorer|winlogon|csrss|lsass)/i,
  />([^\/]*)[\\\/](boot|system32)[\\\/]/i,
];

function levelIndex(access) {
  const a = normalizeAccess(access);
  // Auto allows what "test" allows outright; the rest is checked, not auto-approved.
  if (a === 'auto') return ACCESS_LEVELS.indexOf('test');
  return Math.max(0, ACCESS_LEVELS.indexOf(a));
}

/**
 * Is this shell command only looking? Listing a folder, reading a file, git status --
 * asking about those every time was the most common prompt in a live run, and they
 * change nothing. Strict on purpose: every piece of a chain must be on the list, and
 * redirection, command substitution or anything unknown makes the whole thing ask.
 */
const READ_ONLY_CMDS = new Set(['dir', 'ls', 'pwd', 'cd', 'echo', 'type', 'cat', 'head', 'tail', 'more', 'less',
  'findstr', 'grep', 'rg', 'where', 'which', 'whoami', 'hostname', 'ver', 'tree', 'wc', 'stat', 'file', 'du', 'df', 'date']);
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'reflog']);
function isReadOnlyCommand(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return false;
  // Silencing or merging error output writes nothing anywhere: 2>NUL, >/dev/null, 2>&1.
  // Models add these to almost every look-around command, which kept them asking.
  const quiet = s.replace(/\s*\d?>\s*(nul|\/dev\/null)(?=\s|$|[&|;])/gi, ' ').replace(/\s*2>&1/g, ' ');
  // Any other redirection, substitution, variable expansion or escape is out.
  if (/[<>`]|\$\(|%[^%\s]+%|\^/.test(quiet)) return false;
  // A lone & is "then" in cmd.exe (and a background job in sh -- still only looking).
  const parts = quiet.split(/&&|\|\||;|\||&/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  return parts.every((p) => {
    const words = p.split(/\s+/);
    const w0 = words[0].toLowerCase().replace(/\.exe$/, '');
    if (w0 === 'git') {
      const sub = (words[1] || '').toLowerCase();
      if (sub === 'branch') return words.slice(2).every((x) => /^(-a|-r|-v|-vv|--list|--all|--show-current)$/.test(x));
      if (sub === 'remote') return words.slice(2).every((x) => x === '-v');
      if (sub === 'config') return words.slice(2).some((x) => x === '--get' || x === '--list' || x === '-l');
      return READ_ONLY_GIT.has(sub) && !words.some((x) => /^--output/.test(x));
    }
    if (['node', 'npm', 'python', 'python3', 'py', 'pip', 'dotnet', 'java', 'go', 'cargo', 'rustc', 'deno', 'bun'].includes(w0)) {
      return words.length === 2 && /^(--version|-v|-V|version)$/.test(words[1]) || (w0 === 'npm' && /^(ls|list|outdated|view|root|prefix)$/.test(words[1] || ''));
    }
    if (w0 === 'find') return !words.some((x) => /^-(exec|execdir|delete|ok|fprint)/.test(x));
    if (w0 === 'sort') return !words.some((x) => /^(-o|\/o)$/i.test(x));
    return READ_ONLY_CMDS.has(w0);
  });
}

function checkToolAllowed(toolName, access, extra) {
  const lvl = levelIndex(access);
  // `extra` carries the call's arguments so a folded tool is judged on the
  // operation it is actually performing, not on the name of the surface.
  const key = policyKey(toolName, extra);
  const auto = AUTO_LEVEL[key] !== undefined ? AUTO_LEVEL[key]
    : (AUTO_LEVEL[toolName] !== undefined ? AUTO_LEVEL[toolName] : 0);
  // ALWAYS_PROMPT entries are gated by USER PERMISSION, not hard-blocked: at full
  // access they auto-allow (autonomous mode); below that the agent loop routes them
  // through askPermission rather than failing the call.
  if (ALWAYS_PROMPT.includes(key) || (key === toolName && ALWAYS_PROMPT.includes(toolName))) {
    return {
      allowed: lvl >= 3,                 // full access == autonomous auto-allow
      needsPermission: lvl < 3,          // below full access → prompt the user
      reason: `requires permission (level ${ACCESS_LABELS[ACCESS_LEVELS[lvl]]})`,
    };
  }
  if (lvl < auto) {
    return { allowed: false, needsPermission: true, reason: `tool requires level "${ACCESS_LABELS[ACCESS_LEVELS[auto]]}"+` };
  }
  return { allowed: true, needsPermission: false };
}

function checkShellCommand(cmd) {
  for (const re of DANGEROUS) if (re.test(String(cmd || ''))) return { blocked: true, pattern: String(re) };
  return { blocked: false };
}

function worktreeIsolationInfo(workdir) {
  // when the session is operating inside a .voxai/wt/<branch> worktree, note it
  const rel = String(workdir || '').replace(/\\/g, '/');
  const m = rel.match(/\.voxai\/wt\/([^/]+)$/);
  return { inWorktree: !!m, branch: m ? m[1] : null };
}

function makeSandboxTool({ getAccess }) {
  return {
    defs: [
      {
        type: 'function',
        function: {
          name: 'sandbox_status',
          description: 'Report the current access level and which tools are auto-allowed vs require permission, plus worktree isolation state.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    ],
    async run(name, args, ctx) {
      const access = normalizeAccess((getAccess && getAccess()) || ctx.access || 'test');
      const lvl = levelIndex(access);
      const tools = Object.entries(AUTO_LEVEL).map(([t, a]) => ({ tool: t, auto: lvl >= a }));
      return {
        access,
        accessLabel: labelFor(access),
        inWorktree: worktreeIsolationInfo(ctx.workdir).inWorktree,
        branch: worktreeIsolationInfo(ctx.workdir).branch,
        tools,
      };
    },
  };
}

module.exports = { checkToolAllowed, checkShellCommand, worktreeIsolationInfo, makeSandboxTool, ACCESS_LEVELS, ACCESS_LABELS, normalizeAccess, labelFor, isReadOnlyCommand };