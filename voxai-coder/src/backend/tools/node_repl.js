/**
 * node_repl — live JavaScript REPL execution in a constrained Node VM context.
 * Inspired by Codex's node_repl MCP. Uses node:vm with a fresh context per call;
 * filesystem/network access is DISABLED inside the VM (code runs in a sandbox with
 * only pure-JS globals + a tiny console that echoes back). No require, no process.
 */
const vm = require('vm');

function makeReplTool() {
  return {
    def: {
      type: 'function',
      function: {
        name: 'node_repl',
        description: 'Evaluate a JavaScript expression or snippet in a pure sandbox (no fs, no network, no require). Good for quick math, data munging, algorithm checks, JSON transformations. Returns the last expression value (JSON) plus console output.',
        parameters: {
          type: 'object',
          properties: { code: { type: 'string', description: 'JavaScript to evaluate.' } },
          required: ['code'],
          additionalProperties: false,
        },
      },
    },
    async run({ code }, ctx) {
      const src = String(code || '');
      if (!src.trim()) throw new Error('node_repl needs code');
      if (src.length > 20000) throw new Error('node_repl code too long');
      const logs = [];
      const sandbox = {
        console: {
          log: (...a) => logs.push(a.map(serializeForLog).join(' ')),
          warn: (...a) => logs.push('warn: ' + a.map(serializeForLog).join(' ')),
          error: (...a) => logs.push('error: ' + a.map(serializeForLog).join(' ')),
        },
        JSON, Math, Date, Array, Object, String, Number, Boolean, RegExp, Promise,
        Set, Map, WeakSet, WeakMap, Error, TypeError, RangeError, parseInt, parseFloat,
        isNaN, isFinite, encodeURIComponent, decodeURIComponent,
      };
      sandbox.globalThis = sandbox;
      const ctx2 = vm.createContext(sandbox);
      let value;
      // 1) try as an expression → gives us the completion value (REPL-style)
      try {
        value = vm.runInContext('(' + src + '\n)', ctx2, { timeout: 10000, filename: 'node_repl' });
      } catch (eExpr) {
        // 2) fall back to statements
        try {
          vm.runInContext(src, ctx2, { timeout: 10000, filename: 'node_repl' });
          value = undefined;
        } catch (eStmt) {
          return { ok: false, error: (eStmt && eStmt.message) || String(eStmt), logs: logs.slice(0, 50) };
        }
      }
      return { ok: true, value: serializeSafe(value), logs: logs.slice(0, 50) };
    },
  };
}

function serializeForLog(x) {
  try {
    if (typeof x === 'string') return x;
    return JSON.stringify(x);
  } catch { return String(x); }
}

function serializeSafe(v) {
  try {
    if (v === undefined) return undefined;
    if (typeof v === 'function') return '[Function]';
    const s = JSON.stringify(v, (k, val) => typeof val === 'bigint' ? String(val) : val);
    if (s === undefined) return String(v);
    return JSON.parse(s.slice(0, 8000));
  } catch { return String(v); }
}

module.exports = { makeReplTool };