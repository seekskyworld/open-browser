import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { startDemo } from './demo-site.mjs';

function fail(code) { throw Object.assign(new Error(code), { code }); }

export function nativeDemo(call, { deliverResult = true } = {}) {
  let starting;
  let site;
  let closed = false;
  const pages = new Map();
  const active = new Set();
  const pendingLogins = new Map();

  async function check(page) {
    const expected = pages.get(page.workspaceId);
    if (!expected || expected !== page.pageId || !site) fail('not_demo_page');
    const ws = await call('getWorkspace', { workspaceId: page.workspaceId });
    if (!ws.pages.some(p => p.pageId === expected && p.origin === site.origin)) fail('not_demo_page');
  }

  async function complete(page, controlGeneration) {
    if (!deliverResult) return page;
    const receipt = await call('finishWorkspace', {workspaceId:page.workspaceId, keepPageIds:[page.pageId],
      operationId:page.pageId, controlGeneration});
    if (receipt.state !== 'completed') fail(receipt.error || 'delivery_unconfirmed');
    pages.delete(page.workspaceId);
    pendingLogins.delete(page.workspaceId);
    return {...page, delivered:true};
  }

  async function login(page) {
    await check(page);
    if (active.has(page.pageId)) fail('demo_running');
    pendingLogins.delete(page.workspaceId);
    active.add(page.pageId);
    try {
      const view = await call('observe', page);
      const authenticated = snap => snap.text.includes('我的账号') &&
        snap.elements.some(el => el.role === 'button' && el.name === '退出登录');
      if (authenticated(view)) return await complete(page,view.controlGeneration);
      const field = (role, name) => {
        const match = view.elements.find(el => el.role === role && el.name === name);
        if (!match) fail('login_form_changed');
        return match.ref;
      };
      const { documentId, controlGeneration } = view;
      const operationId = randomUUID();
      const actions = [
        { kind: 'fillCredential', ref: field('textbox', '账号'), credentialRef: 'demo.username' },
        { kind: 'fillCredential', ref: field('textbox', '密码'), credentialRef: 'demo.password' },
        { kind: 'click', ref: field('button', '登录') },
      ];
      let receipt = await call('act', { ...page, documentId, controlGeneration, operationId, actions });
      const deadline = Date.now() + 35_000;
      while (['queued', 'running'].includes(receipt.state)) {
        if (Date.now() > deadline) fail('operation_pending');
        await sleep(50);
        receipt = await call('getOperation', { workspaceId: page.workspaceId, operationId });
      }
      if (receipt.error === 'credential_required') {
        pendingLogins.set(page.workspaceId, operationId);
        return page;
      }
      if (receipt.state !== 'completed') fail(receipt.error || receipt.state);
      const after = await call('observe', page);
      if (!authenticated(after)) fail(after.text.includes('账号或密码不正确') ? 'wrong_password' : 'account_page_unconfirmed');
      return await complete(page,after.controlGeneration);
    } finally { active.delete(page.pageId); }
  }

  return {
    async start({ withPassword = true }) {
      if (typeof withPassword !== 'boolean') fail('invalid_params');
      if (closed) fail('service_stopped');
      if (!starting) starting = startDemo().then(value => (site = value)).catch(error => {
        starting = undefined;
        throw error;
      });
      await starting;
      if (closed) fail('service_stopped');
      const { workspaceId } = await call('createWorkspace', {
        name: withPassword ? '自动登录' : '凭据补充', agentName: '登录助手', allowedOrigins: [site.origin],
      });
      let page;
      try {
        const loginPath = withPassword ? '/login' : '/login?prompt=login';
        page = await call('openPage', { workspaceId, url: site.origin + loginPath });
        pages.set(workspaceId, page.pageId);
        const bind = (credentialRef, value) => call('setCredential', { workspaceId, origin: site.origin, credentialRef, value });
        await bind('demo.username', site.demoAccount.username);
        if (withPassword) await bind('demo.password', site.demoAccount.password);
      } catch (error) {
        pages.delete(workspaceId);
        await call('closeWorkspace', { workspaceId }).catch(() => {});
        throw error;
      }
      return login(page);
    },
    resume: ({ workspaceId, pageId }) => login({ workspaceId, pageId }),
    async password(page) {
      await check(page);
      return { password: site.demoAccount.password };
    },
    decorate(info) {
      if (!site || !pages.has(info.workspaceId)) return info;
      const request = info.activity.credentialRequest;
      const pending = request && pendingLogins.get(info.workspaceId) === request.operationId &&
        request.pageId === pages.get(info.workspaceId) && request.origin === site.origin;
      const activity = pending ? { ...info.activity, credentialRequest: { ...request, isDemoLogin: true } } : info.activity;
      return { ...info, activity, pages: info.pages.map(page =>
        page.pageId === pages.get(info.workspaceId) && page.origin === site.origin
          ? { ...page, isDemo: true } : page) };
    },
    forget(workspaceId) { pages.delete(workspaceId); pendingLogins.delete(workspaceId); },
    async close() {
      closed = true;
      await starting?.catch(() => {});
      await site?.close();
      pages.clear();
      pendingLogins.clear();
    },
  };
}
