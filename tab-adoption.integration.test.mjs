import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('only the selected ordinary tab becomes manageable and ten handoffs retain its identity', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ob-adopt-'));
  process.env.OPEN_BROWSER_STATE_DIR = dir;
  process.env.OPEN_BROWSER_AUTO_INSTALL_SKILLS = '0';
  const entry = file => process.env.OPEN_BROWSER_QA_APP
    ? pathToFileURL(path.join(process.env.OPEN_BROWSER_QA_APP,file)).href : new URL(file,import.meta.url).href;
  const {startApplication} = await import(entry('service.mjs'));
  const {OpenBrowserClient} = await import(entry('sdk.mjs'));
  const {extensionId} = await import(entry('chromium-host.mjs'));
  const site = createServer((req, res) => {
    if (req.url === '/login') {
      res.writeHead(302, {'set-cookie':'fixture_session=active; HttpOnly; SameSite=Strict; Path=/',location:'/'});
      return res.end();
    }
    if (req.headers.cookie !== 'fixture_session=active') return res.writeHead(401).end('Sign in');
    res.writeHead(200, {'content-type':'text/html'});
    res.end('<button>Save</button><main class="react-flow"><div class="react-flow__node selected" data-id="draft">Draft</div><span class="react-flow__edge" data-id="ab">Draft to output</span></main><article data-message-author-role="assistant">Finished <b data-open-browser-private>private</b></article><a download href="/result">Report</a>');
  });
  site.listen(0,'127.0.0.1');
  await once(site,'listening');
  const origin = 'http://127.0.0.1:' + site.address().port;
  const api = new OpenBrowserClient();
  let app;
  t.after(async () => {
    api.close();
    await app?.close();
    site.closeAllConnections();
    await new Promise(resolve => site.close(resolve));
    await rm(dir, {recursive:true, force:true,maxRetries:6,retryDelay:200});
  });
  const start = () => startApplication({mode:'chromium',headless:true});
  app = await start();
  const ctx = app.sharedContext;
  const other = await ctx.newPage(), chosen = await ctx.newPage();
  await other.goto(origin + '/login');
  await chosen.goto(origin);
  await chosen.evaluate(() => { document.querySelector('button').textContent = 'Selected session'; });
  const worker = ctx.serviceWorkers()[0];
  await chosen.bringToFront();
  const target = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({active:true, lastFocusedWindow:true});
    return (await chrome.debugger.getTargets()).find(t => t.tabId === tab.id && t.type === 'page');
  });
  const newTask = async () => ({workspaceId:(await api.createWorkspace({name:'Session review'})).workspaceId});
  const ws = await newTask();
  const panel = await ctx.newPage();
  await panel.goto('chrome-extension://' + extensionId + '/popup.html#tab-' + target.tabId);
  await chosen.bringToFront();
  await panel.locator('#adopt-alias').fill('Work');
  const startTime = performance.now();
  await panel.locator('#adopt').click();
  await panel.locator('#adopt-token').waitFor({timeout:5000});
  const grant = JSON.parse(await panel.locator('#adopt-token').inputValue());
  assert.equal(grant.workspaceId, ws.workspaceId);
  const page = await api.call('adoptCurrentTab', grant);
  const first = await api.observe(page);
  t.diagnostic('user selection to first observation: ' + Math.round(performance.now()-startTime) + ' ms');
  assert.match(first.text,/Selected session/);
  await assert.rejects(api.call('adoptCurrentTab',grant), {code:'adoption_expired'});
  await assert.rejects(api.openPage(ws.workspaceId,origin), {code:'single_tab_scope'});
  let lastGeneration = first.controlGeneration;
  for (let i=0; i<10; i++) {
    const human = await api.handOff(ws.workspaceId);
    await assert.rejects(api.reattachPage(page), {code:'workspace_under_user_control'});
    const waiting = api.reattachPage(page,{waitMs:3000});
    await app.hostCall('returnToAgent',{...page,controlGeneration:human.controlGeneration});
    const fresh = await waiting;
    assert.equal(fresh.pageId, first.pageId);
    assert.notEqual(fresh.controlGeneration, lastGeneration);
    assert.match(fresh.text,/Selected session/);
    lastGeneration = fresh.controlGeneration;
  }
  const state = await api.getWorkspace(ws.workspaceId);
  await assert.rejects(api.call('getWorkspace',{...ws,profileId:'different'}),{code:'profile_mismatch'});
  assert.equal(state.accountAlias, 'Work');
  assert.equal(state.pages.length, 1);
  assert.equal(state.pages[0].syncState,'synced');
  assert.ok(state.pages[0].syncRevision >= 21);
  const canvas = await api.canvasSnapshot(page);
  assert.deepEqual(canvas.nodes,[{id:'draft',label:'Draft',selected:true}]);
  assert.equal(canvas.edges[0].id, 'ab');
  assert.deepEqual(canvas.messages,[{role:'assistant',text:'Finished'}]);
  assert.deepEqual(canvas.attachments,[{label:'Report'}]);
  await chosen.locator('.react-flow__node').evaluate(el=>el.classList.remove('selected'));
  assert.notEqual((await api.canvasSnapshot(page)).snapshotVersion, canvas.snapshotVersion);
  await chosen.goto(origin.replace('127.0.0.1','localhost'));
  await assert.rejects(api.reattachPage(page),{code:'origin_denied'});
  await chosen.goto(origin);
  const preview = await api.previewFinish(ws.workspaceId);
  assert.deepEqual(preview.keptPageIds,[page.pageId]);
  await assert.rejects(api.finishWorkspace(ws.workspaceId,[],'stale-finish','obsolete'),{code:'finish_preview_changed'});
  const receipt = await api.finishWorkspace(ws.workspaceId,[],'done',preview.previewId);
  assert.equal(receipt.state,'completed');
  assert.equal(chosen.isClosed(),false);
  const next = await newTask();
  async function adopt(work) {
    const offer = await app.hostCall('offerCurrentTab',{...work,targetId:target.id,origin});
    return api.adoptCurrentTab(work.workspaceId,offer.adoptionToken);
  }
  const oldOffer = await app.hostCall('offerCurrentTab',{...next,targetId:target.id,origin});
  await chosen.reload();
  await assert.rejects(api.adoptCurrentTab(next.workspaceId,oldOffer.adoptionToken),{code:'adoption_expired'});
  const adoptedAgain = await adopt(next);
  await api.closeWorkspace(next.workspaceId);
  assert.equal(chosen.isClosed(),false);
  const last = await newTask();
  const finalPage = await adopt(last);
  await chosen.close();
  await assert.rejects(api.reattachPage(finalPage),{code:'page_not_found'});
  assert.equal((await api.getWorkspace(last.workspaceId)).pageAvailability,'closed');
  assert.equal(await other.locator('button').innerText(),'Save');
  await app.close();
  app = await start();
  const history = await api.getRecoverySummary(next.workspaceId);
  assert.equal(history.pages[0].pageId,adoptedAgain.pageId);
  assert.equal(history.pages[0].lastDisposition,'released');
  assert.equal(history.pages[0].nextAction,'request_tab_selection');
});
