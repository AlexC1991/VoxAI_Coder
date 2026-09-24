/**
 * sandbox — policy enforcement layer. Grants/denies tools per access level,
 * blocks dangerous shell patterns always, and reports worktree-isolation state.
 * Enforced by the agent loop (ctx.checkToolAllowed) before every tool call.
 */

// New canonical keys (stored in settings) + user-facing labels + migration.
// Old keys map to the new canonical form so previously-saved settings keep working.
const ACCESS_LEVELS = ['ask', 'edit', 'test', 'full'];
const ACCESS_LABELS = {
  ask: 'Ask before changes',
  edit: 'Auto-edit files',
  test: 'Auto-edit + tests',
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
  return Math.max(0, ACCESS_LEVELS.indexOf(normalizeAccess(access)));
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

module.exports = { checkToolAllowed, checkShellCommand, worktreeIsolationInfo, makeSandboxTool, ACCESS_LEVELS, ACCESS_LABELS, normalizeAccess, labelFor };