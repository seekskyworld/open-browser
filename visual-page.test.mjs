import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { PNG } from 'pngjs';
import { launchBrowser } from './control.mjs';
import { BrowserService } from './engine-service.mjs';

test('scoped pixels and one-shot spatial input use a real masked canvas fixture',async t=>{
  const site=createServer((req,res)=>{
    res.setHeader('content-type','text/html');
    res.end(`<style>*{margin:0;padding:0;border:0} body{height:2200px} canvas{display:block} input,iframe,.secret{position:absolute;left:110px;width:70px;height:18px;background:#f00} input{top:0} iframe{top:25px}.secret{top:50px}</style>
      <canvas width=100 height=100 tabindex=0></canvas><input type=password value="secret-password"><iframe srcdoc="<body style='background:red'>secret</body>"></iframe><div class=secret data-open-browser-private>private</div>
      <script>const c=document.querySelector('canvas'); const draw=c.getContext('2d');draw.fillStyle='#12ab34';draw.fillRect(0,0,100,100);window.log=[];
      for(const type of ['click','pointerdown','pointerup','pointermove','keydown','touchstart','touchend','wheel']) c.addEventListener(type,e=>window.log.push([type,e.offsetX,e.offsetY,e.key]));
      </script>`);
  });
  site.listen(0,'127.0.0.1');await once(site,'listening');
  const origin='http://127.0.0.1:'+site.address().port;
  const browser=await launchBrowser();
  const engine=new BrowserService(browser);
  t.after(async()=>{await engine.shutdown();await browser.close();site.closeAllConnections();await new Promise(r=>site.close(r));});
  const call=(m,p,actor='owner')=>engine.call(m,p,'owner',actor);
  const {workspaceId}=await call('createWorkspace',{name:'测试任务',allowedOrigins:[origin]});
  const handle=await call('openPage',{workspaceId,url:origin});
  const tab=engine.workspaces.get(workspaceId).pages.get(handle.pageId);
  const region={x:0,y:0,width:200,height:100}, params={...handle,region};
  await assert.rejects(call('captureVisual',params),{code:'pixel_permission_required'});
  const grant=allow=>call('setPixelPermission',{workspaceId,principalId:'owner',origin,allow});
  await grant(true);
  const capture=async()=>{await delay(155);return call('captureVisual',params);};
  const run=async(frame,action)=>{
    const p={...handle,documentId:frame.documentId,controlGeneration:frame.controlGeneration,operationId:crypto.randomUUID(),
      actions:[{kind:'spatial',frameId:frame.frameId,action}]};
    await call('act',p);await engine.workspaces.get(workspaceId).tail;return call('getOperation',p);
  };
  const frame=await capture();const png=PNG.sync.read(Buffer.from(frame.data,'base64'));
  const at=(x,y)=>png.data.readUInt32BE((png.width*y+x)*4);
  assert.equal(at(30,30),0x12ab34ff);
  for(const top of [0,25,50]) for(let y=top+2;y<top+16;y++)for(let x=112;x<178;x++)assert.equal(at(x,y),0x000000ff);
  const action={type:'click',x:30,y:30};
  assert.equal((await run(frame,action)).state,'completed');
  assert.equal((await run(frame,action)).error,'stale_visual_frame');
  assert.deepEqual(await tab.page.evaluate(()=>window.log.filter(e=>e[0]==='click').map(e=>e.slice(0,3))),[['click',30,30]]);
  assert.equal((await run(await capture(),{...action,x:120,y:6})).error,'visual_target_denied');
  await assert.rejects(call('captureVisual',params,'peer'),{code:'pixel_permission_required'});
  const stale=await capture();
  await tab.page.evaluate(()=>scrollTo(0,40));
  assert.equal((await run(stale,action)).error,'stale_visual_frame');
  await tab.page.evaluate(()=>scrollTo(0,0));
  for(const candidate of [{type:'hover',x:12,y:13},{type:'drag',x:10,y:20,toX:50,toY:80},
    {type:'key',x:20,y:20,keys:['Shift','a']},{type:'tap',x:30,y:24},{type:'scroll',x:25,y:30,deltaX:0,deltaY:12}]) {
    const result=await run(await capture(),candidate);assert.equal(result.state,'completed',JSON.stringify(result));
  }
  const log=await tab.page.evaluate(()=>window.log);
  assert.ok(log.some(e=>e[0]==='pointerup'&&e[1]===50&&e[2]===80));
  assert.ok(log.some(e=>e[0]==='keydown'&&e[3]==='Shift'));
  assert.ok(log.some(e=>e[0]==='touchstart'));
  await tab.page.waitForFunction(()=>scrollY>0);
  await tab.page.evaluate(()=>scrollTo(0,0));
  const revoke=await capture();await grant(false);
  assert.equal((await run(revoke,action)).error,'pixel_permission_required');
  await grant(true);
  assert.equal((await run(revoke,action)).error,'stale_visual_frame');
  const changed=await capture();
  await tab.page.evaluate(()=>{const d=document.querySelector('canvas').getContext('2d');d.fillStyle='#333';d.fillRect(0,0,20,20);});
  assert.equal((await run(changed,action)).error,'stale_visual_frame');
  const observer=await call('observe',handle);
  const ref=observer.elements.find(e=>e.role==='textbox')?.ref || observer.elements[0]?.ref;
  assert.ok(ref);
  await delay(160);
  const element=await call('captureVisual',{...handle,ref});
  assert.ok(element.pixelWidth<200);
  await delay(160);
  const viewport=await call('captureVisual',handle);
  assert.deepEqual([viewport.pixelWidth,viewport.pixelHeight],[viewport.viewport.width,viewport.viewport.height]);
  await tab.page.evaluate(()=>document.body.style.filter='blur(2px)');
  await delay(160);await assert.rejects(call('captureVisual',params),{code:'visual_redaction_unavailable'});
  await tab.page.evaluate(()=>document.body.style.removeProperty('filter'));
  const tail=await call('listEvents',{workspaceId,limit:100});
  assert.ok(tail.events.some(e=>e.kind==='visual_capture' && e.state==='completed' && e.pixelWidth===200 && e.pixelHeight===100));
  assert.doesNotMatch(JSON.stringify(tail),/data:image|iVBORw0|secret-password/);
  const heldFrame=await capture();
  await tab.page.exposeBinding('giveToHuman',()=>{void engine.handOff(engine.workspaces.get(workspaceId),handle.pageId,false);});
  await tab.page.evaluate(()=>document.querySelector('canvas').addEventListener('pointerdown',()=>window.giveToHuman(),{once:true}));
  const held=await run(heldFrame,{type:'drag',x:10,y:20,toX:80,toY:90});
  assert.equal(held.state,'outcome_unknown');
  const ws=engine.workspaces.get(workspaceId);
  await ws.handoff;
  assert.equal(ws.mode,'human');
  const prior=await tab.page.evaluate(()=>window.log.length);
  await delay(100);
  assert.equal(await tab.page.evaluate(()=>window.log.length),prior);
  await tab.page.evaluate(()=>document.addEventListener('pointermove',e=>window.lastButtons=e.buttons,{once:true}));
  await tab.page.mouse.move(32,25);
  assert.equal(await tab.page.evaluate(()=>window.lastButtons),0);
  await call('returnToAgent',{workspaceId});
  await assert.rejects(run(heldFrame,action),{code:'stale_control'});
  await tab.page.focus('canvas');
  await tab.page.evaluate(()=>{
    document.addEventListener('keyup',e=>window.lastReleased=e.key,{once:true});
  });
  // Stop the host between the actual Chromium modifier down and the next key.
  // This makes the handoff point deterministic across platform IPC ordering.
  const keyboard=tab.page.keyboard,down=keyboard.down.bind(keyboard);
  keyboard.down=async key=>{
    await down(key);
    if(key==='Shift') void engine.handOff(ws,handle.pageId,false);
  };
  let interrupted;
  try { interrupted=await run(await capture(),{type:'key',x:30,y:30,keys:['Shift','a']}); }
  finally { keyboard.down=down; }
  assert.equal(interrupted.state,'outcome_unknown');
  await ws.handoff;
  assert.equal(await tab.page.evaluate(()=>window.lastReleased),'Shift');
  await call('returnToAgent',{workspaceId});
  const detached=await capture();
  const delivered=await call('finishWorkspace',{workspaceId,keepPageIds:[handle.pageId],operationId:crypto.randomUUID()});
  assert.deepEqual(delivered.keptPageIds,[handle.pageId]);
  assert.equal(tab.page.isClosed(),false);
  await assert.rejects(run(detached,action),{code:'workspace_not_found'});

});

