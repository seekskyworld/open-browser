#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultWaitMs = 10_000;
const retryDelayMs = 150;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseErrorCode(stderr) {
  try {
    const response = JSON.parse(stderr.trim());
    return response?.error?.code;
  } catch {
    return undefined;
  }
}

async function executable(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function detached(command, args, options = {}) {
  const child = spawn(command, args, { ...options, detached: true, stdio: 'ignore' });
  child.unref();
}

async function startLocalBrowser(root) {
  const appBundle = process.platform === 'darwin' && path.basename(root) === 'app'
    ? path.resolve(root, '../../../')
    : undefined;
  if (appBundle?.endsWith('.app')) {
    detached('open', ['-g', appBundle]);
    return;
  }

  const portableRoot = path.resolve(root, '..');
  const portableLauncher = process.platform === 'win32'
    ? path.join(portableRoot, 'open-browser.cmd')
    : path.join(portableRoot, 'open-browser');
  if (await executable(portableLauncher)) {
    if (process.platform === 'win32') {
      detached(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${portableLauncher}"`], { cwd: portableRoot });
    } else {
      detached(portableLauncher, [], { cwd: portableRoot });
    }
    return;
  }

  const service = path.join(root, 'service.mjs');
  if (await access(service).then(() => true, () => false)) {
    detached(process.execPath, [service, '--chromium'], { cwd: root });
    return;
  }

  throw new Error('OPEN_BROWSER_APP_NOT_FOUND');
}

function waitLimit() {
  const value = Number(process.env.OPEN_BROWSER_AUTOSTART_TIMEOUT_MS ?? defaultWaitMs);
  return Number.isFinite(value) ? Math.max(1_000, Math.min(30_000, value)) : defaultWaitMs;
}

async function run(node, root, args, input) {
  return new Promise(resolve => {
    const child = spawn(node, [path.join(root, 'cli.mjs'), ...args], {
      cwd: root,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', error => resolve({ code: 1, stdout: '', stderr: JSON.stringify({ error: { code: 'CLI_START_FAILED', message: error.message } }) + '\n' }));
    child.once('close', code => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    child.stdin.end(input);
  });
}

async function waitForService(node, root) {
  const deadline = Date.now() + waitLimit();
  while (Date.now() < deadline) {
    const probe = await run(node, root, ['capabilities'], '{}\n');
    const code = parseErrorCode(probe.stderr);
    if (probe.code === 0) return true;
    if (!['SERVICE_UNAVAILABLE', 'not_ready'].includes(code)) return false;
    await sleep(retryDelayMs);
  }
  return false;
}

export async function invoke({ node, root, args, input, start = startLocalBrowser }) {
  const first = await run(node, root, args, input);
  if (first.code === 0) return first;
  const errorCode = parseErrorCode(first.stderr);
  if (!['SERVICE_UNAVAILABLE', 'not_ready'].includes(errorCode) || process.env.OPEN_BROWSER_AUTOSTART === '0') return first;
  if (errorCode === 'SERVICE_UNAVAILABLE') {
    try { await start(root); } catch { return first; }
  }
  if (!await waitForService(node, root)) return first;
  return run(node, root, args, input);
}

async function main() {
  const [root, ...args] = process.argv.slice(2);
  if (!root) throw new Error('OPEN_BROWSER_CLI_ROOT_REQUIRED');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const result = await invoke({ node: process.execPath, root, args, input: Buffer.concat(chunks) });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(JSON.stringify({ error: { code: error.code ?? 'CLI_BOOTSTRAP_FAILED', message: error.message } }) + '\n');
    process.exitCode = 1;
  });
}
