import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chooseGrantedFile } from './uploads.mjs';
import { inspectDocument, observationDelta } from './page-observation.mjs';
import { rememberBlock } from './network-policy.mjs';
import { ServiceError, fail, redact, requirePageOrigin, webOrigin } from './workspace-state.mjs';

async function trackNavigation(tab) {
  if (tab.navigation) return tab.navigation;
  if (!tab.networkSession && !tab.summarySession)
    tab.summarySession = await tab.page.context().newCDPSession(tab.page);
  const session=tab.networkSession ?? tab.summarySession;
  await session.send('Page.enable');
  const navigation={documents:0,routes:0};
  let mainFrame;
  session.on('Page.frameNavigated', ({frame})=>{
    if(!frame.parentId) {mainFrame=frame.id; navigation.documents++;}
  });
  session.on('Page.navigatedWithinDocument', ({frameId})=>{
    if(frameId===mainFrame) navigation.routes++;
  });
  const {frameTree}=await session.send('Page.getFrameTree');
  mainFrame=frameTree.frame.id;
  tab.navigation=navigation;
  return navigation;
}

function readCheckState(node) {
  const control = node.control ?? node;
  if (control.matches('input[type="checkbox"],input[type="radio"]'))
    return control.type === 'checkbox' && control.indeterminate ? 'mixed' : control.checked;
  const state = control.getAttribute('aria-checked');
  return state === 'true' ? true : state === 'false' ? false : state === 'mixed' ? state : null;
}

async function fillOutcome(handle, expected, credential) {
  const actual = await handle.inputValue();
  const type = await handle.getAttribute('type');
  if (credential || type === 'password') return actual === expected ? 'exact' : actual ? 'transformed' : 'unchanged';
  if (actual === expected) return 'exact';
  if (actual.trim() === expected.trim()) return 'equivalent';
  if (actual.includes(expected) || expected.includes(actual)) return 'appended';
  return actual ? 'transformed' : 'unchanged';
}

function beforeDispatch(service, ws, tab, op, documentId, generation) {
  if (op.cancel) fail('operation_cancelled');
  ensureBudget(op);
  service.requireControl(ws, generation);
  requirePageOrigin(ws, tab);
  if (tab.documentId !== documentId) fail('stale_document');
  op.receipt.phase = 'dispatching';
  // Persist before entering Playwright. A process crash must never turn an
  // unacknowledged submission into permission to send it a second time.
  service.store.save(ws.owner, ws.id, op.digest, op.receipt, true);
  op.dispatched = true;
  service.notify(ws);
}

function ensureBudget(op) {
  if (op.deadline !== undefined && Date.now() >= op.deadline) fail('run_timeout');
}

async function armClickProbe(handle, expectedClicks) {
  const id = randomUUID();
  await handle.evaluate((node, { id: probeId, count }) => {
    const key = '__openBrowserClickProbes';
    const probes = node.ownerDocument[key] || (node.ownerDocument[key] = Object.create(null));
    const probe = { seen: 0 };
    probe.handler = event => {
      if (!event.isTrusted || !(event.target === node || node.contains(event.target))) return;
      probe.seen++;
      if (probe.seen >= count) {
        node.ownerDocument.removeEventListener('click', probe.handler, true);
        delete probes[probeId];
      }
    };
    probes[probeId] = probe;
    node.ownerDocument.addEventListener('click', probe.handler, true);
    setTimeout(() => {
      node.ownerDocument.removeEventListener('click', probe.handler, true);
      delete probes[probeId];
    }, 5000);
  }, { id, count: expectedClicks });
  return id;
}

async function consumeClickProbe(handle, probeId, expectedClicks) {
  try {
    return await handle.evaluate((node, { id, count }) => {
      const probes = node.ownerDocument.__openBrowserClickProbes;
      const probe = probes?.[id];
      if (!probe) return false;
      node.ownerDocument.removeEventListener('click', probe.handler, true);
      delete probes[id];
      return probe.seen >= count;
    }, { id: probeId, count: expectedClicks });
  } catch { return false; }
}

