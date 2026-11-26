import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { loadavg, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const schedulerOnly = process.argv.includes('--scheduler-only');
const root = fileURLToPath(new URL('../', import.meta.url));
const skill = path.join(root, 'skills/open-browser/scripts/open-browser');
const temp = await mkdtemp(path.join(tmpdir(), 'ob-perf-'));
const execute = promisify(execFile);
const sessions = [];
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const pctl = (values, fraction) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*fraction)-1];
function envFor(name) {
  const env = { ...process.env, OPEN_BROWSER_STATE_DIR: temp, OPEN_BROWSER_PROFILE: name,
    OPEN_BROWSER_USE_SOURCE: '1', OPEN_BROWSER_AGENT_NAME: 'bench' };
  delete env.OPEN_BROWSER_CLIENT_TOKEN_FILE;
  return env;
}
const form = '<!doctype html><title>Form</title><input aria-label="value"><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output>' +
  '<p>Benchmark text</p>'.repeat(20);
let revision = 0;
const tickets = new Map(), accounts = new Map();
function loginTicket(account) {
  const ticket = randomUUID();
  tickets.set(ticket, account);
  return '/login?ticket=' + ticket;
}
const site = createServer((req,res) => {
  const url = new URL(req.url,'http://localhost');
  res.setHeader('content-type','text/html');
  res.setHeader('cache-control','no-store');
  if (url.pathname === '/login') {
    const ticket = url.searchParams.get('ticket');
    const account = tickets.get(ticket);
    if (!account) { res.statusCode = 401; res.end('Invalid ticket'); return; }
    tickets.delete(ticket);
    const session = randomUUID();
    accounts.set(session, account);
    res.setHeader('Set-Cookie','session=' + session + '; Path=/; HttpOnly; SameSite=Lax');
    res.end('Signed in');
  } else if (url.pathname === '/me') {
    const token = /(?:^|; )session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    res.end('Account ' + (accounts.get(token) || 'guest'));
  } else if (url.pathname === '/edit') {
    res.end(`<button onclick="fetch('/commit?base=${revision}',{method:'POST'}).then(r=>r.text()).then(s=>document.querySelector('output').textContent=s)">Commit</button><output></output>`);
  } else if (url.pathname === '/commit' && req.method === 'POST') {
    if (Number(url.searchParams.get('base')) === revision) { revision++; res.end('Write accepted'); }
    else { res.statusCode = 409; res.end('Write conflict'); }
  } else res.end(form);
});
site.listen(0,'127.0.0.1'); await once(site,'listening');
const origin = 'http://127.0.0.1:' + site.address().port;
async function service(profile) {
  const env = envFor(profile);
  const child = spawn(process.execPath,['service.mjs','--chromium','--headless'],{cwd:root,env});
  const exited = once(child,'close');
  sessions.push({child,exited});
  let output = '', errors = '';
  child.stdout.on('data', c => output += c);
  child.stderr.on('data', c => errors = (errors+c).slice(-900));
  const end = Date.now()+30_000;
  while (!output.includes('open-browser ready')) {
    if (child.exitCode !== null || child.signalCode || Date.now()>end) throw new Error('service startup: '+errors);
    await delay(50);
  }
  async function cli(method,params={},meter) {
    const proc=spawn(skill,[method],{cwd:root,env});
    let out='',err='';
    proc.stdout.on('data',c=>out+=c); proc.stderr.on('data',c=>err+=c);
    const done=once(proc,'close');
    proc.stdin.end(JSON.stringify(params));
    assert.equal((await done)[0],0,err);
    const result=JSON.parse(out);
    if (meter) { meter.calls++; meter.payload+=bytes(params)+bytes(result); meter.stdio+=bytes(params)+Buffer.byteLength(out); }
    return result;
  }
  return {cli,env,pid:child.pid};
}
async function fixture(cli,url='/form') {
  const { workspaceId }=await cli('createWorkspace',{name:'perf',agentName:'bench'});
  return cli('openPage',{workspaceId,url:origin+url});
}
async function rss(rootPid) {
  const {stdout}=await execute('ps',['-axo','pid=,ppid=,rss=']);
  const rows=stdout.trim().split('\n').map(s=>s.trim().split(/\s+/).map(Number));
  const children=new Set([rootPid]);
  for(let size=-1;size!==children.size;) {
    size=children.size;
    for(const [id,parent] of rows) if(children.has(parent)) children.add(id);
  }
  return rows.reduce((sum,[id,,kb])=>sum+(children.has(id)?kb:0),0)/1024;
}
async function task(call,page,mode,meter) {
  const first=await call('observe',page,meter);
  const marker='r-'+randomUUID().slice(0,8);
  const ref=role=>first.elements.find(el=>el.role===role).ref;
  const args={...page,documentId:first.documentId,controlGeneration:first.controlGeneration,operationId:randomUUID(),
    actions:[{kind:'fill',ref:ref('textbox'),value:marker},{kind:'click',ref:ref('button')}]};
  if(mode!=='ordinary') args.observeAfter=mode;
  let receipt=await call('act',args,meter);
  const deadline=Date.now()+15_000;
  while(['queued','running'].includes(receipt.state) && Date.now()<deadline) {
    await delay(40);
    receipt=await call('getOperation',{workspaceId:page.workspaceId,operationId:args.operationId},meter);
  }
  assert.equal(receipt.state,'completed');
  const result=mode==='ordinary'?await call('observe',page,meter):receipt.observation || receipt.delta;
  assert.ok(result.text.includes(marker));
}
let mcp;
try {
  const a=await service('alpha');
  for(const count of [1,4,8]) {
    const pages=await Promise.all(Array.from({length:count},()=>fixture(a.cli)));
    await Promise.all(pages.map(p=>task(a.cli,p,'full')));
    const durations=[], samples=[await rss(a.pid)];
    let running=true;
    const sampler=(async ()=>{while(running){samples.push(await rss(a.pid));await delay(150);}})();
    const loadStart = loadavg()[0];
    const start=performance.now();
    let elapsed;
    try {
      await Promise.all(pages.map(async p=>{
        for(let i=0;i<24/count;i++){const t=performance.now();await task(a.cli,p,'full');durations.push(performance.now()-t);}
      }));
    } finally {elapsed=performance.now()-start;running=false;await sampler;}
    const total=durations.length;
    console.log(JSON.stringify({count,total,p50ms:Math.round(pctl(durations,.5)),p95ms:Math.round(pctl(durations,.95)),
      perSecond:+(total*1000/elapsed).toFixed(2),
      load1minStart:loadStart,load1minEnd:loadavg()[0],peakRssMiB:Math.round(Math.max(...samples)),rssSamples:samples.length,
      ...(schedulerOnly && {scheduler:await a.cli('admin.scheduler')})}));
    await Promise.all(pages.map(p=>a.cli('closeWorkspace',{workspaceId:p.workspaceId})));
  }
  if (!schedulerOnly) {
    const page=await fixture(a.cli);
    mcp=new Client({name:'bench',version:'1'});
    const transport = new StdioClientTransport({command:process.execPath,args:[path.join(root,'mcp.mjs')],env:a.env});
    await mcp.connect(transport);
    let activeMeter;
    const send = transport.send.bind(transport);
    const receive = transport.onmessage;
    transport.send = async message => {
      if (activeMeter) activeMeter.stdio += bytes(message) + 1;
      return send(message);
    };
    transport.onmessage = (message, extra) => {
      if (activeMeter) activeMeter.stdio += bytes(message) + 1;
      return receive(message, extra);
    };
    async function mcpCall(method,params,meter){
      activeMeter = meter;
      let reply;
      try { reply = await mcp.callTool({name:method,arguments:params}); }
      finally { activeMeter = undefined; }
      assert.ok(!reply.isError,reply.content[0].text);
      const result=JSON.parse(reply.content[0].text);
      meter.calls++;meter.payload+=bytes(params)+bytes(result);
      return result;
    }
    for(const [entry,call] of [['CLI',a.cli],['MCP',mcpCall]]) {
      for(const mode of ['ordinary','full','delta']) {
        const meter={calls:0,payload:0,stdio:0},trials=5;
        for(let i=0;i<trials;i++) await task(call,page,mode,meter);
        console.log(JSON.stringify({entry,mode,trials,calls:meter.calls,bytes:meter.payload,stdioBytes:meter.stdio}));
      }
    }
    const b=await service('bravo');
    const p=await fixture(a.cli,loginTicket('alice')), q=await fixture(a.cli,loginTicket('bob'));
    const remote=await fixture(b.cli,'/me');
    const see=async(cli,handle)=> (await cli('observe',handle)).text;
    const me=async(cli,p)=>see(cli,await cli('openPage',{workspaceId:p.workspaceId,url:origin+'/me'}));
    assert.equal(await see(b.cli,remote),'Account guest');
    assert.equal(await me(a.cli,p),'Account bob');
    await b.cli('openPage',{workspaceId:remote.workspaceId,url:origin+loginTicket('carol')});
    assert.equal(await me(b.cli,remote),'Account carol');
    assert.equal(await me(a.cli,p),'Account bob');
    const edits = await Promise.all([p,q].map(tab => a.cli('openPage',{workspaceId:tab.workspaceId,url:origin+'/edit'})));
    const writes = await Promise.all(edits.map(async tab => {
      const first = await a.cli('observe',tab);
      await a.cli('act',{...tab,operationId:randomUUID(),documentId:first.documentId,
        controlGeneration:first.controlGeneration,actions:[{kind:'click',ref:first.elements.find(el=>el.name==='Commit').ref}]});
      const end = Date.now()+10_000;
      do {
        const match = (await see(a.cli,tab)).match(/Write (accepted|conflict)/);
        if(match) return match[0];
        await delay(40);
      } while(Date.now()<end);
      throw new Error('No write result');
    }));
    assert.deepEqual(writes.sort(),['Write accepted','Write conflict']);
    console.log(JSON.stringify({sharedCookie:'last-writer-bob',profiles:['alpha:bob','bravo:carol'],writes}));
  }
} finally {
  await mcp?.close();
  await Promise.all(sessions.map(async({child,exited})=>{if(child.exitCode===null && !child.signalCode) child.kill('SIGTERM');await exited;}));
  site.closeAllConnections();await new Promise(resolve=>site.close(resolve));
  await rm(temp,{recursive:true,force:true});
}
