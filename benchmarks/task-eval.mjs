// A deterministic task driver and independent HTTP outcome grader. JSON Lines on stdout.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cases = ['native-label', 'referenced-label', 'multi-label'];
const rounds = Number(process.argv[2] ?? 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('Expected 1–100 rounds');
const records = new Map();
const site = createServer(async (req, res) => {
  const id = req.url.slice(1);
  const record = records.get(id);
  if (!record) return res.writeHead(404).end();
  res.setHeader('content-type','text/html; charset=utf-8');
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    record.writes.push(new URLSearchParams(body));
    return res.end('<p>Saved</p>');
  }
  const field = {
    'native-label':'<label>Delivery city <input name="city"></label>',
    'referenced-label':'<span id="city-name">Delivery city</span><input aria-labelledby="city-name" name="city">',
    'multi-label':'<span id="noun">city</span><span id="prefix">Delivery</span><input aria-labelledby="prefix noun private" aria-label="Old name" name="city"><span hidden id="private">PRIVATE_MARKER</span>',
  }[record.id];
  res.end('<form method="POST"><label>Billing city <input name="billing" value="Original"></label>' +
    field + '<button>Save</button></form>');
});
const state = await mkdtemp(path.join(tmpdir(),'ob-eval-'));
process.env.OPEN_BROWSER_STATE_DIR = state;
process.env.OPEN_BROWSER_PROFILE = 'default';
process.env.OPEN_BROWSER_USE_SOURCE = '1';
delete process.env.OPEN_BROWSER_CLIENT_TOKEN_FILE;
const { startApplication } = await import('../service.mjs');
let service;
async function runCase(id, origin) {
  const key = randomUUID();
  const record = {id, writes:[]};
  records.set(key,record);
  const started = performance.now();
  let calls = 0, bytes = 0, workspaceId, failure;
  const rubric = { located:false, savedOnce:false, billingPreserved:false, delivered:false };
  async function call(method, params) {
    calls++;
    const windows = process.platform === 'win32';
    const proc = spawn(windows ? process.execPath : path.join(root,'skills/open-browser/scripts/open-browser'),
      windows ? [path.join(root,'cli.mjs'),method] : [method], {cwd:root});
    const stdout = [], stderr = [];
    const exit = once(proc,'close');
    proc.stdout.on('data',block => stdout.push(block));
    proc.stderr.on('data',block => stderr.push(block));
    const input = JSON.stringify(params);
    proc.stdin.end(input);
    const [code] = await exit;
    const data = Buffer.concat(stdout);
    bytes += Buffer.byteLength(input) + data.length;
    if (code) throw Error(JSON.parse(Buffer.concat(stderr).toString()).error.code);
    return JSON.parse(data);
  }
  try {
    ({workspaceId} = await call('createWorkspace',{name:'task-eval',agentName:'grader-fixture'}));
    const page = await call('openPage',{workspaceId,url:origin+'/'+key});
    const snapshot = await call('observe',page);
    const matches = snapshot.elements.filter(e => e.role === 'textbox' && e.name === 'Delivery city');
    const button = snapshot.elements.find(e => e.role === 'button' && e.name === 'Save');
    if (JSON.stringify(snapshot).includes('PRIVATE_MARKER')) throw Error('hidden_content_returned');
    if (matches.length !== 1 || !button) throw Error('target_name_missing_or_ambiguous');
    rubric.located = true;
    const action = {...page,documentId:snapshot.documentId,controlGeneration:snapshot.controlGeneration,
      operationId:randomUUID(),actions:[{kind:'fill',ref:matches[0].ref,value:'Shanghai'},{kind:'click',ref:button.ref}]};
    let receipt = await call('act',action);
    const deadline = Date.now()+10000;
    while (['queued','running'].includes(receipt.state) && Date.now()<deadline) {
      await delay(25);
      receipt = await call('getOperation',{workspaceId,operationId:action.operationId});
    }
    if (receipt.state !== 'completed') throw Error(receipt.error || receipt.state);
    await call('act',action); // Re-deliver exactly the same request.
    const first = record.writes[0];
    rubric.savedOnce = record.writes.length === 1 && first.get('city') === 'Shanghai';
    rubric.billingPreserved = first?.get('billing') === 'Original';
    const finish = await call('finishWorkspace',{workspaceId,operationId:randomUUID(),keepPageIds:[]});
    rubric.delivered = finish.state === 'completed' && finish.closedPageIds.includes(page.pageId) &&
      !(await call('listWorkspaces',{})).some(w => w.workspaceId === workspaceId);
  } catch (error) { failure = error.message; }
  finally {
    if (workspaceId && !rubric.delivered) await call('closeWorkspace',{workspaceId});
    records.delete(key);
  }
  return {id,rubric,perfect:!failure && Object.values(rubric).every(Boolean),failure,
    calls,stdioBytes:bytes,ms:Math.round(performance.now()-started)};
}
try {
  site.listen(0,'127.0.0.1');
  await once(site,'listening');
  const origin = 'http://127.0.0.1:'+site.address().port;
  service = await startApplication({mode:'chromium',headless:true});
  let perfect = 0;
  for (let round=1;round<=rounds;round++) {
    for (const id of cases) {
      const row = await runCase(id,origin);
      if (row.perfect) perfect++;
      console.log(JSON.stringify({round,...row}));
    }
  }
  console.log(JSON.stringify({perfect,total:rounds*cases.length}));
  if (perfect !== rounds*cases.length) process.exitCode = 1;
} finally {
  await service?.close();
  site.closeAllConnections();
  await new Promise(resolve => site.close(resolve));
  await rm(state,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
