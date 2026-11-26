import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { launchBrowser } from './control.mjs';
import { BrowserService } from './engine-service.mjs';
import { ReceiptStore } from './receipt-store.mjs';

test('persisted receipts recover dispatched and undispatched states, with bounded cursor queries', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'open-browser-receipts-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const db = path.join(directory, 'receipts.db');
  let store = new ReceiptStore(db);
  const r = {operationId:'one',state:'running',phase:'dispatching',totalSteps:2,stepKind:'click',completedSteps:1,snapshot:'PRIVATE-PAGE',value:'PRIVATE-SECRET'};
  store.save('owner','space','first',r,true);
  store.save('owner','space','second',{...r,operationId:'two'},false);
  store.close();
  store = new ReceiptStore(db);
  t.after(() => store.close());
  assert.equal(store.get('owner','space','one').receipt.state, 'outcome_unknown');
  assert.equal(store.get('owner','space','one').receipt.phase, 'outcome_unknown');
  assert.equal(store.get('owner','space','one').receipt.totalSteps, 2);
  assert.equal(store.get('owner','space','one').receipt.stepKind, 'click');
  assert.equal(store.get('owner','space','two').receipt.state, 'cancelled');
  assert.equal(store.get('other','space','one'), null);
  assert.throws(() => store.save('owner','space','other',r), {code:'operation_id_conflict'});
  const first = store.list('owner','space',0,1);
  assert.equal(first.operations.length,1);
  assert.equal(store.list('owner','space',first.nextCursor,1).operations[0].operationId,'two');
  assert.doesNotMatch((await readFile(db)).toString(), /PRIVATE-/);
  store.clear('space');
  assert.deepEqual(store.events('owner','space').events,[]);
});

test('5000 scheduled operations execute FIFO on each workspace under a global cap', async t => {
  const service = new BrowserService({newBrowserCDPSession:async()=>({detach:async()=>{}})}, {
    sharedContext:{},concurrency:4 });
  t.after(() => service.shutdown());
  const spaces = [];
  for (let i=0;i<8;i++) {
    const w = await service.call('createWorkspace',{name:'测试任务'},'load');
    spaces.push(service.workspaces.get(w.workspaceId));
  }
  let active=0,peak=0;
  const counts=Array(8).fill(0);
  for (let batch=0;batch<25;batch++) {
    const tasks=[];
    for(let n=0;n<25;n++) for(let i=0;i<8;i++) {
      const expected=batch*25+n;
      tasks.push(service.enqueue(spaces[i],async()=>{
        assert.equal(counts[i]++,expected);
        peak=Math.max(peak,++active);
        await tick();
        active--;
      },{kind:'observe'}));
    }
    await Promise.all(tasks);
  }
  assert.equal(peak,4);
  assert.deepEqual(counts,Array(8).fill(625));
});

