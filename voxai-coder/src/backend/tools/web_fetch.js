/**
 * web_fetch — bounded public HTTPS research fetch (network.research).
 * Inspired by AI_GUI's web.fetch tool. Strips HTML → text, caps size, https-only.
 */
const { fetch } = globalThis;

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The page's outbound links, absolute, de-duplicated, same-site first.
 *
 * stripHtml throws hrefs away, so a fetched page was a dead end: the model could read
 * it but not follow it anywhere, and the only way to reach the next page was to
 * invent its URL. In one research session that meant 53 fetches, 36 of them 404/403,
 * and not one Gemini app page reached. Links turn guessing into navigating.
 */
function extractLinks(html, base, limit = 60) {
  let origin = '';
  try { origin = new URL(base).origin; } catch { /* keep '' */ }
  const seen = new Set();
  const same = [];
  const other = [];
  const re = /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) && seen.size < limit * 4) {
    const raw = (m[2] || m[3] || m[4] || '').trim();
    if (!raw || /^(#|javascript:|mailto:|tel:|data:)/i.test(raw)) continue;
    let abs;
    try { abs = new URL(raw, base).href.replace(/#.*$/, ''); } catch { continue; }
    if (!/^https:\/\//i.test(abs) || seen.has(abs)) continue;
    seen.add(abs);
    const text = stripHtml(m[5]).replace(/\s+/g, ' ').slice(0, 80);
    (abs.startsWith(origin) ? same : other).push(text ? { url: abs, text } : { url: abs });
  }
  return same.concat(other).slice(0, limit);
}

// Consecutive failed fetches before the model is told to stop guessing.
const MISS_STREAK_WARN = 3;

function makeWebFetchTool({ checkPermission }) {
  return {
    def: {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'Fetch a public HTTPS URL you ALREADY HAVE and return its text plus the links on the page. '
          + 'This is not a search engine. Get URLs from the user, or by following `links` from a page you '
          + 'fetched (start at the site homepage, docs index, blog index or sitemap). Do not construct or '
          + 'guess article URLs — guessed URLs mostly 404 and waste turns. If you cannot reach a source, say '
          + 'so; never describe a page you did not successfully fetch.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
          additionalProperties: false,
        },
      },
    },
    async run({ url }, ctx) {
      const u = String(url || '').trim();
      if (!/^https:\/\//i.test(u)) throw new Error('web_fetch only allows https:// URLs');
      await checkPermission('web-fetch', u);
      const ctl = AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined;
      // Without Accept-Language, sites localise by guesswork: Google's Gemini API docs
      // came back in Hindi in one research session, and the model cited them anyway.
      const res = await fetch(u, {
        headers: { 'User-Agent': 'VoxAI-Coder/0.1 (+research)', 'Accept-Language': 'en-US,en;q=0.9' },
        signal: ctl,
      });
      const sess = (ctx && ctx.session) || null;
      if (!res.ok) {
        const misses = sess ? (sess._fetchMisses = (sess._fetchMisses || 0) + 1) : 1;
        const out = { url: u, status: res.status, error: 'HTTP ' + res.status };
        if (misses >= MISS_STREAK_WARN) {
          out.hint = `${misses} fetches in a row have failed. Stop guessing URLs. Fetch a page you know exists `
            + '(the site homepage, docs index or sitemap.xml) and follow its `links`, or tell the user this '
            + 'source could not be reached. Do not report on pages you have not fetched.';
        }
        return out;
      }
      if (sess) sess._fetchMisses = 0;
      const ct = String(res.headers.get('content-type') || '');
      const buf = await res.arrayBuffer();
      const maxBytes = 512 * 1024;
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, maxBytes));
      // Surface to the right-hand preview panel (model-driven display).
      if (ctx && ctx.emit) {
        try {
          ctx.emit({ type: 'display', display: { url: u, kind: /html/i.test(ct) ? 'html' : 'text', title: u, text: (/html/i.test(ct) ? stripHtml(text) : text).slice(0, 30000) } });
        } catch { /* panel optional */ }
      }
      if (/html/i.test(ct)) {
        const links = extractLinks(text, res.url || u);
        return { url: u, status: res.status, kind: 'html', chars: text.length, text: stripHtml(text).slice(0, 20000), links };
      }
      return { url: u, status: res.status, kind: ct.split(';')[0] || 'text', chars: text.length, text: text.slice(0, 20000) };
    },
  };
}

module.exports = { makeWebFetchTool, stripHtml, extractLinks, MISS_STREAK_WARN };