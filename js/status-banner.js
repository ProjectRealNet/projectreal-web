(() => {
  const STATUS_URL = 'https://status.projectreal.gg/index.json';
  const OBSERVER_URL = 'https://real-status.support-projectreal.workers.dev/api/status';
  const STATUS_PAGE_URL = 'https://status.projectreal.gg/';
  const MAINTENANCE_PAGE_URL = 'https://status.projectreal.gg/maintenance';
  const POLL_INTERVAL_MS = 5 * 60_000;
  const CACHE_KEY = 'real:status-banner:v1';
  const CACHE_TTL_MS = POLL_INTERVAL_MS;

  if (typeof window.__realStatusBannerCleanup === 'function') {
    window.__realStatusBannerCleanup();
  }

  const controller = new AbortController();
  let resizeObserver = null;

  function clearBanner() {
    resizeObserver?.disconnect();
    resizeObserver = null;
    document.querySelector('.status-banner')?.remove();
    document.body?.classList.remove('has-status-banner');
    document.documentElement.style.removeProperty('--status-banner-height');
  }

  function classify(data, observer) {
    const attributes = data?.data?.attributes || {};
    const included = data?.included || [];
    const resources = included
      .filter((item) => item?.type === 'status_page_resource')
      .map((item) => ({
        name: String(item?.attributes?.public_name || ''),
        status: String(item?.attributes?.status || '').toLowerCase(),
      }));
    const reports = included
      .filter((item) => item?.type === 'status_report' && item?.attributes?.report_type === 'maintenance')
      .map((item) => ({ id: item.id, ...item.attributes }))
      .filter((report) => Number.isFinite(Date.parse(report.starts_at)))
      .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    const now = Date.now();
    const activeReport = reports.find((report) => {
      const start = Date.parse(report.starts_at);
      const end = Date.parse(report.ends_at);
      return start <= now && (!Number.isFinite(end) || end > now);
    });
    const scheduledReport = reports.find((report) => Date.parse(report.starts_at) > now);
    const reportKey = (report) => report && `report:${report.id}:${report.starts_at}:${report.ends_at || ''}`;

    if (activeReport) {
      return { level: 'maintenance', key: reportKey(activeReport) || attributes.updated_at };
    }

    const observerState = String(observer?.overall?.display_state || '').toLowerCase();
    const observerReason = String(observer?.overall?.reason || '');
    const isRobloxUpdateLag = observer?.source_health === 'fresh' && observerReason === 'UPDATE_REQUIRED';
    if (isRobloxUpdateLag) {
      return {
        level: 'update',
        key: `observer:update:${observer?.last_checked_at || observer?.updated || attributes.updated_at || 'current'}`,
      };
    }

    if (observer?.source_health === 'fresh' && !isRobloxUpdateLag) {
      if (observerState === 'outage') return { level: 'outage', key: `observer:${observerState}` };
      if (['partial', 'degraded'].includes(observerState)) {
        return { level: 'degraded', key: `observer:${observerState}:${observerReason || 'current'}` };
      }
    }

    // Better Stack has binary monitor states. Ignore its own observer heartbeat
    // as a product outage, then use the actual customer-facing resources as a
    // fallback if the semantic Worker API is temporarily unreachable.
    const customerResources = resources.filter((resource) => resource.name !== 'Status Observer');
    const down = customerResources.filter((resource) => ['downtime', 'outage', 'major_outage'].includes(resource.status));
    if (down.length) {
      if (down.every((resource) => resource.name === 'Executor')) {
        return { level: 'degraded', key: `executor:${attributes.updated_at || 'current'}` };
      }
      return { level: 'outage', key: attributes.updated_at };
    }
    if (customerResources.some((resource) => ['degraded', 'degraded_performance', 'partial_outage'].includes(resource.status))) {
      return { level: 'degraded', key: attributes.updated_at };
    }
    if (scheduledReport) return { level: 'scheduled', key: reportKey(scheduledReport) };
    return null;
  }

  function render(level, updatedAt) {
    const body = document.body;
    if (!body) return;

    const incidentKey = `${level}:${updatedAt || 'current'}`;
    try {
      if (sessionStorage.getItem('real:dismissed-status-banner') === incidentKey) {
        clearBanner();
        return;
      }
    } catch {}

    let banner = document.querySelector('.status-banner');
    if (banner?.dataset.incidentKey === incidentKey) return;
    clearBanner();

    banner = document.createElement('aside');
    banner.className = `status-banner status-banner--${level}`;
    banner.dataset.incidentKey = incidentKey;
    banner.setAttribute('role', level === 'outage' ? 'alert' : 'status');
    banner.setAttribute('aria-live', level === 'outage' ? 'assertive' : 'polite');

    const content = document.createElement('span');
    content.className = 'status-banner-content';

    const message = document.createElement('strong');
    message.textContent = body.dataset[`status${level[0].toUpperCase()}${level.slice(1)}`] || '';

    const link = document.createElement('a');
    link.href = level === 'maintenance' || level === 'scheduled'
      ? MAINTENANCE_PAGE_URL
      : STATUS_PAGE_URL;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = body.dataset.statusLink || 'View live status';

    const close = document.createElement('button');
    close.className = 'status-banner-close';
    close.type = 'button';
    close.setAttribute('aria-label', body.dataset.statusDismiss || 'Dismiss status notification');
    close.textContent = '×';
    close.addEventListener('click', () => {
      try { sessionStorage.setItem('real:dismissed-status-banner', incidentKey); } catch {}
      clearBanner();
    });

    content.append(message, link);
    banner.append(content, close);
    body.prepend(banner);
    body.classList.add('has-status-banner');

    const updateHeight = () => {
      document.documentElement.style.setProperty('--status-banner-height', `${Math.ceil(banner.getBoundingClientRect().height)}px`);
    };
    updateHeight();
    resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(banner);
  }

  function readCachedStatus() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return { hit: false, status: null };
      const cached = JSON.parse(raw);
      if (!cached || Date.now() - Number(cached.cachedAt || 0) > CACHE_TTL_MS) return { hit: false, status: null };
      return { hit: Object.hasOwn(cached, 'status'), status: cached.status || null };
    } catch {
      return { hit: false, status: null };
    }
  }

  function writeCachedStatus(status) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ cachedAt: Date.now(), status }));
    } catch {}
  }

  function applyStatus(status) {
    if (!status) {
      clearBanner();
      return;
    }
    render(status.level, status.key);
  }

  async function syncStatus() {
    try {
      const fetchJson = async (url) => {
        const response = await fetch(url, {
          cache: 'default',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
        });
        if (!response.ok) throw new Error(`Status source returned ${response.status}`);
        return response.json();
      };
      const [statusResult, observerResult] = await Promise.allSettled([
        fetchJson(STATUS_URL),
        fetchJson(OBSERVER_URL),
      ]);
      if (statusResult.status === 'rejected' && observerResult.status === 'rejected') return;
      const data = statusResult.status === 'fulfilled' ? statusResult.value : null;
      const observer = observerResult.status === 'fulfilled' ? observerResult.value : null;
      const status = classify(data, observer);
      writeCachedStatus(status ? { level: status.level, key: status.key || data?.data?.attributes?.updated_at } : null);
      applyStatus(status);
    } catch (error) {
      if (error?.name !== 'AbortError' && error?.name !== 'TimeoutError') {
        console.debug('Status banner refresh failed');
      }
    }
  }

  const syncIfVisible = () => {
    if (document.visibilityState !== 'hidden') void syncStatus();
  };
  const interval = window.setInterval(syncIfVisible, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', syncIfVisible, { signal: controller.signal });
  document.addEventListener('astro:page-load', syncStatus, { signal: controller.signal });
  window.__realStatusBannerCleanup = () => {
    controller.abort();
    window.clearInterval(interval);
    resizeObserver?.disconnect();
  };
  const cachedStatus = readCachedStatus();
  if (cachedStatus.hit) applyStatus(cachedStatus.status);
  else void syncStatus();
})();
