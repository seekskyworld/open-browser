import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {runTestHarness} from './benchmarks/test-harness.mjs';

test('managed login popups follow the originating click across workspaces and control transfers', async () => {
  const hits=[];
  const foreign=createServer((req,res)=>{hits.push(req.url);res.end('unexpected');});
  foreign.listen(0,'127.0.0.1');await once(foreign,'listening');
  const blocked='http://127.0.0.1:'+foreign.address().port;
  const site=createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost'), key=url.pathname.split('/')[1];
    res.setHeader('content-type','text/html;charset=utf-8');
    if(url.pathname.endsWith('/login')) return res.end('<form action="submit" method="post"><label>Account<input name="account"></label><button>Sign in</button></form>');
    if(url.pathname.endsWith('/submit')) {
      const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
        if(req.method!=='POST'||new URLSearchParams(Buffer.concat(chunks).toString()).get('account')!==key){res.writeHead(403).end('Denied');return;}
        res.setHeader('Set-Cookie','session='+key+'; HttpOnly; SameSite=Lax; Path=/'+key+'/');res.end('<h1>Signed in</h1>');
      });return;
    }
    if(url.pathname.endsWith('/private')) return res.end(req.headers.cookie?.includes('session='+key)?'<h1>Private '+key+'</h1>':'Unauthorized');
    res.end('<button onclick="window.open(\'login\');window.open(\'duplicate\')">Immediate</button><button onclick="window.setTimeout(()=>window.open(\'login\'),650)">Delayed</button>'+
      '<button onclick="window.open(\''+blocked+'/denied\');window.open(\'duplicate\')">Foreign</button><a href="private">Account page</a>');
  });
  site.listen(0,'127.0.0.1');await once(site,'listening');
  const base='http://127.0.0.1:'+site.address().port;
  try {
    await runTestHarness({
      async 'login popups through the real CLI'({open,cli,service}) {
        const user=await service.sharedContext.newPage();await user.goto('about:blank');await user.bringToFront();
        await user.evaluate(()=>{window.blurCount=0;addEventListener('blur',()=>window.blurCount++);});
        const [a,b]=await Promise.all([open(base+'/alpha/'),open(base+'/bravo/')]);
        const sent=new Map();
        async function act(p,name,fill) {
          const view=await cli('observe',p),ref=view.elements.find(e=>e.name===name)?.ref;assert.ok(ref,name);
          const operationId=crypto.randomUUID();
          const actions=fill?[{kind:'fill',ref:view.elements.find(e=>e.name==='Account').ref,value:fill}]:[];
          const args={...p,operationId,documentId:view.documentId,controlGeneration:view.controlGeneration,actions:[...actions,{kind:'click',ref}]};
          sent.set(operationId,args);
          let result=await cli('act',args);
          for(let i=0;i<100 && ['queued','running'].includes(result.state);i++){await delay(20);result=await cli('getOperation',{...p,operationId});}
          assert.equal(result.state,'completed',JSON.stringify(result));
          return operationId;
        }
        async function children(p,id) {
          for(let i=0;i<50;i++){
            const {pages}=await cli('getWorkspace',p);
            const matches=pages.filter(item=>item.openerPageId===p.pageId && item.openedByOperationId===id);
            if(matches.length){assert.equal(matches.length,1);return matches[0];}
            await delay(40);
          }
          throw Error('missing popup '+id);
        }
        const ops=await Promise.all([act(a.page,'Immediate'),act(b.page,'Delayed')]);
        const [one,two]=await Promise.all([children(a.page,ops[0]),children(b.page,ops[1])]);
        for(const [p,child,id,key] of [[a.page,one,ops[0],'alpha'],[b.page,two,ops[1],'bravo']]) {
          const recorded=await cli('getOperation',{...p,operationId:id});assert.deepEqual(recorded.openedPageIds,[child.pageId]);
          assert.ok((await cli('observe',child)).text.includes('Sign in'));
          const replay=await cli('act',sent.get(id));
          assert.deepEqual(replay.openedPageIds,[child.pageId]);
          assert.equal((await cli('getWorkspace',p)).pages.length,2);
          await act(child,'Sign in',key);
          await act(p,'Account page');assert.ok((await cli('observe',p)).text.includes('Private '+key));
        }
        assert.equal(await user.evaluate(()=>window.blurCount),0);
        const {workspaceId}=await cli('createWorkspace',{name:'race'});const c={page:await cli('openPage',{workspaceId,url:base+'/race/'})};await act(c.page,'Foreign');await delay(100);
        assert.deepEqual(hits,[]);assert.equal((await cli('getWorkspace',c.page)).pages.length,1);
        assert.ok((await service.hostCall('getWorkspace',c.page)).blockedOrigins.some(item=>item.origin===blocked));
        await act(c.page,'Delayed');await service.hostCall('takeControl',c.page);await delay(850);
        assert.equal((await cli('getWorkspace',c.page)).pages.length,1);
        await service.hostCall('returnToAgent',c.page);
        await act(c.page,'Delayed');await cli('finishWorkspace',{...c.page,operationId:'finish',keepPageIds:[c.page.pageId]});
        await delay(850);assert.equal(service.sharedContext.pages().filter(page=>page.url()===base+'/race/login').length,0);
        return {opened:2,verifiedAuthenticatedOpeners:2,foreignRequests:hits.length};
      }
    },1);
    assert.notEqual(process.exitCode,1);
  } finally {for(const server of [site,foreign]){server.closeAllConnections();await new Promise(r=>server.close(r));}}
});
