import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

test('two Chromium workspaces download distinct PDFs with the same filename, retain one copy and clean up the other',async t=>{
  const state = await mkdtemp(path.join(tmpdir(),'open-browser-download-test-'));
  process.env.OPEN_BROWSER_STATE_DIR = state;
  const {startApplication} = await import('./service.mjs');
  const {OpenBrowserClient,localRequest} = await import('./sdk.mjs');
  const {socketPath,tokenPath,adminTokenPath} = await import('./paths.mjs');
  const {writeFile} = await import('node:fs/promises');
  const {extensionId} = await import('./chromium-host.mjs');
  const downloads = new Map();
  const reports = new Map();
  let otherRequests = 0;
  const other = createServer((_req,res)=>{otherRequests++;res.writeHead(200,{'Content-Disposition':'attachment; filename=other.txt'}).end('other');});
  other.listen(0,'127.0.0.1'); await once(other,'listening');
  const otherOrigin = 'http://127.0.0.1:'+other.address().port;
  let lateResponse;
  const site = createServer(async (req,res)=>{
    const url = new URL(req.url,'http://localhost'), key = url.searchParams.get('key');
    if (url.pathname === '/late') { lateResponse = res; return; }
    if (url.pathname === '/file') {
      downloads.set(key, (downloads.get(key)||0) + 1);
      const report = await app.sharedContext.newPage();
      try {
        await report.setContent('<h1>Workspace report</h1><p>Account ' + (key === 'alpha' ? 'alpha' : 'beta') + '</p>');
        const bytes = await report.pdf();
        reports.set(key,bytes);
        res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="report.pdf"'}).end(bytes);
      } finally { await report.close(); }
    } else res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end('<a href="/file?key='+key+'">Download report</a> <a href="'+otherOrigin+'/file">Other origin</a> <a href="/late">Late report</a>');
  });
  site.listen(0,'127.0.0.1'); await once(site,'listening');
  const origin = 'http://127.0.0.1:'+site.address().port;
  let app;
  t.after(async()=>{
    await app?.close();
    for(const srv of [site,other]) {srv.closeAllConnections(); await new Promise(resolve=>srv.close(resolve));}
    await rm(state,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  });
  app = await startApplication({headless:true,mode:'chromium'});
  const sdk = new OpenBrowserClient();
  const admin = (m,p)=>localRequest(socketPath,adminTokenPath,'/v1/admin',m,p);
  const make = async key=>{
    const {workspaceId} = await sdk.createWorkspace({name:key,allowedOrigins:[origin]});
    const page = await sdk.openPage(workspaceId,origin+'/?key='+key);
    const tab = app.sharedContext.pages().find(item=>item.url()===origin+'/?key='+key);
    return {key,workspaceId,page,tab};
  };
  const [a,b] = await Promise.all([make('alpha'),make('beta')]);
  const click = async (task,name, expectCompletion = true) => {
    const view = await sdk.observe(task.page);
    const ref = view.elements.find(el=>el.name===name)?.ref;
    assert.ok(ref,name);
    let receipt = await sdk.call('act',{...task.page,documentId:view.documentId,controlGeneration:view.controlGeneration,
      operationId:crypto.randomUUID(),actions:[{kind:'click',ref}]});
    while (['queued','running'].includes(receipt.state)) {
      await delay(40);
      receipt = await sdk.getOperation(task.workspaceId,receipt.operationId);
    }
    if (expectCompletion) assert.equal(receipt.state,'completed',name+' '+JSON.stringify(receipt));
    return receipt;
  };
  const [files] = await Promise.all([
    Promise.all([a,b].map(task=>task.tab.waitForEvent('download',{timeout:30_000}))),
    Promise.all([click(a,'Download report'),click(b,'Download report')])
  ]);
  const temporary = await Promise.all(files.map(f=>f.path()));
  const get = task=>sdk.call('listDownloads',{workspaceId:task.workspaceId});
  async function ready(task) {
    for(let n=0;n<80;n++){const [file]=await get(task);if(file?.state==='ready')return file;await delay(50);}
    assert.fail('file not ready');
  }
  const [first,second] = await Promise.all([ready(a),ready(b)]);
  assert.equal(first.filename,'report.pdf'); assert.equal(second.filename,'report.pdf');
  assert.notEqual(first.downloadId,second.downloadId);
  assert.equal(first.pageId,a.page.pageId); assert.equal(second.pageId,b.page.pageId);
  assert.equal(reports.get('alpha').subarray(0,5).toString(),'%PDF-');
  assert.equal(reports.get('beta').subarray(0,5).toString(),'%PDF-');
  assert.ok(!reports.get('alpha').equals(reports.get('beta')));
  assert.deepEqual(await readFile(temporary[0]),reports.get('alpha'));
  assert.deepEqual(await readFile(temporary[1]),reports.get('beta'));
  const entry = (task,id)=>({workspaceId:task.workspaceId,downloadId:id});
  await assert.rejects(sdk.call('cancelDownload',entry(b,first.downloadId)),{code:'download_not_found'});
  const grantee = await admin('pair',{name:'readonly'});
  const grantToken = path.join(state,'reader.token');await writeFile(grantToken,grantee.token);
  await admin('grant',{principalId:grantee.principalId,workspaceId:a.workspaceId,permission:'read'});
  const viewer = new OpenBrowserClient({tokenPath:grantToken});
  assert.deepEqual(await viewer.call('listDownloads',{workspaceId:a.workspaceId}),[first]);
  await assert.rejects(viewer.call('listDownloads',{workspaceId:b.workspaceId}),{code:'workspace_not_found'});
  await assert.rejects(viewer.call('cancelDownload',entry(a,first.downloadId)),{code:'forbidden'});
  await assert.rejects(localRequest(socketPath,tokenPath,'/v1/call','keepDownload',entry(a,first.downloadId)),{code:'forbidden'});

  const ui = await app.sharedContext.newPage();
  await ui.goto('chrome-extension://'+extensionId+'/popup.html');
  await ui.locator('#workspaces').selectOption(a.workspaceId);
  await ui.locator('#downloads summary').click();
  await ui.getByRole('button',{name:'保留文件'}).click();
  await ui.getByRole('button',{name:'查看保存位置'}).waitFor({timeout:5000});
  const saved = await app.hostCall('keepDownload',entry(a,first.downloadId));
  assert.ok(saved.path.startsWith(path.join(state,'open-browser-deliveries',a.workspaceId,first.downloadId)+path.sep));
  assert.deepEqual(await readFile(saved.path),reports.get('alpha'));
  const outputs = await sdk.call('listOutputs',{workspaceId:a.workspaceId});
  assert.deepEqual(outputs,[saved.output]);
  assert.deepEqual(await viewer.listOutputs(a.workspaceId),[saved.output]);
  assert.equal((await viewer.readOutput(a.workspaceId,saved.output.id,{limit:64*1024})).done,true);
  const firstChunk = await sdk.call('readOutput',{workspaceId:a.workspaceId,outputId:saved.output.id,limit:32});
  assert.equal(firstChunk.bytes,32);
  assert.equal(firstChunk.done,false);
  const remainder = await sdk.call('readOutput',{workspaceId:a.workspaceId,outputId:saved.output.id,offset:firstChunk.nextOffset,limit:64*1024});
  assert.equal(Buffer.concat([Buffer.from(firstChunk.data,'base64'),Buffer.from(remainder.data,'base64')]).compare(reports.get('alpha')),0);
  await click(b,'Other origin',false);
  assert.equal(otherRequests,0);
  assert.equal((await get(b)).length,1);
  await sdk.call('cancelDownload',entry(b,second.downloadId));
  assert.equal((await get(b))[0].state,'cancelled');
  assert.equal((await sdk.finishWorkspace(a.workspaceId,[],'finish-a')).state,'completed');
  assert.deepEqual(await sdk.listOutputs(a.workspaceId),[saved.output]);
  const afterFinish = await sdk.readOutput(a.workspaceId,saved.output.id,{limit:64*1024});
  assert.equal(Buffer.from(afterFinish.data,'base64').compare(reports.get('alpha')),0);
  await sdk.closeWorkspace(b.workspaceId);
  for (const file of temporary) await assert.rejects(stat(file),{code:'ENOENT'});
  assert.deepEqual(await readFile(saved.path),reports.get('alpha'));
  assert.deepEqual([...downloads.entries()].sort(),[['alpha',1],['beta',1]]);

  // A same-origin in-memory export exercises the real Chromium download
  // manager while bytes are still being copied to its temporary artifact.
  const active = await make('inflight');
  await active.tab.evaluate(()=>{
    const exportLink = document.createElement('a');
    exportLink.href = URL.createObjectURL(new Blob(Array(96).fill(new Uint8Array(1024*1024))));
    exportLink.download = 'large.bin';
    exportLink.textContent = 'Large export';
    document.body.append(exportLink);
  });
  const cancellation = active.tab.waitForEvent('download',{timeout:30_000}).then(async artifact=>{
    // Subscribe while Chromium still owns this artifact; some platforms release
    // its protocol handle as soon as the cancellation receipt is delivered.
    const failure = artifact.failure();
    const [started] = await get(active);
    assert.equal(started.state,'receiving');
    assert.equal((await sdk.cancelDownload(active.workspaceId,started.downloadId)).state,'cancelled');
    assert.match(await failure,/cancel/i);
    await assert.rejects(app.hostCall('keepDownload',entry(active,started.downloadId)),{code:'download_not_ready'});
    assert.equal((await get(active))[0].state,'cancelled');
  });
  await Promise.all([click(active,'Large export'),cancellation]);
  await sdk.closeWorkspace(active.workspaceId);

  const late = await make('late');
  let lateDownloads = 0;
  late.tab.on('download',()=>lateDownloads++);
  // Start the request as the page would after an asynchronous form callback.
  // The fixture withholds attachment headers until after delivery.
  const before = await sdk.getWorkspace(late.workspaceId);
  const denied = late.tab.waitForEvent('requestfailed',{predicate:r=>r.url().endsWith('/late'),timeout:8000});
  await late.tab.evaluate(()=>{setTimeout(()=>document.querySelector('[href="/late"]').click(),0);});
  for(let n=0;!lateResponse && n<80;n++) await delay(25);
  assert.ok(lateResponse);
  const finish = sdk.finishWorkspace(late.workspaceId,[late.page.pageId],'finish-late');
  for(let n=0;n<80;n++) {
    const current = await sdk.getWorkspace(late.workspaceId).catch(()=>null);
    if (!current || current.controlGeneration !== before.controlGeneration) break;
    await delay(20);
  }
  lateResponse.writeHead(200,{'Content-Disposition':'attachment; filename=late.txt'}).end('late data');
  await denied;
  assert.equal((await finish).state,'completed');
  assert.equal(lateDownloads,0);
});
