import { createHash, randomUUID } from 'node:crypto';
import { discardDialog } from './page-dialogs.mjs';
import { releaseInput } from './desktop-page.mjs';
import { clearRefs, fail, stringParam, workspaceView } from './workspace-state.mjs';

export function finishDigest(keepPageIds) {
  if (!Array.isArray(keepPageIds) || keepPageIds.some(id => typeof id !== 'string') ||
      new Set(keepPageIds).size !== keepPageIds.length) fail('invalid_params');
  return createHash('sha256').update(JSON.stringify(['finish', [...keepPageIds].sort()])).digest('hex');
}

export function previewFinish(service, ws, keepPageIds) {
  const digest = finishDigest(keepPageIds);
  for (const id of keepPageIds) service.tab(ws, id);
  const keptPageIds = [], closedPageIds = [];
  for (const tab of ws.pages.values())
    (keepPageIds.includes(tab.id) || !tab.createdByAgent ? keptPageIds : closedPageIds).push(tab.id);
  const previewId = createHash('sha256').update(JSON.stringify([ws.id, ws.generation, digest, keptPageIds, closedPageIds])).digest('hex');
  return {previewId, keptPageIds, closedPageIds};
}

function stopOperations(ws, controlTransferred = false) {
  ws.uploads?.clear();
  ws.control.abort();
  for (const job of ws.jobs) {
    if (controlTransferred) job.controlTransferred = true;
    job.cancel = true;
    job.controller?.abort();
  }
}

export async function finish(service, ws, {operationId, keepPageIds, controlGeneration, previewId}, trusted = false) {
  stringParam(operationId, 160);
  const digest = finishDigest(keepPageIds);
  const past = service.store.get(ws.owner, ws.id, operationId);
  if (past) {
    if (past.digest !== digest) fail('operation_id_conflict');
    return ws.finishing?.operationId === operationId ? ws.finishing.promise : past.receipt;
  }
  if (controlGeneration !== undefined && controlGeneration !== ws.generation) fail('stale_control');
  if (ws.finishing) fail('workspace_finishing');
  if (previewId !== undefined && (ws.pending || ws.inputPending || ws.popupTasks.size ||
      previewFinish(service, ws, keepPageIds).previewId !== previewId)) fail('finish_preview_changed');
  if (!trusted || ws.mode !== 'human') service.requireControl(ws, ws.generation);
  for (const id of keepPageIds) service.tab(ws, id);
  ws.offer?.revoke();
  const keep = new Set(keepPageIds);
  const receipt = { operationId, state:'running', phase:'running', totalSteps:ws.pages.size, completedSteps:0, keptPageIds:[], closedPageIds:[] };
  service.store.save(ws.owner, ws.id, digest, receipt);
  const pending = { operationId };
  ws.finishing = pending;
  for (const tab of ws.pages.values()) discardDialog(tab);
  ws.generation = randomUUID();
  stopOperations(ws);
  pending.promise = (async () => {
    await Promise.allSettled([ws.tail, ws.inputTail,...ws.popupTasks]);
    try {
      await ws.downloads.close();
      const tabs = [...ws.pages.values()];
      if (ws.onPage) ws.context.off('page', ws.onPage);
      if (!service.sharedContext && tabs.some(tab => keep.has(tab.id) || !tab.createdByAgent))
        await ws.networkRelease?.();
      for (const tab of tabs) {
        service.store.save(ws.owner, ws.id, digest, receipt, true);
        if (keep.has(tab.id) || !tab.createdByAgent) {
          await releaseInput(tab);
          await service.setInputGuard?.(ws, tab, false);
          await service.releaseTab?.(tab.page, ws.id, tab.id);
          await tab.releasePopups?.();
          await tab.networkRelease?.();
          if (tab.networkSession) {
            await tab.networkSession.send('Network.setBypassServiceWorker', {bypass:false});
            await tab.networkSession.detach();
          }
          tab.unregister();
          receipt.keptPageIds.push(tab.id);
        } else {
          await service.releaseTab?.(tab.page, ws.id, tab.id);
          await tab.page.close();
          receipt.closedPageIds.push(tab.id);
        }
        receipt.completedSteps++;
        service.store.save(ws.owner, ws.id, digest, receipt);
      }
      if (!service.sharedContext && !receipt.keptPageIds.length) await ws.context.close();
      ws.mode = 'closed';
      ws.credentials.clear();
      ws.credentialRequests.clear();
      service.store.event(ws.owner, ws.id, 'control', ws.mode);
      service.notify(ws);
      service.workspaces.delete(ws.id);
      receipt.state = 'completed';
      receipt.phase = 'completed';
    } catch {
      // Some tabs may already have been released. Preserve their exact
      // acknowledgements and require inspection before issuing a new finish.
      receipt.state = 'outcome_unknown';
      receipt.phase = 'outcome_unknown';
      receipt.error = 'inspect_before_retry';
      ws.mode = 'transferring';
      try {
        await setWorkspaceGuard(service, ws, false);
        ws.mode = 'human';
      } catch {
        ws.unlockPending = true;
      }
      ws.generation = randomUUID();
      service.notify(ws);
    } finally {
      service.store.save(ws.owner, ws.id, digest, receipt);
      ws.finishing = null;
    }
    return { ...receipt };
  })();
  return pending.promise;
}