async function waitActionable(service, ws, tab, op, el, kind, documentId, generation) {
  if (op.receipt.phase !== 'actionability') {
    op.receipt.phase = 'actionability';
    service.store.save(ws.owner, ws.id, op.digest, op.receipt);
    service.notify(ws);
  }
  const deadline = Math.min(Date.now() + 5000, op.deadline ?? Infinity);
  while (!op.cancel) {
    ensureBudget(op);
    service.requireControl(ws, generation);
    if (tab.documentId !== documentId) fail('stale_document');
    const visible = await el.isVisible();
    if (!visible && await el.evaluate(node => !node.isConnected)) fail('stale_ref');
    const pointerAction = ['click', 'doubleClick', 'hover', 'drag', 'press', 'scroll'].includes(kind);
    if (visible && pointerAction && await el.isEnabled()) {
      // Trial performs Chromium's hit and stability checks without sending the click.
      // A background tab may need several animation frames before stability is known.
      try {
        if (kind === 'hover') await el.hover({ trial: true, timeout: Math.max(1, deadline - Date.now()) });
        else await el.click({ trial: true, timeout: Math.max(1, deadline - Date.now()) });
        return;
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        if (op.cancel) fail('operation_cancelled');
        fail(error.message.includes('intercepts pointer events') ? 'target_obscured' : 'target_not_actionable');
      }
    }
    if (visible && !pointerAction && await el.isEditable()) return;
    if (Date.now() >= deadline) fail('timeout');
    await delay(40, undefined, {signal:op.controller.signal});
  }
  fail('operation_cancelled');
}

