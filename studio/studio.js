'use strict';
const $ = id => document.getElementById(id);
const state = { access: '', config: {}, workspaces: [], workspace: '', page: '', detail: null, demoRetry: null, demoOperations: new Set(), refreshId: 0, entered: false };
const active = () => state.workspaces.find(w => w.workspaceId === state.workspace);
const currentPage = () => active()?.pages.find(p => p.pageId === state.page);
const timestamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const labels = { agent: 'Agent 控制', human: '用户控制', transferring: '交接中' };
const groups = [
  { id: 'attention', title: '待处理' }, { id: 'running', title: 'Agent 运行' },
  { id: 'human', title: '人工接管' }, { id: 'idle', title: '待命' },
];
const phases = { idle: '等待指令', queued: '已排队', running: '执行中', needs_credential: '等待凭据',
  completed: '已完成', failed: '执行失败', cancelled: '已取消', outcome_unknown: '结果待核对' };
const kinds = { openPage: '打开页面', observe: '观察页面', act: '页面操作' };
const stepKinds = { click: '点击', fill: '填写', fillCredential: '填写凭据' };
const errorText = {
  credential_required: '请补充缺少的凭据', wrong_password: '站点拒绝了账号或密码，请更新后再试。',
  pairing_failed: '管理入口已使用，请从 open-browser 重新打开控制台。',
  unauthorized: '管理入口已失效，请重新打开控制台。',
  origin_not_allowed: '新页面超出了当前工作区授权站点，请另建工作区。',
  login_form_changed: '登录表单已变化，请读取页面后再试。',
  human_control: '当前为用户控制，请先交回 Agent。',
};

