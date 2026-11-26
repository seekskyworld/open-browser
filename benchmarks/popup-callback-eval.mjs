import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startProfile, act } from './recovery-eval.mjs';

const modes=['valid','wrongTarget','wrongSource','expired','handoff'];
const received=new Map(), providers=new Map(), pending=new Map();
let siteOrigin, providerOrigin;
const state=await mkdtemp(path.join(tmpdir(),'open-browser-opener-'));
const site=createServer((req,res)=>{
  const url=new URL(req.url,siteOrigin),mode=url.searchParams.get('case');
  if(url.pathname==='/accepted'){
    received.set(mode,(received.get(mode)||0)+1);
    return res.end('ok');
  }
  const provider=JSON.stringify(providerOrigin+'/?case='+mode);
  const wrong=mode==='wrongSource',expired=mode==='expired';
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(`<button>Sign in</button><p id="result">Waiting</p>
    <script>let auth,expires;document.querySelector('button').onclick=()=>{
      auth=window.open('');expires=Date.now()+${expired?-1000:10000};
      if(auth)auth.location=${provider};
    };
    addEventListener('message',async e=>{
      if(e.origin!==${JSON.stringify(providerOrigin)}||e.source!==${wrong?'window':'auth'}||e.data!=='fixture-complete'||Date.now()>expires)return;
      await fetch('/accepted?case=${mode}',{method:'POST'});document.querySelector('#result').textContent='Signed in';
    });</script>`);
});
const provider=createServer((req,res)=>{
  const url=new URL(req.url,providerOrigin), mode=url.searchParams.get('case');
  if(url.pathname==='/attempt'){
    providers.set(mode,url.searchParams.get('opener'));
    return res.end('recorded');
  }
  if(url.pathname==='/release') {pending.set(mode,res);return;}
  const target=mode==='wrongTarget'?providerOrigin:siteOrigin;
  res.writeHead(200,{'content-type':'text/html'}).end(`<p>Provider</p><script>(async()=>{
    await fetch('/attempt?case=${mode}&opener='+Boolean(window.opener));
    ${mode==='handoff'?"await fetch('/release?case=handoff');":''}
    if(window.opener){window.opener.postMessage('fixture-complete',${JSON.stringify(target)});window.close();}
  })();</script>`);
});
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;}
let app;
try {
  siteOrigin=await listen(site);providerOrigin=await listen(provider);
  const candidate=process.argv.includes('--candidate');
  app=await startProfile('callback',state,candidate?['--blank-candidate']:[]);
  // Confirm the two fixture origins can complete a real WindowProxy flow in the same Chromium.
  await app.host('fixture.nativeCallback',{url:siteOrigin+'/?case=valid'});
  assert.equal(received.get('valid'),1);
  providers.clear();received.clear();
  const rows=[];
  for(const mode of modes) {
    const w=await app.cli('createWorkspace',{name:'登录窗口',agentName:'callback-eval',allowedOrigins:[siteOrigin,providerOrigin]});
    const scope={workspaceId:w.workspaceId};
    const p=await app.cli('openPage',{...scope,url:siteOrigin+'/?case='+mode});
    await act(app.cli,p,view=>[{kind:'click',ref:view.elements.find(el=>el.name==='Sign in').ref}]);
    if(candidate)for(let i=0;i<40&&!providers.has(mode);i++)await delay(25);
    if(mode==='handoff'){
      await app.cli('handOff',scope);
      if(candidate)for(let i=0;i<40&&!pending.has(mode);i++)await delay(25);
      pending.get(mode)?.end('continue');
    }
    await delay(100);
    const detail=await app.cli('getWorkspace',scope);
    const row={mode,managedPages:detail.pages.length,providerOpener:providers.get(mode)??null,accepted:received.get(mode)??0};
    assert.equal(row.managedPages,candidate?2:1);assert.equal(row.providerOpener,candidate?'false':null);
    assert.equal(row.accepted,0);rows.push(row);
    await app.host('finishWorkspace',{...scope,operationId:crypto.randomUUID(),keepPageIds:[]});
  }
  console.log(JSON.stringify({nativeReference:1,variant:candidate?'blank-handle':'current',rows}));
} finally {
  for(const res of pending.values())res.end();
  await app?.stop();
  for(const server of [provider,site]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await rm(state,{recursive:true,force:true,maxRetries:6,retryDelay:100});
}
