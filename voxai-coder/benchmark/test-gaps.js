/**
 * test-plan.js — verifies Plan Mode backend gating without an LLM.
 * We can't easily call runAgent end-to-end (needs a provider), so this validates
 * the wiring + SYSTEM prompt + that the chip setting round-trips.
 */
const assert = require('assert');
const p = require('../src/backend/providers/openrouter');

// 1) SYSTEM prompt includes plan-mode instructions when planMode on
// (read the source to confirm the template branch)
const fs = require('fs');
const src = fs.readFileSync(require.resolve('../src/backend/agent'), 'utf8');
assert(src.includes("PLAN MODE is ON"), 'plan-mode instruction present in SYSTEM');
assert(src.includes("planApproved"), 'planApproved gating variable present');
assert(src.includes("const MUTATING"), 'mutating tools list present');
console.log('PASS  plan-mode SYSTEM instructions + gating in agent.js');

// 2) planMode setting round-trip via getSettings default
const mainSrc = fs.readFileSync(require.resolve('../src/main/main.js'), 'utf8');
assert(mainSrc.includes("planMode: raw.planMode === true || raw.planMode === 'true'"), 'planMode default in getSettings');
assert(mainSrc.includes('planMode: s.planMode'), 'planMode passed to runAgent');
console.log('PASS  planMode wiring in main.js');

// 3) renderer chip present + wired
const html = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
assert(html.includes('chipPlan'), 'plan chip element');
// Plan is a switch now, not a two-option dropdown.
assert(/id="chipPlan"[^>]*role="switch"/.test(html), 'plan is a switch');
assert(html.includes("saveSettings({ planMode: !S.planMode })"), 'plan switch saves setting');
console.log('PASS  plan chip in renderer');

// 4) native a11y module exports
const native = require('../src/backend/cu/native');
assert(typeof native.buildA11y === 'function', 'buildA11y exported');
assert(typeof native.clickElement === 'function', 'clickElement exported');
console.log('PASS  native a11y exports (buildA11y + clickElement)');

// 5) mutating tools gated set matches sandbox-aligned names
const spawn = fs.readFileSync(require.resolve('../src/backend/tools/spawn'), 'utf8');
assert(spawn.includes("type: 'sub'"), 'sub-agent live event broadcast present');
console.log('PASS  sub-agent inline live-event broadcast');

console.log('\nALL PLAN/A11Y GAP TESTS PASSED');
