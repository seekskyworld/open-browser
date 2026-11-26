// Run with --baseline to measure the older API using the same fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function serviceProcess() {
  if(process.argv.includes('--blank-candidate')) await import('./popup-callback-candidate.mjs');
  const {startApplication} = await import('../service.mjs');
  const app = await startApplication({headless:true,mode:'chromium'});
  const session = await app.sharedContext.browser().newBrowserCDPSession();
  const {processInfo} = await session.send('SystemInfo.getProcessInfo');
  await session.detach();
  process.on('message',async ({method, params, key}) => {
    try {
      if(method==='fixture.nativeCallback') {
        const url=new URL(params.url);
        assert.equal(url.hostname,'127.0.0.1');
        const p=await app.sharedContext.newPage();
        try {
          await p.goto(url.href);
          await p.getByRole('button',{name:'Sign in'}).click();
          await p.getByText('Signed in',{exact:true}).waitFor({timeout:5000});
        } finally { await p.close(); }
        process.send({key,result:true});
      } else process.send({key,result:await app.hostCall(method,params)});
    }
    catch(error) { process.send({key,error:error.code || error.message}); }
  });
  app.closed.then(()=>process.disconnect?.());
  console.log(JSON.stringify({ready:processInfo.find(item=>item.type==='browser').id}));
  process.on('SIGTERM',()=>void app.close());
  await app.closed;
}

export async function startProfile(profileId, state, extraArgs=[]) {
  const env = {...process.env, OPEN_BROWSER_STATE_DIR:state, OPEN_BROWSER_PROFILE:profileId, OPEN_BROWSER_USE_SOURCE:'1'};
  delete env.OPEN_BROWSER_CLIENT_TOKEN_FILE;
  const child = spawn(process.execPath,[fileURLToPath(import.meta.url),'--service',...extraArgs],{env,cwd:root,stdio:['ignore','pipe','inherit','ipc']});
  const closed = once(child, 'close');
  const lines = createInterface({input:child.stdout});
  const [line] = await Promise.race([once(lines,'line'), closed.then(()=>{throw Error('service exited during startup');})]);
  const {ready:browserPid} = JSON.parse(line);
  async function cli(method, params={}) {
    const proc = process.platform==='win32'
      ? spawn(process.execPath,[path.join(root,'cli.mjs'),method],{cwd:root,env})
      : spawn(path.join(root,'skills/open-browser/scripts/open-browser'),[method],{cwd:root,env});
    const done = once(proc,'close'), out=[], err=[];
    proc.stdout.on('data',chunk=>out.push(chunk));
    proc.stderr.on('data',chunk=>err.push(chunk));
    proc.stdin.on('error',error=>{if(error.code!=='EPIPE')proc.destroy(error);});
    proc.stdin.end(JSON.stringify(params));
    const [code]=await done;
    if(code) throw Error(Buffer.concat(err).toString());
    return JSON.parse(Buffer.concat(out).toString());
  }
  async function host(method,params={}) {
    const key=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const reply=msg=>{
        if(msg.key!==key)return;
        child.off('message',reply);
        if(msg.error)reject(Error(msg.error));else resolve(msg.result);
      };
      child.on('message',reply);
      child.send({key,method,params});
    });
  }
  return {cli, host, async stop(target='graceful') {
    if (target==='browser') process.kill(browserPid,'SIGKILL');
    else child.kill(target==='service'?'SIGKILL':'SIGTERM');
    await closed;
  }};
}

export async function act(cli, page, actions, submitOnly=false) {
  const view = await cli('observe',page);
  const operationId = crypto.randomUUID();
  const args={...page,operationId,documentId:view.documentId,controlGeneration:view.controlGeneration,
    actions:actions(view)};
  let receipt=await cli('act',args);
  for(let n=0;!submitOnly && n<130 && ['running','queued'].includes(receipt.state);n++) {
    await delay(25);
    receipt=await cli('getOperation',{workspaceId:page.workspaceId,operationId});
  }
  if(!submitOnly) assert.equal(receipt.state,'completed',JSON.stringify(receipt));
  return {receipt,args};
}

async function evaluate() {
  const state = await mkdtemp(path.join(tmpdir(),'open-browser-recovery-'));
  let service, commits=0;
  const clicked=Promise.withResolvers();
  const site=createServer((req,res)=>{
    if(req.url==='/commit') {
      commits++;
      clicked.resolve();
      res.writeHead(200,{'content-type':'text/plain'}).end('committed');
      return;
    }
    res.writeHead(200,{'content-type':'text/html'}).end('<button>Ready</button><button onclick="const xhr=new XMLHttpRequest();xhr.open(\'POST\',\'/commit\',false);xhr.send();const until=performance.now()+1500;while(performance.now()<until){}">Commit</button>');
  });
  await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+site.address().port;
  try {
    service=await startProfile('recovery',state);
    const ws=await service.cli('createWorkspace',{name:'恢复复核',agentName:'recovery-eval'});
    const scope={workspaceId:ws.workspaceId};
    const page=await service.cli('openPage',{...scope,url:origin});
    const click=name=>v=>[{kind:'click',ref:v.elements.find(e=>e.name===name).ref}];
    const known=await act(service.cli,page,click('Ready'));
    const baseline=process.argv.includes('--baseline');
    if(baseline) await assert.rejects(service.cli('getRecoverySummary',scope),/UNKNOWN_METHOD/);
    else {
      const summary=await service.cli('getRecoverySummary',scope);
      assert.deepEqual(summary.pages,[{pageId:page.pageId,next:'observe'}]);
      assert.equal(summary.operations.find(row=>row.operationId===known.args.operationId).next,'already_completed');
    }
    const inFlight=await act(service.cli,page,click('Commit'),true);
    await clicked.promise;
    await service.stop('service');service=undefined;
    service=await startProfile('recovery',state);
    const receipt=await service.cli('act',inFlight.args);
    assert.equal(receipt.state,'outcome_unknown',JSON.stringify(receipt));
    assert.equal(commits,1);
    const summary=baseline?null:await service.cli('getRecoverySummary',scope);
    if(summary) {
      assert.equal(summary.mode,'unavailable');
      assert.equal(summary.pages[0].next,'handle_unavailable');
      assert.equal(summary.operations.find(row=>row.operationId===inFlight.args.operationId).next,'verify_site');
    }
    const fresh=await service.cli('createWorkspace',{name:'浏览器恢复',agentName:'recovery-eval'});
    const livePage=await service.cli('openPage',{workspaceId:fresh.workspaceId,url:origin});
    const done=await act(service.cli,livePage,click('Ready'));
    await service.stop('browser');service=undefined;
    service=await startProfile('recovery',state);
    const replay=await service.cli('act',done.args);
    assert.equal(replay.state,'completed');
    if(!baseline) {
      const after=await service.cli('getRecoverySummary',{workspaceId:fresh.workspaceId});
      assert.equal(after.pages[0].next,'handle_unavailable');
      assert.equal(after.operations[0].next,'already_completed');
    }
    console.log(JSON.stringify({summary:!baseline,known:replay.state,uncertain:receipt.state,siteCommits:commits,
      priorPage:summary?.pages[0].next??null,afterDispatch:summary?.operations.find(x=>x.operationId===inFlight.args.operationId).next??null}));
  } finally {
    await service?.stop();
    site.closeAllConnections();await new Promise(resolve=>site.close(resolve));
    await rm(state,{recursive:true,force:true,maxRetries:6,retryDelay:100});
  }
}
if (process.argv[1]===fileURLToPath(import.meta.url)) {
  if(process.argv.includes('--service')) await serviceProcess();
  else await evaluate();
}
