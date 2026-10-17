'use strict';
/**
 * What a message actually costs you on each model, from your own sessions.
 *
 * A price per million tokens says little about a bill: a model that thinks and writes twice as
 * much costs twice as much at the same price (Gemini 4 and Grok 4.7 write about double their
 * predecessors per task). Each run's cost is already kept with its session (runLog); this adds
 * them up per model -- the median cost of a message, and how many it is based on -- for the
 * model picker. Sub-agents' spending is inside their parent run's cost.
 *
 * Files are read again only when they change, and only their run lines are parsed.
 */
const fsp = require('fs').promises;
const path = require('path');

const seen = new Map();   // file -> { stamp, model, runs: [{ model, cost }] }

async function modelCosts(sessionsDir) {
  let files = [];
  try { files = (await fsp.readdir(sessionsDir)).filter((f) => f.endsWith('.jsonl')); } catch { return {}; }
  const per = {};
  for (const f of files) {
    const file = path.join(sessionsDir, f);
    let row;
    try {
      const st = await fsp.stat(file);
      const stamp = st.mtimeMs + ':' + st.size;
      row = seen.get(file);
      if (!row || row.stamp !== stamp) {
        const lines = (await fsp.readFile(file, 'utf8')).split('\n');
        let model = '';
        try { const meta = JSON.parse(lines[0]); if (meta.kind === 'meta') model = meta.model || ''; } catch { /* no meta */ }
        const runs = [];
        for (const l of lines) {
          if (!l.startsWith('{"kind":"run"')) continue;
          try { const r = JSON.parse(l).run; if (r && Number(r.cost) > 0) runs.push({ model: r.model || model, cost: Number(r.cost) }); } catch { /* damaged line */ }
        }
        row = { stamp, runs };
        seen.set(file, row);
      }
    } catch { continue; }
    for (const r of row.runs) if (r.model) (per[r.model] || (per[r.model] = [])).push(r.cost);
  }
  const out = {};
  for (const [m, costs] of Object.entries(per)) {
    const s = costs.slice().sort((a, b) => a - b);
    const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    out[m] = { runs: s.length, median: mid };
  }
  return out;
}

module.exports = { modelCosts };
