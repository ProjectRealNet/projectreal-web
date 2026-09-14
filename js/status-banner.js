(async () => {
  try {
    const r = await fetch('https://api.projectreal.gg/status', {
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return;
    const data = await r.json();
    const statuses = Object.values(data.services || {});
    const hasOutage   = statuses.some(v => v === 'outage');
    const hasDegraded = statuses.some(v => v === 'degraded');
    if (!hasOutage && !hasDegraded) return;
    const b = document.createElement('div');
    b.className = 'outage-banner' + (hasDegraded && !hasOutage ? ' outage-banner--degraded' : '');
    const level = hasOutage ? 'a major outage' : 'degraded performance';
    const text = document.createElement('span');
    text.className = 'outage-banner-text';
    text.innerHTML = '&#9888;&#xFE0E; We are currently experiencing ' + level
      + '. Check <a href="https://status.projectreal.gg" target="_blank" rel="noopener">status.projectreal.gg</a> for live updates.';

    const close = document.createElement('button');
    close.className = 'outage-banner-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss status banner');
    close.textContent = '×';
    close.addEventListener('click', () => b.remove());

    b.append(text, close);
    document.body.prepend(b);
  } catch {}
})();
