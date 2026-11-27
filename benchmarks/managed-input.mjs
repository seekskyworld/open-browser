// Run against a compiled Dev engine in an unlocked desktop session.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright-core';
import { managedInput } from '../managed-input.mjs';

const executablePath = process.argv[2];
if (!executablePath || !process.stdin.isTTY) throw Error('Use an interactive terminal: node benchmarks/managed-input.mjs <chromium-executable>');
const terminal = createInterface({input:process.stdin, output:process.stdout});
const site = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/frame') return res.end('<button onclick="this.textContent=Number(this.textContent)+1">0</button>');
  res.end('<title>open-browser 输入验收</title><button style="padding:40px" onclick="this.textContent=Number(this.textContent)+1">0</button>' +
    '<p>下方为另一来源的页面</p><iframe src="http://localhost:' + site.address().port + '/frame"></iframe>');
});
let browser;
try {
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  browser = await chromium.launch({executablePath, headless:false, chromiumSandbox:true, args:['--site-per-process']});
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = 'http://127.0.0.1:' + site.address().port;
  await page.goto(url);
  const tab = {page};
  let hints = 0;
  const guard = managedInput(context, () => { hints++; });
  const button = page.getByRole('button');
  const framed = page.frameLocator('iframe').getByRole('button');
  const count = async locator => Number(await locator.textContent());
  const human = async (message, target, expected) => {
    await page.bringToFront();
    await terminal.question(message + '，然后回到终端按回车。');
    assert.equal(await count(target), expected);
  };
  await human('请点击主页面的大按钮一次', button, 1);
  await human('请点击子页面的小按钮一次', framed, 1);

  const timings = [];
  for (const enabled of [false, true]) {
    await guard(tab, enabled);
    const startCount = await count(button), latency = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      await button.click();
      latency.push(performance.now() - start);
    }
    assert.equal(await count(button), startCount + 100);
    latency.sort((a,b) => a - b);
    timings.push({guard:enabled, completed:100, p50Ms:latency[49], p95Ms:latency[94]});
  }
  await human('保护已开启，请再次点击大按钮一次', button, 201);
  await human('保护已开启，请再次点击小按钮一次', framed, 1);
  assert.ok(hints >= 2, 'expected native blocked press notifications');
  await framed.click();
  assert.equal(await count(framed), 2);

  const ordinary = await context.newPage();
  await ordinary.goto(url);
  await ordinary.bringToFront();
  await terminal.question('请点击普通标签的大按钮一次，然后回到终端按回车。');
  assert.equal(await count(ordinary.getByRole('button')), 1);
  await guard(tab, false);
  await human('已人工接管，请点击大按钮一次', button, 202);
  console.table(timings);
} finally {
  terminal.close();
  await browser?.close();
  site.closeAllConnections();
  if (site.listening) await new Promise(resolve => site.close(resolve));
}
