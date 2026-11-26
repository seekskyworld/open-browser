// Use only a disposable profile and synthetic local content. The persistent result is host names and counts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(path.join(tmpdir(),'open-browser-egress-'));
process.env.OPEN_BROWSER_STATE_DIR = dir;
delete process.env.OPEN_BROWSER_CLIENT_TOKEN_FILE;
delete process.env.OPEN_BROWSER_PROFILE;
const packaged = process.env.OPEN_BROWSER_QA_APP;
const cliPath = packaged ? path.join(packaged, 'cli.mjs') : path.join(root,'skills/open-browser/scripts/open-browser');
const { startApplication } = await import(pathToFileURL(path.join(packaged || root,'service.mjs')));
const raw = path.join(dir,'netlog.json');
const phases = [{at:Date.now(),name:'startup'}];
const received = {};
function receiver(name, handler) {
  const tally = () => {
    const phase = phases.at(-1).name;
    return (received[phase] ||= {})[name] ||= {connections:0, requests:0, bodyBytes:0};
  };
  const server = createServer(async (req,res) => {
    const row = tally();
    row.requests++;
    let bytes = 0;
    for await (const chunk of req) bytes += chunk.length;
    row.bodyBytes += bytes;
    handler(req,res);
  });
  server.on('connection', () => tally().connections++);
  return server;
}
const denied = receiver('unapproved', (_req,res) => res.end());
const marker = 'open-browser-synthetic';
const site = receiver('approved', (req,res) => {
  if (req.url === '/received') return res.end();
  res.writeHead(200,{'content-type':'text/html'}).end(`<p>Loading</p><script>
    (async () => {
      await fetch('http://127.0.0.1:${denied.address().port}/unapproved',{method:'POST',body:'${marker}'}).catch(()=>{});
      await fetch('/received',{method:'POST',body:'${marker}'});
      document.querySelector('p').textContent='Fixture result';
    })()</script>`);
});
const next = name => phases.push({at:Date.now(), name});
const nodeConnections = [];
channel('net.client.socket').subscribe(({socket}) => {
  const phase = phases.at(-1).name;
  socket.once('connect',() => {
    if (socket.remoteAddress) nodeConnections.push({phase,address:socket.remoteAddress});
  });
});
async function cli(method, params) {
  const proc = spawn(packaged ? process.execPath : cliPath, packaged ? [cliPath,method] : [method],
    {env:{...process.env,OPEN_BROWSER_USE_SOURCE:'1'}, stdio:['pipe','pipe','inherit']});
  const exit = once(proc,'close');
  const chunks = [];
  proc.stdout.on('data',c=>chunks.push(c));
  proc.stdin.end(JSON.stringify(params));
  assert.equal((await exit)[0],0);
  return JSON.parse(Buffer.concat(chunks));
}

let app;
try {
  const isolated = process.argv.includes('--isolated');
  if (isolated) assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal),
    'Run --isolated in a network namespace with only loopback');
  denied.listen(0,'127.0.0.1'); await once(denied,'listening');
  site.listen(0,'127.0.0.1'); await once(site,'listening');
  app = await startApplication({mode:'chromium',headless:true,chromiumNetLog:raw});
  next('idle'); await delay(4000);
  next('local-task');
  const ws = await cli('createWorkspace',{name:'privacy fixture',agentName:'privacy test'});
  const page = await cli('openPage',{workspaceId:ws.workspaceId,url:'http://127.0.0.1:'+site.address().port});
  let complete = false;
  for (let i=0; i<20 && !complete; i++) complete = (await cli('observe',page)).text.includes('Fixture result');
  assert.ok(complete, 'fixture must attempt both requests and complete');
  await cli('finishWorkspace',{workspaceId:ws.workspaceId,keepPageIds:[],operationId:'privacy-fixture-end'});
  if (process.env.OPEN_BROWSER_PRIVACY_AUDIT_UPDATE_HELP === '1') {
    next('update-help');
    const info = await app.sharedContext.newPage();
    await info.goto('chrome://settings/help');
    await delay(2500);
  }
  await app.close(); app = null;
  const log = JSON.parse(await readFile(raw,'utf8'));
  const names = log.constants.logEventTypes;
  const offset = Number(log.constants.timeTickOffset);
  assert.ok(Number.isFinite(offset));
  const counts = {};
  const sockets = {};
  const counted = new Set();
  const attempts = new Map();
  const connected = {};
  for (const event of log.events) {
    const when = Number(event.time) + offset;
    const phase = phases.findLast(item => item.at <= when)?.name || 'startup';
    const url = URL.parse(event.params?.url || '');
    if (event.source?.type === log.constants.logSourceType.URL_REQUEST && url && ['http:','https:','ws:','wss:'].includes(url.protocol)) {
      const key = event.source.id + ':' + url.hostname;
      if (counted.has(key)) continue;
      counted.add(key);
      const group = counts[phase] ||= {};
      group[url.hostname] = (group[url.hostname] || 0) + 1;
    }
    if (event.type === names.TCP_CONNECT_ATTEMPT && typeof event.params?.address === 'string') {
      const group = sockets[phase] ||= {};
      group[event.params.address] = (group[event.params.address] || 0) + 1;
      attempts.set(event.source.id, event.params.address);
    }
    if (event.type === names.TCP_CONNECT_ATTEMPT && event.phase === log.constants.logEventPhase.PHASE_END) {
      const address = attempts.get(event.source.id);
      if (address && !event.params?.net_error) {
        const group = connected[phase] ||= {};
        group[address] = (group[address] || 0) + 1;
      }
      attempts.delete(event.source.id);
    }
  }
  assert.equal(received['local-task']?.approved?.bodyBytes, Buffer.byteLength(marker));
  for (const row of Object.values(received)) assert.equal(row.unapproved?.connections || 0, 0);
  if (isolated) for (const group of Object.values(connected))
    for (const address of Object.keys(group)) assert.match(address, /^(127\.|\[::1\]:)/);
  assert.ok(counts['local-task']?.['127.0.0.1'] > 0,'NetLog must register the local test request');
  const nonLocalNodeConnections = nodeConnections.filter(({address}) =>
    !address.startsWith('127.') && address !== '::1' && address !== 'localhost');
  assert.equal(nonLocalNodeConnections.length, 0, 'Node must not open a non-local TCP connection');
  console.log(JSON.stringify({platform:process.platform,scope:'Chromium NetLog and host Node TCP connections',
    phases:phases.map(p=>p.name),requestsByHost:counts,isolated,tcpConnectionAttempts:sockets,successfulTcpAttempts:connected,received,nodeConnections}));
} finally {
  await app?.close();
  denied.closeAllConnections();
  await new Promise(resolve=>denied.close(resolve));
  site.closeAllConnections();
  await new Promise(resolve=>site.close(resolve));
  await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:250});
}
