// Run against source, or --bundle for the previously built macOS baseline.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { runTestHarness } from './test-harness.mjs';

const socketCounts = {approved:0, other:0};
const sockets = new Set();
function upgrade(server, label) {
  server.on('upgrade', (req, socket) => {
    socketCounts[label]++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    socket.write(Buffer.from([0x81,2,79,75])); // Single UTF-8 frame, "OK"
  });
}
function treeRssMiB() {
  const rows = execFileSync('ps',['-axo','pid=,ppid=,rss='],{encoding:'utf8'}).trim().split('\n')
    .map(row => row.trim().split(/\s+/).map(Number));
  const ids = new Set([process.pid]);
  for (let n=-1; n!==ids.size;) {
    n=ids.size;
    for (const [id,parent] of rows) if (ids.has(parent)) ids.add(id);
  }
  return Math.round(rows.reduce((sum,[id,,rss]) => sum+(ids.has(id)?rss:0),0)/1024);
}
const other = createServer((_req,res) => res.end());
upgrade(other,'other');
other.listen(0,'127.0.0.1'); await once(other,'listening');
const site = createServer((req,res) => {
  if (req.url === '/worker.js') return res.writeHead(200,{'content-type':'text/javascript'}).end("postMessage('ready')");
  if (req.url.startsWith('/asset')) return res.writeHead(200).end('fixture');
  res.writeHead(200,{'content-type':'text/html'}).end(`<button disabled>Loading</button><script>
    async function live(url) {
      return new Promise(resolve => {
        const socket=new WebSocket(url);
        const timer=setTimeout(()=>{socket.close();resolve(false)},2000);
        socket.onmessage=e=>{clearTimeout(timer);socket.close();resolve(e.data==='OK')};
        socket.onclose=socket.onerror=()=>{clearTimeout(timer);resolve(false)};
      });
    }
    (async()=>{
      await Promise.all(Array.from({length:20},(_,i)=>fetch('/asset'+i).then(r=>r.text())));
      const button=document.querySelector('button');
      const ready=Math.round(performance.now());
      const worker=await new Promise(resolve=>{
        try {
          const w=new Worker('/worker.js');
          const finish=ok=>{w.terminate();resolve(ok)};
          w.onmessage=()=>finish(true);w.onerror=()=>finish(false);
        } catch {resolve(false)}
      });
      const [ok,other]=await Promise.all([live('ws://'+location.host+'/updates'),live('ws://127.0.0.1:${other.address().port}/updates')]);
      button.disabled=false;button.textContent='Ready '+ready+' '+Math.round(performance.now())+' '+ok+' '+other+' '+worker;
    })()</script>`);
});
upgrade(site,'approved');
site.listen(0,'127.0.0.1'); await once(site,'listening');
try {
  await runTestHarness({networkCompatibility: async ({open, service}) => {
    // Chromium requires an independent site permission for a native loopback socket.
    // Only the disposable benchmark profile and the positive fixture receive it.
    await service.sharedContext.grantPermissions(['local-network-access'], {origin:'http://127.0.0.1:'+site.address().port});
    const pages=await Promise.all(Array.from({length:4},()=>open('http://127.0.0.1:'+site.address().port)));
    const reports=await Promise.all(pages.map(async page=>{
      for(let i=0;i<30;i++) {
        const text=(await page.observe()).text;
        const result=/Ready (\d+) (\d+) (true|false) (true|false) (true|false)/.exec(text);
        if(result) return {assetMs:Number(result[1]),readyMs:Number(result[2]),live:result[3]==='true',foreign:result[4]==='true',worker:result[5]==='true'};
      }
      throw Error('Timed out waiting for fixture');
    }));
    assert.equal(socketCounts.other,0);
    assert.ok(reports.every(r=>!r.foreign && !r.worker));
    const working=reports.filter(r=>r.live).length;
    if(!process.argv.includes('--baseline')) assert.equal(working,4,JSON.stringify({reports,socketCounts}));
    return {working, pages:4, unauthorizedHandshakes:socketCounts.other,
      workerStarts:reports.filter(r=>r.worker).length,assetsReadyMs:reports.map(r=>r.assetMs),firstActionableMs:reports.map(r=>r.readyMs), treeRssMiB:treeRssMiB()};
  }},Number(process.argv[2] || 3));
} finally {
  for(const socket of sockets) socket.destroy();
  for(const server of [site,other]) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
