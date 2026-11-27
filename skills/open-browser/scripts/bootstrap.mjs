#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';
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

async function wakeExisting(root) {
  try {
    const { pidPath, socketPath } = await import(pathToFileURL(path.join(root, 'paths.mjs')).href);
    const pid = Number((await readFile(pidPath, 'utf8')).trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    const active = await new Promise(resolve => {
      const probe = net.connect(socketPath);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (!active) return false;
    process.kill(pid, 'SIGUSR2');
    return true;
  } catch { return false; }
}

async function startLocalBrowser(root) {
  if (await wakeExisting(root)) return;
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

async function runSession(node, root, args) {
  let probe = await run(node, root, ['capabilities'], '{}\n');
  const errorCode = parseErrorCode(probe.stderr);
  if (probe.code !== 0 && ['SERVICE_UNAVAILABLE', 'not_ready'].includes(errorCode) && process.env.OPEN_BROWSER_AUTOSTART !== '0') {
    if (errorCode === 'SERVICE_UNAVAILABLE') {
      try { await startLocalBrowser(root); } catch { /* return the original service error below */ }
    }
    if (await waitForService(node, root)) probe = { code: 0 };
  }
  if (probe.code !== 0) {
    if (probe.stdout) process.stdout.write(probe.stdout);
    if (probe.stderr) process.stderr.write(probe.stderr);
    return probe.code;
  }
  const child = spawn(node, [path.join(root, 'cli.mjs'), ...args], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  return new Promise(resolve => child.once('close', code => resolve(code ?? 1)));
}

async function installSkillLinks(root) {
  if (process.env.OPEN_BROWSER_AUTO_INSTALL_SKILLS === '0') return;
  const installer = path.join(root, 'skill-links.mjs');
  if (!await executable(installer)) return;
  try {
    const { installAgentSkillLinks } = await import(pathToFileURL(installer).href);
    const result = await installAgentSkillLinks({ source: path.join(root, 'skills', 'open-browser') });
    if (process.env.OPEN_BROWSER_SKILLS_VERBOSE === '1') process.stderr.write(JSON.stringify({ skillLinks: result }) + '\n');
  } catch (error) {
    if (process.env.OPEN_BROWSER_SKILLS_VERBOSE === '1') process.stderr.write(JSON.stringify({ skillLinksError: error.message }) + '\n');
  }
}

async function printSkillGuide(root) {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : null;
  const candidates = platform
    ? [path.join(root, 'skills', 'open-browser', `SKILL.${platform}.md`), path.join(root, 'skills', 'open-browser', 'SKILL.md')]
    : [path.join(root, 'skills', 'open-browser', 'SKILL.md')];
  for (const guide of candidates) {
    try {
      const { readFile } = await import('node:fs/promises');
      process.stdout.write(await readFile(guide, 'utf8'));
      return;
    } catch {}
  }
  throw Object.assign(new Error(`未找到 Skill 指南。已检查：${candidates.join('、')}`), { code: 'SKILL_GUIDE_NOT_FOUND' });
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
  if (args[0] === 'skill') {
    if (args.length > 1) throw Object.assign(new Error('skill 不接受额外参数。'), { code: 'INVALID_PARAMS' });
    await printSkillGuide(root);
    return;
  }
  await installSkillLinks(root);
  if (args[0] === 'session') {
    process.exitCode = await runSession(process.execPath, root, args);
    return;
  }
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
