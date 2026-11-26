// node benchmarks/observe-compare.mjs > /tmp/open-browser-observe-results.jsonl
// node benchmarks/observe-compare.mjs --sdk > /tmp/open-browser-observe-sdk.jsonl
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { loadavg, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { OpenBrowserClient } from '../sdk.mjs';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const skill = path.join(root, 'skills/open-browser/scripts/open-browser');
const execute = promisify(execFile);
const base = await mkdtemp(path.join(tmpdir(), 'ob-compare-'));
const modes = ['playwright', 'rust', 'direct'];
const smoke = process.argv[2] === '--smoke';
const useSdk = process.argv.includes('--sdk');
const sampleCount = smoke ? 1 : useSdk ? 120 : 24;
const order = [1,4,8];
const signatures = new Set();
const fixture = `<!doctype html><meta charset=utf-8><title>Observe fixture</title>
  <main><span id="label">Display name</span><input aria-labelledby="label" aria-label="Ignored fallback">
  <input aria-label="Password" type=password value="SECRET_FIXTURE_VALUE">
  <div aria-hidden="true"><button>PRIVATE_HIDDEN</button></div>
  <p style="display:none">PRIVATE_CSS</p><section inert>PRIVATE_INERT</section>
  <button aria-label="Save entry" onclick="document.querySelector('output').textContent='Published'">Save</button>
  <output>Draft</output>${'<p>Public catalogue record.</p>'.repeat(30)}</main>`;
const site = createServer((req, res) => res.writeHead(200, {
  'content-type':'text/html; charset=utf-8', 'cache-control':'no-store',
}).end(fixture));
site.listen(0,'127.0.0.1');
await once(site,'listening');
const url = 'http://127.0.0.1:' + site.address().port;
const env = {...process.env, OPEN_BROWSER_STATE_DIR:base, OPEN_BROWSER_PROFILE:'bench', OPEN_BROWSER_USE_SOURCE:'1'};
delete env.OPEN_BROWSER_CLIENT_TOKEN_FILE;
const {stdout: sdkSocket} = await execute(process.execPath, ['--input-type=module', '-e',
  "import {socketPath} from './paths.mjs'; process.stdout.write(socketPath)"], {cwd:root, env});


async function cli(method, params, tokenFile) {
  const options = tokenFile ? {...env, OPEN_BROWSER_CLIENT_TOKEN_FILE:tokenFile} : env;
  const started = performance.now();
  const child = spawn(skill, [method], {cwd:root, env:options});
  const exit = once(child,'close');
  const out = [], err = [];
  child.stdout.on('data', s=>out.push(s)); child.stderr.on('data', s=>err.push(s));
  const input = JSON.stringify(params);
  child.stdin.end(input);
  if ((await exit)[0] !== 0) throw new Error(JSON.parse(Buffer.concat(err).toString()).error.code);
  const body = Buffer.concat(out);
  return {result:JSON.parse(body), elapsedMs:performance.now()-started, bytesIn:Buffer.byteLength(input), bytesOut:body.length};
}
function validate(view, label) {
  assert.ok(view.text.includes(label));
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_|SECRET_FIXTURE_VALUE|Ignored fallback/);
  assert.deepEqual(view.elements, [
    {role:'textbox',name:'Display name'}, {role:'textbox',name:'Password'}, {role:'button',name:'Save entry'},
  ]);
  assert.ok(view.workspaceId && view.pageId && view.documentId && view.controlGeneration);
  const {workspaceId,pageId,documentId,controlGeneration,...content} = view;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
function cpuSeconds(time) {
  // BSD ps reports cumulative user+system CPU in [[hh:]mm:]ss.cc.
  return time.split(':').reduce((sum, component) => sum*60 + Number(component), 0);
}
async function tree(rootPid) {
  const {stdout} = await execute('ps',['-axo','pid=,ppid=,rss=,time=']);
  const rows = stdout.trim().split('\n').map(line => {
    const [pid,ppid,rss,time] = line.trim().split(/\s+/);
    return {pid:+pid,parent:+ppid,rssKiB:+rss,cpu:cpuSeconds(time)};
  });
  const selected = new Set([rootPid]);
  for (let previous = 0; previous !== selected.size;) {
    previous = selected.size;
    for (const row of rows) if (selected.has(row.parent)) selected.add(row.pid);
  }
  return rows.filter(r=>selected.has(r.pid));
}
function percentile(values, p) {
  if (!values.length) return null;
  return [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
}
async function measure(pid, pages, tokenFile, round, mode) {
  const sdk = new OpenBrowserClient({socketPath:sdkSocket, tokenPath:tokenFile});
  async function read(page) {
    if (!useSdk) return cli('observe',page,tokenFile);
    const start = performance.now();
    const result = await sdk.observe(page);
    return {result,elapsedMs:performance.now()-start,
      bytesIn:Buffer.byteLength(JSON.stringify({method:'observe',params:page})),
      bytesOut:Buffer.byteLength(JSON.stringify({result}))};
  }
  const n = pages.length, observations = [], errors = [], totalByPid = new Map();
  let peakRSSKiB = 0, samples = 0, pending = true;
  async function sample() {
    const rows = await tree(pid);
    peakRSSKiB = Math.max(peakRSSKiB,rows.reduce((sum,r)=>sum+r.rssKiB,0));
    for (const {pid,cpu} of rows) {
      const item = totalByPid.get(pid) || {start:samples ? 0 : cpu, end:cpu};
      item.end = cpu; totalByPid.set(pid,item);
    }
    samples++;
  }
  await sample();
  const sampleLoop = (async () => {
    while(pending) { await delay(100); if(pending) await sample(); }
  })();
  const start = performance.now();
  try {
    await Promise.all(pages.map(async page => {
      for(let i=0;i<sampleCount/n;i++) {
        try {
          const {result,elapsedMs,bytesIn,bytesOut} = await read(page);
          const hash = validate(result,'Draft');
          signatures.add(hash);
          observations.push({ms:+elapsedMs.toFixed(2),bytesIn,bytesOut,hash});
        } catch (error) { errors.push(String(error.message).slice(0,120)); }
      }
    }));
  } finally { pending = false; }
  const elapsedMs = performance.now()-start;
  await sampleLoop; await sample();
  const cpu = [...totalByPid.values()].reduce((sum,p)=>sum+p.end-p.start,0);
  const times = observations.map(s=>s.ms);
  const entry = {type:'sample',entrypoint:useSdk?'sdk':'cli',round,mode,concurrency:n,attempts:sampleCount,successes:times.length,
    errors,elapsedMs:Math.round(elapsedMs),p50:percentile(times,.5),p95:percentile(times,.95),
    peakRssMiB:+(peakRSSKiB/1024).toFixed(1),cpuSec:+cpu.toFixed(3),
    cpuPercent:+(100_000*cpu/elapsedMs).toFixed(1),samples,load1:loadavg()[0],observations};
  console.log(JSON.stringify(entry));
  if(errors.length) throw new Error('Observation checks failed: '+errors[0]);
}

async function run(mode, round, rotation) {
  const proc = spawn(process.execPath,['experiments/observe-service.mjs',mode],{cwd:root,env});
  const exit = once(proc,'close');
  let output = '', diagnostic = '';
  proc.stdout.on('data',s=>output+=s);
  proc.stderr.on('data',s=>diagnostic=(diagnostic+s).slice(-1000));
  try {
    const readyBy=Date.now()+40_000;
    while(!output.includes('open-browser ready')) {
      if(proc.exitCode!==null || proc.signalCode || Date.now()>readyBy) throw new Error('Service startup: '+diagnostic);
      await delay(40);
    }
    const readToken = path.join(base,randomUUID());
    const controlToken = path.join(base,randomUUID());
    const {result:reader} = await cli('admin.pair',{name:'observer',tokenFile:readToken});
    await cli('admin.pair',{name:'writer',tokenFile:controlToken});
    const pages = [];
    for(let i=0;i<(smoke ? 1 : 8);i++) {
      const {result:{workspaceId}}=await cli('createWorkspace',{name:'fixture',agentName:'writer'},controlToken);
      const {result:page}=await cli('openPage',{workspaceId,url},controlToken);
      await cli('admin.grant',{workspaceId,principalId:reader.principalId,permission:'read'});
      validate((await cli('observe',page,readToken)).result,'Draft');
      pages.push(page);
    }
    await assert.rejects(cli('act',{...pages[0],operationId:randomUUID(),actions:[]},readToken),/forbidden/);
    for(let i=0;i<(smoke ? 1 : order.length);i++) {
      const n=order[(i+rotation)%order.length];
      await measure(proc.pid,pages.slice(0,n),readToken,round,mode);
    }
    const first=pages[0], {result:view}=await cli('observe',first,controlToken);
    const operationId=randomUUID();
    let {result:receipt}=await cli('act',{...first,operationId,documentId:view.documentId,
      controlGeneration:view.controlGeneration,actions:[{kind:'click',ref:view.elements.find(e=>e.name==='Save entry').ref}]},controlToken);
    const end=Date.now()+10_000;
    while(['queued','running'].includes(receipt.state) && Date.now()<end) {
      await delay(25);
      ({result:receipt}=await cli('getOperation',{workspaceId:first.workspaceId,operationId},controlToken));
    }
    assert.equal(receipt.state,'completed');
    validate((await cli('observe',first,readToken)).result,'Published');
    for(const [index,page] of pages.entries()) {
      const keepPageIds=index===0?[page.pageId]:[];
      const {result}=await cli('finishWorkspace',{workspaceId:page.workspaceId,operationId:randomUUID(),keepPageIds},controlToken);
      assert.deepEqual(result.keptPageIds,keepPageIds);
    }
    console.log(JSON.stringify({type:'functional',round,mode,write:'completed',delivery:'confirmed',readScope:'enforced'}));
  } finally {
    if (proc.exitCode===null && !proc.signalCode) proc.kill('SIGTERM');
    const timer=setTimeout(()=>proc.kill('SIGKILL'),6000);
    try { await exit; } finally { clearTimeout(timer); }
  }
}
try {
  if (smoke) await run(process.argv[3] || 'rust', 0, 0);
  for(let round=0;!smoke && round<3;round++) {
    for(let step=0;step<3;step++) await run(modes[(step+round)%3],round+1,round);
  }
  assert.equal(signatures.size,1,'normalized observations differ across modes or callers');
  console.log(JSON.stringify({type:'complete',normalizedOutputHashes:[...signatures]}));
} finally {
  site.closeAllConnections(); await new Promise(resolve=>site.close(resolve));
  await rm(base,{recursive:true,force:true});
}
