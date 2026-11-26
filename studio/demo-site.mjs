import { createServer } from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';

export const randomToken = () => randomBytes(32).toString('base64url');
const host = '127.0.0.1';
const baseHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

export function reply(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { ...baseHeaders, 'Content-Type': type, ...headers }).end(body);
}
export function json(res, status, value) {
  reply(res, status, JSON.stringify(value), 'application/json');
}
export async function readBody(req) {
  const parts = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) throw new Error('request_too_large');
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString('utf8');
}
export async function serve(handler) {
  const server = createServer((req, res) => {
    const authority = host + ':' + server.address().port;
    if (req.headers.host !== authority) return reply(res, 403, 'Forbidden');
    Promise.resolve(handler(req, res, 'http://' + authority)).catch(() => {
      if (!res.headersSent) json(res, 400, { error: 'invalid_request' });
      else res.end();
    });
  });
  server.listen(0, host);
  await once(server, 'listening');
  return {
    origin: 'http://' + host + ':' + server.address().port,
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

function demoDocument(title, body) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · open-browser</title><link rel="icon" type="image/png" href="/open-browser-icon.png"><link rel="stylesheet" href="/demo.css"><main class="login-shell"><header><img src="/open-browser-icon.png" width="28" height="28" alt=""><span>open-browser</span></header>${body}</main></html>`;
}

export async function startDemo() {
  const logo = await readFile(new URL('../browser-extension/icons/open-browser-48.png', import.meta.url));
  const style = await readFile(new URL('./demo.css', import.meta.url));
  const demoAccount = { username: 'demo-' + randomBytes(3).toString('hex'), password: randomToken().slice(0, 16) };
  const salt = randomBytes(16);
  const hash = scryptSync(demoAccount.password, salt, 32);
  const sessions = new Map();
  const cookieName = 'open-browser-demo-' + randomBytes(5).toString('hex');
  const cookiePrefix = cookieName + '=';
  const cookieAttributes = '; HttpOnly; SameSite=Strict; Path=/';
  const form = '<form method="post" action="/login"><label for="username">账号</label><input name="username" id="username" autocomplete="username" required><label for="password">密码</label><input name="password" id="password" type="password" autocomplete="current-password" required><button type="submit">登录</button></form>';
  const viewLogin = invalid => demoDocument('登录', '<p class="kicker">本机验证站</p><h1>登录账号</h1>' + (invalid ? '<p role="alert">账号或密码不正确</p>' : '') + form);
  const site = await serve(async (req, res, origin) => {
    const token = (req.headers.cookie || '').split('; ').find(c => c.startsWith(cookiePrefix))?.slice(cookiePrefix.length);
    const signedIn = (sessions.get(token) || 0) > Date.now();
    if (token && !signedIn) sessions.delete(token);
    const redirect = (location, headers = {}) => reply(res, 303, '', 'text/plain', { Location: location, ...headers });
    if (req.method === 'GET') {
      if (req.url === '/open-browser-icon.png') return reply(res, 200, logo, 'image/png');
      if (req.url === '/demo.css') return reply(res, 200, style, 'text/css');
      if (req.url === '/') return redirect(signedIn ? '/account' : '/login');
      if (req.url === '/login' || req.url === '/login?prompt=login') {
        if (signedIn && req.url === '/login') return redirect('/account');
        return reply(res, 200, viewLogin(false), 'text/html; charset=utf-8', { 'Referrer-Policy': 'same-origin' });
      }
      if (req.url === '/account') {
        if (!signedIn) return redirect('/login');
        const html = demoDocument('我的账号', '<p class="kicker">本机验证站</p><h1>我的账号</h1><p class="identity">当前账号 <strong>' + demoAccount.username + '</strong></p><form method="post" action="/logout"><button type="submit">退出登录</button></form>');
        return reply(res, 200, html, 'text/html; charset=utf-8', { 'Referrer-Policy': 'same-origin' });
      }
    }
    if (req.method === 'POST') {
      if (req.headers.origin !== origin) return reply(res, 403, 'Forbidden');
      if (req.url === '/logout') {
        sessions.delete(token);
        return redirect('/login', { 'Set-Cookie': cookiePrefix + cookieAttributes + '; Max-Age=0' });
      }
      if (req.url === '/login') {
        const values = new URLSearchParams(await readBody(req));
        if (values.get('username') !== demoAccount.username ||
            !timingSafeEqual(scryptSync(values.get('password') || '', salt, 32), hash)) {
          return reply(res, 401, viewLogin(true), 'text/html; charset=utf-8', { 'Referrer-Policy': 'same-origin' });
        }
        sessions.delete(token);
        const session = randomToken();
        const now = Date.now();
        for (const [key, expiry] of sessions) if (expiry <= now) sessions.delete(key);
        sessions.set(session, now + 3600000);
        return redirect('/account', { 'Set-Cookie': cookiePrefix + session + cookieAttributes + '; Max-Age=3600' });
      }
    }
    reply(res, 404, 'Not found');
  });
  return { ...site, demoAccount };
}
