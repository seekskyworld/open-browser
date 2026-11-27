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

function paintTarget(x, y, origin, actionKind = '操作') {
  const key = '__openBrowserActionRing';
  globalThis[key]?.remove();
  globalThis.__openBrowserAgentCursor?.remove();
  delete globalThis[key];
  delete globalThis.__openBrowserAgentCursor;
  if (origin !== location.origin || !Number.isFinite(x) || !Number.isFinite(y) ||
      x < 0 || y < 0 || x > innerWidth || y > innerHeight || !document.documentElement) return;
  const ring = document.createElement('div');
  ring.inert = true;
  ring.setAttribute('aria-hidden', 'true');
  ring.setAttribute('data-open-browser-target', '');
  const cursor = document.createElement('div');
  cursor.inert = true;
  cursor.setAttribute('aria-hidden', 'true');
  cursor.setAttribute('data-open-browser-agent-cursor', '');
  const label = document.createElement('span');
  const actionLabels = { click: '点击', doubleClick: '双击', hover: '悬停', press: '按键',
    scroll: '滚动', drag: '拖拽', fill: '填写', fillCredential: '填写凭据', select: '选择',
    upload: '上传', setChecked: '切换' };
  label.textContent = 'Agent · ' + (actionLabels[actionKind] || String(actionKind || '操作'));
  cursor.append(label);
  for (const [property, value] of Object.entries({
    all: 'initial', position: 'fixed', left: (x - 11) + 'px', top: (y - 11) + 'px',
    width: '18px', height: '18px', border: '2px solid #7659e8', 'border-radius': '50%',
    'box-shadow': '0 0 0 2px white', 'z-index': '2147483647', 'pointer-events': 'none',
  })) ring.style.setProperty(property, value, 'important');
  for (const [property, value] of Object.entries({
    all: 'initial', position: 'fixed', left: x + 'px', top: y + 'px',
    width: '18px', height: '24px', background: '#7659e8',
    '-webkit-clip-path': 'polygon(0 0, 0 100%, 30% 72%, 48% 100%, 60% 94%, 43% 66%, 86% 66%)',
    filter: 'drop-shadow(0 1px 2px rgba(20,20,40,.55))',
    'z-index': '2147483647', 'pointer-events': 'none', transition: 'left 180ms ease, top 180ms ease',
  })) cursor.style.setProperty(property, value, 'important');
  for (const [property, value] of Object.entries({
    all: 'initial', display: 'block', position: 'absolute', left: '12px', top: '10px',
    padding: '3px 7px', color: 'white', background: 'rgba(45,35,90,.92)',
    'border-radius': '5px', font: '12px/1.2 -apple-system,BlinkMacSystemFont,sans-serif',
    'white-space': 'nowrap', 'box-shadow': '0 1px 4px rgba(20,20,40,.25)',
  })) label.style.setProperty(property, value, 'important');
  document.documentElement.append(ring);
  document.documentElement.append(cursor);
  globalThis[key] = ring;
  globalThis.__openBrowserAgentCursor = cursor;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
    ring.animate([{ transform: 'scale(.75)', opacity: 1 }, { transform: 'scale(1.75)', opacity: 0 }], 460);
  setTimeout(() => {
    ring.remove();
    if (globalThis[key] === ring) delete globalThis[key];
  }, 470);
}

async function paint(tab, fn, args, current) {
  if (!current() || tab.page.isClosed() || !/^https?:/.test(tab.page.url())) return;
  let executionContextId = tab.context?.navigation === tab.navigation ? tab.context.id : undefined;
  if (!executionContextId) {
    const { frameTree } = await tab.session.send('Page.getFrameTree');
    const created = await tab.session.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'open-browser-activity',
    });
    executionContextId = created.executionContextId;
    tab.context = { navigation: tab.navigation, id: executionContextId };
  }
  if (!current()) return;
  try {
    await tab.session.send('Runtime.evaluate', { contextId: executionContextId,
      expression: '(' + fn.toString() + ')(...' + JSON.stringify(args) + ')' });
  } catch (error) {
    if (tab.context?.id === executionContextId && /context|execution|target/i.test(error.message)) {
      tab.context = undefined;
      return paint(tab, fn, args, current);
    }
    throw error;
  }
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
      paint(tab, paintEdge, [Boolean(origin), origin], () => tab.revision === revision)
        .then(() => { if (!origin) return paint(tab, paintTarget, [null, null, null], () => true); })
        .catch(() => {}));
  }
  return {
    track(page, session, workspaceId, pageId) {
      if (tabs.has(pageId)) return;
      const tab = { page, session, workspaceId, origin: null, revision: 0, pending: Promise.resolve() };
      tabs.set(pageId, tab);
      tab.navigation = 0;
      tab.navigated = frame => { if (frame === page.mainFrame()) { tab.navigation++; tab.context = undefined; } };
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
      tab.context = undefined;
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
    target({ workspaceId, pageId, x, y, origin, controlGeneration, actionKind }) {
      const tab = tabs.get(pageId);
      if (!tab || tab.workspaceId !== workspaceId) return;
      const navigation = tab.navigation;
      tab.pending = tab.pending.then(() => paint(tab, paintTarget, [x, y, origin, actionKind], () =>
        tab.generation === controlGeneration && tab.navigation === navigation && tab.mode === 'agent')).catch(() => {});
    },
    has(pageId) { return tabs.has(pageId); },
  };
}