test('100 real action, timeout, retry and handoff rounds preserve receipts and keep user result pages', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'open-browser-delivery-'));
  const journalPath=path.join(dir,'receipts.db');
  const server=createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'})
    .end('<button onclick="window.submits=(window.submits||0)+1">submit</button><input type="password">'));
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const browser=await launchBrowser();
  const released=[];
  let service=new BrowserService(browser,{journalPath,releaseTab:async(page,ws,id)=>released.push(id)});
  t.after(async()=>{
    await service.shutdown();
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  });
  const call=(m,p,actor='owner')=>service.call(m,p,'owner',actor);
  const ws=await call('createWorkspace',{name:'测试任务',allowedOrigins:[origin]});
  const work=await call('openPage',{workspaceId:ws.workspaceId,url:origin});
  const another=await call('openPage',{workspaceId:ws.workspaceId,url:origin});
  const internal=service.workspaces.get(ws.workspaceId);
  const page=internal.pages.get(work.pageId).page;
  let expected=0, last;
  for(let n=0;n<100;n++) {
    const snap=await call('observe',work);
    const action=n%4===0?{kind:'wait',text:'never',timeoutMs:15}:
      {kind:'click',ref:snap.elements.find(el=>el.role==='button').ref};
    const params={...work,operationId:'race-'+n,documentId:snap.documentId,controlGeneration:snap.controlGeneration,actions:[action]};
    if(n%4===1) await page.locator('button').evaluate(el=>{el.disabled=true;});
    await call('act',params,'delegate');
    if(n%4===0 || n%4===2) await internal.tail;
    if(n%4===1) await sleep(15);
    const human=await call('takeControl',work);
    await assert.rejects(call('act',{...params,operationId:'while-human-'+n}),{code:'workspace_under_user_control'});
    const receipt=await call('getOperation',params);
    assert.deepEqual(await call('act',params),receipt);
    if(n%4===2) {assert.equal(receipt.state,'completed');expected++;}
    else if(n%4===0) assert.equal(receipt.error,'wait_timeout');
    else assert.equal(receipt.state,'cancelled');
    await page.locator('button').evaluate(el=>{el.disabled=false;});
    await call('returnToAgent',{...work,controlGeneration:human.controlGeneration});
    last=params;
  }
  assert.equal(await page.evaluate(()=>window.submits),expected);
  const snap=await call('observe',work);
  await call('act',{...work,operationId:'credential',documentId:snap.documentId,controlGeneration:snap.controlGeneration,
    actions:[{kind:'fillCredential',ref:snap.elements.find(e=>e.role==='textbox').ref,credentialRef:'pw'}]});
  await internal.tail;
  const request=(await call('getWorkspace',work)).activity.credentialRequest;
  await assert.rejects(call('resolveCredential',{...work,...request,documentId:'old',value:'private'}),{code:'stale_credential_request'});
  await call('takeControl',work);
  await assert.rejects(call('resolveCredential',{...work,...request,value:'private'}),{code:'stale_credential_request'});
  const finish={workspaceId:ws.workspaceId,operationId:'deliver',keepPageIds:[work.pageId]};
  await assert.rejects(call('finishWorkspace',finish),{code:'workspace_under_user_control'});
  const result=await call('hostFinishWorkspace',finish);
  assert.equal(result.state,'completed');
  assert.deepEqual(result.keptPageIds,[work.pageId]);
  assert.deepEqual(result.closedPageIds,[another.pageId]);
  // Both result and temporary tabs leave their native group before the latter closes.
  assert.deepEqual(released,[work.pageId,another.pageId]);
  assert.equal(page.isClosed(),false);
  await service.shutdown();
  service=new BrowserService(browser,{journalPath});
  assert.deepEqual(await call('finishWorkspace',finish),result);
  assert.deepEqual(await call('getOperation',finish),result);
  await assert.rejects(call('finishWorkspace',{...finish,keepPageIds:[]}),{code:'operation_id_conflict'});
  assert.equal((await call('act',last)).operationId,last.operationId);
  const {events,nextCursor}=await call('listEvents',{...work,limit:100});
  assert.ok(events.some(e=>e.kind==='operation'&&e.actorId==='delegate'));
  assert.ok((await call('listEvents',{...work,after:nextCursor,limit:100})).events[0].sequence>nextCursor);
  assert.equal((await service.call('listEvents',work,'other')).events.length,0);
});

test('a blocked page yields to another page and handoff waits for both lanes', async t => {
  const service = new BrowserService({newBrowserCDPSession:async()=>({detach:async()=>{}})}, {sharedContext:{}});
  t.after(() => service.shutdown());
  const handle = await service.call('createWorkspace',{name:'测试任务'},'owner');
  const ws = service.workspaces.get(handle.workspaceId);
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  const started = [];
  const slow = service.enqueue(ws, () => { started.push('a'); return first.promise; }, {kind:'observe',pageId:'a'});
  const fast = service.enqueue(ws, () => { started.push('b'); return second.promise; }, {kind:'observe',pageId:'b'});
  await tick();
  assert.deepEqual(started,['a','b']);
  assert.equal((await service.call('getWorkspace',handle,'owner')).activity.running.length,2);
  let transferred=false;
  const result = service.call('takeControl',handle,'owner').then(()=>{transferred=true;});
  const work = Promise.allSettled([slow,fast]);
  first.resolve();
  await tick();
  assert.equal(transferred,false);
  second.resolve();
  await Promise.all([work,result]);
  assert.equal(ws.mode,'human');
});

