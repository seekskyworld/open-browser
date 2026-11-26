import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { BrowserService } from './engine-service.mjs';
import { launchBrowser } from './control.mjs';

test('local SSO redirects, conditional OTP and SPA result confirmation', async t => {
  const servers = [];
  async function serve(handler) {
    const server = createServer(handler);
    server.listen(0,'127.0.0.1');
    servers.push(server);
    await once(server,'listening');
    return 'http://127.0.0.1:' + server.address().port;
  }
  const otp = '723519', submissions = [];
  const idp = await serve(async (req,res) => {
    if (req.method === 'POST') {
      let body = '';
      for await (const block of req) body += block;
      submissions.push(new URLSearchParams(body).get('otp'));
      if (submissions.at(-1) === otp) return res.writeHead(303,{location:site + '/account'}).end();
    }
    res.writeHead(200,{'content-type':'text/html'}).end('<form method="post"><label>Code<input name="otp"></label><button>Verify</button></form>');
  });
  const site = await serve((req,res) => {
    if (req.url === '/start') return res.writeHead(302,{location:idp + '/authorize'}).end();
    res.writeHead(200,{'content-type':'text/html'}).end('<h1>Welcome</h1><button onclick="history.pushState({},\'\',\'/receipt\'); document.querySelector(\'h1\').textContent=\'Receipt\'">Continue</button>');
  });
  const browser = await launchBrowser();
  const service = new BrowserService(browser);
  t.after(async () => {
    await service.shutdown();
    await browser.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  });
  const call = (method,args) => service.call(method,args,'local');
  const {workspaceId} = await call('createWorkspace',{name:'测试任务',allowedOrigins:[site,idp]});
  const page = await call('openPage',{workspaceId,url:site + '/start'});
  const snapshot = await call('observe',page);
  async function submit(s,actions) {
    const operationId = randomUUID();
    const params = {...page,documentId:s.documentId,controlGeneration:s.controlGeneration,operationId,actions,observeAfter:'delta'};
    let receipt = await call('act',params);
    for (let i=0;i<150 && ['running','queued'].includes(receipt.state);i++) {
      await delay(50); receipt = await call('getOperation',{workspaceId,operationId});
    }
    return receipt;
  }
  const fill = {kind:'fillCredential',ref:snapshot.elements.find(e=>e.role==='textbox').ref,credentialRef:'otp'};
  assert.equal((await submit(snapshot,[fill])).error,'credential_required');
  const requested = (await call('getWorkspace',{workspaceId})).activity.credentialRequest;
  assert.equal(requested.origin,idp);
  await call('resolveCredential',{workspaceId,...requested,value:otp});
  const confirmation = await submit(snapshot,[fill,{kind:'click',ref:snapshot.elements.find(e=>e.role==='button').ref},
    {kind:'wait',url:site+'/account'},{kind:'wait',element:{role:'heading',name:'Welcome'}}]);
  assert.equal(confirmation.state,'completed',JSON.stringify(confirmation));
  assert.equal(confirmation.observation.text.includes('Welcome'),true);
  assert.deepEqual(submissions,[otp]);
  const after = await submit(confirmation.observation,[{kind:'click',ref:confirmation.observation.elements.find(e=>e.role==='button').ref},
    {kind:'wait',text:'Receipt'}]);
  assert.equal(after.state,'completed',JSON.stringify(after));
  assert.match(JSON.stringify(after),/Receipt/);
  assert.ok(!JSON.stringify(await call('listOperations',{workspaceId})).includes(otp));
});
