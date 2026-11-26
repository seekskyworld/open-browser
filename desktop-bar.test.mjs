import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { OpenBrowserClient } from './sdk.mjs';

async function until(description, get) {
  const deadline = Date.now() + 12_000;
  do {
    const value = await get();
    if (value) return value;
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail('Timed out waiting for ' + description);
}

test('desktop bar follows the foreground tab and validates clicks against the current window and lease', {
  skip: process.platform !== 'darwin' && 'Native bar is a macOS feature',
}, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ob-bar-'));
  const root = fileURLToPath(new URL('.', import.meta.url));
  const child = spawn(process.execPath, ['service.mjs', '--chromium', '--desktop-bar', '--headless'], {
    cwd: root, env: { ...process.env, OPEN_BROWSER_STATE_DIR: dir },
  });
  const exited = once(child, 'close');
  const site = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Desktop Bar Fixture</title><main>Test workspace</main>');
  });
  t.after(async () => {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 6000);
    try { await exited; } finally { clearTimeout(deadline); }
    if (site.listening) {
      site.closeAllConnections();
      await new Promise(resolve => site.close(resolve));
    }
    await rm(dir, { force: true, recursive: true });
  });
  const frames = [];
  const diagnostics = [];
  child.stderr.on('data', chunk => diagnostics.push(chunk));
  createInterface({ input: child.stdout }).on('line', line => {
    try { frames.push(JSON.parse(line)); } catch { /* Ignore non-protocol diagnostics. */ }
  });
  const waitFrame = (description, match, from = 0) => until(description, () => {
    const frame = frames.slice(from).find(match);
    if (!frame && (child.exitCode !== null || child.signalCode)) {
      assert.fail('Service exited before ' + description + ': ' + Buffer.concat(diagnostics).toString().slice(-800));
    }
    return frame;
  });
  await waitFrame('ready', f => f.ready === true);
  const ordinary = f => f.event === 'desktop.bar' && f.bar === null;
  await waitFrame('hidden bar on ordinary new tab', ordinary);
  const api = new OpenBrowserClient({
    socketPath: path.join(dir, 'open-browser.sock'), tokenPath: path.join(dir, 'open-browser.token'),
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const { workspaceId } = await api.createWorkspace({ name: 'Bar test', agentName: 'bar-fixture' });
  const page = await api.openPage(workspaceId, 'http://127.0.0.1:' + site.address().port);
  const active = (mode, from) => waitFrame(mode + ' active managed tab', f => f.event === 'desktop.bar' &&
    f.bar?.pageId === page.pageId && f.bar.workspaceId === workspaceId && f.bar.mode === mode, from).then(f => f.bar);
  function click(bar, patch = {}) {
    const { workspaceId, pageId, windowId, mode, controlGeneration } = bar;
    child.stdin.write(JSON.stringify({ event: 'desktop.bar.click', workspaceId, pageId,
      windowId, mode, controlGeneration, ...patch }) + '\n');
  }
  let from = frames.length;
  const handoff = await api.handOff(workspaceId);
  const human = await active('human', from);
  assert.equal(human.agentName, 'bar-fixture');
  assert.equal(human.controlGeneration, handoff.controlGeneration);
  assert.ok(Number.isInteger(human.windowId));
  for (const field of ['left', 'top', 'width', 'height', 'viewportWidth']) assert.ok(Number.isFinite(human[field]), field);
  assert.ok(human.width > 0 && human.height > 0 && human.viewportWidth > 0);

  from = frames.length;
  click(human);
  const agent = await active('agent', from);
  assert.notEqual(agent.controlGeneration, human.controlGeneration);
  for (const patch of [{ windowId: agent.windowId + 1 }, { controlGeneration: human.controlGeneration }]) {
    click(agent, patch);
    // Ignored clicks have no acknowledgement. Check over multiple sync intervals.
    for (let i = 0; i < 5; i++) {
      await delay(200);
      const current = await api.getWorkspace(workspaceId);
      assert.equal(current.mode, 'agent');
      assert.equal(current.controlGeneration, agent.controlGeneration);
    }
  }
  from = frames.length;
  click(agent);
  const taken = await active('human', from);
  assert.notEqual(taken.controlGeneration, agent.controlGeneration);
  await assert.rejects(api.observe(page), { code: 'workspace_under_user_control' });
  from = frames.length;
  click(taken);
  const returned = await active('agent', from);
  from = frames.length;
  click(returned, { action: 'delivery' });
  await waitFrame('hidden bar after returning to the ordinary tab', ordinary, from);
  await assert.rejects(api.getWorkspace(workspaceId), { code: 'workspace_not_found' });
});