export async function perform(service, ws, tab, { documentId, controlGeneration, actions, observeAfter }, op, { finalize = true } = {}) {
  const before = tab.lastObservation;
  const receipt = op.receipt;
  if (op.cancel) { receipt.state = 'cancelled'; receipt.phase = 'cancelled'; return; }
  receipt.state = 'running';
  const navigationStart = actions.some(a=>a.kind==='wait' && a.navigation)
    ? {...await trackNavigation(tab)} : null;
  ws.credentialRequests.delete(tab.id);
  for (const action of actions) {
    ensureBudget(op);
    op.pageId = tab.id;
    op.stepKind = action.kind;
    receipt.stepKind = action.kind;
    service.notify(ws);
    if (op.cancel) { receipt.state = 'cancelled'; receipt.phase = 'cancelled'; return; }
    service.requireControl(ws, controlGeneration);
    const origin = requirePageOrigin(ws, tab);
    // A read-only completion condition may follow a navigation caused by this batch.
    const followNavigation = action.kind === 'wait' && (receipt.completedSteps > 0 || action.navigation);
    if (!followNavigation && tab.documentId !== documentId) fail('stale_document');
    if (action.kind === 'wait') {
      if (receipt.phase !== 'waiting') {
        receipt.phase = 'waiting';
        service.store.save(ws.owner, ws.id, op.digest, receipt);
        service.notify(ws);
      }
      const deadline = Date.now() + (action.timeoutMs ?? 5000);
      for (;;) {
        ensureBudget(op);
        if (op.cancel || op.controller.signal.aborted) { receipt.state = 'cancelled'; receipt.phase = 'cancelled'; return; }
        service.requireControl(ws, controlGeneration);
        requirePageOrigin(ws, tab);
        if (!followNavigation && tab.documentId !== documentId) fail('stale_document');
        let matched;
        try {
          if (action.url) matched = tab.page.url() === action.url;
          else if(action.navigation) {
            receipt.navigation=tab.navigation.documents!==navigationStart.documents ? 'document_committed' :
              tab.navigation.routes!==navigationStart.routes ?
                'same_document' : 'not_committed';
            matched=receipt.navigation!=='not_committed';
          } else if(action.absent || (action.element && Object.keys(action.element).length>2)) {
            const {role,name,...expected}=action.element ?? action.absent;
            const match=await tab.page.evaluate(inspectDocument,{locator:{role,name},summaryOnly:true,origins:[...ws.origins]});
            matched=!!match && (action.absent ? match.match.count===0 : match.match.count===1 &&
              Object.entries(expected).every(([key,value])=>match.details[0][key]===value));
          } else if (action.element) matched = await tab.page.getByRole(action.element.role,
            {name:action.element.name,exact:true}).first().isVisible();
          else matched = redact(ws,await tab.page.evaluate(inspectDocument,true)).includes(action.text);
        } catch (error) {
          if (!followNavigation || !/context was destroyed|navigation/i.test(error.message)) throw error;
        }
        service.requireControl(ws,controlGeneration);
        requirePageOrigin(ws,tab);
        if (matched) break;
        if (Date.now() >= deadline) fail('wait_timeout');
        const remaining = Math.min(deadline - Date.now(), op.deadline === undefined ? Infinity : op.deadline - Date.now());
        if (remaining <= 0) fail('run_timeout');
        await delay(Math.min(100, remaining), undefined, { signal: op.controller.signal }).catch(() => {});
      }
      receipt.completedSteps++;
      service.notify(ws);
      continue;
    }
    if (action.kind === 'spatial') {
      try {
        await service.visual.input(ws,tab,service.actors.getStore(),{...action,documentId,controlGeneration},'agent',
          () => beforeDispatch(service, ws,tab,op,documentId,controlGeneration));
      } catch (error) {
        if (!op.dispatched) fail(error.code || 'visual_action_failed');
        tab.needsSubmissionReview=true;
        Object.assign(receipt,{state:'outcome_unknown',phase:'outcome_unknown',error:'inspect_before_retry'});
        return;
      }
      receipt.completedSteps++;
      op.dispatched=false;
      service.store.save(ws.owner,ws.id,op.digest,receipt);
      service.notify(ws);
      continue;
    }
    const frameEntry=tab.frameRefs.get(action.ref);
    const el=frameEntry?.handle ?? tab.refs.get(action.ref);
    if (!el) fail('stale_ref');
    await service.checkSemanticTarget(ws,tab,action.ref,frameEntry,el,action.kind==='upload' ? 'click' : action.kind);
    let destination;
    if (action.kind === 'drag') {
      const destinationFrame = tab.frameRefs.get(action.toRef);
      destination = destinationFrame?.handle ?? tab.refs.get(action.toRef);
      if (!destination || destinationFrame || frameEntry) fail('invalid_actions');
      await service.checkSemanticTarget(ws, tab, action.toRef, null, destination, 'click');
    }
    let value = action.value;
    if (action.kind === 'fillCredential') {
      const targetOrigin=frameEntry?.document.origin ?? origin;
      value=ws.credentials.get(targetOrigin+'\n'+action.credentialRef);
      if (value === undefined) {
        Object.assign(receipt, { state: 'failed', phase: 'failed', error: 'credential_required', credentialRef: action.credentialRef });
        ws.credentialRequests.set(tab.id, {
          origin:targetOrigin,...(frameEntry && {frameId:frameEntry.document.frameId}),credentialRef:action.credentialRef,pageId: tab.id, operationId: receipt.operationId, documentId, controlGeneration,
        });
        return;
      }
    }
    service.requireControl(ws, controlGeneration);
    requirePageOrigin(ws, tab);
    if (tab.documentId !== documentId) fail('stale_document');
    if (op.cancel) { receipt.state = 'cancelled'; receipt.phase = 'cancelled'; return; }
    let clickProbe;
    try {
      if (action.kind === 'upload') {
        if (frameEntry) fail('file_origin_mismatch');
        try { ws.uploads.get(ws,tab,action.fileId); } catch(error) { fail(error.code); }
        await waitActionable(service, ws,tab,op,el,'click',documentId,controlGeneration);
        await chooseGrantedFile(ws,tab,el,action.fileId,
          ()=>beforeDispatch(service, ws,tab,op,documentId,controlGeneration),
          ()=>{ service.requireControl(ws,controlGeneration); if (op.cancel) fail('operation_cancelled'); });
      } else if (action.kind === 'setChecked') {
        const state = await el.evaluate(readCheckState);
        if (state === null) fail('invalid_actions');
        if (state !== action.checked) {
          if(!action.checked && await el.evaluate(node=>(node.control ?? node).matches('input[type="radio"],[role="radio"]')))
            fail('invalid_actions');
          await waitActionable(service, ws,tab,op,el,'click',documentId,controlGeneration);
          await service.checkSemanticTarget(ws,tab,action.ref,frameEntry,el,action.kind);
          if (await el.evaluate(readCheckState) !== action.checked) {
            beforeDispatch(service, ws,tab,op,documentId,controlGeneration);
            await el.click({timeout:5000});
            if (await el.evaluate(readCheckState) !== action.checked) fail('state_mismatch');
          }
        }
      } else if (action.kind === 'click') {
        const target = service.sharedContext && await el.evaluate(node =>
          node.matches('a[href]') && node.target.toLowerCase() === '_blank' ? node.href : null);
        service.requireControl(ws, controlGeneration);
        requirePageOrigin(ws, tab);
        if (tab.documentId !== documentId) fail('stale_document');
        if (op.cancel) { receipt.state = 'cancelled'; receipt.phase = 'cancelled'; return; }
        if (target && !ws.origins.has(webOrigin(target))) {
          rememberBlock(ws, webOrigin(target), 'navigation', 'document', 'origin_denied');
          fail('origin_denied');
        }
        service.notifyTarget(ws, tab, el, documentId, controlGeneration, origin, action.kind);
        await waitActionable(service, ws, tab, op, el, action.kind, documentId, controlGeneration);
        await service.checkSemanticTarget(ws,tab,action.ref,frameEntry,el,action.kind);
        clickProbe = await armClickProbe(el, 1);
        const lease={token:randomUUID(),op,generation:controlGeneration,origin,documentId,armDeadline:Date.now()+7500};
        if (target && !frameEntry) {
          beforeDispatch(service, ws,tab,op,documentId,controlGeneration);
          await service.openPopup(ws,tab,lease,target);
        } else {
          if (!frameEntry) {
            await tab.page.evaluate(token=>window.__openBrowserArmPopup?.(token),lease.token);
            service.requireControl(ws,controlGeneration);
            if (tab.documentId!==documentId || op.cancel) fail('stale_document');
            tab.popupLease=lease;
          }
          beforeDispatch(service, ws,tab,op,documentId,controlGeneration);
          // Chromium pauses JavaScript inside a modal. A handoff must finish
          // while the user is still deciding how to answer it.
          let interrupt;
          const suspended = new Promise((_,reject) => {
            interrupt = () => { if (tab.dialog) reject(new ServiceError('operation_cancelled')); };
            op.controller.signal.addEventListener('abort',interrupt,{once:true});
          });
          try { await Promise.race([el.click({timeout:5000,noWaitAfter:!!navigationStart}), suspended]); }
          finally { op.controller.signal.removeEventListener('abort',interrupt); }
          if (lease.opening) await lease.opening;
        }
      } else if (action.kind === 'doubleClick' || action.kind === 'hover' || action.kind === 'press' || action.kind === 'scroll' || action.kind === 'drag') {
        service.notifyTarget(ws, tab, el, documentId, controlGeneration, origin, action.kind);
        await waitActionable(service, ws, tab, op, el, action.kind, documentId, controlGeneration);
        await service.checkSemanticTarget(ws,tab,action.ref,frameEntry,el,action.kind);
        if (action.kind === 'doubleClick') clickProbe = await armClickProbe(el, 2);
        beforeDispatch(service, ws, tab, op, documentId, controlGeneration);
        if (action.kind === 'doubleClick') {
          await el.dblclick({timeout:5000});
        }
        else if (action.kind === 'hover') await el.hover({timeout:5000});
        else if (action.kind === 'press') await el.press(action.key, {timeout:5000});
        else if (action.kind === 'scroll') {
          await el.scrollIntoViewIfNeeded({timeout:5000});
          await tab.page.mouse.wheel(action.deltaX ?? 0, action.deltaY);
        } else await el.dragTo(destination, {timeout:5000});
      } else {
        service.notifyTarget(ws, tab, el, documentId, controlGeneration, origin, action.kind);
        await waitActionable(service, ws, tab, op, el, action.kind, documentId, controlGeneration);
        await service.checkSemanticTarget(ws,tab,action.ref,frameEntry,el,action.kind);
        beforeDispatch(service, ws, tab, op, documentId, controlGeneration);
        if (action.kind === 'select') await el.selectOption({ value }, {timeout:5000});
        else {
          await el.fill(value, {timeout:5000});
          receipt.fillOutcome = await fillOutcome(el, value, action.kind === 'fillCredential');
        }
      }
    } catch (error) {
      if (!op.dispatched) throw error;
      if (clickProbe && !tab.dialog && await consumeClickProbe(el, clickProbe, action.kind === 'doubleClick' ? 2 : 1)) {
        receipt.completedSteps++;
        op.dispatched = false;
        service.store.save(ws.owner, ws.id, op.digest, receipt);
        service.notify(ws);
        continue;
      }
      // A later observation may replace the latest receipt while the user
      // still needs this tab to determine whether the site received a write.
      tab.needsSubmissionReview = true;
      receipt.state = 'outcome_unknown';
      receipt.phase = 'outcome_unknown';
      receipt.error = 'inspect_before_retry';
      return;
    }
    receipt.completedSteps++;
    receipt.phase = 'verifying';
    op.dispatched = false;
    service.store.save(ws.owner, ws.id, op.digest, receipt);
    service.notify(ws);
  }
  if (observeAfter) {
    receipt.phase = 'verifying';
    try {
      service.requireControl(ws, controlGeneration);
      const after = await service.observe(ws, tab);
      const comparable = before?.controlGeneration === controlGeneration && before.documentId === after.documentId;
      const payload = observeAfter === 'delta' && comparable ? {delta:observationDelta(before,after)} : {observation:after};
      tab.actionObservation = { operationId: receipt.operationId, generation: controlGeneration,
        documentId: after.documentId, payload };
    } catch { /* Committed actions keep their receipt when the page changes during the optional read. */ }
  }
  if (finalize) {
    receipt.state = 'completed';
    receipt.phase = 'completed';
  } else {
    // A workflow owns the operation boundary. Keep the receipt running between
    // steps so observers never see a completed intermediate step.
    receipt.state = 'running';
    receipt.phase = 'running';
    service.store.save(ws.owner, ws.id, op.digest, receipt);
    service.notify(ws);
  }
}
