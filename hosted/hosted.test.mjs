import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initialize } from './init.mjs';
import { localRequest } from '../sdk.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function waitFor(check, description) {
  const deadline = Date.now() + 15_000;
  do {
    const result = await check();
    if (result) return result;
    await delay(60);
  } while (Date.now() < deadline);
  assert.fail(description);
}
function run(script, args, env) {
  const child = spawn(process.execPath, [path.join(root, script), ...args],
    {env:{...process.env, ...env}, stdio:['ignore', 'pipe', 'pipe']});
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const closed = once(child,'close');
  async function ready() {
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(output);
      return output.includes(' ready');
    }, 'process readiness');
  }
  async function stop(signal = 'SIGTERM') {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    await closed;
  }
  return {ready, stop};
}

test('two tenants, two Chromium nodes, lease fencing, site-side recovery without replay', {timeout:65_000}, async t => {
  const temp = await mkdtemp('/tmp/open-browser-hosted-');
  const home = await initialize(path.join(temp, 'hosted'));
  const configFile = path.join(home, 'config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  // B can use a second node. Its first session should go to the less-loaded B.
  config.nodes[0].tenants.push('tenant-b');
  await writeFile(configFile, JSON.stringify(config));
  const children = [];
  const newNode = suffix => {
    const child = run('service.mjs', ['--headless'], {OPEN_BROWSER_STATE_DIR:path.join(home, 'node-' + suffix), OPEN_BROWSER_PROFILE:'default'});
    children.push(child);
    return child;
  };
  const newCoordinator = () => {
    const child = run('hosted/server.mjs', [home], {});
    children.push(child);
    return child;
  };
  const tickets = new Map(['Alice','Bob'].map(name => [randomBytes(16).toString('hex'), name]));
  const [aliceTicket,bobTicket] = [...tickets.keys()];
  const sessions = new Map();
  const siteDB = new DatabaseSync(path.join(temp,'site.sqlite'));
  siteDB.exec('CREATE TABLE submissions(account TEXT NOT NULL)');
  const submissions = () => siteDB.prepare('SELECT account FROM submissions ORDER BY rowid').all().map(row=>row.account);
  const site = http.createServer((req,res) => {
    const url = new URL(req.url, 'http://localhost');
    const user = sessions.get(req.headers.cookie?.split('=')[1]);
    if (url.pathname === '/login') {
      const ticket = url.searchParams.get('ticket');
      if (!tickets.has(ticket)) { res.writeHead(403).end(); return; }
      const cookie = randomBytes(16).toString('hex');
      sessions.set(cookie,tickets.get(ticket));
      tickets.delete(ticket);
      res.writeHead(303, {location:'/me', 'set-cookie':'sid=' + cookie + '; HttpOnly; SameSite=Strict; Path=/'});
      res.end();
    } else if (url.pathname === '/submit' && req.method === 'POST' && user) {
      siteDB.prepare('INSERT INTO submissions(account) VALUES(?)').run(user);
      // The site has committed. Hold the browser's response until the worker dies.
    } else {
      res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
      res.end('<p>' + (user || 'guest') + '</p><form method="post" action="/submit"><button>Submit</button></form>');
    }
  });
  t.after(async () => {
    await Promise.all(children.map(child => child.stop()));
    site.closeAllConnections();
    await new Promise(resolve => site.close(resolve));
    siteDB.close();
    await rm(temp, {recursive:true, force:true});
  });
  site.listen(0,'127.0.0.1');
  await once(site,'listening');
  const origin = 'http://127.0.0.1:' + site.address().port;
  const nodeA = newNode('a');
  const nodeB = newNode('b');
  await Promise.all([nodeA.ready(), nodeB.ready()]);
  const coordinator = newCoordinator();
  await coordinator.ready();
  const socket = path.join(home,'control.sock');
  const api = (who, method, params = {}, admin = false) => localRequest(socket, path.join(home, who + '.token'), admin ? '/v1/admin' : '/v1/call', method, params);
  const alice = (method, params) => api('tenant-a',method,params);
  const bob = (method, params) => api('tenant-b',method,params);
  const review = params => api('admin','review',params,true);
  const stdout = execFileSync(process.execPath,[path.join(root,'hosted/cli.mjs'),'nodes'], {
    env:{...process.env, OPEN_BROWSER_HOSTED_DIR:home, OPEN_BROWSER_HOSTED_TOKEN_FILE:path.join(home,'tenant-a.token')},
    timeout:2_000, input:'{}',
  });
  assert.deepEqual(JSON.parse(stdout), [{id:'node-a', healthy:true}]);
  const sessionA = 'one';
  const sessionB = 'two';
  const a = await alice('create',{sessionId:sessionA,name:'Alice 任务',allowedOrigins:[origin]});
  const b = await bob('create',{sessionId:sessionB,name:'Bob 任务',allowedOrigins:[origin]});
  assert.equal(a.node,'node-a'); assert.equal(b.node,'node-b');
  assert.equal(a.state,'live'); assert.equal(b.state,'live');
  await assert.rejects(alice('create',{sessionId:sessionA,name:'Alice 任务'}),{code:'session_id_conflict'});
  const races = await Promise.allSettled([alice('acquire',{sessionId:sessionA}), alice('acquire',{sessionId:sessionA})]);
  assert.equal(races.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(races.find(r=>r.status==='rejected').reason.code,'lease_busy');
  const aArgs = {sessionId:sessionA,lease:races.find(r=>r.status==='fulfilled').value.lease};
  assert.throws(() => execFileSync(process.execPath,[path.join(root,'hosted/server.mjs'),home],
    {stdio:'pipe',timeout:2000}), error => error.status === 1 && error.stderr.toString().includes('locked'));
  await alice('renew',aArgs);
  const bArgs = {sessionId:sessionB,lease:(await bob('acquire',{sessionId:sessionB})).lease};
  await assert.rejects(bob('status',aArgs),{code:'session_not_found'});
  await assert.rejects(bob('renew',aArgs),{code:'session_not_found'});
  await assert.rejects(api('tenant-a','review',{tenant:'tenant-a',sessionId:sessionA},true), {code:'forbidden'});
  await assert.rejects(alice('renew',{...aArgs,lease:'wrong'}), {code:'invalid_lease'});
  const open = (client,args,id,url) => client('openPage',{...args,operationId:id,params:{url}});
  await assert.rejects(bob('receipt',{sessionId:sessionA,operationId:'login'}),{code:'session_not_found'});
  await assert.rejects(alice('act',{...aArgs,operationId:'bad',params:{actions:[]}}),{code:'invalid_actions'});
  assert.equal((await alice('receipt',{...aArgs,operationId:'bad'})).state,'failed');
  const aPage = await open(alice,aArgs,'login',origin + '/login?ticket=' + aliceTicket);
  const bGuest = await open(bob,bArgs,'guest',origin + '/me');
  assert.match((await bob('observe',{...bArgs,pageId:bGuest.pageId})).text,/guest/);
  const bPage = await open(bob,bArgs,'login',origin + '/login?ticket=' + bobTicket);
  assert.match((await bob('observe',{...bArgs,pageId:bPage.pageId})).text,/Bob/);
  // Both tenants may choose the same public session ID; their internal IDs and
  // browser contexts remain separate even when the scheduler selects one worker.
  const colocated = await bob('create',{sessionId:sessionA,name:'Alice 任务',allowedOrigins:[origin]});
  assert.equal(colocated.node, 'node-a');
  const bSeparate = {sessionId:sessionA, lease:(await bob('acquire',{sessionId:sessionA})).lease};
  const isolated = await open(bob,bSeparate,'guest',origin + '/me');
  assert.match((await bob('observe',{...bSeparate,pageId:isolated.pageId})).text,/guest/);
  await assert.rejects(bob('receipt',{sessionId:sessionA,operationId:'login'}),{code:'operation_not_found'});
  assert.equal((await bob('finishWorkspace',{...bSeparate,operationId:'finish',params:{keepPageIds:[]}})).session.state,'closed');
  const snapshot = await alice('observe',{...aArgs,pageId:aPage.pageId});
  assert.match(snapshot.text,/Alice/);
  await assert.rejects(bob('observe',{...bArgs,pageId:aPage.pageId}),{code:'page_not_found'});
  const submit = {...aArgs,operationId:'submit',params:{pageId:aPage.pageId,documentId:snapshot.documentId,
    controlGeneration:snapshot.controlGeneration,actions:[{kind:'click',ref:snapshot.elements.find(el=>el.role==='button').ref}]}};
  const submission = alice('act',submit);
  await waitFor(()=>submissions().length === 1, 'accepted site submission');
  await nodeA.stop('SIGKILL');
  await submission;
  await waitFor(async () => (await alice('status',aArgs)).state === 'review', 'failed node fenced');
  assert.equal((await alice('receipt',{...aArgs,operationId:'submit'})).session.state,'review');
  await assert.rejects(alice('act',submit), {code:'review_required'});
  assert.match((await bob('observe',{...bArgs,pageId:bPage.pageId})).text,/Bob/);
  const restarted = newNode('a');
  await restarted.ready();
  await waitFor(async () => (await alice('nodes'))[0].healthy, 'restarted node available');
  const audit = await review({tenant:'tenant-a',sessionId:sessionA});
  assert.equal(audit.session.pendingOperationId,'submit');
  assert.ok(['completed','outcome_unknown','failed'].includes(audit.nodeReceipt?.state),JSON.stringify(audit));
  assert.deepEqual(submissions(),['Alice']);
  const archived = await review({tenant:'tenant-a',sessionId:sessionA,decision:'applied'});
  assert.equal(archived.state,'archived');
  assert.equal((await alice('receipt',{...aArgs,operationId:'submit'})).session.decision,'applied');
  await assert.rejects(alice('act',submit), {code:'session_inactive'});

  await coordinator.stop();
  const resumed = newCoordinator();
  await resumed.ready();
  await assert.rejects(bob('renew',bArgs),{code:'invalid_lease'});
  bArgs.lease = (await bob('acquire',bArgs)).lease;
  assert.match((await bob('observe',{...bArgs,pageId:bPage.pageId})).text,/Bob/);
  assert.equal((await bob('closeWorkspace',{...bArgs,operationId:'close'})).session.state,'closed');
  assert.equal((await alice('status',aArgs)).decision,'applied');
  assert.deepEqual(submissions(),['Alice']);
  assert.deepEqual((await bob('sessions')).map(s=>s.sessionId),[sessionA,sessionB]);
  await resumed.stop();
  const storage = await readFile(path.join(home,'directory.sqlite'));
  for (const secret of [aliceTicket,bobTicket,aArgs.lease,origin,'Alice','Bob'])
    assert.equal(storage.includes(Buffer.from(secret)),false);
});
