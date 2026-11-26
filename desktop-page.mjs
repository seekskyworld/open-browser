// Native desktop surface. Its pixel stream and input are private host calls.
function reject(code) { throw Object.assign(new Error(code), { code }); }

function checkPage(ws, tab, documentId, generation) {
  if (ws.pages.get(tab.id) !== tab || tab.page.isClosed()) reject('page_not_found');
  if (ws.generation !== generation || !['agent', 'human'].includes(ws.mode)) reject('stale_control');
  if (tab.documentId !== documentId) reject('stale_observation');
  if (!ws.origins.has(URL.parse(tab.page.url())?.origin)) reject('origin_denied');
}

export async function refreshTitle(ws, tab) {
  const { documentId } = tab;
  const url = URL.parse(tab.page.url());
  if (!url || !ws.origins.has(url.origin)) return '';
  const raw = await tab.page.title().catch(() => '');
  if (tab.documentId !== documentId) return '';
  // Some title-less pages supply the address as a title. Hide URL credentials,
  // query strings and fragments in workspace summaries.
  const asUrl = URL.parse(raw);
  const clean = asUrl && ['http:', 'https:'].includes(asUrl.protocol)
    ? asUrl.origin : raw.replace(/(?:https?:\/\/|\/)[^\s?#]*[?#][^\s]*/gi, address =>
      address.split(/[?#]/, 1)[0]).trim().slice(0, 160);
  tab.title = clean;
  return clean;
}

const keyNames = new Set([
  'Tab', 'Enter', 'Backspace', 'Delete', 'Escape', 'Space', 'Home', 'End',
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Alt', 'Control', 'Meta', 'Shift', 'Insert', 'CapsLock',
]);

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) reject('invalid_input');
  let fields;
  switch (event.type) {
    case 'mouseMove': case 'mouseDown': case 'mouseUp':
      fields = ['type', 'x', 'y', 'button', 'clickCount'];
      if (event.button !== undefined && !['left', 'right', 'middle'].includes(event.button))
        reject('invalid_input');
      if (event.clickCount !== undefined && ![1, 2, 3].includes(event.clickCount))
        reject('invalid_input');
      break;
    case 'wheel':
      fields = ['type', 'x', 'y', 'deltaX', 'deltaY'];
      if (![event.deltaX, event.deltaY].every(value => Number.isFinite(value) && Math.abs(value) <= 10000))
        reject('invalid_input');
      break;
    case 'text':
      fields = ['type', 'text'];
      if (typeof event.text !== 'string' || !event.text.length || event.text.length > 8192)
        reject('invalid_input');
      break;
    case 'keyDown': case 'keyUp':
      fields = ['type', 'key'];
      if (typeof event.key !== 'string' || !(keyNames.has(event.key) || /^[ -~]$/.test(event.key)
          || /^F(?:[1-9]|1[0-2])$/.test(event.key))) reject('invalid_input');
      break;
    default: reject('invalid_input');
  }
  if (Object.keys(event).some(field => !fields.includes(field))) reject('invalid_input');
}

function navigationKey(held, key) {
  const command = held.has('Meta') || held.has('Control');
  if (key === 'F5' || (command && key.toLowerCase() === 'r')) return 'reload';
  if ((held.has('Meta') && key === '[') || (held.has('Alt') && key === 'ArrowLeft')) return 'back';
  if ((held.has('Meta') && key === ']') || (held.has('Alt') && key === 'ArrowRight')) return 'forward';
}

export async function pageLocation(ws, tab) {
  // CDP reports pushState, redirects, back/forward and in-page navigation from
  // Chromium's real history. The private session closes along with the tab.
  tab.historySession ??= tab.page.context().newCDPSession(tab.page).catch(error => {
    tab.historySession = undefined;
    throw error;
  });
  const session = await tab.historySession;
  const { entries, currentIndex } = await session.send('Page.getNavigationHistory');
  const urlAt = index => {
    const url = URL.parse(entries[index]?.url);
    return url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      ws.origins.has(url.origin) ? url.href : '';
  };
  return { url: urlAt(currentIndex), canGoBack: !!urlAt(currentIndex - 1),
    canGoForward: !!urlAt(currentIndex + 1) };
}

export async function navigatePage(ws, tab, action, url, check) {
  const options = { waitUntil: 'domcontentloaded', timeout: 15000 };
  const { page } = tab;
  if (action === 'go') {
    check();
    await page.goto(url, options);
  } else {
    const location = await pageLocation(ws, tab);
    check();
    if (action === 'back' && location.canGoBack) await page.goBack(options);
    if (action === 'forward' && location.canGoForward) await page.goForward(options);
    if (action === 'reload' && location.url) await page.reload(options);
  }
  return pageLocation(ws, tab);
}

async function dispatch(ws, tab, event, check) {
  const { page } = tab;
  if (event.type === 'text') return page.keyboard.insertText(event.text);
  if (event.type === 'keyDown') {
    const navigation = navigationKey(tab.heldKeys, event.key);
    if (navigation) return navigatePage(ws, tab, navigation, undefined, check);
    tab.heldKeys.add(event.key);
    return page.keyboard.down(event.key);
  }
  if (event.type === 'keyUp') {
    await page.keyboard.up(event.key);
    tab.heldKeys.delete(event.key);
    return;
  }
  const size = page.viewportSize();
  if (!size || !Number.isFinite(event.x) || !Number.isFinite(event.y) ||
      event.x < 0 || event.x >= size.width || event.y < 0 || event.y >= size.height)
    reject('invalid_input');
  await page.mouse.move(event.x, event.y);
  check();
  const button = event.button || 'left';
  const options = { button, clickCount: event.clickCount || 1 };
  switch (event.type) {
    case 'mouseDown':
      tab.heldButtons.add(button);
      return page.mouse.down(options);
    case 'mouseUp':
      await page.mouse.up(options);
      tab.heldButtons.delete(button);
      return;
    case 'wheel': return page.mouse.wheel(event.deltaX, event.deltaY);
  }
}

export async function releaseInput(tab) {
  for (const key of tab.heldKeys) await tab.page.keyboard.up(key).catch(() => {});
  tab.heldKeys.clear();
  for (const button of tab.heldButtons) {
    // Release outside the viewport to avoid activating a link when the native
    // window loses the physical mouse-up event during a control transition.
    await tab.page.mouse.move(-1, -1).catch(() => {});
    await tab.page.mouse.up({ button }).catch(() => {});
  }
  tab.heldButtons.clear();
}

export function enqueueHuman(ws, generation, work) {
  const check = () => {
    if (ws.mode !== 'human') reject('not_in_human_control');
    if (ws.generation !== generation) reject('stale_control');
  };
  check();
  if (ws.inputPending >= 128) reject('queue_full');
  ws.inputPending++;
  const task = ws.inputTail.then(async () => {
    check();
    return work(check);
  }).finally(() => { ws.inputPending--; });
  ws.inputTail = task.catch(() => {});
  return task;
}

export function pageInput(ws, tab, { documentId, controlGeneration, event }) {
  validateEvent(event);
  return enqueueHuman(ws, controlGeneration, async checkOwner => {
    const check = () => {
      checkOwner();
      checkPage(ws, tab, documentId, controlGeneration);
    };
    check();
    await dispatch(ws, tab, event, check);
    return { accepted: true };
  });
}

export class DesktopFrames {
  active = 0;

  async capture(ws, tab, { width, height }) {
    const { page, documentId } = tab;
    const controlGeneration = ws.generation;
    const check = () => checkPage(ws, tab, documentId, controlGeneration);
    check();
    const current = page.viewportSize();
    width ??= current?.width || 1024;
    height ??= current?.height || 768;
    if (!Number.isInteger(width) || width < 320 || width > 1920 ||
        !Number.isInteger(height) || height < 200 || height > 1200) reject('invalid_viewport');
    if (tab.capturing || this.active >= 3) reject('frame_busy');
    tab.capturing = true;
    this.active++;
    try {
      if (current?.width !== width || current?.height !== height)
        await page.setViewportSize({ width, height });
      check();
      const [jpeg, title] = await Promise.all([
        page.screenshot({ type: 'jpeg', quality: 78, scale: 'css', caret: 'initial', timeout: 3000 }),
        refreshTitle(ws, tab),
      ]);
      check();
      return { data: jpeg.toString('base64'), width, height, documentId, controlGeneration, title };
    } finally {
      tab.capturing = false;
      this.active--;
    }
  }
}
