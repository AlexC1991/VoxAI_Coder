/**
 * Line endings. Models write "\n"; a Windows file is often "\r\n". An edit on such a
 * file matched only through the whitespace-forgiving fallback and left the file with
 * mixed endings, and a multi-line patch never matched at all. Found in a live run.
 * Text going into a file takes that file's endings.
 */

/** The file's line ending: whichever it uses more. */
function eolOf(text) {
  const s = String(text || '');
  const crlf = (s.match(/\r\n/g) || []).length;
  const lf = (s.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** `s` with its line breaks in `eol`. */
function toEol(s, eol) {
  s = String(s == null ? '' : s);
  return eol === '\r\n' ? s.replace(/\r?\n/g, '\r\n') : s;
}

module.exports = { eolOf, toEol };
