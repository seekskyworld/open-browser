import { profileId as serviceProfileId } from './paths.mjs';
import { redactSensitiveText } from './privacy-config.mjs';

export class ServiceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function fail(code) { throw new ServiceError(code); }

export function webOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('invalid_url');
  return url.origin;
}

export function allowedPageOrigin(ws, tab) {
  const url = URL.parse(tab.page.url());
  if (url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      ws.origins.has(url.origin)) return url.origin;
  return null;
}

export function requirePageOrigin(ws, tab) {
  return allowedPageOrigin(ws, tab) || fail('origin_denied');
}

export function publicError(error) {
  if (error instanceof ServiceError) return error.code;
  return error.name === 'TimeoutError' ? 'timeout' : 'browser_action_failed';
}

export function stringParam(value, max) {
  if (typeof value !== 'string' || !value.length || value.length > max) fail('invalid_params');
  return value;
}


export function redact(ws, text) {
  return redactSensitiveText(text, ws.credentials.values());
}

export function clearFrameRefs(tab) {
  for(const entry of tab.frameRefs.values()) void entry.handle.dispose().catch(()=>{});
  tab.frameRefs.clear();
}

export function clearRefs(tab) {
  clearFrameRefs(tab);
  tab.cursors.clear();
  for (const handle of tab.refs.values()) void handle.dispose().catch(() => {});
  tab.refs.clear();
  tab.strictLocator=undefined;
  void tab.observedNodes?.dispose().catch(() => {});
  tab.observedNodes = undefined;
}

function operationView(job) {
  if (!job) return null;
  const { state, phase, completedSteps, error } = job.receipt;
  return { kind: job.kind, state, completedSteps, totalSteps: job.totalSteps,
    ...(phase && {phase}),
    ...(job.stepKind && state === 'running' && {dispatchState: job.dispatched ? 'dispatched' : 'waiting'}),
    ...(job.stepKind && { stepKind: job.stepKind }), ...(error && { error }) };
}

export function workspaceView(ws, includeCredentialRequest = false) {
  const pages = [...ws.pages.values()].map(tab => {
    const origin = allowedPageOrigin(ws, tab);
    return { workspaceId: ws.id, pageId: tab.id, documentId:tab.documentId, origin: origin || 'null',
      ...(tab.openerPageId && {openerPageId:tab.openerPageId,openedByOperationId:tab.openedByOperationId}),
      title: origin ? redact(ws, tab.title) : '' };
  });
  const pending = [...ws.jobs];
  const queued = pending.filter(job => job.receipt.state === 'queued');
  const running = pending.filter(job => job.receipt.state === 'running');
  const currentJob = running[0] || queued[0];
  const current = operationView(currentJob);
  if (currentJob?.pageId && ws.pages.has(currentJob.pageId)) current.pageId = currentJob.pageId;
  const request = ws.credentialRequests.values().next().value;
  const recent = operationView(ws.recent);
  let phase = 'idle';
  if (ws.securityChallenge) phase = 'needs_human_verification';
  else if (current) phase = current.state;
  else if (request) phase = 'needs_credential';
  else if (recent && recent.error !== 'credential_required') phase = recent.state;
  return { workspaceId: ws.id, profileId: serviceProfileId, name: ws.name, agentName: ws.agentName, mode: ws.mode, controlGeneration: ws.generation, pages,
    ...(includeCredentialRequest && {pendingDialogs: [...ws.pages.values()].flatMap(tab=>tab.dialog ? [tab.dialog.info] : [])}),
    ...(includeCredentialRequest && { blockedOrigins: [...ws.blockedOrigins.values()] }),
    ...(ws.mode === 'transferring' && ws.unlockPending && {unlockPending:true}),
    activity: { phase, queued: queued.length, needsCredential: !!request,
      needsHumanVerification: !!ws.securityChallenge,
      ...(ws.securityChallenge && { securityChallenge: { ...ws.securityChallenge } }), current, recent,
      running: running.map(job => ({ ...operationView(job), ...(ws.pages.has(job.pageId) && {pageId:job.pageId}) })),
      credentialRequest: request && includeCredentialRequest ? { ...request } : null } };
}