test('5000 receipt-bearing commands remain pageable after the live operation cache evicts them', async t => {
  const service = new BrowserService({newBrowserCDPSession: async () => ({detach:async()=>{}})}, {sharedContext:{}});
  t.after(() => service.shutdown());
  const ws = await service.call('createWorkspace',{name:'测试任务',allowedOrigins:['http://test.local']},'owner');
  const scope = service.workspaces.get(ws.workspaceId);
  const page = {url:()=> 'http://test.local/',isClosed:()=>false,evaluate:async()=> 'ready',close:async()=>{}};
  scope.pages.set('target',{id:'target',page,title:'',documentId:'doc'});
  const handle = {workspaceId:ws.workspaceId, pageId:'target', documentId:'doc',
    controlGeneration:scope.generation, actions:[{kind:'wait',text:'ready'}]};
  for(let base=0;base<5000;base+=100) {
    const batch=Array.from({length:100},(_,i)=>service.call('act',{...handle,operationId:'op-'+(base+i)},'owner'));
    await Promise.all(batch);
    await scope.tail;
  }
  assert.ok(scope.operations.size<=128);
  const original = await service.call('getOperation',{...handle,operationId:'op-0'},'owner');
  assert.equal(original.state,'completed');
  assert.deepEqual(await service.call('act',{...handle,operationId:'op-0'},'owner'),original);
  let cursor=0,count=0;
  do {
    const history=await service.call('listOperations',{...handle,after:cursor,limit:100},'owner');
    count+=history.operations.length;
    cursor=history.nextCursor;
  } while (cursor !== null);
  assert.equal(count,5000);
  service.store.db.prepare('UPDATE receipts SET expires=0 WHERE operation=?').run('op-0');
  await assert.rejects(service.call('getOperation',{...handle,operationId:'op-0'},'owner'),{code:'operation_not_found'});
});

test('action run budgets cover queue wait and execution without changing idempotency', async t => {
  const service = new BrowserService({newBrowserCDPSession: async () => ({detach:async()=>{}})}, {sharedContext:{}, concurrency:1});
  t.after(() => service.shutdown());
  const wsView = await service.call('createWorkspace', { name: '测试任务', allowedOrigins:['http://budget.test']}, 'owner');
  const ws = service.workspaces.get(wsView.workspaceId);
  const page = {url:()=> 'http://budget.test/', isClosed:()=>false, evaluate:async()=> 'ready', close:async()=>{}};
  const tab = {id:'budget-page', page, documentId:'budget-document', refs:new Map(), frameRefs:new Map()};
  ws.pages.set(tab.id, tab);
  const handle = {workspaceId:ws.id, pageId:tab.id, documentId:tab.documentId, controlGeneration:ws.generation};
  const operationId = 'budget-operation';
  const submitted = await service.call('act', {...handle, operationId, timeoutMs:25,
    actions:[{kind:'wait', text:'never', timeoutMs:1000}]}, 'owner');
  assert.equal(submitted.state, 'queued');
  await ws.tail;
  const receipt = await service.call('getOperation', {workspaceId:ws.id, operationId}, 'owner');
  assert.equal(receipt.error, 'run_timeout');
  assert.deepEqual(await service.call('act', {...handle, operationId, timeoutMs:25,
    actions:[{kind:'wait', text:'never', timeoutMs:1000}]}, 'owner'), receipt);
  await assert.rejects(service.call('act', {...handle, operationId, timeoutMs:26,
    actions:[{kind:'wait', text:'never', timeoutMs:1000}]}, 'owner'), {code:'operation_id_conflict'});
});

