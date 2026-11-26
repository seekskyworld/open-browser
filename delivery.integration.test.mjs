import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

test('paired Skill clients deliver the human-edited result once and read redacted receipts after restart', async t => {
  const dir = await mkdtemp(path.join(tmpdir(),'ob-delivery-'));
  process.env.OPEN_BROWSER_STATE_DIR = dir;
  const packaged = process.env.OPEN_BROWSER_QA_APP;
  const entry = file => packaged ? pathToFileURL(path.join(packaged,file)).href : new URL(file,import.meta.url).href;
  const { startApplication } = await import(entry('service.mjs'));
  const { extensionId } = await import(entry('chromium-host.mjs'));
  const baseEnv = {...process.env, OPEN_BROWSER_USE_SOURCE:'1'};
  delete baseEnv.OPEN_BROWSER_CLIENT_TOKEN_FILE;
  async function cli(method, params = {}, client) {
    const child = spawn(packaged ? process.execPath : 'skills/open-browser/scripts/open-browser',
      packaged ? [path.join(packaged,'cli.mjs'),method] : [method],{env:{...baseEnv,
      ...(client && {OPEN_BROWSER_CLIENT_TOKEN_FILE:path.join(dir,client)})}});
    const out = [], err = [];
    const exit = once(child,'close');
    child.stdout.on('data',chunk => out.push(chunk));
    child.stderr.on('data',chunk => err.push(chunk));
    child.stdin.end(JSON.stringify(params));
    if ((await exit)[0]) {
      const detail = JSON.parse(Buffer.concat(err).toString()).error;
      throw Object.assign(new Error(detail.message),{code:detail.code});
    }
    return JSON.parse(Buffer.concat(out).toString());
  }
  let app;
  const posted = [];
  const site = createServer(async (req,res) => {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      posted.push(new URLSearchParams(body).get('draft'));
      res.end('<h1>accepted-result-marker</h1>');
    } else res.end('<form method="post"><label>Draft <input name="draft"></label><button>Send</button></form>');
  });
  t.after(async () => {
    await app?.close();
    site.closeAllConnections();
    await new Promise(resolve => site.close(resolve));
    await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:300});
  });
  site.listen(0,'127.0.0.1');
  await once(site,'listening');
  const url = 'http://127.0.0.1:' + site.address().port;
  const start = () => startApplication({headless:true,mode:'chromium'});
  const pair = name => cli('admin.pair',{name,tokenFile:path.join(dir,name)});
  app = await start();
  const a = await pair('alpha'), b = await pair('bravo');
  const work = await cli('createWorkspace',{name:'测试任务',agentName:'delivery'},'alpha');
  const ws = {workspaceId:work.workspaceId};
  const page = await cli('openPage',{...ws,url},'alpha');
  await cli('openPage',{...ws,url:url + '/working'},'alpha');
  assert.deepEqual(await cli('listWorkspaces',{},'bravo'),[]);
  await assert.rejects(cli('observe',page,'bravo'),{code:'workspace_not_found'});
  const delegate = {principalId:b.principalId,...ws};
  await cli('admin.grant',{...delegate,permission:'read'});
  await cli('observe',page,'bravo');
  await assert.rejects(cli('handOff',ws,'bravo'),{code:'forbidden'});
  await cli('admin.grant',{...delegate,permission:'control'});
  const snap = await cli('observe',page,'bravo');
  async function act(snapshot, operationId, actions, client) {
    const params = {...page,documentId:snapshot.documentId,controlGeneration:snapshot.controlGeneration,operationId,actions};
    let receipt = await cli('act',params,client);
    for (let i=0;i<80 && ['queued','running'].includes(receipt.state);i++) {
      await delay(50);
      receipt = await cli('getOperation',{...ws,operationId},client);
    }
    assert.equal(receipt.state,'completed',JSON.stringify(receipt));
    return params;
  }
  const ref = (s,role) => s.elements.find(e => e.role === role).ref;
  await act(snap,'draft',[{kind:'fill',ref:ref(snap,'textbox'),value:'agent-draft-marker'}],'bravo');
  await cli('admin.revoke',delegate);
  assert.equal((await cli('getWorkspace',ws,'alpha')).mode,'human');
  await assert.rejects(cli('observe',page,'bravo'),{code:'workspace_not_found'});
  const live = app.sharedContext.pages().find(p => p.url() === url + '/');
  await live.getByRole('textbox').fill('human-correction-marker');
  const popup = await app.sharedContext.newPage();
  await popup.goto('chrome-extension://' + extensionId + '/popup.html');
  await popup.getByRole('button',{name:'交回 Agent'}).click();
  const fresh = await cli('observe',page,'alpha');
  assert.notEqual(fresh.controlGeneration,snap.controlGeneration);
  const submit = await act(fresh,'submit-once',[{kind:'click',ref:ref(fresh,'button')}],'alpha');
  await cli('act',submit,'alpha');
  assert.deepEqual(posted,['human-correction-marker']);
  await live.getByRole('heading',{name:'accepted-result-marker'}).waitFor();
  const finish = {...ws,operationId:'deliver',keepPageIds:[page.pageId]};
  const delivered = await cli('finishWorkspace',finish,'alpha');
  assert.deepEqual(delivered.keptPageIds,[page.pageId]);
  assert.equal(delivered.closedPageIds.length,1);
  assert.equal(live.isClosed(),false);
  await assert.rejects(cli('observe',page,'alpha'),{code:'workspace_not_found'});
  assert.equal(await live.getByRole('heading').innerText(),'accepted-result-marker');
  await app.close();
  app = await start();
  assert.deepEqual(await cli('finishWorkspace',finish,'alpha'),delivered);
  const rows = await cli('listOperations',ws,'alpha');
  assert.equal(rows.operations.length,3);
  const history = await cli('listEvents',ws,'alpha');
  assert.ok(history.events.some(row => row.actorId === b.principalId));
  assert.deepEqual((await cli('listEvents',{...ws,after:history.nextCursor},'alpha')).events,[]);
  assert.doesNotMatch(JSON.stringify([rows,history]),/agent-draft-marker|human-correction-marker|accepted-result-marker/);
  await cli('admin.clearHistory',ws);
  await assert.rejects(cli('getOperation',{...ws,operationId:'deliver'},'alpha'),{code:'workspace_not_found'});
  await cli('admin.revokeClient',{principalId:a.principalId});
  await assert.rejects(cli('listWorkspaces',{},'alpha'),{code:'forbidden'});
});
