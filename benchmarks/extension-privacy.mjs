import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {runTestHarness} from './test-harness.mjs';
const secret='qa-secret-7636a', msg='qa-msg-2acd', body='qa-body-c4eb', file='qa-file-794a.txt', bytes='qa-bytes-9b64';
const site=createServer((req,res)=>{
 res.setHeader('content-type','text/html');
 res.end('<h1>'+body+'</h1><button onclick="confirm(\''+msg+' '+secret+'\')">Decide</button>');
});
site.listen(0,'127.0.0.1');await once(site,'listening');
const origin='http://127.0.0.1:'+site.address().port;
try {
 await runTestHarness({async privacy({open,cli,service}) {
  const app=await open(origin+'/');const p=app.page, o=await app.observe();
  await service.hostCall('setCredential',{workspaceId:p.workspaceId,credentialRef:'qa',origin,value:secret});
  const panel=await service.sharedContext.newPage();
  const remote=[];panel.on('request',req=>{if(/^https?:/.test(req.url()))remote.push(req.url());});
  try{
    await panel.goto('chrome-extension://ehmdmliolflappfnmopemgojhbiilmpl/popup.html');
   await panel.locator('#workspaces').selectOption(p.workspaceId);
   await panel.waitForFunction(p=>document.querySelector('#pages').value===p,p.pageId);
   await panel.locator('#uploads > summary').click();
   const picker=panel.waitForEvent('filechooser');await panel.locator('#upload-file').click();await (await picker).setFiles({name:file,mimeType:'text/plain',buffer:Buffer.from(bytes)});
   await panel.getByText('已向 '+origin+' 授权 '+file,{exact:false}).waitFor({timeout:5000});
   const operationId='qa-op-'+crypto.randomUUID();
   await cli('act',{...p,operationId,documentId:o.documentId,controlGeneration:o.controlGeneration,actions:[{kind:'click',ref:o.elements.find(e=>e.name==='Decide').ref}]});
   let dialog;
   for(let i=0;i<15&&!dialog;i++){dialog=(await cli('getWorkspace',p)).pendingDialogs[0];if(!dialog)await delay(30);}
   assert.ok(dialog);assert.equal(dialog.message,msg+' [redacted]');
   await panel.locator('#dialogs').getByText(new RegExp(msg)).first().waitFor({timeout:5000});
   assert.ok(!(await panel.locator('#dialogs').innerText()).includes(secret));
   await cli('respondDialog',{...p,dialogId:dialog.dialogId,controlGeneration:o.controlGeneration,accept:false});
   await panel.locator('#diagnostic-operation').evaluate(el=>el.closest('details').open=true);
   await panel.locator('#diagnostic-operation').fill(operationId);
   await panel.locator('#diagnostic-preview').click();
   const link=panel.locator('#diagnostic-export');await link.waitFor();
   const text=await panel.locator('#diagnostic-data').innerText();
   assert.deepEqual(Object.keys(JSON.parse(text)).sort(),['category','completedSteps','dispatchRecorded','nextAction','phase','state','totalSteps','version'].sort());
   const d=panel.waitForEvent('download');await link.click();const exported=await readFile(await (await d).path(),'utf8');assert.equal(exported,text);
   const db=new DatabaseSync(path.join(process.env.OPEN_BROWSER_STATE_DIR,'open-browser-receipts.sqlite'),{readOnly:true});
   let journal;
   try{journal=JSON.stringify(['events','receipts','recovery_objects'].map(table=>db.prepare('SELECT * FROM '+table).all()));}finally{db.close();}
   const worker=service.sharedContext.serviceWorkers()[0];
   const storage=JSON.stringify(await worker.evaluate(()=>chrome.storage.session.get(null)));
   for (const marker of [secret,msg,body,file,bytes,Buffer.from(bytes).toString('base64')]) {
     assert.ok(!text.includes(marker));assert.ok(!journal.includes(marker));assert.ok(!storage.includes(marker));
   }
   assert.ok(!text.includes(operationId));
   assert.deepEqual(remote,[]);
   return {checkedMarkers:6,exportFields:Object.keys(JSON.parse(text)).length,panelHttpRequests:remote.length,previewMatchesDownloadedBytes:true};
  }finally{await panel.close();}
 }},1);
}finally{site.closeAllConnections();await new Promise(resolve=>site.close(resolve));}
