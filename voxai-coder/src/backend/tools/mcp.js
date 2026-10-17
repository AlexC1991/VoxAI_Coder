/**
 * mcp — Model Context Protocol client over stdio (JSON-RPC 2.0).
 *
 * Servers are configured in settings as `mcpServers`: { name: { command, args[], env{}, cwd } },
 * the same shape Claude Desktop and Claude Code use.
 *
 * This had never worked: it wrote one message per line (right) but read replies as
 * LSP-framed "Content-Length:" blocks, so no reply was ever understood and every call
 * sat 30 s and failed; the configured servers were never even passed to it; `npx`
 * (a .cmd on Windows) could not be started; and each turn started a fresh copy of every
 * server without ending the last. Found in a live test.
 */
const { spawn } = require('child_process');
const procs = require('./procs');

const isWin = process.platform === 'win32';
// One client per configured server for the whole app, not per turn.
const clients = new Map();   // key -> client

function keyOf(name, cfg) { return name + '\u0000' + JSON.stringify(cfg || {}); }

function tail(s, n = 1500) { s = String(s || ''); return s.length > n ? '…' + s.slice(-n) : s; }

function startProcess(cfg, cwd) {
  const command = String(cfg.command);
  const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
  const env = { ...process.env, ...(cfg.env && typeof cfg.env === 'object' ? cfg.env : {}) };
  // npx, uvx and friends are .cmd files on Windows: they need the shell to start.
  const viaShell = isWin && !/\.exe$/i.test(command);
  const q = (a) => (/[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a);
  return viaShell
    ? spawn(q(command), args.map(q), { cwd, env, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

// `own`: a private copy for Settings' Test button, never shared with a run (and never
// ended under one).
function connect(name, cfg, cwd, own) {
  const key = keyOf(name, cfg);
  const have = own ? null : clients.get(key);
  if (have && !have.dead) return have;
  const c = { name, cfg, buf: '', nextId: 1, pending: new Map(), tools: [], stderr: '', dead: false };
  if (!own) clients.set(key, c);
  if (!cfg || !cfg.command) { c.dead = true; c.ready = Promise.reject(new Error(`MCP server "${name}" has no command in settings.`)); c.ready.catch(() => {}); return c; }
  let proc;
  try { proc = startProcess(cfg, cfg.cwd || cwd); } catch (e) { c.dead = true; c.ready = Promise.reject(new Error(`Could not start MCP server "${name}": ${e.message}`)); c.ready.catch(() => {}); return c; }
  c.proc = proc;
  procs.track({ pid: proc.pid, name: 'mcp:' + name, command: String(cfg.command) });
  const fail = (why) => {
    if (c.dead) return;
    c.dead = true;
    const err = new Error(`MCP server "${name}" ${why}` + (c.stderr.trim() ? `. It said: ${tail(c.stderr.trim(), 600)}` : ''));
    for (const p of c.pending.values()) p.reject(err);
    c.pending.clear();
    if (clients.get(key) === c) clients.delete(key);
  };
  const handle = (msg) => {
    if (!msg || msg.id == null) return;          // notifications / requests from the server
    const p = c.pending.get(msg.id);
    if (!p) return;
    c.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`MCP server "${name}": ${msg.error.message || JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
  };
  proc.stdout.on('data', (d) => {
    c.buf += d.toString('utf8');
    for (;;) {
      // A few older servers frame like LSP; the spec is one JSON message per line.
      if (/^\s*Content-Length:/i.test(c.buf)) {
        const idx = c.buf.indexOf('\r\n\r\n'); if (idx < 0) break;
        const m = /Content-Length:\s*(\d+)/i.exec(c.buf.slice(0, idx));
        const len = m ? parseInt(m[1], 10) : 0;
        if (c.buf.length < idx + 4 + len) break;
        const body = c.buf.slice(idx + 4, idx + 4 + len);
        c.buf = c.buf.slice(idx + 4 + len);
        try { handle(JSON.parse(body)); } catch {}
        continue;
      }
      const nl = c.buf.indexOf('\n'); if (nl < 0) break;
      const line = c.buf.slice(0, nl).trim();
      c.buf = c.buf.slice(nl + 1);
      if (!line) continue;
      try { handle(JSON.parse(line)); } catch { /* a log line on stdout */ }
    }
  });
  proc.stderr.on('data', (d) => { c.stderr = tail(c.stderr + d.toString('utf8'), 4000); });
  proc.on('error', (e) => fail(`could not start (${e.message})`));
  proc.on('exit', (code) => fail(`stopped (exit ${code})`));
  c.ready = (async () => {
    // The first run of an npx server downloads it, which can take a while.
    await rpc(c, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'voxai-coder', version: '1' } }, false, 90000);
    notify(c, 'notifications/initialized');
    const tl = await rpc(c, 'tools/list', {}, false, 30000);
    c.tools = (tl && tl.tools) || [];
  })();
  c.ready.catch(() => {});
  return c;
}

function notify(c, method, params) {
  try { c.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n'); } catch {}
}

function rpc(c, method, params, _unused, ms = 60000) {
  return new Promise((resolve, reject) => {
    if (c.dead || !c.proc) return reject(new Error(`MCP server "${c.name}" is not running.`));
    const id = c.nextId++;
    const timer = setTimeout(() => {
      if (c.pending.has(id)) { c.pending.delete(id); reject(new Error(`MCP server "${c.name}" did not answer ${method} within ${Math.round(ms / 1000)} s` + (c.stderr.trim() ? `. It said: ${tail(c.stderr.trim(), 600)}` : '.'))); }
    }, ms);
    c.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    try { c.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
    catch (e) { c.pending.delete(id); clearTimeout(timer); reject(e); }
  });
}

/** The servers the agent may use: the ones not switched off in Settings. */
function activeServers(all) {
  const out = {};
  if (!all || typeof all !== 'object') return out;
  for (const n of Object.keys(all)) if (all[n] && typeof all[n] === 'object' && !all[n].disabled) out[n] = all[n];
  return out;
}

/**
 * Settings' Test button: start the server on its own, list its tools, end it.
 * { ok, tools: [{ name, description }], ms } or { ok: false, error }.
 */
async function probe(name, cfg, cwd, ms = 90000) {
  const t0 = Date.now();
  const c = connect(name, cfg, cwd, true);
  let timer;
  try {
    await Promise.race([c.ready, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`"${name}" did not finish starting within ${Math.round(ms / 1000)} s` + (c.stderr.trim() ? `. It said: ${tail(c.stderr.trim(), 600)}` : '.'))), ms); })]);
    return { ok: true, ms: Date.now() - t0, tools: c.tools.map((t) => ({ name: String(t.name || ''), description: String(t.description || '').slice(0, 200) })) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
    c.dead = true;
    if (c.proc && c.proc.pid) { try { procs.stop(c.proc.pid); } catch { /* already gone */ } }
  }
}

/** For Settings: which servers a run has started, and how many tools each gave. */
function status(all) {
  const out = {};
  for (const n of Object.keys(all || {})) {
    const c = clients.get(keyOf(n, all[n]));
    out[n] = c && !c.dead ? { running: true, tools: c.tools.length } : { running: false };
  }
  return out;
}

function makeMcpTool({ getSettings }) {
  function serverConfigs() {
    const s = (getSettings && getSettings()) || {};
    return activeServers(s.mcpServers);
  }
  const NONE = 'No MCP servers are switched on. The user adds them in Settings > Apps (MCP).';

  async function listTools(cwd) {
    const configs = serverConfigs();
    const out = [];
    for (const n of Object.keys(configs)) {
      try {
        const c = connect(n, configs[n], cwd);
        await c.ready;
        // With its arguments: a tool the model cannot see the inputs of, it cannot call.
        for (const t of c.tools) {
          const schema = t.inputSchema || {};
          const small = JSON.stringify(schema).length <= 3000;
          out.push({ server: n, name: t.name, description: String(t.description || '').slice(0, 300),
            inputSchema: small ? schema : { note: 'large schema', properties: Object.keys(schema.properties || {}), required: schema.required || [] } });
        }
      } catch (e) { out.push({ server: n, error: String(e.message || e) }); }
    }
    return out;
  }

  async function call(server, toolName, args, cwd) {
    const configs = serverConfigs();
    if (!configs[server]) throw new Error(Object.keys(configs).length ? `No MCP server called "${server}". Configured: ${Object.keys(configs).join(', ')}.` : NONE);
    const c = connect(server, configs[server], cwd);
    await c.ready;
    const r = await rpc(c, 'tools/call', { name: toolName, arguments: args || {} });
    const parts = (r && r.content) || [];
    const text = parts.map((p) => (p.type === 'text' ? p.text : JSON.stringify(p))).join('\n');
    if (r && r.isError) return { ok: false, error: text.slice(0, 16000) || 'The tool reported an error.' };
    return { ok: true, text: text.slice(0, 20000) };
  }

  return {
    defs: [
      {
        type: 'function',
        function: {
          name: 'mcp_list_tools',
          description: 'List the tools on the MCP servers set up in settings (mcpServers), with each tool\'s inputs.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      {
        type: 'function',
        function: {
          name: 'mcp_call',
          description: 'Call a tool on an MCP server. server = its name in settings, name = the tool, arguments = its inputs.',
          parameters: {
            type: 'object',
            properties: {
              server: { type: 'string' },
              name: { type: 'string' },
              arguments: { type: 'object' },
            },
            required: ['server', 'name'],
            additionalProperties: false,
          },
        },
      },
    ],
    async run(name, args, ctx) {
      const cwd = (ctx && ctx.workdir) || process.cwd();
      if (name === 'mcp_list_tools') {
        const servers = Object.keys(serverConfigs());
        if (!servers.length) return { servers: [], tools: [], note: NONE };
        return { servers, tools: await listTools(cwd) };
      }
      if (name === 'mcp_call') return await call(String(args.server), String(args.name), args.arguments || {}, cwd);
      throw new Error('unknown mcp tool');
    },
  };
}

module.exports = { makeMcpTool, activeServers, probe, status, _clients: clients };