test('desktop zoom and pinch keep decoded canvas pixels, redaction, scroll and input in CSS coordinates',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {launchChromiumShell}=await import('./chromium-shell.mjs');
  const profileDir=await mkdtemp(join(tmpdir(),'ob-visual-zoom-'));
  let context, engine;
  t.after(async()=>{
    try { await engine?.shutdown(); }
    finally {
      try { await context?.close(); }
      finally { await rm(profileDir,{recursive:true,force:true,maxRetries:6,retryDelay:200}); }
    }
  });
  context=await launchChromiumShell({profileDir,headless:true});
  engine=new BrowserService(context.browser(),{sharedContext:context});
  const site=createServer((_req,res)=>{
    res.setHeader('Content-Type','text/html');
    res.end('<style>body{margin:0;height:2500px}canvas,input{position:absolute;top:200px}canvas{left:15px}input{left:105px;background:red;width:70px;height:20px}</style><canvas width=60 height=60></canvas><input type=password value=secret><script>const c=document.querySelector("canvas"),d=c.getContext("2d");d.fillStyle="#0080fe";d.fillRect(0,0,60,60);window.events=[];c.onclick=e=>events.push([e.offsetX,e.offsetY]);</script>');
  });
  site.listen(0,'127.0.0.1');await once(site,'listening');
  t.after(async()=>{site.closeAllConnections();await new Promise(r=>site.close(r));});
  const origin='http://127.0.0.1:'+site.address().port;
  const call=(m,p)=>engine.call(m,p,'owner');
  const {workspaceId}=await call('createWorkspace',{name:'测试任务',allowedOrigins:[origin]});
  const handle=await call('openPage',{workspaceId,url:origin});
  const ws=engine.workspaces.get(workspaceId), page=ws.pages.get(handle.pageId).page;
  await call('setPixelPermission',{workspaceId,principalId:'owner',origin,allow:true});
  await page.bringToFront();
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://')) ||
    await context.waitForEvent('serviceworker',{timeout:10000});
  const cdp=await context.newCDPSession(page);
  for(const [zoom,scale] of [[1,1],[1.5,1],[1.5,2],[1,2]]) {
    await worker.evaluate(async zoom=>{
      const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
      await chrome.tabs.setZoom(tab.id,zoom);
    },zoom);
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
    await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1});
    await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:scale});
    await page.evaluate(()=>scrollTo(0,140));
    if(scale===2) {
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:80,y:110}]});
      for(const y of [106,100,94,88,82]) {
        await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:80,y}]});
        await delay(35);
      }
      await delay(120);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    }
    await delay(180);
    const {cssVisualViewport:v}=await cdp.send('Page.getLayoutMetrics');
    assert.equal(v.zoom,zoom);assert.equal(v.scale,scale);
    if(scale===2) assert.ok(v.offsetY>0,'pinch scroll really panned the visual viewport '+JSON.stringify(v));
    const x=Math.round(40-v.pageX),y=Math.round(225-v.pageY);
    const frame=await call('captureVisual',{...handle,region:{x:x-12,y:y-20,width:128,height:44}});
    const png=PNG.sync.read(Buffer.from(frame.data,'base64'));
    assert.equal(png.data.readUInt32BE((20*png.width+12)*4),0x0080feff,`canvas ${zoom} ${scale}`);
    for(let py=0;py<=12;py++) for(let px=84;px<124;px++)
      assert.equal(png.data.readUInt32BE((py*png.width+px)*4),0x000000ff,`password ${zoom} ${scale}`);
    const p={...handle,documentId:frame.documentId,controlGeneration:frame.controlGeneration,operationId:crypto.randomUUID(),
      actions:[{kind:'spatial',frameId:frame.frameId,action:{type:'click',x,y}}]};
    const before=await page.evaluate(()=>events.length);
    await call('act',p);await ws.tail;
    const receipt=await call('getOperation',p); assert.equal(receipt.state,'completed',JSON.stringify({zoom,scale,receipt,v}));
    assert.deepEqual(await page.evaluate(n=>events.slice(n),before),[[25,25]],`input ${zoom} ${scale}`);
  }
});
