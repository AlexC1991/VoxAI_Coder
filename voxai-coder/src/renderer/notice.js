/* The corner card (notice.html): fills itself from the query string, counts down,
   pauses while pointed at, and tells main/attention.js which answer was clicked. */
(function () {
  const $ = (id) => document.getElementById(id);
  let d = {};
  try { d = JSON.parse(new URLSearchParams(location.search).get('d') || '{}'); } catch { d = {}; }
  const act = (a) => { try { window.notice.act(a); } catch { /* closing */ } };

  const card = $('card');
  if (d.kind === 'ask') card.classList.add('ask');
  document.documentElement.style.setProperty('--tone', d.tone || '#c8a961');
  $('t').textContent = d.title || 'VoxAI Coder';
  $('s').textContent = d.sub ? '· ' + d.sub : '';
  $('w').textContent = d.what || '';
  $('w').title = d.what || '';
  for (const b of d.actions || []) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'b' + (b.primary ? ' pri' : '') + (b.quiet ? ' no' : '');
    el.textContent = b.label;
    if (b.title) el.title = b.title;
    el.onclick = (e) => { e.stopPropagation(); leave(b.act); };
    $('acts').appendChild(el);
  }

  const bar = $('left');
  let gone = false;
  function leave(a) {
    if (gone) return;
    gone = true;
    card.classList.add('out');
    setTimeout(() => act(a), 130);
  }
  $('x').onclick = (e) => { e.stopPropagation(); leave('dismiss'); };
  card.onclick = () => leave('open');                 // the card itself opens the session

  // Countdown, paused while the pointer is on the card.
  const total = Math.max(2000, Number(d.timeoutMs) || 12000);
  let left = total, last = 0, paused = false;
  card.addEventListener('mouseenter', () => { paused = true; });
  card.addEventListener('mouseleave', () => { paused = false; });
  function tick(now) {
    if (gone) return;
    if (last && !paused) left -= now - last;
    last = now;
    bar.style.transform = 'scaleX(' + Math.max(0, left / total) + ')';
    if (left <= 0) { leave('expire'); return; }
    requestAnimationFrame(tick);
  }
  // Answered somewhere else: fade and let main close the window.
  try { window.notice.onBye(() => { if (!gone) { gone = true; card.classList.add('out'); } }); } catch { /* no bridge */ }
  requestAnimationFrame(() => { card.classList.add('in'); requestAnimationFrame(tick); });
})();
