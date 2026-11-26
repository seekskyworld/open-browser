import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { runTestHarness } from './test-harness.mjs';

const baseline = process.argv.includes('--baseline');
const pick = process.env.OPEN_BROWSER_CASE;
const html = {
  waits: `<button onclick="this.hidden=true;document.querySelector('input').checked=true">Apply</button>
    <input type="checkbox" aria-label="Applied"><button onclick="history.pushState({},'', '/spa')">Route</button>
    <button onclick="setTimeout(()=>location.assign('/late-headers'),50)">Slow response</button>
    <button onclick="location.assign('/committed')">Navigate</button>`,
  foreground: `<button onclick="out.value='wrong-background'">Confirm</button>
    <dialog id="box" aria-labelledby="title"><h2 id="title">Approve</h2>
      <button onclick="box.close();out.value='confirmed-dialog'">Confirm</button></dialog>
    <output id="out"></output><script>box.showModal()</script>`,
  locator: `<div id="rows"><section aria-label="Order A"><button onclick="output.textContent+='A'">Save</button></section>
    <section aria-label="Order B"><button onclick="output.textContent+='B'">Save</button></section></div>
    <button onclick="rows.prepend(rows.lastElementChild)">Reorder</button><output id="output">writes=</output>`,
  state: `<label><input id="box" type="checkbox" onclick="out.value=Number(out.value)+1">Notify</label>
    <output id="out">0</output><input aria-label="Mixed" type="checkbox" id="tri">
    <button aria-pressed="true" aria-expanded="false">Filters</button>
    <div role="tab" aria-selected="true" aria-label="First"></div>
    <script>tri.indeterminate=true</script>`,
};
const server = createServer((req, res) => {
  if(req.url==='/late-headers') {setTimeout(()=>res.writeHead(200).end('late'),1200);return;}
  if(req.url==='/committed') {res.writeHead(200,{'content-type':'text/html'}).end('<img src="/late-resource">Ready');return;}
  if(req.url==='/late-resource') {setTimeout(()=>res.writeHead(204).end(),1500);return;}
  res.writeHead(200, {'content-type':'text/html'}).end(html[req.url.slice(1)] || '');
});
server.listen(0,'127.0.0.1');
await once(server,'listening');
const origin = 'http://127.0.0.1:'+server.address().port;
const cases = {
  async waits({open,cli}) {
    const session=await open(origin+'/waits');
    const view=await session.observe();
    const find=(v,name)=>({kind:'click',ref:v.elements.find(e=>e.name===name).ref});
    const gone={kind:'wait',absent:{role:'button',name:'Apply'}};
    const checked={kind:'wait',element:{role:'checkbox',name:'Applied',checked:true}};
    if(baseline) {
      await assert.rejects(session.act(view,[gone]),/invalid_actions/);
      await assert.rejects(session.act(view,[{kind:'wait',navigation:'commit'}]),/invalid_actions/);
      const wrong=await perform(cli,session.page,view,[{...checked,timeoutMs:150}]);
      assert.equal(wrong.state,'completed'); // old API silently ignored checked:true
      return {absence:false,navigation:false,wrongStateAccepted:true};
    }
    const before=await perform(cli,session.page,view,[{...checked,timeoutMs:150}]);
    assert.equal(before.error,'wait_timeout');
    await session.act(view,[find(view,'Apply'),gone,checked]);
    const navigate=async(name,expected)=>{
      const sess=await open(origin+'/waits');
      const v=await sess.observe();
      const result=await perform(cli,sess.page,v,[find(v,name),{kind:'wait',navigation:'commit',timeoutMs:600}]);
      assert.equal(result.navigation,expected);
      assert.equal(result.state,expected==='not_committed'?'failed':'completed');
    };
    await navigate('Slow response','not_committed');
    await navigate('Navigate','document_committed');
    await navigate('Route','same_document');
    return {wrongStateAccepted:false,absence:true,navigation:['not_committed','document_committed','same_document']};
  },
  async foreground({open}) {
    const session=await open(origin+'/foreground');
    const view=await session.observe();
    const buttons=view.elements.filter(e=>e.name==='Confirm');
    if(baseline) {
      assert.equal(buttons.length,2);
      return {confirmRefs:2,foreground:false};
    }
    assert.equal(view.foreground.name,'Approve');
    assert.ok(view.foreground.bounds.width>0);
    assert.equal(buttons.length,1);
    await session.act(view,[{kind:'click',ref:buttons[0].ref}]);
    const after=await session.observe();
    assert.match(after.text,/confirmed-dialog/);
    assert.equal(after.foreground,undefined);
    assert.equal(after.elements.filter(e=>e.name==='Confirm').length,1);
    return {confirmRefs:1,backgroundWrites:0,restoredBackground:true};
  },
  async locator({open,cli}) {
    const session=await open(origin+'/locator');
    const locate=(within)=>cli('observe',{...session.page,locator:{role:'button',name:'Save',within}});
    const ambiguous=await locate();
    if(baseline) {
      assert.equal(ambiguous.elements.filter(e=>e.name==='Save').length,2);
      assert.equal(ambiguous.match,undefined);
      return {candidates:2,scopeHonored:false};
    }
    assert.equal(ambiguous.match.status,'ambiguous');
    assert.deepEqual(ambiguous.match.candidates.map(e=>e.within.name),['Order A','Order B']);
    assert.equal(ambiguous.elements.length,0);
    assert.equal((await locate({role:'region',name:'Missing'})).match.status,'missing');
    const initial=await session.observe();
    await session.act(initial,[{kind:'click',ref:initial.elements.find(e=>e.name==='Reorder').ref}]);
    const target=await locate({role:'region',name:'Order B'});
    assert.equal(target.match.status,'unique');
    await session.act(target,[{kind:'click',ref:target.elements[0].ref}]);
    assert.match((await session.observe()).text,/writes=B$/);
    return {ambiguousRefs:0,missingRefs:0,reorderedTarget:'B',writes:1};
  },
  async state({open, cli}) {
    const session = await open(origin+'/state');
    const view = await session.observe();
    const box = view.elements.find(e=>e.name==='Notify');
    if (baseline) {
      assert.equal(box.checked,undefined);
      await assert.rejects(session.act(view,[{kind:'setChecked',ref:box.ref,checked:true}]),/invalid_actions/);
      return {stateObservable:false,targetAction:false};
    }
    assert.equal(box.checked,false);
    assert.equal(view.elements.find(e=>e.name==='Mixed').checked,'mixed');
    assert.equal(view.elements.find(e=>e.name==='Filters').pressed,true);
    assert.equal(view.elements.find(e=>e.name==='Filters').expanded,false);
    assert.equal(view.elements.find(e=>e.name==='First').selected,true);
    const action = {kind:'setChecked',ref:box.ref,checked:true};
    const receipt=await perform(cli,session.page,view,[action],'delta');
    assert.equal(receipt.delta.changed.find(e=>e.ref===box.ref).checked,true);
    await session.act(view,[action]);
    const result=await session.observe();
    assert.equal(result.elements.find(e=>e.name==='Notify').checked,true);
    assert.match(result.text,/\b1\b/);
    return {stateObservable:true,clicksForTwoRequests:1,mixed:true,delta:true};
  },
};
async function perform(cli,page,view,actions,observeAfter) {
  const operationId=randomUUID();
  let receipt=await cli('act',{...page,documentId:view.documentId,controlGeneration:view.controlGeneration,operationId,actions,observeAfter});
  const deadline=Date.now()+15000;
  while (['queued','running'].includes(receipt.state) && Date.now()<deadline) {
    await delay(10);
    receipt=await cli('getOperation',{workspaceId:page.workspaceId,operationId});
  }
  return receipt;
}
try {
  const order=pick ? [pick] : ['state','locator','foreground','waits'];
  await runTestHarness(Object.fromEntries(order.map(name=>[name,cases[name]])));
} finally {
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
}
