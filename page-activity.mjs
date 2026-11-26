// Runs in a Chromium isolated world. The page receives only a decorative,
// input-transparent edge. Control requests stay in the browser toolbar.
function paintEdge(active, origin) {
  const key = '__openBrowserActivityEdge';
  if (!active || location.origin !== origin) {
    globalThis[key]?.remove();
    delete globalThis[key];
    return;
  }
  if (globalThis[key]?.isConnected || !document.documentElement) return;
  const edge = document.createElement('div');
  edge.setAttribute('aria-hidden', 'true');
  edge.setAttribute('data-open-browser-activity', '');
  edge.inert = true;
  for (const [property, value] of Object.entries({
    all: 'initial', position: 'fixed', inset: '0', 'z-index': '2147483647',
    'pointer-events': 'none', 'border-radius': '4px',
    'box-shadow': 'inset 0 0 0 2px #7762e8, inset 0 0 12px 1px rgba(62,159,215,.55)',
  })) edge.style.setProperty(property, value, 'important');
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
    edge.animate([{ opacity: .6 }, { opacity: 1 }], { duration: 850, iterations: Infinity, direction: 'alternate' });
  document.documentElement.append(edge);
  globalThis[key] = edge;
}

function paintTarget(x, y, origin) {
  const key = '__openBrowserActionRing';
  globalThis[key]?.remove();
  delete globalThis[key];
  if (origin !== location.origin || !Number.isFinite(x) || !Number.isFinite(y) ||
      x < 0 || y < 0 || x > innerWidth || y > innerHeight || !document.documentElement) return;
  const ring = document.createElement('div');
  ring.inert = true;
  ring.setAttribute('aria-hidden', 'true');
  ring.setAttribute('data-open-browser-target', '');
  for (const [property, value] of Object.entries({
    all: 'initial', position: 'fixed', left: (x - 11) + 'px', top: (y - 11) + 'px',
    width: '18px', height: '18px', border: '2px solid #7659e8', 'border-radius': '50%',
    'box-shadow': '0 0 0 2px white', 'z-index': '2147483647', 'pointer-events': 'none',
  })) ring.style.setProperty(property, value, 'important');
  document.documentElement.append(ring);
  globalThis[key] = ring;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
    ring.animate([{ transform: 'scale(.75)', opacity: 1 }, { transform: 'scale(1.75)', opacity: 0 }], 460);
  setTimeout(() => { ring.remove(); if (globalThis[key] === ring) delete globalThis[key]; }, 470);
}

async function paint(tab, fn, args, current) {
  if (!current() || tab.page.isClosed() || !/^https?:/.test(tab.page.url())) return;
  const { frameTree } = await tab.session.send('Page.getFrameTree');
  const { executionContextId } = await tab.session.send('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id, worldName: 'open-browser-activity',
  });
  if (!current()) return;
  await tab.session.send('Runtime.evaluate', { contextId: executionContextId,
    expression: '(' + fn.toString() + ')(...' + JSON.stringify(args) + ')' });
}

export function pageActivity() {
  const tabs = new Map();
  function render(tab, origin, force = false) {
    if (!force && tab.origin === origin) return;
    const wasActive = !!tab.origin;
    tab.origin = origin;
    if (!wasActive && !origin) return;
    const revision = ++tab.revision;
    tab.pending = tab.pending.then(() =>
      paint(tab, paintEdge, [Boolean(origin), origin], () => tab.revision === revision)).catch(() => {});
  }
  return {
    track(page, session, workspaceId, pageId) {
      if (tabs.has(pageId)) return;
      const tab = { page, session, workspaceId, origin: null, revision: 0, pending: Promise.resolve() };
      tabs.set(pageId, tab);
      tab.navigation = 0;
      tab.navigated = frame => { if (frame === page.mainFrame()) tab.navigation++; };
      page.on('framenavigated',tab.navigated);
      tab.loaded = () => { if (tab.origin) render(tab, tab.origin, true); };
      page.on('domcontentloaded',tab.loaded);
      tab.closed = () => tabs.delete(pageId);
      page.once('close',tab.closed);
    },
    async release(pageId) {
      const tab = tabs.get(pageId);
      if (!tab) return;
      tabs.delete(pageId);
      tab.mode = 'released';
      tab.generation = null;
      tab.revision++;
      tab.page.off('framenavigated',tab.navigated);
      tab.page.off('domcontentloaded',tab.loaded);
      tab.page.off('close',tab.closed);
      await tab.pending;
      try {
        await paint(tab,paintEdge,[false,null],() => true);
        await paint(tab,paintTarget,[null,null,null],() => true);
      } finally { await tab.session.detach().catch(() => {}); }
    },
    update({ workspaceId, pages, mode, activity, controlGeneration }) {
      const running = new Set((activity.running || [activity.current]).filter(job => mode === 'agent' && job?.state === 'running').map(job => job.pageId));
      for (const [id, tab] of tabs) {
        if (tab.workspaceId !== workspaceId) continue;
        const previous = tab.generation;
        tab.generation = controlGeneration;
        if (previous && previous !== controlGeneration)
          void paint(tab, paintTarget, [null, null, null], () => tab.generation === controlGeneration).catch(() => {});
        tab.mode = mode;
        const origin = running.has(id) && pages.find(page => page.pageId === id)?.origin;
        render(tab, origin && /^https?:/.test(origin) ? origin : null);
      }
    },
    target({ workspaceId, pageId, x, y, origin, controlGeneration }) {
      const tab = tabs.get(pageId);
      if (!tab || tab.workspaceId !== workspaceId) return;
      const navigation = tab.navigation;
      void paint(tab, paintTarget, [x, y, origin], () => tab.generation === controlGeneration &&
        tab.navigation === navigation && tab.mode === 'agent').catch(() => {});
    },
    has(pageId) { return tabs.has(pageId); },
  };
}