async function post(route, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.access) headers.Authorization = 'Bearer ' + state.access;
  const response = await fetch(route, { method: 'POST', headers, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'request_failed');
  return data;
}
async function call(method, params = {}) {
  return (await post('/call', { method, params })).result;
}
function log(message) {
  const list = $('activity');
  list.querySelector('.empty')?.remove();
  const row = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = timestamp();
  row.append(time, document.createTextNode(message));
  list.prepend(row);
  while (list.children.length > 20) list.lastElementChild.remove();
  $('activity-count').textContent = list.children.length + ' 条';
}
function notify(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}
function clearObservation() {
  $('snapshot').textContent = '暂无观察结果';
  $('observed-at').textContent = '';
}
function choose(workspaceId) {
  state.workspace = workspaceId;
  state.page = '';
  state.detail = null;
  state.entered = true;
  state.refreshId++;
  sessionStorage.setItem('open-browser.selection', workspaceId);
  clearSensitiveInputs();
  clearObservation();
  notify('');
  paint();
}
function clearSensitiveInputs() {
  $('password').value = '';
  $('bind-value').value = '';
  $('credential-settings').open = false;
  $('demo-secret').textContent = '';
  $('demo-details').open = false;
  $('reveal').textContent = '显示密码';
}
function groupOf(w) {
  if (w.mode === 'human' || w.mode === 'transferring') return 'human';
  const a = w.activity || {};
  if (a.needsCredential || a.phase === 'failed' || a.phase === 'outcome_unknown') return 'attention';
  if (a.current || a.queued || a.phase === 'running' || a.phase === 'queued') return 'running';
  return 'idle';
}
function describe(operation) {
  if (!operation) return '';
  const kind = kinds[operation.kind] || '操作';
  const status = operation.error === 'credential_required' ? '缺少凭据' :
    phases[operation.state] || operation.state;
  if (operation.state === 'running' && operation.stepKind) {
    return stepKinds[operation.stepKind] + ' · ' + operation.completedSteps + '/' + operation.totalSteps;
  }
  return [kind, status].filter(Boolean).join(' · ');
}
function shortState(w) {
  if (w.mode !== 'agent') return labels[w.mode];
  const a = w.activity || {};
  if (a.needsCredential) return '等待凭据';
  return describe(a.current) || phases[a.phase] || '等待指令';
}
function paintRail() {
  const byGroup = new Map(groups.map(g => [g.id, []]));
  for (const w of state.workspaces) byGroup.get(groupOf(w)).push(w);
  const view = groups.map(g => ({ ...g, items: byGroup.get(g.id).map(w => ({
    id: w.workspaceId, name: w.name || '工作区', status: shortState(w),
    pages: w.pages.length, selected: w.workspaceId === state.workspace,
  })) }));
  const rail = $('workspaces');
  const signature = JSON.stringify(view);
  if (rail.dataset.view !== signature) {
    const focused = document.activeElement?.dataset.workspaceId;
    const blocks = view.map(group => {
      const block = document.createElement('div');
      block.className = 'group';
      block.dataset.group = group.id;
      block.dataset.empty = String(!group.items.length);
      block.setAttribute('role', 'group');
      block.setAttribute('aria-label', group.title);
      const header = document.createElement('div');
      header.className = 'group-header';
      const title = document.createElement('h3');
      title.textContent = group.title;
      const count = document.createElement('span');
      count.className = 'group-total';
      count.textContent = group.items.length;
      header.append(title, count);
      block.append(header);
      for (const row of group.items) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = row.selected ? 'ws active' : 'ws';
        item.dataset.workspaceId = row.id;
        if (row.selected) item.setAttribute('aria-current', 'true');
        const name = document.createElement('b');
        name.textContent = row.name;
        const status = document.createElement('small');
        status.textContent = row.status + ' · ' + row.pages + ' 页';
        item.append(name, status);
        item.onclick = () => { if (state.workspace !== row.id) { choose(row.id); sync(); } };
        block.append(item);
      }
      return block;
    });
    rail.replaceChildren(...blocks);
    rail.dataset.view = signature;
    if (focused) Array.from(rail.querySelectorAll('button')).find(el => el.dataset.workspaceId === focused)?.focus({ preventScroll: true });
  }
  $('rail-empty').hidden = state.workspaces.length > 0;
  $('count').textContent = state.workspaces.length;
}
function credentialRequest() {
  const w = active();
  if (!w || w.mode !== 'agent') return null;
  const request = state.detail?.activity?.credentialRequest;
  if (request) return { ...request, workspaceId: w.workspaceId };
  if (state.demoRetry?.workspaceId === w.workspaceId && w.pages.some(p => p.pageId === state.demoRetry.pageId)) return state.demoRetry;
  return null;
}
function paintCredential() {
  const request = credentialRequest();
  const panel = $('credential-view');
  const key = request ? JSON.stringify([request.workspaceId, request.operationId, request.credentialRef]) : '';
  if (panel.dataset.request !== key) $('password').value = '';
  panel.dataset.request = key;
  panel.hidden = !request;
  if (!request) return;
  const demoPassword = request.origin === new URL(state.config.demoUrl).origin && request.credentialRef === 'demo.password';
  const canContinue = state.demoOperations.has(request.operationId);
  $('credential-title').textContent = demoPassword ? '需要补充密码' : '需要补充凭据';
  $('credential-ref').textContent = request.credentialRef;
  $('credential-origin').textContent = request.origin;
  $('credential-label').textContent = demoPassword ? '密码' : '凭据值';
  $('insert-password').hidden = !demoPassword;
  $('submit-credential').textContent = canContinue ? '补充并继续' : '绑定凭据';
}
function paint() {
  paintRail();
  const w = active();
  $('new-view').hidden = Boolean(w);
  $('active-view').hidden = !w;
  if (!w) return;
  $('workspace-name').textContent = w.name || '工作区';
  $('wid').title = w.workspaceId;
  $('mode').textContent = labels[w.mode] || w.mode;
  const a = w.activity || {};
  $('work-state').textContent = w.mode === 'human' ? '自动化已暂停' :
    w.mode === 'transferring' ? '正在交接' : a.needsCredential ? '等待补充凭据' :
    describe(a.current) || '等待指令';
  if (w.mode === 'agent' && a.queued > 0) $('work-state').textContent += ' · 排队 ' + a.queued;
  $('result-text').textContent = describe(a.recent) || '暂无已结束操作';
  $('take').hidden = w.mode !== 'agent' || !w.pages.length;
  $('give').hidden = w.mode !== 'human';
  $('view-controlled').hidden = w.mode !== 'human' || !w.pages.length;
  $('page-form').hidden = w.mode !== 'agent';
  $('close-workspace').hidden = w.mode !== 'agent';
  const pages = $('pages');
  const pageOptions = JSON.stringify(w.pages.map(p => [p.pageId, p.origin]));
  if (pages.dataset.options !== pageOptions) {
    pages.replaceChildren(...w.pages.map((page, i) => {
      const option = document.createElement('option');
      option.value = page.pageId;
      option.textContent = (i + 1) + ' · ' + page.origin;
      return option;
    }));
    pages.dataset.options = pageOptions;
  }
  if (!w.pages.some(p => p.pageId === state.page)) {
    const fallback = w.pages.at(-1)?.pageId || '';
    if (state.page !== fallback) clearObservation();
    state.page = fallback;
  }
  if (pages.value !== state.page) pages.value = state.page;
  $('wid').textContent = [currentPage()?.origin, w.pages.length + ' 个页面'].filter(Boolean).join(' · ');
  const isDemo = currentPage()?.origin === new URL(state.config.demoUrl).origin;
  $('login-action').hidden = !isDemo || w.mode !== 'agent';
  $('demo-details').hidden = !isDemo;
  $('credential-settings').hidden = !state.page || w.mode !== 'agent';
  $('observe').hidden = !state.page || w.mode !== 'agent';
  paintCredential();
  if (w.mode !== 'agent') {
    clearObservation();
    clearSensitiveInputs();
  }
}
function setConnected(connected) {
  $('connection-status').dataset.connected = String(connected);
  $('connection').textContent = connected ? '本机服务已连接' : '服务已断开';
}
async function refresh() {
  const sequence = ++state.refreshId;
  const selected = state.workspace;
  const rows = await call('listWorkspaces');
  if (sequence !== state.refreshId) return;
  const w = rows.find(row => row.workspaceId === selected);
  let detail = null;
  if (w?.activity?.needsCredential) {
    detail = await call('getWorkspace', { workspaceId: selected });
    if (sequence !== state.refreshId) return;
  }
  state.workspaces = rows.map(row => row.workspaceId === detail?.workspaceId ? detail : row);
  state.detail = detail;
  if (selected && !w) choose('');
  else paint();
  setConnected(true);
}
async function sync() {
  try { await refresh(); } catch { setConnected(false); }
}
function command(id, fn, event = 'click') {
  $(id).addEventListener(event, async e => {
    e.preventDefault();
    const button = event === 'submit' ? e.submitter || $(id).querySelector('button') : $(id);
    if (button.disabled) return;
    button.disabled = true;
    notify('');
    try { await fn(); }
    catch (err) {
      const msg = errorText[err.message] || '操作未完成（' + err.message + '）';
      notify(msg);
      log(msg);
    } finally {
      button.disabled = false;
      await sync();
    }
  });
}
async function create(name, url) {
  const { workspaceId } = await call('createWorkspace', { name, allowedOrigins: [new URL(url).origin] });
  let page;
  try { page = await call('openPage', { workspaceId, url }); }
  catch (error) {
    await call('closeWorkspace', { workspaceId }).catch(() => {});
    throw error;
  }
  state.workspaces = await call('listWorkspaces');
  choose(workspaceId);
  state.page = page.pageId;
  paint();
  log('已打开「' + name + '」');
  return { workspaceId, pageId: page.pageId };
}
async function observe(page, method = 'observe') {
  const snap = await call(method, page);
  if (state.workspace === page.workspaceId && state.page === page.pageId) {
    $('snapshot').textContent = snap.text || (snap.elements || []).map(e => e.role + '  ' + e.name).join('\n') || '当前页无可见文本';
    $('observed-at').textContent = timestamp();
  }
  return snap;
}
async function putCredential(page, credentialRef, value) {
  await call('setCredential', { workspaceId: page.workspaceId, origin: new URL(state.config.demoUrl).origin, credentialRef, value });
}
async function runLogin(page) {
  const snap = await observe(page);
  const authenticated = observation => observation.text.includes('我的账号') &&
    observation.elements.some(e => e.role === 'button' && e.name === '退出登录');
  if (authenticated(snap)) {
    state.demoRetry = null;
    log('已读取受保护的账号页面');
    return;
  }
  const find = (role, name) => snap.elements.find(element => element.role === role && element.name === name)?.ref;
  const username = find('textbox', '账号');
  const password = find('textbox', '密码');
  const submit = find('button', '登录');
  if (!username || !password || !submit) throw new Error('login_form_changed');
  const request = {
    workspaceId: page.workspaceId, pageId: page.pageId, documentId: snap.documentId,
    controlGeneration: snap.controlGeneration, operationId: crypto.randomUUID(), actions: [
      { kind: 'fillCredential', ref: username, credentialRef: 'demo.username' },
      { kind: 'fillCredential', ref: password, credentialRef: 'demo.password' },
      { kind: 'click', ref: submit },
    ],
  };
  let receipt = await call('act', request);
  state.demoOperations.add(request.operationId);
  const deadline = Date.now() + 35000;
  while (['running', 'queued'].includes(receipt.state)) {
    if (Date.now() > deadline) throw new Error('operation_pending');
    await new Promise(resolve => setTimeout(resolve, 100));
    receipt = await call('getOperation', { workspaceId: page.workspaceId, operationId: request.operationId });
  }
  if (receipt.error === 'credential_required' && receipt.credentialRef === 'demo.password') {
    log('任务等待补充密码');
    return;
  }
  if (receipt.state !== 'completed') throw new Error(receipt.error || receipt.state);
  const after = await observe(page);
  if (after.text.includes('账号或密码不正确')) {
    state.demoRetry = { ...page, operationId: request.operationId, credentialRef: 'demo.password', origin: new URL(state.config.demoUrl).origin };
    paint();
    throw new Error('wrong_password');
  }
  if (!authenticated(after))
    throw new Error('account_page_unconfirmed');
  state.demoRetry = null;
  log('登录成功，已读取受保护的账号页面');
}
async function demo(withPassword) {
  const page = await create(withPassword ? '自动登录' : '凭据补充', state.config.demoUrl);
  await putCredential(page, 'demo.username', state.config.username);
  if (withPassword) await putCredential(page, 'demo.password', (await post('/demo-password', {})).password);
  await runLogin(page);
}
function pageHandle() {
  return { workspaceId: state.workspace, pageId: state.page };
}

