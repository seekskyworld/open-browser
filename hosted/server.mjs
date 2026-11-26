import { timingSafeEqual } from 'node:crypto';
import { chmod, lstat, readFile, unlink } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Directory } from './directory.mjs';

async function credentials(config) {
  const entries = [];
  async function add(id, file) {
    const token = (await readFile(file, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid_token_config');
    const key = Buffer.from('Bearer ' + token);
    if (entries.some(entry => entry.id === id || timingSafeEqual(entry.key, key))) throw new Error('duplicate_principal');
    entries.push({id, key});
  }
  await add(null, config.adminTokenFile);
  for (const {id, tokenFile} of config.tenants) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('invalid_tenant');
    await add(id, tokenFile);
  }
  if (!config.nodes.length || config.nodes.some(n => n.tenants.some(id => !entries.some(e => e.id === id))))
    throw new Error('invalid_node_tenants');
  return entries;
}

function reply(res, status, body) {
  res.writeHead(status, {'content-type':'application/json', 'cache-control':'no-store'});
  res.end(JSON.stringify(body));
}

async function bind(server, socket) {
  const info = await lstat(socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (info) {
    if (!info.isSocket()) throw new Error('invalid_socket_path');
    const live = await new Promise((resolve, reject) => {
      const probe = net.connect(socket);
      probe.once('connect', () => { probe.end(); resolve(true); });
      probe.once('error', err => err.code === 'ECONNREFUSED' ? resolve(false) : reject(err));
    });
    if (live) throw new Error('coordinator_already_running');
    await unlink(socket);
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => { server.removeListener('error', reject); resolve(); });
  });
  await chmod(socket, 0o600);
}

export async function startCoordinator(directory) {
  const home = path.resolve(directory);
  const info = await lstat(home);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077))
    throw new Error('private_directory_required');
  const config = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'));
  const principals = await credentials(config);
  const digestKey = (await readFile(config.digestKeyFile, 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/.test(digestKey)) throw new Error('invalid_digest_key');
  // The OS releases this exclusive database lock if the coordinator process dies.
  const lock = new DatabaseSync(path.join(home, 'coordinator.lock.sqlite'), { timeout:0 });
  let directoryAPI, server, closing = false;
  const pending = new Set();
  try {
    lock.exec('BEGIN EXCLUSIVE');
    server = http.createServer({ requestTimeout:20_000, headersTimeout:10_000 }, async (req, res) => {
      const fail = (status, code) => reply(res, status, {error:{code}});
      const admin = req.url === '/v1/admin';
      if (req.method !== 'POST' || (!admin && req.url !== '/v1/call')) return fail(404, 'not_found');
      const presented = Buffer.from(req.headers.authorization || '');
      const principal = principals.find(({key}) => key.length === presented.length && timingSafeEqual(key, presented));
      if (req.headers.origin !== undefined || !principal || admin !== (principal.id === null)) return fail(403, 'forbidden');
      if (closing || !directoryAPI) return fail(503, 'not_ready');
      try {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 256 * 1024) return fail(413, 'request_too_large');
          chunks.push(chunk);
        }
        const frame = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof frame?.method !== 'string') return fail(400, 'invalid_request');
        const args = frame.params ?? {};
        if (!args || typeof args !== 'object' || Array.isArray(args)) return fail(400, 'invalid_params');
        if (admin && frame.method !== 'review') return fail(400, 'unknown_method');
        if (closing) return fail(503, 'not_ready');
        const call = admin ? directoryAPI.review(args) : directoryAPI.request(principal.id, frame.method, args);
        pending.add(call);
        try { reply(res, 200, {result:await call}); }
        finally { pending.delete(call); }
      } catch (error) {
        const code = typeof error.code === 'string' && /^[a-z_]{1,64}$/i.test(error.code) ? error.code : 'invalid_request';
        fail(400, code);
      }
    });
    await bind(server, path.join(home, 'control.sock'));
    directoryAPI = new Directory(home, config, Buffer.from(digestKey, 'hex'));
    await directoryAPI.probeAll();
    let closed;
    return {close() {
      if (!closed) {
        closing = true;
        closed = (async () => {
          await new Promise(resolve => server.close(resolve));
          await Promise.allSettled([...pending]);
          directoryAPI.close();
          lock.close();
        })();
      }
      return closed;
    }};
  } catch (error) {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    directoryAPI?.close();
    lock.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const coordinator = await startCoordinator(process.argv[2] || process.env.OPEN_BROWSER_HOSTED_DIR);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void coordinator.close(); });
    console.log('open-browser hosted ready');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
