/**
 * benchmark/test-cu.js — end-to-end harness for the VoxAI Computer Use surface.
 * Exercises the actual tool layer (makeComputerUseTool) the way agent.js would:
 *   - browser backend: launch → state → click → type → press → scroll → screenshot
 *   - native backend: list windows → screenshot
 *   - verifies each op emits an `image` event (the "see it live" UI stream)
 * Usage: node benchmark/test-cu.js   (Node >= 21 for global WebSocket)
 */
const cuTool = require('../src/backend/cu').makeComputerUseTool();

let pass = 0, fail = 0;
const events = [];
const ctx = { emit: (e) => events.push(e) };

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
function imageCount() { return events.filter((e) => e && e.type === 'image' && e.dataUrl && e.dataUrl.startsWith('data:image')).length; }

async function main() {
  console.log('=== Computer Use harness ===');

  // 1) tool definitions present
  const defs = cuTool.defs.map((d) => d.function.name);
  check('defs registered', ['cu_launch','cu_state','cu_click','cu_type','cu_press','cu_scroll','cu_screenshot','cu_list'].every((n) => defs.includes(n)), '[' + defs.join(',') + ']');

  // 2) browser: launch example.com
  console.log('\n-- browser launch --');
  const launched = await cuTool.run('cu_launch', { url: 'https://example.com', backend: 'browser' }, ctx);
  check('cu_launch ok', launched.ok === true);
  check('browser title', /example/i.test(launched.title || ''), launched.title);
  check('browser has elements', Array.isArray(launched.elements) && launched.elements.length > 0, 'n=' + (launched.elements || []).length);
  check('launch streams image', imageCount() >= 1);

  // 3) browser: state
  console.log('\n-- browser state --');
  events.length = 0;
  const st = await cuTool.run('cu_state', { backend: 'browser' }, ctx);
  check('cu_state has text', (st.text || '').length > 20);
  check('cu_state elements indexed', Array.isArray(st.elements) && st.elements.length > 0);
  check('state streams image', imageCount() >= 1);

  // 4) browser: click first element
  console.log('\n-- browser click/type/press/scroll --');
  events.length = 0;
  const click = await cuTool.run('cu_click', { index: 0, backend: 'browser' }, ctx);
  check('cu_click ok', click.ok === true, JSON.stringify({ x: click.x, y: click.y }));
  check('click streams image', imageCount() >= 1);

  const typeR = await cuTool.run('cu_type', { text: 'voxai test', backend: 'browser' }, ctx);
  check('cu_type ok', typeR.ok === true);

  const pressR = await cuTool.run('cu_press', { key: 'Control+A', backend: 'browser' }, ctx);
  check('cu_press ok', pressR.ok === true);

  const scrollR = await cuTool.run('cu_scroll', { dy: 300, backend: 'browser' }, ctx);
  check('cu_scroll ok', scrollR.ok === true);

  // 5) browser: screenshot + list
  console.log('\n-- browser screenshot/list --');
  events.length = 0;
  const shot = await cuTool.run('cu_screenshot', { backend: 'browser' }, ctx);
  check('cu_screenshot dataUrl', !!(shot.screenshot || '').startsWith('data:image/png'));
  check('screenshot streams image', imageCount() >= 1);
  const list = await cuTool.run('cu_list', { backend: 'browser' }, ctx);
  check('cu_list tabs', Array.isArray(list.tabs) && list.tabs.length > 0);

  // 6) native: list + screenshot
  console.log('\n-- native --');
  if (process.platform === 'win32') {
    const nl = await cuTool.run('cu_list', { backend: 'native' }, ctx);
    check('native cu_list windows', Array.isArray(nl.windows) && nl.windows.length > 0, 'n=' + (nl.windows || []).length);
    const ns = await cuTool.run('cu_screenshot', { backend: 'native' }, ctx);
    check('native cu_screenshot', !!ns.screenshot, 'err=' + ns.error);
    const nst = await cuTool.run('cu_state', { backend: 'native' }, ctx);
    check('native cu_state windows', Array.isArray(nst.windows) && nst.windows.length > 0);
  } else {
    console.log('  (native skipped: not Windows)');
  }

  // 7) error handling: bad index
  console.log('\n-- error path --');
  try {
    await cuTool.run('cu_click', { index: 99999, backend: 'browser' }, ctx);
    check('bad index throws', false);
  } catch (e) {
    check('bad index throws', true, e.message.slice(0, 40));
  }

  console.log('\n==== RESULTS: ' + pass + ' passed, ' + fail + ' failed ====');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
