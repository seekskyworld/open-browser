import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function cli(method, params = {}) {
  const windows = process.platform === 'win32';
  const child = spawn(windows ? process.execPath : path.join(root, 'skills/open-browser/scripts/open-browser'),
    windows ? [path.join(root, 'cli.mjs'), method] : [method], { cwd: root });
  const closed = once(child, 'close');
  const output = [], errors = [];
  child.stdout.on('data', chunk => output.push(chunk));
  child.stderr.on('data', chunk => errors.push(chunk));
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') child.destroy(error); });
  child.stdin.end(JSON.stringify(params));
  const [status] = await closed;
  if (status !== 0) throw new Error(method + ': ' + Buffer.concat(errors).toString().trim());
  return JSON.parse(Buffer.concat(output).toString());
}

async function runCase(name, testCase, service) {
  const workspaces = [];
  async function open(url) {
    const { workspaceId } = await cli('createWorkspace', { name, agentName: 'open-browser-test' });
    workspaces.push(workspaceId);
    const page = await cli('openPage', { workspaceId, url });
    return {
      page,
      observe: () => cli('observe', page),
      async act({ documentId, controlGeneration }, actions) {
        const operationId = randomUUID();
        let receipt = await cli('act', { ...page, documentId, controlGeneration, operationId, actions });
        const deadline = Date.now() + 15000;
        while (['queued', 'running'].includes(receipt.state) && Date.now() < deadline) {
          await delay(10);
          receipt = await cli('getOperation', { workspaceId, operationId });
        }
        assert.equal(receipt.state, 'completed', receipt.error ?? receipt.state);
        return receipt;
      },
    };
  }
  try {
    return await testCase({ open, cli, service });
  } finally {
    for (const workspaceId of workspaces) await cli('closeWorkspace', { workspaceId });
  }
}

const roundArgument = process.argv.slice(2).find(value => /^\d+$/.test(value));

export async function runTestHarness(cases, rounds = Number(roundArgument ?? 3)) {
  rounds = Number(rounds);
  assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 100, 'expected 1–100 rounds');
  const state = await mkdtemp(path.join(tmpdir(), 'open-browser-test-'));
  process.env.OPEN_BROWSER_STATE_DIR = state;
  process.env.OPEN_BROWSER_PROFILE = 'default';
  const useBundle = process.argv.includes('--bundle');
  if (useBundle) assert.equal(process.platform, 'darwin', '--bundle selects the local macOS app');
  process.env.OPEN_BROWSER_USE_SOURCE = useBundle ? '0' : '1';
  delete process.env.OPEN_BROWSER_CLIENT_TOKEN_FILE;
  let service;
  try {
    const { startApplication } = await import(useBundle
      ? '../dist/open-browser.app/Contents/Resources/app/service.mjs' : '../service.mjs');
    service = await startApplication({ mode: 'chromium', headless: true });
    for (let round = 1; round <= rounds; round++) {
      for (const [name, testCase] of Object.entries(cases)) {
        const started = performance.now();
        const row = { round, name };
        try {
          row.metrics = await runCase(name, testCase, service);
          row.pass = true;
        } catch (error) {
          row.pass = false;
          row.error = error.message;
          process.exitCode = 1;
        }
        row.elapsedMs = Math.round(performance.now() - started);
        console.log(JSON.stringify(row));
      }
    }
  } finally {
    try { await service?.close(); }
    finally { await rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
}