export async function handOff(service, ws, pageId, focus = true, expectedGeneration) {
  if (expectedGeneration !== undefined && expectedGeneration !== ws.generation) fail('stale_control');
  if (ws.returning) fail('control_transition');
  if (ws.handoff) return ws.handoff;
  if (ws.mode === 'human') return workspaceView(ws);
  const tab = pageId ? service.tab(ws, pageId) : [...ws.pages.values()].at(-1);
  ws.mode = 'transferring';
  service.store.event(ws.owner, ws.id, 'control', ws.mode);
  ws.credentialRequests.clear();
  ws.generation = randomUUID();
  stopOperations(ws, true);
  service.notify(ws);
  ws.handoff = (async () => {
    await Promise.allSettled([ws.tail,...ws.popupTasks]);
    for (const candidate of ws.pages.values()) clearRefs(candidate);
    try {
      await setWorkspaceGuard(service, ws, false);
    } catch (error) {
      ws.unlockPending = true;
      service.notify(ws);
      throw error;
    }
    ws.unlockPending = false;
    if (ws.mode !== 'transferring') fail('workspace_closed');
    ws.mode = 'human';
    service.store.event(ws.owner, ws.id, 'control', ws.mode);
    service.notify(ws);
    if (focus && tab && !tab.dialog && !tab.page.isClosed())
      await tab.page.bringToFront().catch(() => {});
    await refreshControlGroups(service, ws);
    return workspaceView(ws);
  })().finally(() => { ws.handoff = null; });
  return ws.handoff;
}

async function setWorkspaceGuard(service, ws, enabled) {
  if (!service.setInputGuard) return;
  const results = await Promise.allSettled([...ws.pages.values()].map(async tab => {
    try { await service.setInputGuard(ws, tab, enabled); }
    catch (error) { if (!tab.page.isClosed()) throw error; }
  }));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}

async function refreshControlGroups(service, ws) {
  if (!service.groupTab) return;
  await Promise.allSettled([...ws.pages.values()].filter(tab => !tab.dialog && !tab.page.isClosed())
    .map(async tab => service.syncTab(ws, tab)));
}

export async function returnToAgent(service, ws, expectedGeneration) {
  if (expectedGeneration !== undefined && expectedGeneration !== ws.generation) fail('stale_control');
  if (ws.returning) return ws.returning;
  if (ws.mode !== 'human') fail('not_in_human_control');
  ws.mode = 'transferring';
  service.store.event(ws.owner, ws.id, 'control', ws.mode);
  ws.generation = randomUUID();
  service.notify(ws);
  ws.returning = (async () => {
    try {
      await ws.inputTail;
      await Promise.all([...ws.pages.values()].map(releaseInput));
      ws.guardLost = false;
      await setWorkspaceGuard(service, ws, true);
      if (ws.guardLost) fail('input_guard_unavailable');
    } catch (error) {
      try { await setWorkspaceGuard(service, ws, false); }
      catch (rollbackError) {
        ws.unlockPending = true;
        service.notify(ws);
        throw rollbackError;
      }
      if (ws.mode === 'transferring') {
        ws.mode = 'human';
        service.store.event(ws.owner, ws.id, 'control', ws.mode);
        service.notify(ws);
      }
      throw error;
    }
    if (ws.mode !== 'transferring') fail('workspace_closed');
    // Returning control acknowledges that the user handled the visible site
    // verification. A later navigation or response can raise it again.
    ws.securityChallenge = null;
    ws.control = new AbortController();
    ws.mode = 'agent';
    service.store.event(ws.owner, ws.id, 'control', ws.mode);
    service.notify(ws);
    await refreshControlGroups(service, ws);
    return workspaceView(ws);
  })().finally(() => { ws.returning = null; });
  return ws.returning;
}

export async function close(service, ws) {
  ws.offer?.revoke();
  for (const tab of ws.pages.values()) discardDialog(tab);
  ws.mode = 'closed';
  service.store.event(ws.owner, ws.id, 'control', ws.mode);
  stopOperations(ws);
  service.notify(ws);
  ws.credentials.clear();
  await ws.downloads?.close();
  if (service.sharedContext) {
    await Promise.allSettled([ws.tail, ws.inputTail,...ws.popupTasks]);
    await Promise.all([...ws.pages.values()].map(async tab => {
      const {page, id} = tab;
      if (ws.singleTab) {
        await releaseInput(tab);
        await service.setInputGuard?.(ws, tab, false);
        try { await service.releaseTab?.(page, ws.id, id); }
        finally { tab.unregister(); }
        return;
      }
      if (!page.isClosed() && service.releaseTab) await service.releaseTab(page,ws.id,id).catch(() => {});
      await page.close().catch(() => {});
    }));
  } else await ws.context.close();
  service.workspaces.delete(ws.id);
  await Promise.allSettled([ws.tail, ws.inputTail,...ws.popupTasks]);
}
