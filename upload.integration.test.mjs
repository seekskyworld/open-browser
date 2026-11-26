import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {runTestHarness} from './benchmarks/test-harness.mjs';

test('file grants bind exact bytes to their workspace, document and origin', async () => {
  const uploads = [];
  const site = createServer(async (req,res) => {
    if(req.method === 'POST') {
      const chunks=[];for await(const chunk of req) chunks.push(chunk);
      uploads.push({path:req.url, bytes:Buffer.concat(chunks).toString('hex')});
      res.end('stored');return;
    }
    res.setHeader('Content-Type','text/html');
    res.end(`<button onclick="const i=document.createElement('input');i.type='file';i.onchange=async()=>{const r=await fetch(location.href,{method:'POST',body:i.files[0]});out.textContent=await r.text()};i.click()">Attach</button><p id="out"></p>`);
  });
  site.listen(0,'127.0.0.1');await once(site,'listening');
  try {
    await runTestHarness({async uploadsByOrigin({open,cli,service}) {
      const origin='http://127.0.0.1:'+site.address().port;
      const [a,b]=await Promise.all([open(origin+'/A'),open(origin+'/B')]);
      const [oa,ob]=await Promise.all([a.observe(),b.observe()]);
      async function grant(page,view,bytes) {
        return service.hostCall('grantUpload',{...page,documentId:view.documentId,controlGeneration:view.controlGeneration,
          origin,name:'same.bin',mimeType:'application/octet-stream',data:Buffer.from(bytes).toString('base64')});
      }
      const ga=await grant(a.page,oa,[0,255,4]);
      // Exercise the packaged extension page for the second grant. Only the
      // human file picker uses Playwright here; the agent uses the Skill CLI.
      const panel=await service.sharedContext.newPage();
      let gb;
      try {
        await panel.goto('chrome-extension://ehmdmliolflappfnmopemgojhbiilmpl/popup.html');
        await panel.locator('#workspaces').selectOption(b.page.workspaceId);
        await panel.waitForFunction(expected=>document.querySelector('#pages').value===expected,b.page.pageId);
        await panel.locator('#uploads > summary').click();
        const pick=async()=>{
          const event=panel.waitForEvent('filechooser');
          await panel.locator('#upload-file').click();
          return event;
        };
        const stale=await pick();
        await panel.locator('#workspaces').selectOption(a.page.workspaceId);
        await panel.waitForFunction(id=>document.querySelector('#pages').value===id,a.page.pageId);
        await stale.setFiles({name:'wrong.bin',mimeType:'application/octet-stream',buffer:Buffer.from('private')});
        await panel.getByText('页面或控制权已变更，请重新选择文件。').waitFor();
        assert.equal((await cli('listUploads',a.page)).length,1);
        assert.equal((await cli('listUploads',b.page)).length,0);
        await panel.locator('#workspaces').selectOption(b.page.workspaceId);
        await panel.waitForFunction(id=>document.querySelector('#pages').value===id,b.page.pageId);
        const fresh=await pick();
        await fresh.setFiles({name:'same.bin',mimeType:'application/octet-stream',buffer:Buffer.from([6,1,0])});
        await panel.getByText('已向 '+origin+' 授权 same.bin',{exact:false}).waitFor({timeout:5000});
        [gb]=await cli('listUploads',b.page);
      } finally {await panel.close();}
      assert.equal((await cli('listUploads',a.page))[0].fileId,ga.fileId);
      assert.equal((await cli('listUploads',b.page))[0].fileId,gb.fileId);
      const use=(target,view,fileId)=>target.act(view,[{kind:'upload',ref:view.elements.find(e=>e.name==='Attach').ref,fileId}]);
      await assert.rejects(use(b,ob,ga.fileId),/file_grant_invalid/);
      assert.equal(uploads.length,0);
      await Promise.all([use(a,oa,ga.fileId),use(b,ob,gb.fileId)]);
      for(let i=0;i<20 && uploads.length<2;i++) await delay(10);
      assert.deepEqual(uploads.sort((x,y)=>x.path.localeCompare(y.path)),[{path:'/A',bytes:'00ff04'},{path:'/B',bytes:'060100'}]);
      await assert.rejects(use(a,oa,ga.fileId),/file_grant_invalid/);
      const expired=await grant(a.page,oa,[3]);
      await service.hostCall('revokeUpload',{...a.page,fileId:expired.fileId});
      await assert.rejects(use(a,oa,expired.fileId),/file_grant_invalid/);
      const moved=await grant(a.page,oa,[2]);
      const other=await cli('openPage',{workspaceId:a.page.workspaceId,url:origin+'/C'});
      const oc=await cli('observe',other);
      let op=await cli('act',{...other,operationId:crypto.randomUUID(),documentId:oc.documentId,controlGeneration:oc.controlGeneration,
        actions:[{kind:'upload',ref:oc.elements.find(e=>e.name==='Attach').ref,fileId:moved.fileId}]});
      while(['queued','running'].includes(op.state)) op=await cli('getOperation',{...other,operationId:op.operationId});
      assert.equal(op.error,'file_grant_invalid');assert.equal(uploads.length,2);
      return {matchedBytes:2,crossWorkspaceWrites:0,duplicateWrites:0};
    }},1);assert.notEqual(process.exitCode,1);
  } finally {site.closeAllConnections();await new Promise(resolve=>site.close(resolve));}
});

test('an expired grant and a changed target origin reject the original ID',async t=>{
  const {UploadGrants}=await import('./uploads.mjs');
  t.mock.timers.enable({apis:['Date']});
  let origin='https://first.example';
  const tab={id:'page',documentId:'doc',page:{url:()=>origin}};
  const ws={origins:new Set([origin,'https://second.example']),mode:'agent',generation:'g'};
  const grants=new UploadGrants();
  try {
    const {fileId}=grants.grant(ws,tab,{name:'test',data:'eA==',controlGeneration:'g',origin,documentId:'doc'});
    origin='https://second.example';
    assert.throws(()=>grants.get(ws,tab,fileId),{code:'file_grant_invalid'});
    origin='https://first.example';
    t.mock.timers.tick(300001);
    assert.throws(()=>grants.get(ws,tab,fileId),{code:'file_grant_invalid'});
  } finally {grants.clear();}
});
