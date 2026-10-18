'use strict';
/**
 * Settings > Appearance: the theme, the accent colour, the size of message text and reduced
 * motion. Loaded in <head>, before the page paints, so a light theme never flashes dark first:
 * main answers the settings synchronously (appearance:get), and the page applies them again
 * whenever they change (Settings, or another window: main sends 'appearance' to every pane).
 *
 * The page's colours are tokens on :root (index.html): a theme redefines the surface and text
 * tokens with html[data-theme], and the accent sets --gold, --goldedge, --gold-hi and --on-gold
 * here (the names are older than the picker: --gold is "the accent").
 */
(function () {
  // Each accent has a shade for dark pages and a deeper one that reads on a light page.
  const ACCENTS = {
    gold: { dark: '#c8a961', light: '#856826', name: 'Gold' },
    blue: { dark: '#7aa2f7', light: '#2f5fbf', name: 'Blue' },
    green: { dark: '#8cc084', light: '#3b7a34', name: 'Green' },
    teal: { dark: '#6cc4bc', light: '#1f7f78', name: 'Teal' },
    violet: { dark: '#a99af0', light: '#6a4fc4', name: 'Violet' },
    rose: { dark: '#e08aa0', light: '#b0405e', name: 'Rose' },
    orange: { dark: '#e39a5c', light: '#b25c1e', name: 'Orange' },
  };
  const THEMES = { dark: 'Dark', midnight: 'Midnight', light: 'Light', system: 'Match the system' };
  // The background each theme paints, for the window behind the page (main.js) and the mixes below.
  const BG = { dark: '#0e0e10', midnight: '#0b0f17', light: '#f7f5f0' };
  const SIZES = { s: '13.5px', m: '15px', l: '16.5px', xl: '18px' };

  const hex = (c) => {
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(c || '').trim());
    if (!m) return null;
    const h = m[1].length === 3 ? m[1].replace(/./g, (x) => x + x) : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  };
  const toHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  /** a toward b by t (0..1). */
  const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t));
  // WCAG relative luminance, to pick dark or light text for the accent.
  const lum = (c) => hex(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

  const media = (q) => { try { return window.matchMedia(q); } catch { return null; } };
  const darkQ = media('(prefers-color-scheme: dark)');
  const motionQ = media('(prefers-reduced-motion: reduce)');

  /** The theme actually shown: "system" follows the OS between Dark and Light. */
  function resolveTheme(t) {
    if (t === 'system') return darkQ && !darkQ.matches ? 'light' : 'dark';
    return BG[t] ? t : 'dark';
  }
  /** The accent's colours on this theme: { gold, edge, hi, on }. */
  function accentFor(accent, theme) {
    const light = theme === 'light';
    const preset = ACCENTS[accent];
    let gold = preset ? preset[light ? 'light' : 'dark'] : (hex(accent) ? toHex(hex(accent)) : ACCENTS.gold.dark);
    // A colour that is too faint on this background, or under its own button text, is deepened
    // (light theme) or lifted (dark) until both read: 3:1 on the page, 4.5:1 for the text on it.
    const bg = BG[theme];
    const textOn = (g) => (contrast(g, '#121110') >= contrast(g, '#ffffff') ? '#121110' : '#ffffff');
    for (let i = 0; i < 12 && (contrast(gold, bg) < 3 || contrast(gold, textOn(gold)) < 4.5); i++) gold = mix(gold, light ? '#000000' : '#ffffff', 0.1);
    const on = textOn(gold);
    return {
      gold,
      edge: mix(bg, gold, light ? 0.38 : 0.3),
      hi: mix(gold, light ? '#000000' : '#ffffff', 0.16),
      on,
    };
  }

  let last = null;
  /** Apply { theme, accent, msgSize, reduceMotion } to this page. */
  function applyAppearance(a) {
    a = a || {};
    last = a;
    const root = document.documentElement;
    const theme = resolveTheme(a.theme || 'dark');
    root.dataset.theme = theme;
    const c = accentFor(a.accent || 'gold', theme);
    root.style.setProperty('--gold', c.gold);
    root.style.setProperty('--goldedge', c.edge);
    root.style.setProperty('--gold-hi', c.hi);
    root.style.setProperty('--on-gold', c.on);
    root.style.setProperty('--msg-fs', SIZES[a.msgSize] || SIZES.m);
    root.classList.toggle('calm', a.reduceMotion === true || (a.reduceMotion !== false && !!(motionQ && motionQ.matches)));
    // Scrollbars take literal colours (custom properties resolve unreliably in their
    // pseudo-elements, see index.html), so their rule is written out for this theme.
    const edge2 = getComputedStyle(root).getPropertyValue('--edge2').trim() || '#2e2e34';
    let st = document.getElementById('voxScrollbars');
    if (!st) { st = document.createElement('style'); st.id = 'voxScrollbars'; (document.head || root).appendChild(st); }
    st.textContent = `::-webkit-scrollbar-thumb{background-color:${edge2}}`
      + `::-webkit-scrollbar-thumb:hover{background-color:${c.edge}}`
      + `::-webkit-scrollbar-thumb:active{background-color:${c.gold}}`;
    return { theme, ...c };
  }

  // "Match the system" follows the OS as it changes, as does the system's reduced-motion setting.
  const again = () => { if (last) applyAppearance(last); };
  try { darkQ && darkQ.addEventListener('change', again); } catch { /* old engine */ }
  try { motionQ && motionQ.addEventListener('change', again); } catch { /* old engine */ }

  window.VoxAppearance = { ACCENTS, THEMES, SIZES, BG, apply: applyAppearance, resolveTheme, accentFor, current: () => last };
  // Before the first paint.
  try { applyAppearance(window.voxai && window.voxai.appearance ? window.voxai.appearance() : null); } catch { applyAppearance(null); }
})();
