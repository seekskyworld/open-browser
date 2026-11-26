import {randomUUID} from 'node:crypto';

function fail(code) { throw Object.assign(new Error(code), {code}); }

export function attachDialogs(ws, tab, notify) {
  function receive(dialog) {
    const origin = URL.parse(tab.page.url())?.origin;
    const op = [...ws.jobs].find(job => job.pageId === tab.id && job.dispatched);
    // Playwright's Dialog identifies a page, but not the initiating frame.
    // Only attribute a message to this origin if every frame shares it.
    const singleOrigin = tab.page.frames().every(frame => URL.parse(frame.url())?.origin === origin);
    if (!op || tab.dialog || ws.mode !== 'agent' || !ws.origins.has(origin) || !singleOrigin ||
        !['alert','confirm','prompt'].includes(dialog.type())) {
      void dialog.dismiss().catch(() => {});
      return;
    }
    const type = dialog.type();
    let message = dialog.message();
    for (const secret of ws.credentials.values()) message = message.replaceAll(secret, '[redacted]');
    const info = {dialogId:randomUUID(), pageId:tab.id, documentId:tab.documentId, origin,
      operationId:op.receipt.operationId, type, message:message.slice(0,1024)};
    tab.dialog = {dialog, info};
    (op.receipt.dialogIds ??= []).push(info.dialogId);
    notify();
  }
  tab.page.on('dialog',receive);
  return () => {tab.page.off('dialog',receive); discardDialog(tab);};
}

export function discardDialog(tab) {
  const pending = tab.dialog;
  tab.dialog = null;
  if (pending) void pending.dialog.dismiss().catch(() => {});
}

export async function respondDialog(ws,tab,params,desktop) {
  if (ws.generation !== params.controlGeneration) fail('stale_control');
  if (desktop ? !['human','transferring'].includes(ws.mode) : ws.mode !== 'agent')
    fail(desktop ? 'take_control_first' : 'workspace_under_user_control');
  const pending = tab.dialog;
  if (!pending || pending.info.dialogId !== params.dialogId) fail('dialog_not_found');
  if (pending.info.documentId !== tab.documentId || !ws.origins.has(pending.info.origin) ||
      pending.info.origin !== URL.parse(tab.page.url())?.origin) fail('stale_document');
  if (typeof params.accept !== 'boolean' || (params.text !== undefined &&
      (!params.accept || pending.info.type !== 'prompt' || typeof params.text !== 'string' || params.text.length > 2048)))
    fail('invalid_params');
  tab.dialog = null; // Claim before the first await so concurrent replies cannot both reach the site.
  try {
    if (params.accept) await pending.dialog.accept(params.text);
    else await pending.dialog.dismiss();
  } catch { fail('inspect_before_retry'); }
  return {dialogId:params.dialogId, accepted:params.accept};
}
