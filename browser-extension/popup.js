'use strict';

const el = id => document.getElementById(id);
let selected = '', detail, request, selectedTab = '', revision = 0, busy = false, refreshing = false, contextTab = false;
const phases = globalThis.openBrowserPhaseLabels;

async function call(method, params = {}) {
  const reply = await chrome.runtime.sendMessage({ method, params });
  if (!reply || reply.error) throw new Error(reply?.error || 'host_unavailable');
  return reply.result;
}

function notify(text = '') {
  el('notice').textContent = text;
  el('notice').hidden = !text;
}

function describe(w) {
  if (w.activity?.needsHumanVerification) return '需要人工验证';
  if (w.mode === 'human') return '人工接管';
  if (w.mode === 'transferring') return '交接中';
  if (w.activity?.needsCredential) return '等待凭据';
  const current = w.activity?.current;
  const stage = current?.dispatchState;
  if (stage) return stage === 'dispatched' ? '已派发' : '等待页面';
  return phases[current?.phase] || phases[w.activity?.phase] || 'Agent 控制';
}

function options(node, entries, value) {
  const signature = JSON.stringify(entries);
  if (node.dataset.signature !== signature) {
    node.replaceChildren(...entries.map(([id, title]) => new Option(title, id)));
    node.dataset.signature = signature;
  }
  node.value = value;
}

function showCredential(next) {
  const previous = JSON.stringify(request);
  request = next;
  if (previous !== JSON.stringify(next)) el('secret').value = '';
  el('credential').hidden = !next;
  if (!next) return;
  el('credential-target').textContent = next.origin + ' · ' + next.credentialRef;
  el('save').textContent = '绑定凭据';
}

let popupTabId, ordinaryTarget, tokenTimer, standalone = false;
function clearToken() {
  clearTimeout(tokenTimer);
  el('adopt-token').value = '';
  el('adopt-result').hidden = true;
}
el('adopt-task').onchange = () => { clearToken(); el('adopt').disabled = !el('adopt-task').value; };
el('adopt').onclick = () => perform(async () => {
  clearToken();
  const {id:targetId, origin} = ordinaryTarget;
  const reply = await call('offerCurrentTab',{workspaceId:el('adopt-task').value, tabId:popupTabId,
    targetId, origin, accountAlias:el('adopt-alias').value.trim()});
  el('adopt-token').value = JSON.stringify({workspaceId:reply.workspaceId,adoptionToken:reply.adoptionToken});
  el('adopt-result').hidden = false;
  el('adopt-token').select();
  tokenTimer = setTimeout(clearToken, Math.max(0, reply.expiresAt - Date.now()));
});

let deliveryKey = '', finishId;
function renderDelivery(w) {
  const originLabels = {resource:'加载静态资源',navigation:'允许导航与页面操作'};
  const blocks = (w.blockedOrigins || []).filter(item => originLabels[item.scope]);
  el('blocked').replaceChildren(...blocks.map(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = '本次' + originLabels[item.scope] + ' · ' + item.origin;
    button.onclick = () => perform(() => call('grantOrigin',{workspaceId:w.workspaceId,
      controlGeneration:w.controlGeneration,origin:item.origin,scope:item.scope}));
    return button;
  }));
  const key = JSON.stringify([w.workspaceId, w.controlGeneration, w.pages.map(p => p.pageId)]);
  if (deliveryKey === key) return;
  deliveryKey = key;
  finishId = crypto.randomUUID();
  el('delivery').open = false;
  el('keep').replaceChildren(...w.pages.map(p => {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    input.disabled = p.ownership === 'user';
    input.value = p.pageId;
    input.onchange = () => { finishId = crypto.randomUUID(); };
    label.append(input, ' ' + (p.title || p.origin || '页面'));
    return label;
  }));
}
el('finish').onclick = () => perform(async () => {
  const keepPageIds = [...el('keep').querySelectorAll('input:checked')].map(input => input.value);
  const receipt = await call('finishWorkspace',{workspaceId:selected,keepPageIds,operationId:finishId,
    controlGeneration:detail.controlGeneration});
  if (receipt.state !== 'completed') { notify('交付待核实 · ' + receipt.operationId); return; }
  notify('已保留 ' + receipt.keptPageIds.length + ' 页，已关闭 ' + receipt.closedPageIds.length + ' 页。');
  render(null);
});

