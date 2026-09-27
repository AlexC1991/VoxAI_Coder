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
  'cu_launch', 'cu_state', 'cu_click', 'cu_type', 'cu_press', 'cu_scroll', 'cu_screenshot', 'cu_list', 'cu_focus',
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

/**
 * Does a command point outside the project, or at something secret? Absolute paths not
 * under the project folder, climbing out with ..\, home and profile folders, and variables
 * that expand to places. "Only looking" read C:\Users\...\.ssh\id_rsa without a word
 * (found by scripts/auto-battery.js).
 */
const SECRET_PATH = /(\.ssh\b|id_rsa|id_ed25519|id_ecdsa|\.aws\b|\.azure\b|\.gnupg|\.kube\b|\.docker[\\/]config|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials\.json|voxai-settings|update-key\.pem|Login Data|Cookies|wallet\.dat|\.kdbx)/i;
function touchesOutside(cmd, workdir) {
  const s = String(cmd || '');
  if (SECRET_PATH.test(s)) return true;
  if (/(^|[\s"'=])(~[\\/]|\.\.[\\/]|\.\.$)|%(USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH|HOMEDRIVE|PROGRAMDATA|SYSTEMROOT|WINDIR|TEMP|TMP)%|\$env:|\$HOME\b|\\\\[\w.-]+\\/i.test(s)) return true;
  const root = String(workdir || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const abs = s.match(/\b[a-z]:[\\/][^\s"'&|;<>]*/gi) || [];
  return abs.some((p) => {
    const q = p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    return !root || !(q === root || q.startsWith(root + '\\'));
  });
}

/**
 * Ordinary work in the project, allowed in Auto without a check: installing the project's
 * packages, its scripts, running its files, building with its toolchain, local git, making
 * and moving things inside it, and trying the local server. Every piece of a chain must be
 * one of these (or only looking); nothing may point outside the project (touchesOutside);
 * redirection only into a project file. Anything else goes to the check -- which is not a
 * no, only a second look. The check asked about `python app.py` and `git stash`, and the
 * user: "auto still asking me for CMD commands that isn't bad".
 */
const PROJECT_CMDS = [
  /^(npm|pnpm|yarn)(\.cmd)?\s+(install|i|ci|add|remove|rm|uninstall|update|up|run|run-script|start|test|t|build|dev|rebuild|dedupe|prune|init|create|audit\s+fix)\b(?!.*\s(-g|--global|--location[= ]global)\b)/i,
  /^(npm|pnpm|yarn)(\.cmd)?\s+(test|start|install|i|ci)$/i,
  /^node(\.exe)?\s+(--[\w-]+\s+)*(?!-)[\w.\/\\-]+\.(m?js|cjs|ts)\b/i,
  /^(python3?|py)(\.exe)?\s+((-m\s+(venv|pip\s+install|pytest|unittest|http\.server)\b)|(?!-)[\w.\/\\-]+\.py\b)/i,
  /^(\.?venv|env)[\\/](Scripts|bin)[\\/](python3?|pip3?)(\.exe)?\s/i,
  /^pip3?(\.exe)?\s+install\b/i,
  /^(mkdir|md)\s/i,
  /^cd(\s+\/d)?\s/i,
  /^git\s+(init|add|commit|checkout\s+-b|checkout\s+(?!-)[\w\/.-]+$|switch|stash(\s+(push|pop|apply|list))?|fetch|pull|merge\s+(?!-)[\w\/.-]+$|tag\s+(?!-d)|branch\s+(?!-D|-d|--delete)[\w\/.-]+$|mv)\b/i,
  /^dotnet\s+(build|run|test|restore|new|add|watch)\b/i,
  /^cargo\s+(build|run|test|check|fmt|clippy|add|new|init)\b/i,
  /^go\s+(build|run|test|vet|fmt|mod\s+(tidy|init|download)|get)\b/i,
  /^(copy|xcopy|robocopy|move|ren|rename)\s/i,
  /^(timeout\s+\/t\s+\d+|ping\s+-n\s+\d+\s+127\.0\.0\.1)\b/i,
  // The project's own scripts, by a path inside it.
  /^(bash|sh)(\.exe)?\s+(?!-)[\w.\/\\-]+\.sh\b/i,
  /^(powershell|pwsh)(\.exe)?\s+(-NoProfile\s+|-ExecutionPolicy\s+Bypass\s+|-ep\s+bypass\s+)*-File\s+"?(?![a-z]:|[\\/]|\.\.)[\w.\/\\ -]+\.ps1"?(\s|$)/i,
  /^(cmd(\.exe)?\s+\/c\s+)?"?(\.\\)?(?![a-z]:|[\\/]|\.\.)[\w.\/\\-]+\.(bat|cmd)"?(\s|$)/i,
  // One project file by name (no wildcards, not the whole tree).
  /^(del|erase)\s+(\/[fq]\s+)*(?!.*[*?])(?!.*\s\/s\b)[\w.\/\\ -]+$/i,
  // Build output, installed packages and caches: made again by the next build or install.
  /^(rd|rmdir)\s+(\/[sq]\s+)*"?(\.\\)?(dist|build|out|node_modules|\.next|\.nuxt|\.cache|\.parcel-cache|\.vite|coverage|__pycache__|\.pytest_cache|target|bin|obj)"?$/i,
];
function isProjectCommand(cmd, workdir) {
  const s = String(cmd || '').trim();
  if (!s || touchesOutside(s, workdir)) return false;
  // Quieting output is not writing: 2>NUL, >/dev/null, 2>&1.
  let q = s.replace(/\s*\d?>\s*(nul|\/dev\/null)(?=\s|$|[&|;])/gi, ' ').replace(/\s*2>&1/g, ' ');
  // Into a project file is fine (echo PORT=3000> .env); anywhere else, the check decides.
  q = q.replace(/\s*\d?>>?\s*("?)([^\s"&|;<>]+)\1/g, (m, _q, target) => (/^[a-z]:|^[\\/]|\.\./i.test(target) ? m : ' '));
  if (/[<>`]|\$\(|%[^%\s]+%|\^/.test(q)) return false;
  const parts = q.split(/&&|\|\||;|\||&/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  return parts.every((p) => {
    if (isReadOnlyCommand(p)) return true;
    if (PROJECT_CMDS.some((re) => re.test(p))) return true;
    // Trying the project's own local server.
    if (/^(curl|wget)(\.exe)?\s/i.test(p) || /^start\s+https?:/i.test(p) || /^powershell(\.exe)?\s+(-\w+\s+)*-Command\s+"?Invoke-WebRequest\s/i.test(p)) {
      const urls = p.match(/https?:\/\/[^\s"']+|(?<=\s)(localhost|127\.0\.0\.1)(:\d+)?[^\s"']*/gi) || [];
      return urls.length > 0 && urls.every((u) => /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u)) && !/\s(-T|--upload-file|-o|--output|-O)\b/.test(p);
    }
    return false;
  });
}

/**
 * Always the user's call in Auto, whatever the check would say: the kinds of command whose
 * harm is known. The check (a cheap model with no thinking) passed a global npm install,
 * winget, and copying VoxAI's own settings (the API key) into the project, now and then --
 * a rule never does. Returns why, said to the user, or ''.
 */
const RISKY = [
  [/\b(npm|pnpm|yarn)(\.cmd)?\s+(publish|unpublish|login|adduser|logout|token|owner|access|deprecate)\b/i, 'it publishes or signs in to a package registry'],
  [/\b(npm|pnpm)(\.cmd)?\s+.*(\s-g\b|--global\b|--location[= ]global)|\byarn\s+global\b/i, 'it installs outside the project, for the whole machine'],
  [/\b(winget|choco|chocolatey|scoop|msiexec)(\.exe)?\s+(install|uninstall|upgrade|\/i|\/x)/i, 'it installs or removes software on the machine'],
  [/\bpip3?(\.exe)?\s+(install|uninstall)\b.*\s--user\b|\bpip3?\s+uninstall\b/i, 'it changes Python packages outside the project'],
  [/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*[fx]|filter-branch|filter-repo|rebase\b|update-ref\s+-d)|\bgit\s+(config\s+(--global|--system)|remote\s+(add|set-url|remove))/i, 'it changes git history, remotes or your global git settings, or pushes code out'],
  [/\bgh\s+(repo|release|pr|issue|gist|secret|api)\b|\bglab\s|\bcbx\s+(submit|release|delete|mark)\b|\bscp\s|\brsync\s.*:|\bsftp\s|\bftp\s/i, 'it sends code or data to an outside service'],
  [/\b(curl|wget)(\.exe)?\s[^|]*(\s-F\b|--form\b|\s-T\b|--upload-file|--data-binary\s+@|\s-d\s+@)/i, 'it uploads a file'],
  [/\|\s*(sh|bash|zsh|iex|invoke-expression|powershell|pwsh|cmd)(\.exe)?\b|\biex\s*\(|invoke-expression/i, 'it downloads and runs a script'],
  [/\b(setx|reg(\.exe)?\s+(add|delete|import)|schtasks|sc(\.exe)?\s+(create|config|delete|stop|start)|net\s+(user|localgroup|share|stop|start)|netsh\b|bcdedit|set-executionpolicy|new-service|set-service|icacls|takeown|attrib\s+.*\+s)/i, 'it changes system settings, services, accounts or permissions'],
  [/\b(shutdown|restart-computer|stop-computer|format(\.com)?\s+[a-z]:|diskpart|cipher\s+\/w)\b/i, 'it restarts the PC or wipes a drive'],
  [/\b(del|erase|rd|rmdir|remove-item|rm)\b[^&|;]*(\s\/s\b|\s-r|\s-recurse)[^&|;]*(\*|\s\.(\s|$)|\s\.\\?\*)/i, 'it deletes everything in the folder'],
];
// Folders a build or an install makes again: deleting them loses nothing.
const DISPOSABLE = /^\.?\\?(dist|build|out|node_modules|\.next|\.nuxt|\.cache|\.parcel-cache|\.vite|coverage|__pycache__|\.pytest_cache|target|bin|obj|\.turbo|\.svelte-kit|tmp|temp)[\\/]?$/i;
function riskyCommand(cmd, workdir) {
  const s = String(cmd || '');
  if (SECRET_PATH.test(s)) return 'it touches a key, token or credentials file';
  for (const [re, why] of RISKY) if (re.test(s)) return why;
  // Throwing away work the user has not committed.
  if (/\bgit\s+(checkout\s+(-f\b|--\s)|checkout\s+\.\s*($|[&|;])|restore\b|stash\s+(drop|clear)\b|branch\s+-D\b)/i.test(s)) return 'it throws away work that is not committed';
  // A whole folder that is not build output, or many files at once.
  for (const part of s.split(/&&|\|\||;|\||&/)) {
    const p = part.trim();
    const m = /^(rd|rmdir|remove-item|rm|del|erase)(\.exe)?\s+(.*)$/i.exec(p);
    if (!m) continue;
    const words = m[3].split(/\s+/).filter(Boolean);
    const recursive = words.some((w) => /^(\/s|-r|-rf|-fr|-recurse|--recursive)$/i.test(w));
    const targets = words.filter((w) => !/^[\/-]/.test(w)).map((w) => w.replace(/^["']|["']$/g, ''));
    if (targets.some((t) => /[*?]/.test(t))) return 'it deletes many files at once';
    if (recursive && targets.some((t) => !DISPOSABLE.test(t))) return 'it deletes a whole folder';
  }
  // Deleting or overwriting outside the project.
  if (/\b(del|erase|rd|rmdir|remove-item|rm|move|ren|copy|xcopy|robocopy)\b/i.test(s) && touchesOutside(s, workdir)) return 'it deletes or changes files outside the project folder';
  return '';
}

/**
 * The same for clicks and typing on websites and in desktop apps (the action as the app words
 * it: 'Click "Place your order" on www.amazon.co.uk'). The check passed "Place your order" and
 * "Sign in with Google" now and then (scripts/auto-battery.js) -- a rule never does. The agent's
 * own local page is allowed before this (agent.js). Returns why, said to the user, or ''.
 */
const RISKY_ACTIONS = [
  [/\b(buy|purchase|check ?out|place (your |the )?order|pay( now)?|payment|subscribe|upgrade( plan| now)?|donate|add (a )?card|transfer|withdraw|send money|top ?up)\b/i, 'it spends or moves money'],
  [/\b(send|post|tweet|publish|reply|comment|share|write a review|submit (a |your )?review|message)\b/i, 'it sends or posts something in your name'],
  [/\b(sign ?in|log ?in|sign up with|continue with (google|github|apple|microsoft)|authori[sz]e|allow access|grant|connect (your |an )?(account|app))\b/i, 'it signs in or gives access to an account'],
  [/\b(delete|remove|erase|deactivate|close|cancel) (this |my |the |your )?(account|repository|repo|project|profile|workspace|organi[sz]ation|subscription|data)\b|\buninstall\b|\breset (this pc|to factory)/i, 'it deletes an account, a repository or data'],
  [/\b(accept (all|terms|the terms)|i agree|agree to)\b/i, 'it accepts terms or all cookies'],
  [/\b(regedit|gpedit|services\.msc|diskmgmt|compmgmt|secpol|msconfig)\b/i, 'it opens a system tool'],
  [/^press (shift\+)?delete in (explorer|file explorer)/i, 'it deletes files'],
  [/password (field|box)/i, 'it types into a password box'],
];
function riskyAction(kind, target) {
  if (!['browser-act', 'desktop-act'].includes(kind)) return '';
  const s = String(target || '');
  for (const [re, why] of RISKY_ACTIONS) if (re.test(s)) return why;
  return '';
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

module.exports = { checkToolAllowed, checkShellCommand, worktreeIsolationInfo, makeSandboxTool, ACCESS_LEVELS, ACCESS_LABELS, normalizeAccess, labelFor, isReadOnlyCommand, isProjectCommand, touchesOutside, SECRET_PATH, riskyCommand, riskyAction };