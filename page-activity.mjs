// Runs in a Chromium isolated world. The page receives only a decorative,
// input-transparent edge. Control requests stay in the browser toolbar.
function paintEdge(state, origin) {
  const key = '__openBrowserActivityEdge';
  if (!state || location.origin !== origin) {
    globalThis[key]?.remove();
    delete globalThis[key];
    return;
  }
  if (!document.documentElement) return;
  if (globalThis[key]?.isConnected && globalThis[key].dataset.openBrowserActivity === state) return;
  globalThis[key]?.remove();
  const edge = document.createElement('div');
  edge.setAttribute('aria-hidden', 'true');
  edge.setAttribute('data-open-browser-activity', state);
  edge.inert = true;
  for (const [property, value] of Object.entries({
    all: 'initial', position: 'fixed', inset: '0', 'z-index': '2147483647',
    'pointer-events': 'none', 'border-radius': '4px',
    'box-shadow': state === 'running' ? 'inset 0 0 0 2px #7762e8, inset 0 0 12px 1px rgba(62,159,215,.55)'
      : 'inset 0 0 0 2px rgba(119,98,232,.55)',
  })) edge.style.setProperty(property, value, 'important');
  if (state === 'running' && !matchMedia('(prefers-reduced-motion: reduce)').matches)
    edge.animate([{ opacity: .6 }, { opacity: 1 }], { duration: 850, iterations: Infinity, direction: 'alternate' });
  document.documentElement.append(edge);
  globalThis[key] = edge;
}

function paintTarget(x, y, origin, actionKind = '操作') {
  const key = '__openBrowserActionRing';
  globalThis[key]?.remove();
  delete globalThis[key];
  if (origin !== location.origin || !Number.isFinite(x) || !Number.isFinite(y) ||
      x < 0 || y < 0 || x > innerWidth || y > innerHeight || !document.documentElement) {
    globalThis.__openBrowserAgentCursor?.remove();
    delete globalThis.__openBrowserAgentCursor;
    return;
  }
  const ring = document.createElement('div');
  ring.inert = true;
  ring.setAttribute('aria-hidden', 'true');
  ring.setAttribute('data-open-browser-target', '');
  const actionLabels = { click: '点击', doubleClick: '双击', hover: '悬停', press: '按键',
    scroll: '滚动', drag: '拖拽', fill: '填写', fillCredential: '填写凭据', select: '选择',
    upload: '上传', setChecked: '切换' };
  for (const [property, value] of Object.entries({
    all: 'initial', position: 'fixed', left: (x - 11) + 'px', top: (y - 11) + 'px',
    width: '18px', height: '18px', border: '2px solid #7659e8', 'border-radius': '50%',
    'box-shadow': '0 0 0 2px white', 'z-index': '2147483647', 'pointer-events': 'none',
  })) ring.style.setProperty(property, value, 'important');
  let cursor = globalThis.__openBrowserAgentCursor;
  if (!cursor?.isConnected || cursor.children.length !== 2) {
    cursor?.remove();
    cursor = document.createElement('div');
    cursor.inert = true;
    cursor.setAttribute('aria-hidden', 'true');
    cursor.setAttribute('data-open-browser-agent-cursor', '');
    const arrow = document.createElement('span'), label = document.createElement('span');
    const style = (node, properties) => {
      for (const [property, value] of Object.entries(properties)) node.style.setProperty(property, value, 'important');
    };
    style(cursor, { all: 'initial', position: 'fixed', width: '18px', height: '24px',
      'z-index': '2147483647', 'pointer-events': 'none',
      transition: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : 'left 140ms ease, top 140ms ease' });
    style(arrow, { all: 'initial', display: 'block', width: '18px', height: '24px', background: '#7659e8',
      'clip-path': 'polygon(0 0, 0 100%, 30% 72%, 48% 100%, 60% 94%, 43% 66%, 86% 66%)', 'pointer-events': 'none' });
    style(label, { all: 'initial', display: 'block', position: 'absolute', padding: '3px 7px',
      color: 'white', background: 'rgba(45,35,90,.92)', 'border-radius': '5px',
      font: '12px/1.2 -apple-system,BlinkMacSystemFont,sans-serif', 'white-space': 'nowrap', 'pointer-events': 'none' });
    cursor.append(arrow, label);
    document.documentElement.append(cursor);
    globalThis.__openBrowserAgentCursor = cursor;
  }
  cursor.style.setProperty('left', x + 'px', 'important');
  cursor.style.setProperty('top', y + 'px', 'important');
  const label = cursor.lastElementChild;
  label.textContent = 'Agent · ' + (actionLabels[actionKind] || '操作');
  label.style.setProperty('left', x + 120 > innerWidth ? 'auto' : '12px', 'important');
  label.style.setProperty('right', x + 120 > innerWidth ? '18px' : 'auto', 'important');
  label.style.setProperty('top', y + 40 > innerHeight ? '-22px' : '10px', 'important');
  document.documentElement.append(ring);
  globalThis[key] = ring;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
    ring.animate([{ transform: 'scale(.75)', opacity: 1 }, { transform: 'scale(1.75)', opacity: 0 }], 460);
  setTimeout(() => {
    ring.remove();
    if (globalThis[key] === ring) delete globalThis[key];
  }, 470);
}

