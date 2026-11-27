import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import test from 'node:test';
import {launchBrowser} from './control.mjs';
import {BrowserService} from './engine-service.mjs';

async function site(t,html) {
  const server=createServer((req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(html(req.url)));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return 'http://127.0.0.1:'+server.address().port;
}
async function setup(t,origin,allowedOrigins=[origin]) {
  const browser=await launchBrowser(),engine=new BrowserService(browser);
  t.after(async()=>{await engine.shutdown();await browser.close();});
  const call=(method,params,actor='owner')=>engine.call(method,params,'owner',actor);
  const {workspaceId}=await call('createWorkspace',{name:'测试任务',allowedOrigins});
  const handle=await call('openPage',{workspaceId,url:origin});
  const ws=engine.workspaces.get(workspaceId),page=ws.pages.get(handle.pageId).page;
  const observe=(options={},actor='owner',readOnly=false)=>call(readOnly?'observeReadOnly':'observe',{...handle,...options},actor);
  const act=async(view,action,actor='owner')=>{
    const operationId=randomUUID();
    const params={...handle,controlGeneration:view.controlGeneration,documentId:view.documentId,operationId,actions:[action]};
    await call('act',params,actor);await ws.tail;return call('getOperation',params,actor);
  };
  return {workspaceId,call,ws,handle,page,act,observe};
}

test('observation cursors bind identity, role, page document and control while redacting split credentials',async t=>{
  const secret='MASKLEFT-MASKRIGHT';
  const origin=await site(t,()=>'<p>'+'a'.repeat(7992)+secret+'z'.repeat(20)+'</p><button style="position:fixed;top:2px;left:2px">Inside</button><button style="position:fixed;top:500px">Outside</button>');
  const {workspaceId,call,handle,page,observe}=await setup(t,origin);
  await call('setCredential',{workspaceId,origin,credentialRef:'bound',value:secret});
  for(const ro of [false,true]) {
    const actor=ro?'reader':'owner',first=await observe({limit:1},actor,ro);
    assert.ok(first.truncated && first.nextCursor);
    await assert.rejects(observe({cursor:first.nextCursor},'different',ro),{code:'stale_cursor'});
    await assert.rejects(observe({cursor:first.nextCursor},actor,!ro),{code:'stale_cursor'});
    const second=await observe({cursor:first.nextCursor},actor,ro);
    assert.deepEqual([...first.elements,...second.elements].map(e=>e.name),['Inside','Outside']);
    assert.ok(!(first.text+second.text).includes('MASK'));
    assert.match(first.text,/\[redacted\]$/);
    assert.match(second.text,/^\[redacted\]/);
    assert.equal(second.truncated,false);
    if(ro) assert.ok(!second.elements[0].ref);
  }
  assert.deepEqual((await observe({region:{x:1,y:1,width:30,height:15}})).elements.map(e=>e.name),['Inside']);
  assert.deepEqual((await observe({name:'OUTSIDE'})).elements.map(e=>e.name),['Outside']);
  let first=await observe({limit:1});
  const freshObservation = await observe();
  assert.match(freshObservation.observationId,/^[0-9a-f-]{36}$/);
  assert.notEqual(freshObservation.observationId,first.observationId);
  await page.reload();
  await assert.rejects(observe({cursor:first.nextCursor}),{code:'stale_cursor'});
  first=await observe({limit:1});
  await call('takeControl',handle);await call('returnToAgent',{workspaceId});
  await assert.rejects(observe({cursor:first.nextCursor}),{code:'stale_cursor'});
});

test('authorized cross-origin references respect private, sandbox, read-only, credential scope, navigation and handoff',async t=>{
  const child=(await site(t,()=>'<input type="password" aria-label="Child PIN"><button>Child action</button>')).replace('127.0.0.1','localhost');
  const denied=await site(t,()=>'<button>Unapproved target</button>');
  const parent=await site(t,()=>`<iframe id=child src="${child}"></iframe><iframe src="${denied}"></iframe><iframe sandbox src="${child}/opaque"></iframe>
    <div data-open-browser-private><iframe src="${child}/private"></iframe><x-private></x-private></div>
    <x-open></x-open><x-closed></x-closed><script>
    document.querySelector('x-private').attachShadow({mode:'open'}).innerHTML='<button>Private shadow</button>';
    document.querySelector('x-closed').attachShadow({mode:'closed'}).innerHTML='<button>Closed shadow</button>';
    document.querySelector('x-open').attachShadow({mode:'open'}).innerHTML='<button>Open shadow</button>';</script>`);
  const {workspaceId,call,handle,page,observe,act}=await setup(t,parent,[parent,child]);
  await page.waitForLoadState('load');
  const options={frameControls:true};
  const read=await observe(options,'reader',true);
  assert.equal(read.frames.length,1);assert.ok(read.frames[0].elements.every(el=>!el.ref));
  let view=await observe(options);
  assert.doesNotMatch(JSON.stringify(view),/Unapproved target|Private shadow|Closed shadow/);
  assert.deepEqual(view.elements.map(el=>el.name),['Open shadow']);
  assert.equal(view.frames.length,1);
  let field=view.frames[0].elements[0].ref;
  const fill={kind:'fillCredential',ref:field,credentialRef:'pin'};
  await call('setCredential',{workspaceId,origin:parent,credentialRef:'pin',value:'parent-only'});
  assert.equal((await act(view,fill)).error,'credential_required');
  const pending=(await call('getWorkspace',{workspaceId})).activity.credentialRequest;
  assert.equal(pending.origin,child);
  await call('resolveCredential',{...pending,workspaceId,value:'child-only'});
  assert.equal((await act(view,fill)).state,'completed');
  const frame=page.frames().find(f=>f.url()===child+'/');
  assert.equal(await frame.locator('input').inputValue(),'child-only');
  assert.equal((await act(view,{kind:'fill',ref:field,value:'forbidden'})).error,'credential_ref_required');
  assert.equal((await act(view,fill,'different')).error,'stale_ref');
  await page.locator('#child').evaluate(el=>el.setAttribute('data-open-browser-private',''));
  assert.equal((await act(view,fill)).error,'stale_ref');
  await page.locator('#child').evaluate(el=>el.removeAttribute('data-open-browser-private'));
  await frame.goto(child+'/reload');
  assert.equal((await act(view,fill)).error,'stale_ref');
  view=await observe(options);field=view.frames[0].elements[0].ref;
  await call('setPixelPermission',{workspaceId,principalId:'owner',origin:parent,allow:true});
  await assert.rejects(call('captureVisual',{...handle,ref:field}),{code:'stale_ref'});
  await call('takeControl',handle);await call('returnToAgent',{workspaceId});
  await assert.rejects(act(view,{kind:'click',ref:field}),{code:'stale_control'});
});
