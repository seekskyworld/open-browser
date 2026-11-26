import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceScheduler } from './scheduler.mjs';

test('a waiting workspace gets the next rotation and cancelled requests release their place', async () => {
  const scheduler = new WorkspaceScheduler(1);
  const controller = new AbortController();
  const run = (workspace, fn, signal = controller.signal) => scheduler.run(workspace, fn, signal, performance.now());
  const holding = Promise.withResolvers();
  const seen = [];
  const held = run('busy', () => holding.promise);
  const jobs = [1,2,3].map(i => run('busy', () => seen.push(i)));
  const short = run('short', () => seen.push('short'));
  const cancel = new AbortController();
  const cancelled = run('cancelled', () => assert.fail('cancelled request dispatched'), cancel.signal);
  cancel.abort();
  await assert.rejects(cancelled, {code:'operation_cancelled'});
  holding.resolve();
  await Promise.all([held,short,...jobs]);
  assert.deepEqual(seen,[1,'short',2,3]);
  assert.equal(scheduler.snapshot(0).active,0);
});

test('low memory lowers admission and separate recovery threshold restores slots', () => {
  let free = 90 * 1048576;
  const scheduler = new WorkspaceScheduler(4, {lowMemoryMiB:100, availableBytes:() => free});
  scheduler.refreshLimit(1000);
  assert.equal(scheduler.limit,2);
  free = 120 * 1048576;
  scheduler.refreshLimit(2000);
  assert.equal(scheduler.limit,2);
  free = 170 * 1048576;
  scheduler.refreshLimit(3000);
  assert.equal(scheduler.limit,4);
});
