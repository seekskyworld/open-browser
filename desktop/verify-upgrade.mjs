// Run using the new package's Node runtime. Arguments are the prior and candidate package app directories.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [oldApp,newApp] = process.argv.slice(2);
assert.ok(oldApp && newApp);
const state = await mkdtemp(path.join(tmpdir(),'open-browser-upgrade-'));
process.env.OPEN_BROWSER_STATE_DIR = state;
delete process.env.OPEN_BROWSER_PROFILE;
delete process.env.OPEN_BROWSER_CLIENT_TOKEN_FILE;
const site = createServer((req,res) => {
  res.setHeader('content-type','text/html;charset=utf-8');
  if (req.url === '/login') res.setHeader('set-cookie','ticket=fixture-user; Max-Age=1800; Path=/; HttpOnly; SameSite=Lax');
  res.end('<title>Local account</title><p>' + (req.headers.cookie?.includes('ticket=fixture-user') ? 'signed in' : 'welcome') +
    '</p><label>Draft<textarea></textarea></label>');
});
site.listen(0,'127.0.0.1'); await once(site,'listening');
const origin = 'http://127.0.0.1:'+site.address().port;
const headed = process.env.OPEN_BROWSER_QA_HEADED === '1';
let app;
async function launch(dir) {
  const mod = name => pathToFileURL(path.resolve(dir,name)).href;
  const {startApplication} = await import(mod('service.mjs'));
  app = await startApplication({headless:!headed,mode:'chromium'});
  const {OpenBrowserClient} = await import(mod('sdk.mjs'));
  return new OpenBrowserClient();
}

try {
  const previous = await launch(oldApp);
  const {workspaceId} = await previous.createWorkspace({name:'prior release'});
  const page = await previous.openPage(workspaceId,origin+'/login');
  await previous.finishWorkspace(workspaceId,[page.pageId],'prior-delivery');
  await app.close(); app = null;
  const current = await launch(newApp);
  const receipt = await current.getOperation(workspaceId,'prior-delivery');
  assert.equal(receipt.state,'completed');
  assert.deepEqual(receipt.keptPageIds,[page.pageId]);
  const editor = await app.sharedContext.newPage();
  await editor.goto(origin+'/account');
  assert.match(await editor.locator('p').innerText(),/signed in/);
  await editor.bringToFront();
  await editor.locator('textarea').focus();
  const cdp = await app.sharedContext.newCDPSession(editor);
  await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:false});
  await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1.5});
  assert.equal(await editor.evaluate(()=>visualViewport.scale),1.5);
  // Exercise Chromium composition on a real text control, including committing the composition.
  await cdp.send('Input.imeSetComposition',{text:'输入',selectionStart:2,selectionEnd:2});
  await cdp.send('Input.insertText',{text:'输入'});
  const handles = await Promise.all(['left','right'].map(async name => {
    const ws = await current.createWorkspace({name,agentName:name});
    const handle = await current.openPage(ws.workspaceId,origin+'/work');
    const snapshot = await current.observe(handle);
    assert.match(snapshot.text,/signed in/);
    await current.finishWorkspace(ws.workspaceId,[],name+'-done');
    return handle;
  }));
  assert.equal(handles.length,2);
  assert.equal(await editor.locator('textarea').inputValue(),'输入');
  assert.equal(await editor.evaluate(()=>document.activeElement.tagName),'TEXTAREA');
  if (headed) assert.ok(await editor.evaluate(()=>document.hasFocus()),'background tasks must preserve front editor focus');
  console.log(JSON.stringify({platform:process.platform,headed,upgradeLogin:true,priorReceipt:true,
    pageZoom:1.5,chromiumComposition:'committed',backgroundWorkspaces:2}));
} finally {
  await app?.close();
  site.closeAllConnections(); await new Promise(resolve=>site.close(resolve));
  await rm(state,{recursive:true,force:true,maxRetries:6,retryDelay:200});
}
