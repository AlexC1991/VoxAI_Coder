/**
 * Write the renderer's Content-Security-Policy into index.html.
 *
 * The page holds the full window.voxai bridge, so a script that got into it could run
 * the agent, change settings and answer its own permission prompts. Escaping is the
 * first line of defence; this is the second: the browser runs only the page's own
 * inline script (by its SHA-256) and scripts shipped with the app -- not an injected
 * <script>, not an onerror= attribute, not a javascript: URL.
 *
 * The inline script's hash changes with every edit, so this runs before start, test and
 * dist (package.json), and a test checks the page is current.
 *
 *   node scripts/csp.js           rewrite the policy if it is out of date
 *   node scripts/csp.js --check   exit 1 if it is out of date
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'src', 'renderer', 'index.html');

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

function policyFor(html) {
  const hashes = inlineScripts(html).map((s) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`);
  return [
    "default-src 'none'",
    `script-src 'self' ${hashes.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

const META_RE = /<meta http-equiv="Content-Security-Policy" content="[^"]*">\n?/;

function withPolicy(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policyFor(html)}">\n`;
  if (META_RE.test(html)) return html.replace(META_RE, meta);
  return html.replace(/(<meta charset="utf-8">\n)/, `$1${meta}`);
}

if (require.main === module) {
  const html = fs.readFileSync(FILE, 'utf8');
  const next = withPolicy(html);
  if (process.argv.includes('--check')) {
    if (next !== html) { console.error('csp: the policy in index.html is out of date; run node scripts/csp.js'); process.exit(1); }
    console.log('csp: current');
  } else if (next !== html) {
    fs.writeFileSync(FILE, next, 'utf8');
    console.log('csp: policy updated');
  }
}

module.exports = { policyFor, withPolicy, inlineScripts };
