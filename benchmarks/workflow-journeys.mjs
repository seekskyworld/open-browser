import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import exportTemplate from '../skills/open-browser/workflows/login-export.json' with {type:'json'};
import uploadTemplate from '../skills/open-browser/workflows/upload-verify.json' with {type:'json'};
import { runTestHarness } from './test-harness.mjs';

const baseline=process.argv.includes('--baseline');
let exportsCount=0, uploadsCount=0, writes=0;
const fileContents='open-browser workflow fixture';
const server=createServer(async (req,res)=>{
  if(req.url==='/sign-in' && req.method==='POST') {
    let data='';for await(const chunk of req) data+=chunk;
    const valid=data==='test-password';
    if(valid) res.setHeader('set-cookie','session=example; HttpOnly; SameSite=Strict; Path=/');
    res.writeHead(valid?200:401).end();return;
  }
  if(req.url==='/export') {
    if(!req.headers.cookie?.includes('session=example')) {res.writeHead(403).end();return;}
    exportsCount++;
    res.writeHead(200,{'content-disposition':'attachment; filename="report.txt"','content-type':'text/plain'}).end('test-report');
    return;
  }
  if(req.url==='/put' && req.method==='POST') {
    let data='';for await(const chunk of req) data+=chunk;
    const valid=data===fileContents;
    if(valid) uploadsCount++;
    res.writeHead(valid?201:400).end();return;
  }
  if(req.url==='/write') {writes++;res.end();return;}
  const content={
    '/account': `<label>Password<input type="password" id="pass"></label><button onclick="login()">Sign in</button>
      <a hidden href="/export">Export report</a><script>async function login(){
      if((await fetch('/sign-in',{method:'POST',body:pass.value})).ok) document.querySelector('a').hidden=false;
      }</script>`,
    '/upload': `<button onclick="choose.click()">Upload attachment</button><input id="choose" hidden type="file">
      <input id="ack" aria-label="Verified" type="checkbox"><script>choose.onchange=async()=>{
      ack.checked=(await fetch('/put',{method:'POST',body:choose.files[0]})).ok;};</script>`,
    '/redirect': '<a href="http://localhost:'+server.address().port+'/changed">Switch</a>',
    '/ambiguous': '<button onclick="fetch(\'/write\')">Save</button><button onclick="fetch(\'/write\')">Save</button>',
    '/changed': '<button onclick="fetch(\'/write\')">Archive</button>',
    '/handoff': '<button onclick="document.querySelector(\'output\').value=\'Started\'">Start</button><output></output><button onclick="fetch(\'/write\')">Save</button>',
  };
  res.writeHead(200,{'content-type':'text/html'}).end(content[req.url] || '');
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin='http://127.0.0.1:'+server.address().port;
const bind=(name)=>({role:'button',name});
async function finish(cli,page,operationId,receipt) {
  for(let i=0;i<100 && ['queued','running'].includes(receipt.state);i++) {
    await delay(40);receipt=await cli('getOperation',{workspaceId:page.workspaceId,operationId});
  }
  return receipt;
}
function params(page,view,steps,bindings={}) {
  return {...page,operationId:randomUUID(),documentId:view.documentId,controlGeneration:view.controlGeneration,
    workflow:{version:1,origin,steps},bindings};
}
try {
  await runTestHarness({
    async account({open,cli,service}) {
      const session=await open(origin+'/account'),page=session.page;
      const view=await session.observe(), start=exportsCount;
      await service.hostCall('setCredential',{workspaceId:page.workspaceId,origin,credentialRef:'session-pass',value:'test-password'});
      const request=params(page,view,exportTemplate.steps,{password:'session-pass'});
      if(baseline) {
        await assert.rejects(cli('runWorkflow',request),/UNKNOWN_METHOD/);
        const submit=view.elements.find(e=>e.name==='Sign in');
        await session.act(view,[{kind:'fillCredential',ref:view.elements.find(e=>e.name==='Password').ref,credentialRef:'session-pass'},
          {kind:'click',ref:submit.ref},{kind:'wait',element:{role:'link',name:'Export report'}}]);
        const fresh=await session.observe();
        await session.act(fresh,[{kind:'click',ref:fresh.elements.find(e=>e.name==='Export report').ref}]);
      } else {
        const r=await finish(cli,page,request.operationId,await cli('runWorkflow',request));
        assert.equal(r.state,'completed',r.error);
        assert.equal(r.completedSteps,4);
        assert.equal((await cli('runWorkflow',request)).state,'completed');
      }
      assert.equal(exportsCount-start,1);
      const files=await cli('listDownloads',{workspaceId:page.workspaceId});
      assert.ok(files.some(f=>f.filename==='report.txt'));
      return {workflow:!baseline,exports:1,logicalSubmissions:baseline?2:1};
    },
    async upload({open,cli,service}) {
      const session=await open(origin+'/upload'),page=session.page,start=uploadsCount;
      const view=await session.observe();
      const grant=await service.hostCall('grantUpload',{...page,origin,documentId:view.documentId,
        controlGeneration:view.controlGeneration,name:'fixture.txt',data:Buffer.from(fileContents).toString('base64')});
      const request=params(page,view,uploadTemplate.steps,{attachment:grant.fileId});
      if(baseline) {
        await assert.rejects(cli('runWorkflow',request),/UNKNOWN_METHOD/);
        await session.act(view,[{kind:'upload',ref:view.elements.find(e=>e.name==='Upload attachment').ref,fileId:grant.fileId},
          {kind:'wait',element:{role:'checkbox',name:'Verified',checked:true}}]);
      } else {
        const result=await finish(cli,page,request.operationId,await cli('runWorkflow',request));
        assert.equal(result.state,'completed',result.error);
        assert.equal(result.completedSteps,2);
      }
      assert.equal(uploadsCount-start,1);
      return {workflow:!baseline,payloadVerified:true};
    },
    async stops({open,cli,service}) {
      if(baseline) return {workflow:false};
      const start=writes;
      for(const [route,code] of [['/ambiguous','target_ambiguous'],['/changed','target_missing']]) {
        const s=await open(origin+route);
        const request=params(s.page,await s.observe(),[{kind:'click',target:bind('Save')}]);
        const receipt=await finish(cli,s.page,request.operationId,await cli('runWorkflow',request));
        assert.equal(receipt.error,code);assert.equal(receipt.completedSteps,0);
      }
      const secondOrigin='http://localhost:'+server.address().port;
      const extra=await cli('createWorkspace',{name:'Workflow origins',agentName:'workflow-eval',allowedOrigins:[origin,secondOrigin]});
      try {
        const page=await cli('openPage',{workspaceId:extra.workspaceId,url:origin+'/redirect'});
        const req=params(page,await cli('observe',page),[
          {kind:'click',target:{role:'link',name:'Switch'}},
          {kind:'click',target:bind('Archive')}]);
        const result=await finish(cli,page,req.operationId,await cli('runWorkflow',req));
        assert.equal(result.error,'workflow_origin_changed');
        assert.equal(result.completedSteps,1);
      } finally {await cli('closeWorkspace',{workspaceId:extra.workspaceId});}
      const s=await open(origin+'/handoff'),view=await s.observe();
      const request=params(s.page,view,[{kind:'click',target:bind('Start')},
        {kind:'expect',target:bind('Ready'),timeoutMs:5000},{kind:'click',target:bind('Save')}]);
      await cli('runWorkflow',request);
      let receipt;
      for(let i=0;i<60;i++){
        receipt=await cli('getOperation',{workspaceId:s.page.workspaceId,operationId:request.operationId});
        if(receipt.completedSteps===1) break;await delay(20);
      }
      assert.equal(receipt.completedSteps,1);
      await cli('handOff',{workspaceId:s.page.workspaceId});
      receipt=await finish(cli,s.page,request.operationId,receipt);
      await service.hostCall('returnToAgent',{workspaceId:s.page.workspaceId});
      assert.equal(receipt.state,'cancelled');
      assert.equal(writes,start);
      return {ambiguousWrites:0,missingWrites:0,crossOriginWrites:0,writesAfterHandoff:0};
    }
  });
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
