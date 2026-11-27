import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { launchBrowser } from './control.mjs';
import { managedInput } from './managed-input.mjs';
import { handOff, returnToAgent } from './workspace-lifecycle.mjs';

test('only the live managed page session can report a blocked physical press', async () => {
  const sessions = [], hints = [];
  const setGuard = managedInput({
    async newCDPSession() {
      const session = new EventEmitter();
      session.send = async (method, args) => {
        assert.equal(method, 'Input.setOpenBrowserInputGuard');
        assert.equal(typeof args.enabled, 'boolean');
      };
      session.detach = async () => { session.detached = true; };
      sessions.push(session);
      return session;
    },
  }, tab => hints.push(tab.id));
  const tab = {id:'page', page:{isClosed:() => false}};
  await setGuard(tab, true);
  await setGuard(tab, true);
  sessions[0].emit('Input.openBrowserInputBlocked');
  await setGuard(tab, false);
  let losses = 0;
  await setGuard(tab, true, () => { losses++; });
  sessions[0].emit('Input.openBrowserInputBlocked');
  sessions[1].emit('Input.openBrowserInputBlocked');
  assert.deepEqual(hints, ['page', 'page']);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].detached, true);
  sessions[1].emit('close');
  assert.equal(losses, 1);
  await setGuard(tab, true);
  assert.equal(sessions.length, 3);
});

test('an unavailable guard rejects the operation and the ordinary page still accepts input', async t => {
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<button onclick="this.textContent=1">0</button>');
  const setGuard = managedInput(page.context(), () => {});
  // Test the missing-command path on stock Chromium even when a patched
  // engine is used for the separate native acceptance run.
  const session = await page.context().newCDPSession(page);
  let available;
  try { await session.send('Input.setOpenBrowserInputGuard', {enabled:false}); available = true; }
  catch (error) { assert.match(error.message, /wasn.t found|not found/i); }
  finally { await session.detach(); }
  if (available) {
    await setGuard({page}, true);
    await setGuard({page}, false);
    return;
  }
  await assert.rejects(setGuard({page}, true), {code:'input_guard_unavailable'});
  await page.getByRole('button').click();
  assert.equal(await page.getByRole('button').textContent(), '1');
});

test('the stock Chromium fallback blocks physical input and opens one Agent dispatch window', async t => {
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<button onclick="this.textContent=String(Number(this.textContent)+1)">0</button>');
  const setGuard = managedInput(page.context(), () => {}, {allowFallback: true});

  await setGuard({page}, true);
  if (setGuard.mode({page}) !== 'fallback') {
    await setGuard({page}, false);
    t.skip('the selected Chromium already provides the native input guard');
    return;
  }

  await page.mouse.click(20, 20);
  assert.equal(await page.getByRole('button').textContent(), '0');
  await setGuard.withAgentInput({page}, () => page.getByRole('button').click());
  assert.equal(await page.getByRole('button').textContent(), '1');
  await page.goto('data:text/html,<button onclick="this.textContent=String(Number(this.textContent)+1)">0</button>');
  await page.mouse.click(20, 20);
  assert.equal(await page.getByRole('button').textContent(), '0');
  await setGuard.withAgentInput({page}, () => page.getByRole('button').click());
  assert.equal(await page.getByRole('button').textContent(), '1');
  await setGuard({page}, false);
  await page.mouse.click(20, 20);
  assert.equal(await page.getByRole('button').textContent(), '2');
});

test('a failed multi-tab guard rolls back before the agent can act; handoff waits for unlock', async () => {
  const browser = await launchBrowser();
  try {
    const {BrowserService} = await import('./engine-service.mjs');
    const service = new BrowserService(browser);
    try {
      const owner = 'tester';
      const view = await service.call('createWorkspace', {name:'Guard test'}, owner);
      const ws = service.workspaces.get(view.workspaceId);
      const first = service.register(ws, await ws.context.newPage());
      const second = service.register(ws, await ws.context.newPage());
      await handOff(service, ws, undefined, false);
      const guarded = new Set();
      let rejectSecond = true, failUnlock = false, pauseUnlock;
      service.setInputGuard = async (_ws, tab, enabled) => {
        assert.equal(ws.mode, 'transferring');
        if (enabled && rejectSecond && tab === second) throw Error('simulated_failure');
        if (enabled) guarded.add(tab);
        else {
          if (failUnlock && tab === second) throw Error('temporary_detach_failure');
          if (pauseUnlock) await pauseUnlock;
          guarded.delete(tab);
        }
      };
      const stale = ws.generation;
      await assert.rejects(returnToAgent(service, ws, stale), /simulated_failure/);
      assert.equal(ws.mode, 'human');
      assert.equal(guarded.size, 0);
      rejectSecond = false;
      await assert.rejects(returnToAgent(service, ws, stale), {code:'stale_control'});
      await returnToAgent(service, ws, ws.generation);
      assert.deepEqual(guarded, new Set([first, second]));
      failUnlock = true;
      await assert.rejects(handOff(service, ws, undefined, false), /temporary_detach_failure/);
      assert.equal(ws.mode, 'transferring');
      assert.ok(ws.unlockPending);
      failUnlock = false;
      let unlock;
      pauseUnlock = new Promise(resolve => { unlock = resolve; });
      const transfer = handOff(service, ws, undefined, false);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(ws.mode, 'transferring');
      unlock();
      await transfer;
      assert.equal(ws.mode, 'human');
      assert.equal(guarded.size, 0);
    } finally { await service.shutdown(); }
  } finally { await browser.close(); }
});
