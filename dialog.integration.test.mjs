import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {runTestHarness} from './benchmarks/test-harness.mjs';

test('native confirm, alert and prompt are owned by a single page and controller', async () => {
  const site = createServer((req, res) => {
    res.setHeader('Content-Type','text/html');
    res.end(`<button onclick="out.textContent=confirm('Save preference?')?'saved':'cancelled'">Save</button>
      <button onclick="alert('Read me');out.textContent='read'">Notice</button>
      <button onclick="out.textContent=prompt('Label')">Label</button><p id="out"></p>`);
  });
  site.listen(0,'127.0.0.1'); await once(site,'listening');
  try {
    await runTestHarness({async dialogs({open,cli,service}) {
      const url = 'http://127.0.0.1:' + site.address().port;
      const [a,b] = await Promise.all([open(url), open(url)]);
      async function trigger(target, name) {
        const obs = await target.observe();
        const ref = obs.elements.find(el=>el.name===name).ref;
        const operationId = crypto.randomUUID();
        await cli('act',{...target.page, documentId:obs.documentId,controlGeneration:obs.controlGeneration,
          operationId,actions:[{kind:'click',ref}]});
        for(let i=0;i<10;i++){
          const current = await cli('getWorkspace',target.page);
          const pending = current.pendingDialogs?.find(d=>d.operationId===operationId);
          if(pending) return {...target.page,dialogId:pending.dialogId,controlGeneration:current.controlGeneration,type:pending.type};
          await delay(20);
        }
        throw new Error('no actionable pending dialog');
      }
      const [one,two] = await Promise.all([trigger(a,'Save'),trigger(b,'Save')]);
      assert.equal(one.type,'confirm');
      const answer=(entry, accept, text) => cli('respondDialog',{workspaceId:entry.workspaceId,pageId:entry.pageId,
        dialogId:entry.dialogId,controlGeneration:entry.controlGeneration,accept,...(text!==undefined && {text})});
      await assert.rejects(answer({...one,dialogId:two.dialogId},true),/dialog_not_found/);
      await Promise.all([answer(one,false),answer(two,true)]);
      await assert.rejects(answer(one,true),/dialog_not_found/);
      assert.match((await a.observe()).text,/cancelled/);
      assert.match((await b.observe()).text,/saved/);
      const alert=await trigger(a,'Notice');assert.equal(alert.type,'alert');await answer(alert,true);
      assert.match((await a.observe()).text,/read/);
      const prompt=await trigger(b,'Label');assert.equal(prompt.type,'prompt');await answer(prompt,true,'hello');
      assert.match((await b.observe()).text,/hello/);
      const handoff=await trigger(a,'Save');
      await service.hostCall('takeControl',a.page);
      const w=await cli('getWorkspace',a.page);
      await assert.rejects(answer({...handoff,controlGeneration:w.controlGeneration},true),/workspace_under_user_control/);
      await service.hostCall('respondDialog',{...a.page,dialogId:handoff.dialogId,controlGeneration:w.controlGeneration,accept:false});
      await service.hostCall('returnToAgent',a.page);
      assert.match((await a.observe()).text,/cancelled/);
      return {dialogs:5,unexpectedWrites:0};
    }},1);
    assert.notEqual(process.exitCode,1);
  } finally {site.closeAllConnections();await new Promise(resolve=>site.close(resolve));}
});