test('idle expiry preserves credential requests and unresolved submissions until the affected page is released', async t => {
  const { EventEmitter } = await import('node:events');
  t.mock.timers.enable({ apis:['setInterval'] });
  const service = new BrowserService({newBrowserCDPSession:async()=>({detach:async()=>{}})},
    {sharedContext:{},idleTimeoutMs:1000});
  t.after(() => service.shutdown());
  const call = (method, params) => service.call(method, params, 'owner');

  async function setup() {
    const created = await call('createWorkspace',{name:'测试任务',allowedOrigins:['http://example.test']});
    const ws = service.workspaces.get(created.workspaceId);
    const page = new EventEmitter();
    let closed = false;
    const frame = {evaluate:async (_inspect, {foregroundTarget})=>{
      assert.equal(foregroundTarget, tab.refs.get('input'));
      return true; // The fixture represents one visible form with no modal.
    }};
    Object.assign(page, {mainFrame:()=>frame, url:()=> 'http://example.test/form', isClosed:()=>closed,
      close:async()=>{closed=true; page.emit('close');}});
    const tab = service.register(ws,page);
    tab.refs.set('input', {ownerFrame:async()=>frame, evaluate:async()=>false, isVisible:async()=>true, isEditable:async()=>true,
      fill:async()=>{throw new Error('Lost action acknowledgement');}, dispose:async()=>{}});
    return {ws,tab,params:{workspaceId:ws.id,pageId:tab.id,controlGeneration:ws.generation,documentId:tab.documentId}};
  }

  const credential = await setup(), uncertain = await setup(), idle = await setup();
  async function act(entry, action) {
    const params = {...entry.params, operationId:'op', actions:[action]};
    await call('act',params);
    await entry.ws.tail;
    return call('getOperation',params);
  }
  assert.equal((await act(credential,{kind:'fillCredential',ref:'input',credentialRef:'login'})).error,'credential_required');
  assert.equal((await act(uncertain,{kind:'fill',ref:'input',value:'draft'})).state,'outcome_unknown');
  // Subsequent successful reads can change the latest receipt; the review
  // protection belongs to the page until the user disposes of that result.
  await service.enqueue(uncertain.ws,async()=>{}, {kind:'observe',pageId:uncertain.tab.id});

  async function expire() {
    for (const ws of service.workspaces.values()) ws.lastActiveAt = Date.now() - 2000;
    for (const ws of service.workspaces.values()) {
      for (const method of ['getWorkspace','visualStatus','listDownloads','listUploads'])
        await service.call(method, {workspaceId:ws.id}, 'owner', 'desktop');
    }
    t.mock.timers.tick(1000);
    await tick();
  }
  await expire();
  assert.equal(service.workspaces.has(idle.ws.id),false);
  assert.equal(service.workspaces.has(credential.ws.id),true);
  assert.equal(service.workspaces.has(uncertain.ws.id),true);
  await call('resolveCredential',{...credential.params,...credential.ws.credentialRequests.get(credential.tab.id),value:'bound'});
  await call('closePage',uncertain.params);
  await expire();
  assert.equal(service.workspaces.size,0);
  assert.equal((await call('getOperation',{...uncertain.params,operationId:'op'})).state,'outcome_unknown');
});

test('a lost response after a real click stays unknown and redelivery does not resubmit', async t => {
  const server = createServer((_req,res) => res.writeHead(200,{'content-type':'text/html'})
    .end('<button onclick="document.querySelector(\'output\').value++">Confirm</button><output>0</output>'));
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const browser = await launchBrowser();
  const service = new BrowserService(browser);
  t.after(async () => {
    await service.shutdown();
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const call = (method, params) => service.call(method, params, 'owner');
  const {workspaceId} = await call('createWorkspace',{name:'测试任务'});
  const page = await call('openPage',{workspaceId,url:'http://127.0.0.1:'+server.address().port});
  const view = await call('observe',page);
  const workspace = service.workspaces.get(workspaceId);
  const tab = workspace.pages.get(page.pageId);
  const ref = view.elements.find(el => el.name === 'Confirm').ref;
  const button = tab.refs.get(ref);
  const click = button.click.bind(button);
  button.click = async options => {
    await click(options);
    if (!options.trial) throw Error('lost driver acknowledgement');
  };
  const params = {...page, documentId:view.documentId, controlGeneration:view.controlGeneration,
    operationId:'confirm-once',actions:[{kind:'click',ref}]};
  await call('act',params);
  await workspace.tail;
  const receipt = await call('getOperation',params);
  assert.equal(receipt.state,'outcome_unknown');
  assert.equal(receipt.error,'inspect_before_retry');
  assert.deepEqual(await call('act',params),receipt);
  assert.equal(await tab.page.locator('output').textContent(),'1');
});

test('handoff commits ownership when the selected page closes, focus fails or the extension restarts', async t => {
  const browser = await launchBrowser();
  const service = new BrowserService(browser);
  t.after(async () => { await service.shutdown(); await browser.close(); });
  const {workspaceId} = await service.call('createWorkspace', { name: '测试任务' }, 'owner');
  const ws = service.workspaces.get(workspaceId);
  const page = await ws.context.newPage();
  const tab = [...ws.pages.values()].find(item => item.page === page);
  page.bringToFront = async () => { throw new Error('focus unavailable'); };
  service.groupTab = async () => { throw new Error('worker unavailable'); };
  assert.equal((await service.handOff(ws, tab.id)).mode, 'human');
  assert.throws(() => service.requireControl(ws, ws.generation), {code:'workspace_under_user_control'});
  assert.equal((await service.returnToAgent(ws)).mode, 'agent');
  page.bringToFront = () => page.close();
  assert.equal((await service.handOff(ws, tab.id)).mode, 'human');
});
