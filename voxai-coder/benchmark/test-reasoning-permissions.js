/**
 * test-reasoning-permissions.js — Reasoning + Permission (access) verification,
 * updated for the RENAMED access levels.
 *
 *  A. Reasoning: what is sent follows the model's catalogue entry.
 *  B. Renamed access levels: canonical keys, friendly labels, migration of old
 *     stored values, monotonic hierarchy, double-gating consistency.
 *  C. Dangerous shell commands blocked.
 */
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

// ---- A. Reasoning ----
// Levels now come from each model's catalogue entry (supported_efforts, default,
// mandatory) rather than five fixed words mapped onto three efforts.
console.log('=== A. Reasoning levels ===');
const fs = require('fs');
const or = require('../src/backend/providers/openrouter');
const dsv4 = { supported_efforts: ['max', 'high', 'low'], default_effort: 'high', default_enabled: true, mandatory: false };
const J = (x) => JSON.stringify(x);
check('model default sends nothing', J(or.reasoningParam('default', dsv4)) === '{}');
check('a supported level is sent', J(or.reasoningParam('low', dsv4)) === J({ reasoning: { effort: 'low' } }));
check('an unsupported level moves to the nearest', J(or.reasoningParam('medium', dsv4)) === J({ reasoning: { effort: 'high' } }));
check('Off turns thinking off', J(or.reasoningParam('none', dsv4)) === J({ reasoning: { enabled: false } }));
check('a model that cannot reason gets nothing', J(or.reasoningParam('high', null)) === '{}');
check('old saved words still read', or.normalizeReasoning('instant') === 'none' && or.normalizeReasoning('balanced') === 'default');

// ---- B. Renamed permissions ----
console.log('\n=== B. Renamed access levels ===');
const sb = require('../src/backend/tools/sandbox');
const KEYS = sb.ACCESS_LEVELS;
const LABELS = sb.ACCESS_LABELS;
const norm = sb.normalizeAccess;

check('4 canonical keys', KEYS.length === 4 && JSON.stringify(KEYS) === JSON.stringify(['ask','edit','test','full']), KEYS.join(','));
// labels are friendly, non-identical to keys, human-readable
const labelWords = Object.values(LABELS);
check('labels are friendly phrases', labelWords.every(l => l.split(' ').length >= 2 || l.split(' ').length === 1 && l === 'Full access'), labelWords.join(' | '));
check('labels differ from raw keys', Object.keys(LABELS).every(k => LABELS[k].toLowerCase() !== k));

// migration: old -> new
check("migrate 'ask each time'->ask", norm('ask each time') === 'ask');
check("migrate 'edit files freely'->edit", norm('edit files freely') === 'edit');
check("migrate 'edit + run tests'->test", norm('edit + run tests') === 'test');
check("migrate 'full access'->full", norm('full access') === 'full');
check("new keys untouched", norm('ask')==='ask' && norm('full')==='full');
check("unknown -> safe 'ask'", norm('garbage') === 'ask');

const tools = require('../src/backend/tools');
const toolNames = tools.definitions({ workdir: process.cwd() }).map((d) => d.function.name);

// full access (key 'full') auto-allows everything
for (const t of toolNames) {
  const v = sb.checkToolAllowed(t, 'full');
  check(`[full] '${t}' auto`, v.allowed === true && v.needsPermission === false);
}
// monotonic
function permits(t, a) { return !sb.checkToolAllowed(t, a).needsPermission; }
for (const t of ['read','write','shell','web_fetch','browser_open','cu_click','spawn_agent','node_repl','lsp','snapshot']) {
  if (!toolNames.includes(t)) continue;
  for (let i = 0; i < KEYS.length-1; i++) {
    check(`monotonic '${t}' ${LABELS[KEYS[i]]}->${LABELS[KEYS[i+1]]}`, !permits(t,KEYS[i]) || permits(t,KEYS[i+1]));
  }
}

// web_fetch double-gating regression (sandbox AUTO_LEVEL web_fetch:1 == agent checkPermission)
check("sandbox web_fetch auto @ edit", !sb.checkToolAllowed('web_fetch','edit').needsPermission);
check("sandbox web_fetch prompt @ ask", sb.checkToolAllowed('web_fetch','ask').needsPermission === true);
for (const a of KEYS) {
  const sbV = !sb.checkToolAllowed('web_fetch', a).needsPermission;
  const agentV = a !== 'ask';
  check(`web_fetch layers agree @ ${LABELS[a]}`, sbV === agentV, `sandbox=${sbV} agent=${agentV}`);
}

// key gates on new keys
check("write prompts @ ask", sb.checkToolAllowed('write','ask').needsPermission === true);
check("write auto @ edit", !sb.checkToolAllowed('write','edit').needsPermission);
check("shell auto @ full", sb.checkToolAllowed('shell','full').allowed === true);
check("cu_click auto @ full", sb.checkToolAllowed('cu_click','full').allowed === true);
check("labelFor('test') friendly", sb.labelFor('test') === 'Auto-edit + tests');

// ---- C. Shell danger ----
console.log('\n=== C. Shell danger ==');
check("blocks rm -rf /", !!sb.checkShellCommand('rm -rf /').blocked);
check("blocks diskpart", !!sb.checkShellCommand('diskpart').blocked);
check("allows npm test", !sb.checkShellCommand('npm test').blocked);

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
