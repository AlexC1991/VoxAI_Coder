/**
 * mcp — minimal Model Context Protocol stdio client (JSON-RPC 2.0, LSP-style framing).
 * Exposes mcp_list_servers / mcp_list_tools / mcp_call to the model. Servers are
 * configured in settings as `mcpServers`: { name: { command, args[] } }.
 * Inspired by Codex's mcp_servers + Goose's MCP support.
 */
const { spawn } = require('child_process');
const path = require('path');

function makeMcpTool({ getSettings, mcpDir }) {
  // state: name -> { proc, nextId, pending: Map<id,{resolve,reject}>, serverInfo }
  const clients = new Map();

  function serverConfigs() {
    const s = (getSettings && getSettings()) || {};
    return (s.mcpServers && typeof s.mcpServers === 'object') ? s.mcpServers : {};
  }

  function connect(name, cfg) {
    if (clients.has(name)) return clients.get(name);
    const c = { cfg, buf: '', nextId: 1, pending: new Map(), tools: [], ready: null };
    clients.set(name, c);
    if (!cfg || !cfg.command) { c.error = 'no command'; return c; }
    const args = Array.isArray(cfg.args) ? cfg.args : [];
    let proc;
    try {
      proc = spawn(cfg.command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { c.error = String(e); return c; }
    c.proc = proc;
    proc.stdout.on('data', (d) => {
      c.buf += d.toString('utf8');
      // framed with \r\n\r\n after headers like LSP
      for (;;) {
        const idx = c.buf.indexOf('\r\n\r\n');
        if (idx < 0) break;
        const m = /Content-Length:\s*(\d+)/i.exec(c.buf.slice(0, idx));
        if (!m) { c.buf = c.buf.slice(idx + 4); continue; }
        const len = parseInt(m[1], 10);
        if (c.buf.length < idx + 4 + len) break;
        const body = c.buf.slice(idx + 4, idx + 4 + len);
        c.buf = c.buf.slice(idx + 4 + len);
        try {
          const msg = JSON.parse(body);
          if (msg.id != null) {
            const p = c.pending.get(msg.id);
            if (p) { c.pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
          }
        } catch { /* ignore */ }
      }
    });
    proc.on('error', (e) => { c.error = String(e); });
    proc.on('exit', () => { clients.delete(name); });
    c.ready = (async () => {
      const r = await rpc(c, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'voxai', version: '0.1' } });
      await rpc(c, 'notifications/initialized', undefined, true);
      const tl = await rpc(c, 'tools/list', {});
      c.tools = (tl && tl.tools) || [];
    })();
    return c;
  }

  function rpc(c, method, params, notify) {
    return new Promise((resolve, reject) => {
      if (c.error) return reject(new Error(c.error));
      if (!c.proc) return reject(new Error('mcp server not started'));
      const id = c.nextId++;
      if (notify) {
        c.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
        return resolve({});
      }
      c.pending.set(id, { resolve, reject });
      c.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      // safety timeout
      setTimeout(() => { if (c.pending.has(id)) { c.pending.delete(id); reject(new Error('mcp timeout')); } }, 30000);
    });
  }

  async function listTools() {
    const configs = serverConfigs();
    const names = Object.keys(configs);
    if (!names.length) return [];
    const out = [];
    for (const n of names) {
      try {
        const c = connect(n, configs[n]);
        await c.ready;
        for (const t of c.tools) out.push({ server: n, name: t.name, description: (t.description || '').slice(0, 300) });
      } catch (e) { out.push({ server: n, error: String(e) }); }
    }
    return out;
  }

  async function call(server, toolName, args) {
    const configs = serverConfigs();
    const c = connect(server, configs[server]);
    await c.ready;
    const r = await rpc(c, 'tools/call', { name: toolName, arguments: args || {} });
    // MCP returns {content: [{type:'text', text}]} (or isError)
    if (r && r.isError) return { ok: false, result: JSON.stringify(r).slice(0, 16000) };
    const parts = (r && r.content) || [];
    const text = parts.map((p) => (p.type === 'text' ? p.text : JSON.stringify(p))).join('\n');
    return { ok: true, text: text.slice(0, 20000) };
  }

  return {
    defs: [
      {
        type: 'function',
        function: {
          name: 'mcp_list_tools',
          description: 'List tools exposed by configured MCP servers (settings.mcpServers). Returns server + tool name + description.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      {
        type: 'function',
        function: {
          name: 'mcp_call',
          description: 'Call a tool on an MCP server. server = configured name, name = tool name, arguments = tool args object.',
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
      if (name === 'mcp_list_tools') {
        const tools = await listTools();
        return { servers: Object.keys(serverConfigs()), tools };
      }
      if (name === 'mcp_call') {
        return await call(String(args.server), String(args.name), args.arguments || {});
      }
      throw new Error('unknown mcp tool');
    },
  };
}

module.exports = { makeMcpTool };