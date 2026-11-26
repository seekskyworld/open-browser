import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { launchBrowser, runBatch } from './control.mjs';

test('the app launches its private engine with fresh disposable profiles', async () => {
  const root = await realpath(fileURLToPath(new URL('./.open-browser/engine/', import.meta.url)));
  const profiles = [];
  const browsers = [];
  try {
    for (let i = 0; i < 2; i++) {
      const browser = await launchBrowser();
      browsers.push(browser);
      const session = await browser.newBrowserCDPSession();
      const { arguments: args } = await session.send('Browser.getBrowserCommandLine');
      assert.ok((await realpath(args[0])).startsWith(root + path.sep));
      const userDir = args.filter(arg => arg.startsWith('--user-data-dir='));
      assert.equal(userDir.length, 1);
      const profile = await realpath(userDir[0].slice('--user-data-dir='.length));
      assert.equal(path.dirname(profile), await realpath(tmpdir()));
      profiles.push(profile);
    }
    assert.notEqual(profiles[0], profiles[1]);
  } finally {
    await Promise.all(browsers.map(browser => browser.close()));
  }
  for (const profile of profiles)
    await assert.rejects(stat(profile), { code: 'ENOENT' });
});

test('isolated ordered batches, bounded overlap and independent failures', async t => {
  let active = 0;
  let peak = 0;
  const server = createServer((req, res) => {
    if (req.url !== '/form') {
      res.writeHead(404).end();
      return;
    }
    peak = Math.max(peak, ++active);
    setTimeout(() => {
      --active;
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(`<!doctype html><input id="name"><button>Submit</button><output></output>
        <script>
          const prior = localStorage.getItem('owner') || document.cookie || 'empty';
          document.querySelector('button').onclick = () => {
            const value = document.querySelector('input').value;
            localStorage.setItem('owner', value);
            document.cookie = 'owner=' + value;
            document.querySelector('output').textContent = prior + ':' + value;
          };
        </script>`);
    }, 200);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const url = `http://127.0.0.1:${server.address().port}/form`;
  const tasks = Array.from({ length: 8 }, (_, i) => ({
    id: String(i), url, steps: [
      { op: 'fill', selector: '#name', value: String(i) },
      { op: 'click', selector: 'button' },
      { op: 'read', selector: 'output' },
    ],
  }));

  // Warm up once, then alternate run order to reduce cold-start bias.
  await runBatch(browser, { tasks: tasks.slice(0, 1) });
  const elapsed = { 1: [], 4: [] };
  for (const concurrency of [1, 4, 4, 1, 1, 4]) {
    peak = 0;
    const start = performance.now();
    const results = await runBatch(browser, { tasks, concurrency });
    elapsed[concurrency].push(Math.round(performance.now() - start));
    assert.deepEqual(results, tasks.map(task => ({
      id: task.id, ok: true, reads: ['empty:' + task.id],
    })));
    if (concurrency === 1) assert.equal(peak, 1);
    else assert.ok(peak > 1 && peak <= concurrency, 'server observed bounded overlap');
    assert.equal(browser.contexts().length, 0);
  }
  t.diagnostic(JSON.stringify({ browser: browser.version(), elapsedMs: elapsed }));
  const broken = { ...tasks[0], steps: [{ op: 'click', selector: '[' }] };
  const [failed, passed] = await runBatch(browser, { tasks: [broken, tasks[1]] });
  assert.equal(failed.ok, false);
  assert.equal(failed.stepIndex, 0);
  assert.deepEqual(passed.reads, ['empty:1']);
  assert.equal(browser.contexts().length, 0);
});
