import test from 'node:test';
import assert from 'node:assert/strict';
import { startStudio } from './index.mjs';
import { BrowserService } from '../engine-service.mjs';
import { launchBrowser } from '../control.mjs';

test('studio pairs once; managed demo site requires a real authenticated session', async t => {
  const studio = await startStudio({ call: async method => method });
  t.after(() => studio.close());
  const { origin, hash } = new URL(studio.url);
  const demo = new URL(studio.demoUrl);
  const post = (route, body, headers = {}) => fetch(origin + route, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  assert.equal((await post('/call', { method: 'listWorkspaces' })).status, 403);
  assert.equal((await post('/pair', { key: hash.slice(1) }, { Origin: demo.origin })).status, 403);
  const pairing = await post('/pair', { key: hash.slice(1) });
  assert.equal(pairing.status, 200);
  const { access } = await pairing.json();
  assert.equal((await post('/pair', { key: hash.slice(1) })).status, 403);
  assert.equal((await post('/call', { method: 'listWorkspaces' }, { Authorization: 'Bearer ' + access })).status, 200);
  assert.equal((await fetch(demo.origin + '/account', { redirect: 'manual' })).status, 303);
  const login = (password, headers = {}) => fetch(studio.demoUrl, {
    method: 'POST', redirect: 'manual', headers: { Origin: demo.origin, ...headers },
    body: new URLSearchParams({ username: studio.demoAccount.username, password }),
  });
  assert.equal((await login('wrong')).status, 401);
  assert.equal((await login(studio.demoAccount.password, { Origin: origin })).status, 403);
  const response = await login(studio.demoAccount.password);
  assert.equal(response.status, 303);
  const cookie = response.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly/);
  const headers = { Cookie: cookie.split(';')[0], Origin: demo.origin };
  const account = await fetch(demo.origin + '/account', { headers });
  assert.equal(account.status, 200);
  assert.ok((await account.text()).includes(studio.demoAccount.username));
  const logout = await fetch(demo.origin + '/logout', { method: 'POST', redirect: 'manual', headers });
  assert.equal(logout.status, 303);
  assert.equal((await fetch(demo.origin + '/account', { redirect: 'manual', headers })).status, 303);
});

test('control window runs automatic and missing-credential flows and hands back the same page', async t => {
  const browser = await launchBrowser();
  const engine = new BrowserService(browser);
  const studio = await startStudio({ call: (method, params) => engine.call(method, params, 'local') });
  t.after(async () => { await studio.close(); await engine.shutdown(); await browser.close(); });
  const window = await browser.newPage();
  window.setDefaultTimeout(8000);
  await window.goto(studio.url);
  await window.getByText('本机服务已连接').waitFor();
  await window.getByRole('button', { name: '自动登录', exact: true }).click();
  await window.locator('#snapshot').filter({ hasText: '我的账号' }).waitFor();
  assert.equal(await window.locator('#credential-view').isVisible(), false);
  await window.getByRole('button', { name: '接管页面' }).click();
  await window.locator('#mode').filter({ hasText: '用户控制' }).waitFor();
  await window.getByRole('button', { name: '交回 Agent' }).click();
  await window.getByRole('button', { name: '读取页面' }).click();
  await window.locator('#snapshot').filter({ hasText: '我的账号' }).waitFor();
  await window.getByRole('button', { name: '新建工作区' }).click();
  await window.getByRole('button', { name: '测试缺少密码' }).click();
  await window.getByRole('heading', { name: '需要补充密码' }).waitFor();
  await window.getByRole('button', { name: '填入演示密码' }).click();
  await window.getByRole('button', { name: '补充并继续' }).click();
  await window.locator('#snapshot').filter({ hasText: '我的账号' }).waitFor();
  assert.equal(await window.locator('#credential-view').isVisible(), false);
  assert.equal(await window.locator('#count').textContent(), '2');
});