command('show-new', () => choose(''));
command('new-form', () => create($('name').value.trim() || '我的工作区', $('url').value), 'submit');
command('demo', () => demo(true));
command('missing', () => demo(false));
command('observe', async () => { await observe(pageHandle(), 'previewPage'); log('已读取当前页面'); });
command('login-action', () => runLogin(pageHandle()));
command('insert-password', async () => { $('password').value = (await post('/demo-password', {})).password; });
command('credential-form', async () => {
  const req = credentialRequest();
  if (!req) throw new Error('credential_request_expired');
  const secret = $('password').value;
  $('password').value = '';
  const latest = await call('getWorkspace', { workspaceId: req.workspaceId });
  const pending = latest.activity.credentialRequest || state.demoRetry;
  if (latest.mode !== 'agent' || !pending || req.operationId !== pending.operationId ||
      req.origin !== pending.origin || req.credentialRef !== pending.credentialRef) {
    throw new Error('credential_request_expired');
  }
  if (latest.activity.credentialRequest) await call('resolveCredential', { ...req, value: secret });
  else if (req === state.demoRetry) await call('setCredential', { ...req, value: secret });
  else throw new Error('credential_request_expired');
  if (state.demoOperations.has(req.operationId)) {
    state.demoRetry = null;
    await runLogin({ workspaceId: req.workspaceId, pageId: req.pageId });
  } else log('已绑定缺少的凭据；调用方可重新观察并提交剩余操作');
}, 'submit');
command('bind-form', async () => {
  const page = currentPage();
  const value = $('bind-value').value;
  $('bind-value').value = '';
  await call('setCredential', { workspaceId: state.workspace, origin: page.origin, credentialRef: $('bind-id').value, value });
  $('credential-settings').open = false;
  log('已为当前工作区绑定站点凭据');
}, 'submit');
command('take', async () => {
  await call('takeControl', pageHandle());
  clearObservation();
  log('已由用户控制当前工作区');
});
command('give', async () => {
  await call('returnToAgent', { workspaceId: state.workspace });
  clearObservation();
  log('已交回 Agent，页面需要重新观察');
});
command('view-controlled', async () => {
  await call('showPage', pageHandle());
  log('已显示接管页面');
});
command('close-workspace', async () => {
  await call('closeWorkspace', { workspaceId: state.workspace });
  if (state.demoRetry?.workspaceId === state.workspace) state.demoRetry = null;
  choose('');
  log('工作区已关闭');
});
command('page-form', async () => {
  const page = await call('openPage', { workspaceId: state.workspace, url: $('address').value });
  state.page = page.pageId;
  $('address').value = '';
  clearObservation();
  log('已打开新页面');
}, 'submit');
command('reveal', async () => {
  const showing = Boolean($('demo-secret').textContent);
  $('demo-secret').textContent = showing ? '' : (await post('/demo-password', {})).password;
  $('reveal').textContent = showing ? '显示密码' : '隐藏密码';
});
$('pages').onchange = () => { state.page = $('pages').value; clearObservation(); paint(); };

(async () => {
  const key = location.hash.slice(1);
  if (key) {
    history.replaceState(null, '', location.pathname);
    state.access = (await post('/pair', { key })).access;
    sessionStorage.setItem('open-browser.studio', state.access);
  } else state.access = sessionStorage.getItem('open-browser.studio') || '';
  state.config = await post('/config', {});
  $('demo-user').textContent = state.config.username;
  $('url').value = state.config.demoUrl;
  state.workspace = sessionStorage.getItem('open-browser.selection') || '';
  await refresh();
  if (!state.workspace && !sessionStorage.getItem('open-browser.selection') &&
      state.workspaces.length && !state.entered) {
    const first = groups.flatMap(g => state.workspaces.filter(w => groupOf(w) === g.id))[0];
    choose(first.workspaceId);
    await refresh();
  }
  setInterval(() => { if (!document.hidden) sync(); }, 900);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
})().catch(error => {
  $('connection').textContent = '未连接';
  notify(errorText[error.message] || '无法连接本机控制台，请重新启动 open-browser。');
  document.querySelectorAll('button,input,select').forEach(el => el.disabled = true);
});
