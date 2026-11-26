// Measures latency to first observation with a fresh service and a service already started for the same profile.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const dir=await mkdtemp(path.join(tmpdir(),'open-browser-warm-'));
process.env.OPEN_BROWSER_STATE_DIR=dir;
delete process.env.OPEN_BROWSER_CLIENT_TOKEN_FILE;
const site=createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'}).end('<p>Warm fixture</p>'));
site.listen(0,'127.0.0.1');await once(site,'listening');
const {OpenBrowserClient}=await import('../sdk.mjs');
const api=new OpenBrowserClient();
try {
  for(let round=1;round<=3;round++){
    for(const policy of (round%2 ? ['cold','warm'] : ['warm','cold'])){
      const start=performance.now();
      const child=spawn(process.execPath,['service.mjs','--chromium','--headless'],{stdio:['ignore','pipe','inherit']});
      const closed=once(child,'close');
      try {
        let ready=false;
        for await(const chunk of child.stdout){if(String(chunk).includes('open-browser ready')){ready=true;break;}}
        assert.ok(ready);
        const started=performance.now();
        const {stdout}=await execute('ps',['-axo','pid=,ppid=,rss=']);
        const rows=stdout.trim().split('\n').map(l=>l.trim().split(/\s+/).map(Number));
        const ids=new Set([child.pid]);for(let before=-1;before!==ids.size;){before=ids.size;for(const [pid,ppid] of rows)if(ids.has(ppid))ids.add(pid);}
        const idleMiB=Math.round(rows.reduce((n,[pid,,rss])=>n+(ids.has(pid)?rss:0),0)/1024);
        const issued=performance.now();
        const ws=await api.createWorkspace({name:'startup measurement'});
        const page=await api.openPage(ws.workspaceId,'http://127.0.0.1:'+site.address().port);
        assert.match((await api.observe(page)).text,/Warm fixture/);
        const finished=performance.now();
        console.log(JSON.stringify({round,policy,preparationMs:Math.round(started-start),
          firstObservationMs:Math.round(finished-issued+(policy==='cold'?started-start:0)),idleMiB}));
        await api.finishWorkspace(ws.workspaceId,[],'finish');
      }finally{child.kill('SIGTERM');await closed;}
    }
  }
} finally {site.closeAllConnections();site.close();await rm(dir,{recursive:true,force:true,maxRetries:4});}
