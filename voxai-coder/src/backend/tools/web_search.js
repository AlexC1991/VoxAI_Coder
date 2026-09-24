/**
 * web_search — find pages, instead of guessing their URLs.
 *
 * Without a search tool the agent could only fetch URLs it already knew, so for
 * research it invented them: one session made 53 fetches, 36 of them 404/403, reached
 * no page about the product it was asked to research — and then reported "strong
 * primary-source material" anyway. Search returns real URLs, which web_fetch then
 * reads in full.
 *
 * Implementation: one small non-streaming OpenRouter call with the `web` plugin.
 * OpenRouter runs the search and returns the results as `url_citation` annotations;
 * we return those, not the model's prose about them.
 *
 * Cost: a flat per-search fee (Exa, ~$0.007) plus the tokens of that one short call.
 * It is charged against the run's budget like any other spend, and refused up front
 * when the budget cannot cover it.
 */
const { chatOnce, DEFAULT_HOST } = require('../providers/openrouter');

// Engines selectable in Settings, with OpenRouter's per-search fee. The fee is used
// only to refuse a search the remaining budget cannot cover (so it takes the HIGH end
// where a range is listed); the real charge comes back in usage.cost and is what the
// run is billed. Native provider search is not offered: most models here lack it.
const ENGINES = {
  exa: { fee: 0.007 },
  parallel: { fee: 0.005 },      // measured $0.0052 on 2026-09-24; $0.001 needs a turbo/fast mode we don't request
  perplexity: { fee: 0.005 },
};
const DEFAULT_ENGINE = 'exa';
const ENGINE = DEFAULT_ENGINE;   // kept for callers of the old export
const SEARCH_FEE_USD = ENGINES[DEFAULT_ENGINE].fee;
const MAX_RESULTS_CAP = 10;          // above 10 OpenRouter bills extra per result
const SNIPPET_CHARS = 500;
const TIMEOUT_MS = 45000;

function makeWebSearchTool({ checkPermission, agentOpts = {} }) {
  const cfg = agentOpts.webSearch || {};
  const engine = ENGINES[cfg.engine] ? cfg.engine : DEFAULT_ENGINE;
  const fee = ENGINES[engine].fee;
  const defaultResults = Math.min(MAX_RESULTS_CAP, Math.max(1, Math.round(Number(cfg.maxResults) || 5)));
  return {
    def: {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web and get back real result URLs with titles and snippets. Use this to FIND '
          + 'sources; then read the ones that matter with web_fetch. Never invent a URL to fetch — search for '
          + `it. Each search costs about $${fee.toFixed(3)} of the run budget, so make queries specific rather than running `
          + 'many near-duplicates. `include_domains` restricts results to those sites (e.g. ["openai.com"]).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for. Specific beats broad.' },
            max_results: { type: 'integer', description: `How many results, 1-${MAX_RESULTS_CAP}. Default ${defaultResults}.` },
            include_domains: { type: 'array', items: { type: 'string' }, description: 'Only return results from these domains.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },

    async run({ query, max_results, include_domains }, ctx) {
      const q = String(query || '').trim();
      if (!q) throw new Error('web_search needs a query');
      if (cfg.enabled === false) throw new Error('web search is turned off in Settings — use web_fetch on URLs you already have');
      if (!agentOpts.apiKey) throw new Error('web_search needs an OpenRouter key — add one in Settings');

      // A search the run cannot pay for is refused BEFORE it is made. An unset budget
      // means the embedder never wired one (tests, tools used standalone).
      const raw = agentOpts.budgetRemaining;
      if (raw !== undefined && raw !== null && raw !== '' && Number(raw) < fee * 2) {
        throw new Error(`not enough run budget left for a search ($${Number(raw).toFixed(4)} remaining). `
          + 'Work from what you already have, or tell the user the budget is exhausted.');
      }

      await checkPermission('web-search', q);

      const n = Math.min(MAX_RESULTS_CAP, Math.max(1, Math.round(Number(max_results) || defaultResults)));
      const domains = Array.isArray(include_domains)
        ? include_domains.map((d) => String(d).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')).filter(Boolean).slice(0, 10)
        : [];

      const plugin = { id: 'web', engine, max_results: n };
      if (domains.length) plugin.include_domains = domains;

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      const parent = ctx && ctx.signal;
      const onAbort = () => ctl.abort();
      if (parent) parent.addEventListener('abort', onAbort, { once: true });
      let body;
      try {
        body = await chatOnce({
          apiKey: agentOpts.apiKey,
          host: agentOpts.host || DEFAULT_HOST,
          model: agentOpts.model,
          // The answer text is thrown away — only the citations are used — so keep the
          // completion tiny. The search results arrive as annotations regardless.
          messages: [{ role: 'user', content: `Search the web for: ${q}\nReply with one line: "done".` }],
          maxTokens: 16,
          extra: { plugins: [plugin], usage: { include: true } },
          signal: ctl.signal,
        });
      } catch (e) {
        if (ctl.signal.aborted) throw new Error(parent && parent.aborted ? 'search cancelled' : `search timed out after ${TIMEOUT_MS / 1000}s`);
        throw e;
      } finally {
        clearTimeout(timer);
        if (parent) parent.removeEventListener('abort', onAbort);
      }

      const msg = (body && body.choices && body.choices[0] && body.choices[0].message) || {};
      const seen = new Set();
      const results = [];
      for (const a of msg.annotations || []) {
        const c = a && a.type === 'url_citation' && a.url_citation;
        if (!c || !c.url || seen.has(c.url)) continue;
        seen.add(c.url);
        results.push({
          title: String(c.title || '').slice(0, 200),
          url: c.url,
          ...(c.content ? { snippet: String(c.content).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS) } : {}),
        });
      }

      const usage = (body && body.usage) || {};
      const cost = Number(usage.cost) || Number(usage.total_cost) || 0;

      if (!results.length) {
        return {
          query: q, results: [], cost_usd: cost,
          note: 'The search returned no results. Try a broader or differently worded query — do not fall back '
            + 'to guessing URLs.',
        };
      }
      return { query: q, engine, results, cost_usd: cost };
    },
  };
}

module.exports = { makeWebSearchTool, SEARCH_FEE_USD, ENGINE, ENGINES, DEFAULT_ENGINE };