async function paint(tab, fn, args, current, retry = true) {
  if (!current() || tab.page.isClosed() || !/^https?:/.test(tab.page.url())) return;
  let executionContextId = tab.context?.navigation === tab.navigation ? tab.context.id : undefined;
  if (!executionContextId) {
    const navigation = tab.navigation;
    const { frameTree } = await tab.session.send('Page.getFrameTree');
    const created = await tab.session.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'open-browser-activity',
    });
    executionContextId = created.executionContextId;
    if (navigation !== tab.navigation || !current()) return;
    tab.context = { navigation, id: executionContextId };
  }
  if (!current()) return;
  try {
    await tab.session.send('Runtime.evaluate', { contextId: executionContextId,
      expression: '(' + fn.toString() + ')(...' + JSON.stringify(args) + ')' });
  } catch (error) {
    if (tab.context?.id === executionContextId && /context|execution|target/i.test(error.message)) {
      tab.context = undefined;
      if (retry) return paint(tab, fn, args, current, false);
    }
    throw error;
  }
}

export function pageActivity() {
  const tabs = new Map();
  function render(tab, origin, state, force = false) {
    if (!force && tab.origin === origin && tab.edgeState === state) return;
    const wasActive = !!tab.origin;
    tab.origin = origin;
    tab.edgeState = state;
    if (!wasActive && !origin) return;
    const revision = ++tab.revision;
    tab.pending = tab.pending.then(() =>
      paint(tab, paintEdge, [state, origin], () => tab.revision === revision)
        .then(() => { if (state !== 'running') return paint(tab, paintTarget, [null, null, null], () => tab.revision === revision); })
        .catch(() => {}));
  }
  return {
    track(page, session, workspaceId, pageId) {
      if (tabs.has(pageId)) return;
      const tab = { page, session, workspaceId, origin: null, revision: 0, targetRevision: 0, pending: Promise.resolve() };
      tabs.set(pageId, tab);
      tab.navigation = 0;
      tab.navigated = frame => { if (frame === page.mainFrame()) { tab.navigation++; tab.context = undefined; } };
      page.on('framenavigated',tab.navigated);
      tab.loaded = () => { if (tab.origin) render(tab, tab.origin, tab.edgeState, true); };
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
          tab.pending = tab.pending.then(() => paint(tab, paintTarget, [null, null, null],
            () => tab.generation === controlGeneration)).catch(() => {});
        tab.mode = mode;
        const page = pages.find(page => page.pageId === id);
        const origin = mode === 'agent' && /^https?:/.test(page?.origin) ? page.origin : null;
        const state = origin ? (running.has(id) ? 'running' : 'idle') : null;
        render(tab, origin, state);
      }
    },
    target({ workspaceId, pageId, x, y, origin, controlGeneration, actionKind }) {
      const tab = tabs.get(pageId);
      if (!tab || tab.workspaceId !== workspaceId) return;
      const navigation = tab.navigation;
      const ticket = ++tab.targetRevision;
      tab.pending = tab.pending.then(() => paint(tab, paintTarget, [x, y, origin, actionKind], () =>
        tab.generation === controlGeneration && tab.navigation === navigation && tab.mode === 'agent' &&
        tab.origin === origin && tab.edgeState === 'running' && tab.targetRevision === ticket)).catch(() => {});
    },
    has(pageId) { return tabs.has(pageId); },
  };
}
