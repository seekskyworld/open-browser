import assert from 'node:assert/strict';
import test from 'node:test';
import { launchBrowser } from './control.mjs';
import { pageActivity } from './page-activity.mjs';

test('agent activity labels remain readable and disappear with the active input', async t => {
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce', viewport: {width: 640, height: 320} });
  const origin = 'http://activity.test';
  await page.route(origin + '/', route => route.fulfill({ contentType: 'text/html', body: '<button>Save</button>' }));
  await page.goto(origin);
  const effects = pageActivity();
  effects.track(page, await page.context().newCDPSession(page), 'w', 'p');
  const update = (mode, generation, running) => effects.update({
    workspaceId: 'w', pages: [{pageId: 'p', origin}], mode, controlGeneration: generation,
    activity: {running: running ? [{pageId: 'p', state: 'running'}] : []},
  });
  const target = (x, actionKind) => effects.target({
    workspaceId: 'w', pageId: 'p', origin, x, y: 64, actionKind, controlGeneration: 'first',
  });
  const cursor = page.locator('[data-open-browser-agent-cursor]');
  update('agent', 'first', true);
  target(80, 'click');
  await cursor.waitFor();
  assert.equal(await cursor.textContent(), 'Agent · 点击');
  assert.equal(await cursor.evaluate(el => getComputedStyle(el).clipPath), 'none');
  assert.equal(await cursor.evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  const firstCursor = await cursor.elementHandle();
  target(615, 'hover');
  await page.waitForFunction(() => document.querySelector('[data-open-browser-agent-cursor]')?.textContent.includes('悬停'));
  assert.ok(await firstCursor.evaluate(el => el.isConnected));
  assert.ok(await cursor.evaluate(el => el.lastElementChild.getBoundingClientRect().right <= innerWidth));
  update('agent', 'first', false);
  target(70, 'drag');
  await cursor.waitFor({state: 'detached'});
  const edge = page.locator('[data-open-browser-activity]');
  await page.locator('[data-open-browser-activity="idle"]').waitFor();
  assert.equal(await edge.evaluate(el => el.getAnimations().length), 0);
  update('transferring', 'second', false);
  await edge.waitFor({state: 'detached'});
  update('human', 'second', false);
  update('agent', 'third', true);
  await page.locator('[data-open-browser-activity="running"]').waitFor();
  target(70, 'drag');
  await effects.release('p');
  assert.equal(await page.locator('[data-open-browser-target], [data-open-browser-activity], [data-open-browser-agent-cursor]').count(), 0);
});
