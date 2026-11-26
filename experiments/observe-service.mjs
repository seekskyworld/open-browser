// Test-only service. Chromium allocates its own disposable profile for every run.
import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { startApplication } from '../service.mjs';
import { engineExecutable } from '../runtime.mjs';
import { inspectDocument } from '../page-observation.mjs';

function rustObserver(port) {
  const executable = fileURLToPath(new URL('./open-browser-observer/target/release/open-browser-observer' +
    (process.platform === 'win32' ? '.exe' : ''), import.meta.url));
  const child = spawn(executable, [String(port)], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let seq = 0;
  let stopped = false;
  function stop() {
    stopped = true;
    for (const request of pending.values()) request.reject(new Error('observer_unavailable'));
    pending.clear();
    child.kill();
  }
  child.on('error', stop);
  child.on('exit', stop);
  child.stdin.on('error', stop);
  const replies = createInterface({ input: child.stdout });
  replies.on('line', line => {
    let result;
    try { result = JSON.parse(line); } catch { stop(); return; }
    const request = pending.get(result.id);
    if (!request) return;
    pending.delete(result.id);
    if (result.error) request.reject(Object.assign(new Error(result.error), {code: result.error}));
    else request.resolve(result.summary);
  });
  return {
    stop,
    async observe(tab, origins) {
      if (stopped || !tab.targetId) throw new Error('observer_unavailable');
      const id = ++seq;
      const timer = setTimeout(stop, 10_000);
      try {
        return await new Promise((resolve, reject) => {
          pending.set(id, {resolve, reject});
          child.stdin.write(JSON.stringify({id, targetId: tab.targetId, origins}) + '\n');
        });
      } finally { clearTimeout(timer); pending.delete(id); }
    },
  };
}

// The previous Playwright implementation is kept here as a reproducible control.
async function playwrightSummary(tab) {
  const snapshot = await tab.page.evaluateHandle(inspectDocument);
  let summary;
  try {
    summary = await snapshot.getProperty('summary');
    return await summary.jsonValue();
  } finally {
    await Promise.all([snapshot, summary].filter(Boolean).map(h => h.dispose().catch(() => {})));
  }
}

export async function startObserveExperiment(mode) {
  if (!['playwright','rust','direct'].includes(mode)) throw new Error('Expected playwright, rust or direct');
  const root = await realpath(tmpdir());
  const base = await realpath(process.env.OPEN_BROWSER_STATE_DIR || '.');
  const relative = path.relative(root, base);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Set OPEN_BROWSER_STATE_DIR to a fresh directory under the OS temporary directory');
  let worker;
  async function launchServiceBrowser() {
    const browser = await chromium.launch({ executablePath: await engineExecutable(), chromiumSandbox: true, headless: true,
      args: ['--enable-automation', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'] });
    try {
      if (mode === 'rust') {
        const session = await browser.newBrowserCDPSession();
        const command = await session.send('Browser.getBrowserCommandLine');
        await session.detach();
        const dir = command.arguments.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
        const port = Number((await readFile(path.join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_debug_port');
        worker = rustObserver(port);
        browser.once('disconnected', worker.stop);
      }
      return browser;
    } catch (error) { await browser.close(); throw error; }
  }
  const readOnlyObserver = mode === 'playwright' ? playwrightSummary :
    mode === 'rust' ? (tab, origins) => worker.observe(tab, origins) : undefined;
  return startApplication({headless: true, launchServiceBrowser, readOnlyObserver});
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const app = await startObserveExperiment(process.argv[2]);
  process.once('SIGTERM', () => void app.close());
  process.once('SIGINT', () => void app.close());
  console.log('open-browser ready');
  await app.closed;
}
