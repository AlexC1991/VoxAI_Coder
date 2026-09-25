/**
 * Command output as text, whichever encoding each line came in.
 *
 * On Windows cmd.exe's own commands (dir, echo, type) write to a pipe in the console's
 * OEM code page -- 437 or 850 here -- while node, git and python (told to) write UTF-8.
 * Read as UTF-8 throughout, "café" came back as "caf�" and the model could not use
 * the file names it was shown; chcp 65001 does not change what cmd itself writes. Found
 * in a live run. So each line is UTF-8 when it is valid UTF-8, and the OEM code page
 * when it is not.
 */
const { execFileSync } = require('child_process');

// The upper halves (0x80-0xFF) of the two OEM pages TextDecoder does not know.
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const CP850 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ';
const TABLES = { 437: CP437, 850: CP850 };
const LABELS = { 866: 'ibm866', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252' };

let oemCp = null;
function oemCodePage() {
  if (oemCp !== null) return oemCp;
  oemCp = 0;
  if (process.platform !== 'win32') return oemCp;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/c', 'chcp'], { windowsHide: true, encoding: 'latin1', timeout: 5000 });
    const m = /(\d{3,5})/.exec(out);
    if (m) oemCp = Number(m[1]);
  } catch {}
  return oemCp;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
function decodeLegacy(buf, cp) {
  const table = TABLES[cp];
  if (table) {
    let s = '';
    for (const b of buf) s += b < 0x80 ? String.fromCharCode(b) : table[b - 0x80];
    return s;
  }
  const label = LABELS[cp];
  if (label) { try { return new TextDecoder(label).decode(buf); } catch {} }
  return buf.toString('utf8');
}

/** Decode a command's output buffer, line by line. */
function decodeOutput(buf, cp = oemCodePage()) {
  if (buf == null) return '';
  if (typeof buf === 'string') return buf;
  try { return utf8.decode(buf); } catch { /* some lines are not UTF-8 */ }
  if (!cp || cp === 65001) return buf.toString('utf8');
  const parts = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      const line = buf.subarray(start, i === buf.length ? i : i + 1);
      try { parts.push(utf8.decode(line)); } catch { parts.push(decodeLegacy(line, cp)); }
      start = i + 1;
    }
  }
  return parts.join('');
}

module.exports = { decodeOutput, oemCodePage, CP437, CP850 };
