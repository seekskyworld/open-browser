import { randomBytes } from 'node:crypto';
import { fail, webOrigin } from './workspace-state.mjs';
import { refreshTitle } from './desktop-page.mjs';

// Only the packaged extension supplies a target ID. Agent clients receive an
// expiring capability scoped to one workspace and never enumerate ordinary tabs.
export async function offerTab(service, ws, {targetId, origin, accountAlias}) {
  if (!service.sharedContext || service.actors.getStore() !== 'desktop') fail('forbidden');
  if (ws.everRegistered || ws.pending || ws.mode !== 'agent') fail('adoption_requires_empty_workspace');
  if (webOrigin(origin) !== origin || typeof targetId !== 'string' ||
      (accountAlias !== undefined && (typeof accountAlias !== 'string' || accountAlias.length > 48))) fail('invalid_params');
  const context = service.sharedContext;
  for (const candidate of context.pages()) {
    if (URL.parse(candidate.url())?.origin !== origin) continue;
    const session = await context.newCDPSession(candidate).catch(() => null);
    if (!session) continue;
    let info;
    try { info = (await session.send('Target.getTargetInfo')).targetInfo; }
    finally { await session.detach().catch(() => {}); }
    if (info.targetId !== targetId) continue;
    if (service.workspaces.get(ws.id) !== ws || ws.mode !== 'agent' || ws.everRegistered) fail('adoption_requires_empty_workspace');
    if (candidate.isClosed() || webOrigin(candidate.url()) !== origin) break;
    if ([...service.workspaces.values()].some(w => [...w.pages.values()].some(t => t.page === candidate)))
      fail('page_already_managed');
    for (const other of service.workspaces.values()) {
      if (other.offer?.page === candidate) other.offer.revoke();
    }
    const token = randomBytes(32).toString('hex');
    ws.offer?.revoke();
    const revoke = () => {
      clearTimeout(timer);
      candidate.off('framenavigated', navigated);
      candidate.off('close', revoke);
      ws.offer = null;
    };
    const navigated = frame => { if (frame === candidate.mainFrame()) revoke(); };
    const timer = setTimeout(revoke, 120_000).unref();
    candidate.on('framenavigated', navigated);
    candidate.once('close', revoke);
    ws.offer = {revoke, page:candidate, origin, token, targetId, accountAlias, expiresAt:Date.now() + 120_000};
    return {adoptionToken:token, workspaceId:ws.id, expiresAt:ws.offer.expiresAt};
  }
  fail('adoption_page_changed');
}

export async function adoptTab(service, ws, params) {
  if (service.actors.getStore() !== ws.owner) fail('forbidden');
  const offer = ws.offer;
  if (!offer || offer.token !== params.adoptionToken || Date.now() >= offer.expiresAt) fail('adoption_expired');
  offer.revoke();
  if (ws.pending || ws.everRegistered || ws.mode !== 'agent') fail('adoption_requires_empty_workspace');
  if (offer.page.isClosed() || URL.parse(offer.page.url())?.origin !== offer.origin) fail('adoption_page_changed');
  ws.singleTab = true;
  ws.networkMode = 'browser';
  ws.origins = new Set([offer.origin]);
  ws.resourceOrigins.clear();
  ws.accountAlias = offer.accountAlias;
  const tab = service.register(ws, offer.page);
  tab.targetId = offer.targetId;
  tab.createdByAgent = false;
  // Bind before yielding so a concurrent redemption cannot claim this page.
  return service.enqueue(ws, async () => {
    await service.setInputGuard?.(ws, tab, true);
    // Extension registration is retryable via reattachPage. Keep the selected
    // page and its capability when only the extension acknowledgement is late.
    try { await service.syncTab(ws, tab); }
    catch (error) { if (error.code !== 'sync_pending') throw error; }
    await refreshTitle(ws, tab);
    service.requireControl(ws, ws.generation);
    if (offer.page.isClosed() || URL.parse(offer.page.url())?.origin !== offer.origin) fail('adoption_page_changed');
    return {workspaceId:ws.id, pageId:tab.id};
  }, {kind:'adoptCurrentTab', pageId:tab.id}).catch(async error => {
    // A concurrent takeover/close owns the release sequence.
    if (ws.mode === 'agent' && !ws.finishing) await service.call('closeWorkspace',{workspaceId:ws.id},ws.owner);
    throw error;
  });
}
