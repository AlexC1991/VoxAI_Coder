#!/usr/bin/env node
/**
 * Claude and OpenAI models straight from their makers with the user's own keys
 * (backend/providers/direct.js, anthropic.js). No key, no network: the Anthropic SDK is pointed at a
 * stand-in for the Messages API run in this process.
 *
 *   node test/regression-direct.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  got: ' + JSON.stringify(detail).slice(0, 400) : '')); }
}

(async () => {
  const direct = require(path.join(ROOT, 'src/backend/providers/direct.js'));
  const A = require(path.join(ROOT, 'src/backend/providers/anthropic.js'));

  console.log('\n[RT] which models go straight to their maker');
  let keys = { anthropic: '', openai: '' };
  direct.configure({ getKeys: () => keys, priceOf: () => null });
  check('without keys, everything goes through OpenRouter', !direct.routeOf('anthropic/claude-opus-5.5') && !direct.routeOf('openai/gpt-5.1'));
  keys = { anthropic: 'sk-ant-x', openai: 'sk-x' };
  check('with an Anthropic key, Claude goes to Anthropic; with an OpenAI key, OpenAI\'s own models go to OpenAI',
    direct.routeOf('anthropic/claude-opus-5.5') === 'anthropic' && direct.routeOf('openai/gpt-5.1') === 'openai' && direct.routeOf('openai/o4-mini') === 'openai');
  check('open-weight gpt-oss and other makers stay on OpenRouter', !direct.routeOf('openai/gpt-oss-120b') && !direct.routeOf('deepseek/deepseek-v4.1-flash') && !direct.routeOf('google/gemini-3.8-flash'));
  check('model ids: OpenRouter\'s dots become Anthropic\'s dashes; suffixes go', A.apiModel('anthropic/claude-opus-5.5') === 'claude-opus-5-5' && A.apiModel('anthropic/claude-sonnet-4.6:thinking') === 'claude-sonnet-4-6'
    && direct.openaiModel('openai/gpt-5.1') === 'gpt-5.1');

  console.log('\n[AN] the conversation, as the Messages API takes it');
  const msgs = [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: 'first task' },
    { role: 'assistant', content: 'old', tool_calls: [{ id: 'c0', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*"}' } }],
      _anthropic: { model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'old', signature: 'S0' }, { type: 'tool_use', id: 'toolu_0', name: 'glob', input: {} }] } },
    { role: 'tool', tool_call_id: 'c0', content: 'a.txt' },
    { role: 'user', content: [{ type: 'text', text: 'second task' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }, { id: 'c2_renamed', type: 'function', function: { name: 'read', arguments: '{"path":"b"}' } }],
      _anthropic: { model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'now', signature: 'S1' }, { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a' } }, { type: 'tool_use', id: 'toolu_2', name: 'read', input: { path: 'b' } }] } },
    { role: 'tool', tool_call_id: 'c1', content: 'A' },
    { role: 'tool', tool_call_id: 'c2_renamed', content: 'B' },
  ];
  const conv = A.toAnthropic(msgs);
  const blocks = (i) => conv.messages[i].content.map((b) => b.type).join(',');
  check('the system prompt goes in system; the conversation opens with you', conv.system[0].text === 'SYSTEM PROMPT' && conv.messages[0].role === 'user');
  check('an earlier run\'s turn goes without its thinking (older history is edited by pruning)', blocks(1) === 'text,tool_use' && conv.messages[1].content[1].id === 'c0');
  check('a tool result and the message after it share one user turn, results first; a picture goes as a base64 image block', blocks(2) === 'tool_result,text,image' && conv.messages[2].content.some((b) => b.type === 'image' && b.source.type === 'base64' && b.source.media_type === 'image/png'));
  check('this run\'s turn goes back as Anthropic sent it, thinking included, with the agent\'s ids', blocks(3) === 'thinking,tool_use,tool_use' && conv.messages[3].content[0].signature === 'S1'
    && conv.messages[3].content[2].id === 'c2_renamed');
  check('parallel tool results go back in one user message', conv.messages[4].role === 'user' && blocks(4) === 'tool_result,tool_result' && conv.messages.length === 5);
  const fb = A.replayBlocks([{ type: 'thinking', signature: 'X' }, { type: 'text', text: 'partial' }, { type: 'tool_use', id: 'd', name: 'x', input: {} }, { type: 'fallback', from: {}, to: {} }, { type: 'thinking', signature: 'Y' }, { type: 'tool_use', id: 'e', name: 'y', input: {} }], [{ id: 'k' }]);
  check('after a fallback, the declined attempt\'s thinking and tool calls are left out; its text stays', fb && fb.map((b) => b.type).join(',') === 'text,thinking,tool_use' && fb[1].signature === 'Y' && fb[2].id === 'k', fb);

  console.log('\n[RQ] the request');
  const opus = A.requestOf({ model: 'anthropic/claude-opus-5.5', messages: msgs, tools: [{ type: 'function', function: { name: 'glob', description: 'd', parameters: { type: 'object', properties: {} } } }], reasoningEffort: 'high', maxTokens: 8000, cacheTtl: '1h' });
  check('Opus 5.5: adaptive thinking shown as a summary, effort from the session, an hour\'s cache, refusal fallbacks', JSON.stringify(opus.params.thinking) === '{"type":"adaptive","display":"summarized"}'
    && opus.params.output_config.effort === 'high' && opus.params.cache_control.ttl === '1h' && opus.params.fallbacks === 'default' && opus.params.betas[0] === 'server-side-fallback-2026-07-01' && opus.beta === true, opus.params);
  check('never sampling settings or a forced tool choice (the newest models refuse them)', !('temperature' in opus.params) && !('tool_choice' in opus.params) && opus.params.tools[0].input_schema.type === 'object');
  const haiku45 = A.requestOf({ model: 'anthropic/claude-haiku-4.5', messages: msgs, reasoningEffort: 'high' });
  check('Haiku 4.5: no adaptive thinking or effort (it takes neither), no fallbacks', !haiku45.params.thinking && !haiku45.params.output_config && !haiku45.params.fallbacks && !haiku45.beta);
  check('"no thinking" asks the lowest effort (it cannot be turned off on the newest models)', A.effortOf('none') === 'low' && A.effortOf('default') === null && A.effortOf('xhigh') === 'xhigh');

  console.log('\n[CO] what it cost (the API does not say)');
  const price = { promptCents: 0.0004, completionCents: 0.002, cacheReadCents: 0.00004, cacheWriteCents: 0.0005 };
  const cost = A.costOf({ input_tokens: 900, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300, output_tokens: 60 }, price, '');
  check('from the catalogue\'s prices: fresh input, cache reads, cache writes and output', Math.abs(cost - 0.0079) < 1e-9, cost);
  check('an hour\'s cache writes cost 2x input, not 1.25x', Math.abs(A.costOf({ cache_creation_input_tokens: 1000 }, price, '1h') - 0.008) < 1e-9);   // 1,000 tokens at 2 x 0.0004 cents
  const u = A.usageOf({ input_tokens: 900, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300, output_tokens: 60 }, cost);
  check('usage in the fields the app reads, marked direct (not off the OpenRouter balance)', u.prompt_tokens === 5200 && u.prompt_tokens_details.cached_tokens === 4000 && u.cache_write_input_tokens === 300 && u.direct === 'anthropic');
  const oc = direct.openaiCost({ prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1000 } }, { promptCents: 0.000125, completionCents: 0.001, cacheReadCents: 0.0000125 });
  check('OpenAI: cached input at the cache price', Math.abs(oc - (200 * 0.000125 + 1000 * 0.0000125 + 40 * 0.001) / 100) < 1e-12, oc);
  const ob = direct.openaiBody({ model: 'openai/gpt-5.1', messages: msgs, tools: [], reasoningEffort: 'high', reasoningSpec: { supported_efforts: ['low', 'medium', 'high'] }, maxTokens: 9000, sessionId: 's1' }, true);
  check('OpenAI: none of OpenRouter\'s extras, its own token limit and effort field, a cache key per session, no Anthropic turns', !ob.provider && !ob.transforms && ob.max_completion_tokens === 9000 && ob.reasoning_effort === 'high'
    && ob.prompt_cache_key === 's1' && ob.messages.every((m) => !m._anthropic));

  console.log('\n[SDK] a streamed run through the official SDK, against a stand-in');
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      const j = JSON.parse(b || '{}'); seen.push({ url: req.url, beta: req.headers['anthropic-beta'] || '', key: req.headers['x-api-key'] || '', body: j });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const ev = (type, d) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
      ev('message_start', { message: { id: 'm1', type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300, output_tokens: 0 } } });
      ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
      ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Considering.' } });
      ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'SIG' } });
      ev('content_block_stop', { index: 0 });
      ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Looking.' } });
      ev('content_block_stop', { index: 1 });
      ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_9', name: 'glob', input: {} } });
      ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"pattern":"*.md"}' } });
      ev('content_block_stop', { index: 2 });
      ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 60 } });
      ev('message_stop', {});
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const events = [];
  const r = await A.chatCompletions({ model: 'anthropic/claude-opus-5.5', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'go' }], tools: [{ type: 'function', function: { name: 'glob', description: 'd', parameters: { type: 'object', properties: {} } } }], onEvent: (e) => events.push(e) }, { apiKey: 'sk-ant-test', price });
  server.close();
  check('the request went to the Messages API with the key and the fallback beta', seen.length === 1 && /\/v1\/messages/.test(seen[0].url) && seen[0].key === 'sk-ant-test' && seen[0].beta.includes('server-side-fallback-2026-07-01') && seen[0].body.stream === true, seen.map((s) => [s.url, s.beta]));
  check('text and thinking stream to the app as they come', events.some((e) => e.token === 'Looking.') && events.some((e) => e.reasoning === 'Considering.') && events.some((e) => e.toolCallDelta && e.toolCallDelta.name === 'glob') && events.some((e) => e.done));
  check('the answer: text, the tool call with its arguments, why it stopped, and the cost', r.content === 'Looking.' && r.toolCalls.length === 1 && r.toolCalls[0].id === 'toolu_9' && JSON.parse(r.toolCalls[0].arguments).pattern === '*.md'
    && r.finishReason === 'tool_calls' && Math.abs(r.usage.cost - 0.0079) < 1e-9, r);
  check('the turn as Anthropic sent it is kept, for its thinking to go back with the results', r.raw.anthropic.content[0].type === 'thinking' && r.raw.anthropic.content[0].signature === 'SIG');

  console.log('\n[WI] wiring');
  const MAIN = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');
  const HTML = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const OR = fs.readFileSync(path.join(ROOT, 'src/backend/providers/openrouter.js'), 'utf8');
  const AG = fs.readFileSync(path.join(ROOT, 'src/backend/agent.js'), 'utf8');
  check('keys are stored encrypted like the others, and an empty one removes it', MAIN.includes("for (const k of ['anthropicKey', 'openaiKey']) {") && MAIN.includes('if (patch[k]) raw[k] = encryptSecret(String(patch[k]).trim());'));
  check('OpenRouter hands the call over first, and never sends Anthropic\'s kept turns on', OR.includes('if (direct.routeOf(opts && opts.model)) return direct.chatCompletions(opts);') && OR.includes('messages: direct.stripRaw(opts.messages)'));
  check('the agent keeps the turn on the saved message; a summary drops it', AG.includes('...(turnRaw ? { _anthropic: turnRaw } : {}),') && fs.readFileSync(path.join(ROOT, 'src/backend/compact.js'), 'utf8').includes("require('./providers/direct').stripRaw("));
  check('Settings has both keys, removable; spend on them does not count down the OpenRouter balance', HTML.includes('id="fAntKey"') && HTML.includes('id="fOaiKey"') && HTML.includes('id="btnAntRemove"')
    && HTML.includes('if (!u.direct) balanceSpend(step);'));
  check('the official SDK is a dependency', !!require(path.join(ROOT, 'package.json')).dependencies['@anthropic-ai/sdk']);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