function clearDiagnostic() {
  const link = el('diagnostic-export');
  if (link.hasAttribute('href')) URL.revokeObjectURL(link.href);
  link.removeAttribute('href');
  link.hidden = true;
}
el('diagnostic-export-button').onclick = () => perform(async () => {
  clearDiagnostic();
  const workspaceId = selected;
  const [operations, events] = await Promise.all([
    call('listOperations', {workspaceId, after: 0, limit: 100}),
    call('listEvents', {workspaceId, after: 0, limit: 100}),
  ]);
  const text = JSON.stringify({ version: 1, workspaceId, exportedAt: new Date().toISOString(),
    operations: (operations.operations || []).filter(item => item.error || ['failed', 'outcome_unknown', 'cancelled'].includes(item.state)),
    events: events.events || [] }, null, 2) + '\n';
  const link = el('diagnostic-export');
  link.href = URL.createObjectURL(new Blob([text], {type:'application/json'}));
  link.hidden = false;
  link.textContent = '下载错误日志';
  link.click();
});

function render(w) {
  if (detail?.workspaceId !== w?.workspaceId) {
    clearDiagnostic();
  }

  detail = w;
  el('workspace').hidden = !w;
  el('empty').hidden = !!w;
  el('context-selection').hidden = contextTab || !w;
  el('status').textContent = w ? describe(w) + ' · 资料 ' + w.profileId : '暂无工作区';
  if (!w) { showCredential(null); return; }
  renderDialogs(w);
  renderDelivery(w);
  const pages = w.pages || [];
  if (standalone && !selectedTab) selectedTab = pages[0]?.pageId || '';
  const page = pages.find(p => p.pageId === selectedTab);
  options(el('pages'), pages.map((p, i) => [p.pageId, (i+1) + ' · ' + (p.title || p.origin || '页面')]), selectedTab);
  if (!page) {
    el('workspace').hidden = !standalone;
    el('control').disabled = true;
    el('uploads').hidden = true;
    el('page-details').textContent = '';
    el('status').textContent = '原标签页已关闭或解绑';
    showCredential(null);
    return;
  }
  const sync = page.lastSyncedAt ? '上次同步 ' + new Date(page.lastSyncedAt).toLocaleTimeString() : '';
  el('page-details').textContent = [page.origin, w.accountAlias, page.syncState === 'sync_pending' ? '同步中' : sync].filter(Boolean).join(' · ');
  el('control').textContent = w.unlockPending ? '重试人工接管' : w.mode === 'human' ? '交回 Agent' : w.scope === 'single_tab' ? '接管此页' : '接管工作区';
  el('control').disabled = busy || (w.mode === 'transferring' && !w.unlockPending) || (!selectedTab && w.mode !== 'human');
  el('uploads').hidden = w.mode!=='agent' || !selectedTab;
  el('upload-origin').textContent = pages.find(p=>p.pageId===selectedTab)?.origin || '';
  showCredential(w.mode === 'agent' ? w.activity?.credentialRequest || null : null);
}

