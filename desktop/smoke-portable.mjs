import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.argv[2]) throw new Error('Expected the extracted open-browser directory.');
const bundle = path.resolve(process.argv[2]), app = path.join(bundle, 'app');
const windows = process.platform === 'win32';
const runtime = path.join(bundle, 'node', windows ? 'node.exe' : 'bin/node');
const state = await mkdtemp(path.join(tmpdir(), 'ob-package-'));
const env = { ...process.env, OPEN_BROWSER_STATE_DIR: state };
delete env.OPEN_BROWSER_CLIENT_TOKEN_FILE;
const site = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<title>open-browser test</title><h1>Package smoke test</h1>');
});
let service, stopped;
async function shutdown() {
  service.stdin.end();
  const timeout = setTimeout(() => service.kill('SIGKILL'), 10_000);
  try { return await stopped; } finally { clearTimeout(timeout); }
}
async function cli(method, params = {}) {
  const command = spawn(runtime, [path.join(app, 'cli.mjs'), method], { env, cwd: state, stdio: ['pipe', 'pipe', 'inherit'] });
  const exit = once(command, 'close');
  let result = '';
  command.stdout.setEncoding('utf8').on('data', chunk => { result += chunk; });
  command.stdin.end(JSON.stringify(params));
  assert.equal((await exit)[0], 0, method);
  return JSON.parse(result);
}
try {
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  // The private channel provides readiness and a graceful exit on EOF on both operating systems.
  service = spawn(runtime, [path.join(app, 'service.mjs'), '--chromium', '--headless', '--desktop-bar'], {
    cwd: state, env, stdio: ['pipe', 'pipe', 'inherit'],
  });
  stopped = once(service, 'close');
  const lines = createInterface({ input: service.stdout });
  const controller = new AbortController();
  try {
    await Promise.race([
      (async () => { for await (const line of lines) if (JSON.parse(line).ready) return; throw new Error('Service ended before ready'); })(),
      delay(180_000, null, { signal: controller.signal }).then(() => { throw new Error('Launch timed out'); }),
    ]);
  } finally { controller.abort(); }
  const w = await cli('createWorkspace', { name: 'Portable verification' });
  const page = await cli('openPage', { workspaceId: w.workspaceId, url: 'http://127.0.0.1:' + site.address().port });
  assert.match((await cli('observe', page)).text, /Package smoke test/);
  await cli('closeWorkspace', { workspaceId: w.workspaceId });
  assert.deepEqual(await cli('listWorkspaces'), []);
  assert.equal((await shutdown())[0], 0);
  console.log('Packaged runtime, Chromium, extension bridge, local service and CLI passed.');
} finally {
  if (service && service.exitCode === null && service.signalCode === null) await shutdown();
  site.closeAllConnections();
  await new Promise(resolve => site.close(resolve));
  await rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
