import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { engineExecutable } from './runtime.mjs';
import { chromiumPrivacyArgs } from './privacy-config.mjs';

export async function launchBrowser({ headless = true } = {}) {
  return chromium.launch({
    executablePath: await engineExecutable(),
    args: [...chromiumPrivacyArgs(), ...(headless ? ['--enable-automation'] : ['--window-size=1140,820'])],
    headless,
    chromiumSandbox: true,
  });
}

function validate({ tasks, concurrency = 4 }) {
  if (!Array.isArray(tasks) || !tasks.length)
    throw new Error('tasks must be a nonempty array');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error('concurrency must be an integer between 1 and 16');
  const ids = new Set();
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || !task.id || ids.has(task.id))
      throw new Error('each task needs a unique string id');
    ids.add(task.id);
    if (!URL.canParse(task.url) || !['http:', 'https:'].includes(new URL(task.url).protocol))
      throw new Error('each task needs an HTTP(S) URL');
    if (!Array.isArray(task.steps)) throw new Error('steps must be an array');
    for (const step of task.steps) {
      if (!step || !['fill', 'click', 'read'].includes(step.op) ||
          typeof step.selector !== 'string' || !step.selector.trim())
        throw new Error('each step needs a fill, click or read operation and a selector');
      if (step.op === 'fill' && typeof step.value !== 'string')
        throw new Error('fill needs a string value');
    }
  }
}

async function runTask(browser, task) {
  let context;
  let stage = 'open';
  let stepIndex = null;
  const reads = [];
  try {
    context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    context.setDefaultTimeout(10_000);
    const page = await context.newPage();
    await page.goto(task.url, { waitUntil: 'domcontentloaded' });
    for (const [index, step] of task.steps.entries()) {
      stepIndex = index;
      stage = step.op;
      const target = page.locator(step.selector);
      switch (step.op) {
        case 'fill': await target.fill(step.value); break;
        case 'click': await target.click(); break;
        case 'read': reads.push(await target.innerText()); break;
      }
    }
    return { id: task.id, ok: true, reads };
  } catch (error) {
    // Browser error messages can contain form values, page text and full URLs.
    return { id: task.id, ok: false, stage, stepIndex, reads,
      error: error.name === 'TimeoutError' ? 'timeout' : 'browser_action_failed' };
  } finally {
    if (context) await context.close();
  }
}

// Long-lived callers can reuse one browser across batches. The limit is per batch.
export async function runBatch(browser, batch) {
  validate(batch);
  const { tasks, concurrency = 4 } = batch;
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await runTask(browser, tasks[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let batch;
  try { batch = JSON.parse(input); }
  catch { throw new Error('stdin must contain a JSON batch'); }
  validate(batch);
  const browser = await launchBrowser();
  try {
    const results = await runBatch(browser, batch);
    console.log(JSON.stringify(results));
    if (results.some(result => !result.ok)) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
