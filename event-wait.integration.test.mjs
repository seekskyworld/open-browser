import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {runTestHarness} from './benchmarks/test-harness.mjs';

test('page event cursors cover immediate and delayed events across CLI processes', async () => {
  let opened=0;
  const site=createServer((req,res)=>{
    res.setHeader('Content-Type','text/html');
    if(req.url==='/child'){ opened++;return res.end('<p>Child</p>'); }
    res.end(`<button onclick="window.open('/child')">Immediate</button>
      <button onclick="setTimeout(()=>window.open('/child'),500)">Delayed</button>`);
  });
  site.listen(0,'127.0.0.1');await once(site,'listening');
  try {
    await runTestHarness({async taskEvents({open,cli}) {
      const url='http://127.0.0.1:'+site.address().port;
      const [a,b]=await Promise.all([open(url),open(url)]);
      async function run(target,button){
        const {nextCursor:after}=await cli('eventCursor',target.page);
        const view=await target.observe(), operationId=crypto.randomUUID();
        const params={...target.page,after,kind:'popup',operationId,timeoutMs:3500};
        const wait=cli('waitForEvent',params);
        const op=await cli('act',{...target.page,operationId,documentId:view.documentId,controlGeneration:view.controlGeneration,
          actions:[{kind:'click',ref:view.elements.find(el=>el.name===button).ref}]});
        assert.ok(op.state);
        let event=await wait;
        // An emulated desktop may still be launching the action's CLI when the
        // first poll expires. Resume from that cursor without reissuing the click.
        const deadline=Date.now()+20000;
        while (!event.event && Date.now()<deadline) {
          event=await cli('waitForEvent',{...params,after:event.nextCursor});
        }
        assert.ok(event.event, 'popup event must arrive before the deadline');
        assert.equal(event.event.pageId,target.page.pageId);
        assert.equal(event.event.operationId,operationId);
        const replay=await cli('waitForEvent',params);
        assert.deepEqual(replay,event);
        const ws=await cli('getWorkspace',target.page);
        assert.ok(ws.pages.some(p=>p.pageId===event.event.resourceId && p.openerPageId===target.page.pageId));
        const expired=await cli('waitForEvent',{...params,after:event.nextCursor,timeoutMs:30});
        assert.equal(expired.event,null);
        return event;
      }
      const [one,two]=await Promise.all([run(a,'Immediate'),run(b,'Delayed')]);assert.notEqual(one.event.resourceId,two.event.resourceId);
      assert.equal(opened,2);
      return {matchedEvents:2,receivedPages:opened,duplicateOpens:0};
    }},1);assert.notEqual(process.exitCode,1);
  } finally {site.closeAllConnections();await new Promise(resolve=>site.close(resolve));}
});
