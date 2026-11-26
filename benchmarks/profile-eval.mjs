import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startProfile, act } from './recovery-eval.mjs';

const state = await mkdtemp(path.join(tmpdir(),'open-browser-accounts-'));
const profiles=['alpha','bravo'], services=[], accounts=new Map();
const site=createServer(async(req,res)=>{
  const account=accounts.get(req.headers.cookie?.split('ticket=')[1]);
  if(req.url==='/export') {
    res.writeHead(account?200:403,{'Content-Disposition':'attachment; filename="account.txt"'}).end(account);
    return;
  }
  if(req.url==='/login' && req.method==='POST') {
    const body=[];for await(const chunk of req)body.push(chunk);
    const data=new URLSearchParams(Buffer.concat(body).toString()),id=data.get('account');
    if(!profiles.includes(id)||data.get('pin')!=='fixture-'+id){res.writeHead(403).end('Denied');return;}
    const ticket=crypto.randomUUID();accounts.set(ticket,id);
    res.writeHead(303,{Location:'/', 'Set-Cookie':'ticket='+ticket+'; HttpOnly; Path=/; SameSite=Lax'}).end();return;
  }
  res.writeHead(200,{'content-type':'text/html'}).end(account?
    '<h1>Active '+account+'</h1><a href="/export" download>Export</a>':
    '<form method="POST" action="/login"><label>Account<input name="account"></label><label>PIN<input name="pin" type="password"></label><button>Sign in</button></form>');
});
await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+site.address().port;
try {
  for(const id of profiles)services.push(await startProfile(id,state));
  const bad={profileId:'bravo',name:'mismatch',agentName:'profile-eval'};
  await assert.rejects(services[0].cli('createWorkspace',bad),/profile_mismatch/);
  const rows=await Promise.all(services.map(async({cli,host},i)=>{
    const id=profiles[i];
    const ws=await cli('createWorkspace',{profileId:id,name:'账号验收',agentName:'profile-eval'});
    const scope={workspaceId:ws.workspaceId};
    assert.equal(ws.profileId,id);
    await host('setCredential',{...scope,origin,credentialRef:'pin',value:'fixture-'+id});
    const page=await cli('openPage',{...scope,url:origin});
    await act(cli,page,v=>[
      {kind:'fill',ref:v.elements.find(e=>e.name==='Account').ref,value:id},
      {kind:'fillCredential',ref:v.elements.find(e=>e.name==='PIN').ref,credentialRef:'pin'},
      {kind:'click',ref:v.elements.find(e=>e.name==='Sign in').ref},
      {kind:'wait',text:'Active '+id}
    ]);
    await act(cli,page,v=>[{kind:'click',ref:v.elements.find(e=>e.name==='Export').ref}]);
    let download;
    for(let n=0;n<50&&!download;n++){download=(await cli('listDownloads',scope)).find(d=>d.state==='ready');if(!download)await delay(40);}
    assert.ok(download);
    const retained=await host('keepDownload',{...scope,downloadId:download.downloadId});
    assert.equal(await readFile(retained.path,'utf8'),id);
    const handoff=await cli('handOff',scope);assert.equal(handoff.mode,'human');
    assert.equal(handoff.profileId,id);
    const receipt=await host('finishWorkspace',{...scope,operationId:crypto.randomUUID(),keepPageIds:[page.pageId]});
    assert.deepEqual(receipt.keptPageIds,[page.pageId]);
    const recovery=await cli('getRecoverySummary',scope);
    assert.deepEqual(recovery.deliveries,[{downloadId:download.downloadId}]);
    return {profile:ws.profileId??null,verifiedAccount:id,download:download.filename,delivered:receipt.keptPageIds.length};
  }));
  console.log(JSON.stringify({mismatchBlocked:true,rows}));
} finally {
  await Promise.all(services.map(s=>s.stop()));site.closeAllConnections();
  await new Promise(resolve=>site.close(resolve));await rm(state,{recursive:true,force:true,maxRetries:6,retryDelay:100});
}