async function sync() {
  if (refreshing || busy) return;
  refreshing = true;
  const serial = revision;
  try {
    if (Number.isInteger(popupTabId)) {
      const key = 'tab:' + popupTabId;
      const mapping = (await chrome.storage.session.get(key))[key];
      if (!contextTab && mapping) {
        contextTab = true;
        selected = mapping.workspaceId;
        selectedTab = mapping.pageId;
        clearToken();
      }
    }
    el('adoption').hidden = true;
    if (!contextTab && !standalone) {
      const list = await call('listWorkspaces');
      const target = (await chrome.debugger.getTargets()).find(t => t.type === 'page' && t.tabId === popupTabId);
      const origin = URL.parse(target?.url);
      if (serial !== revision) return;
      render(null);
      if (!origin || !['http:', 'https:'].includes(origin.protocol)) return;
      if (ordinaryTarget?.id !== target.id || ordinaryTarget?.origin !== origin.origin) clearToken();
      ordinaryTarget = {id:target.id, origin:origin.origin};
      const tasks = list.filter(w => w.pageAvailability === 'unregistered' && w.mode === 'agent');
      el('adoption').hidden = false;
      el('empty').hidden = true;
      el('status').textContent = '普通标签页';
      el('adopt-site').textContent = origin.origin + (tasks.length ? '' : ' · 请让 Agent 先创建一个命名工作区');
      const chooser = el('adopt-task');
      options(chooser, tasks.map(w => [w.workspaceId, workspaceTitle(w) + ' · ' + w.workspaceId.slice(0,8)]),
        tasks.some(w => w.workspaceId === chooser.value) ? chooser.value : tasks.length === 1 ? tasks[0].workspaceId : '');
      el('adopt').disabled = !chooser.value;
      return;
    }
    const list = contextTab ? (selected ? [await call('getWorkspace', {workspaceId: selected })] : []) : await call('listWorkspaces');
    if (serial !== revision) return;
    if (contextTab && !list.some(w => w.workspaceId === selected)) { render(null); return; }
    if (!list.some(w => w.workspaceId === selected)) {
      selectedTab = '';
      selected = (list.find(w => w.activity?.needsCredential) || list[0])?.workspaceId || '';
    }
    const titles = list.map(workspaceTitle);
    const entries = list.map((w, index) => {
      const title = titles[index];
      const duplicate = titles.indexOf(title) !== titles.lastIndexOf(title);
      const suffix = duplicate ? ' · ' + w.workspaceId.slice(0, 8) : '';
      return [w.workspaceId, title + suffix + ' · ' + describe(w)];
    });
    options(el('workspaces'), entries, selected);
    const w = contextTab ? list[0] || null : selected ? await call('getWorkspace', { workspaceId: selected }) : null;
    const [captureReply, downloads, uploads] = w ? await Promise.all([
      call('visualStatus',{workspaceId:selected}).catch(()=>({})),
      call('listDownloads',{workspaceId:selected}),
      call('listUploads',{workspaceId:selected}),
    ]) : [{}, [], []];
    const capture = captureReply.lastCapture;
    if (serial === revision) {
      render(w);
      el('upload-list').replaceChildren(...uploads.map(file=>{
        const button=document.createElement('button');
        button.textContent='撤销 '+file.name+' · '+file.origin;
        button.onclick=()=>perform(()=>call('revokeUpload',{workspaceId:w.workspaceId,fileId:file.fileId}));
        return button;
      }));
      renderDownloads(downloads);
      const status=el('visual-status');
      status.hidden=!capture;
      if(capture) status.textContent='最近画面采集 · '+capture.principalId+' · '+capture.origin+' · ('+
        capture.clip.x+', '+capture.clip.y+') '+capture.clip.width+' × '+capture.clip.height;
    }
  } catch (error) {
    if (serial === revision) {
      render(null);
      if (contextTab && error.message === 'workspace_not_found') {
        el('status').textContent = '原任务已结束或服务已重启';
        notify('请在需要授权的标签页重新打开扩展。');
      } else {
        el('status').textContent = '连接失败';
        notify(error.message);
      }
    }
  } finally {
    refreshing = false;
    if (!busy && serial !== revision) void sync();
  }
}

function renderDialogs(w) {
  const panel = el('dialogs'), items = w.pendingDialogs || [];
  const signature = JSON.stringify([w.workspaceId,w.mode,w.controlGeneration,items]);
  if (panel.dataset.signature === signature) return;
  panel.dataset.signature = signature;
  panel.replaceChildren(...items.map(item => {
    const row = document.createElement('div');
    row.textContent = item.origin + ' · ' + item.type + ' · ' + item.message;
    if (w.mode === 'agent') {
      const take = document.createElement('button');
      take.textContent = '接管并处理';
      take.onclick = () => {
        take.disabled = true;
        void call('takeControl',{workspaceId:w.workspaceId,pageId:item.pageId,controlGeneration:w.controlGeneration})
          .catch(error=>notify(error.message)).finally(()=>void sync());
      };
      row.append(take);
      return row;
    }
    const input = document.createElement('input');
    if (item.type === 'prompt') { input.placeholder = '回复'; input.maxLength = 2048; row.append(input); }
    for (const accept of [true,false]) {
      const button = document.createElement('button');
      button.textContent = accept ? '确定' : '取消';
      button.onclick = () => perform(() => call('respondDialog',{workspaceId:w.workspaceId,pageId:item.pageId,
        dialogId:item.dialogId,controlGeneration:w.controlGeneration,accept,
        ...(accept && item.type === 'prompt' && {text:input.value})}));
      row.append(button);
    }
    return row;
  }));
}

function renderDownloads(items) {
  el('downloads').hidden = !items.length;
  const labels = {receiving:'下载中',ready:'待保留',failed:'失败',cancelled:'已取消',kept:'已保留'};
  el('download-list').replaceChildren(...items.map(item => {
    const row = document.createElement('p');
    row.textContent = item.filename + ' · ' + labels[item.state] + ' ';
    function button(label, handler) {
      const action = document.createElement('button');
      action.type = 'button';
      action.textContent = label;
      action.onclick = () => perform(handler);
      row.append(action);
    }
    const params = {workspaceId:item.workspaceId,downloadId:item.downloadId};
    if (item.state === 'ready' || item.state === 'kept')
      button(item.state === 'kept' ? '查看保存位置' : '保留文件', async () => notify((await call('keepDownload',params)).path));
    if (item.state === 'receiving' || item.state === 'ready') button('取消', () => call('cancelDownload',params));
    return row;
  }));
}

async function perform(action) {
  if (busy) return;
  busy = true;
  revision++;
  notify();
  const enabled = [...document.querySelectorAll('button:enabled, select:enabled, input:enabled')];
  for (const element of enabled) element.disabled = true;
  try { await action(); } catch (error) { notify(error.message); }
  finally {
    busy = false;
    for (const element of enabled) element.disabled = false;
    render(detail);
    void sync();
  }
}

el('workspaces').onchange = event => {
  selected = event.target.value;
  selectedTab = '';
  revision++;
  render(null);
  void sync();
};
el('pages').onchange = event => { selectedTab = event.target.value; render(detail); };
let uploadTarget;
function selectedUploadTarget() {
  const target = detail?.pages.find(page=>page.pageId===selectedTab);
  if (!target || detail.mode!=='agent' || detail.workspaceId!==selected || target.origin==='null') return null;
  return {workspaceId:detail.workspaceId,pageId:target.pageId,controlGeneration:detail.controlGeneration,
    documentId:target.documentId,origin:target.origin};
}
el('upload-file').onclick = event => {
  uploadTarget = selectedUploadTarget();
  if (!uploadTarget) event.preventDefault();
};
el('upload-file').onchange = event => {
  const file=event.target.files[0];
  event.target.value='';
  if (!file) return;
  const target=uploadTarget, current=selectedUploadTarget();
  uploadTarget=null;
  if (!target || !current || Object.keys(target).some(key=>target[key]!==current[key])) {
    notify('页面或控制权已变更，请重新选择文件。');
    return;
  }
  const params={...target,name:file.name,mimeType:file.type};
  void perform(async()=>{
    if (file.size>8*1024*1024) throw Error('单文件上限 8 MiB');
    const data=await new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>resolve(reader.result.split(',')[1]);
      reader.onerror=()=>reject(Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
    await call('grantUpload',{...params,data});
    notify('已向 '+params.origin+' 授权 '+file.name+'，有效期五分钟。');
  });
};
el('control').onclick = () => perform(async () => {
  if (!detail?.pages.some(p => p.pageId === selectedTab)) return;
  if (detail.mode === 'human') await call('returnToAgent', { workspaceId: selected, pageId:selectedTab, controlGeneration: detail.controlGeneration });
  else await call('takeControl', { workspaceId: selected, pageId: selectedTab, controlGeneration: detail.controlGeneration });
});
el('credential').onsubmit = event => {
  event.preventDefault();
  const value = el('secret').value;
  el('secret').value = '';
  if (!value || !request) return;
  const pending = request, workspaceId = selected, generation = detail.controlGeneration;
  void perform(async () => {
    const w = await call('getWorkspace', { workspaceId });
    const fresh = w.activity?.credentialRequest;
    if (w.mode !== 'agent' || generation !== w.controlGeneration || !fresh ||
        ['pageId', 'origin', 'credentialRef', 'operationId'].some(k => fresh[k] !== pending[k])) throw new Error('凭据请求已变化');
    await call('resolveCredential', { workspaceId, ...pending, value });
    notify('已绑定凭据，调用方可以重试。');
  });
};

async function open() {
  const explicit = /^#tab-(\d+)(-delivery)?$/.exec(location.hash);
  standalone = !explicit && !!(await chrome.tabs.getCurrent());
  const tabId = popupTabId = standalone ? undefined : explicit ? Number(explicit[1]) : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  if (Number.isInteger(tabId)) {
    const key = 'tab:' + tabId;
    const owned = (await chrome.storage.session.get(key))[key];
    contextTab = Boolean(owned);
    if (owned) { selected = owned.workspaceId; selectedTab = owned.pageId; }
  }
  await sync();
  if (explicit?.[2] && detail) el('delivery').open = true;
}
void open().catch(() => sync());
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && message?.event === 'workspaceChanged') {
    if (refreshing) revision++;
    else void sync();
  }
});
// Recover after a worker restart and refresh ancillary details such as file grants.
setInterval(sync, 5000);
