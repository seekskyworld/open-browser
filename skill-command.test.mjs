import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

async function run(args) {
  const child = spawn(process.execPath, [path.join(root, 'cli.mjs'), ...args], { cwd: root });
  const out = [];
  const err = [];
  child.stdout.on('data', chunk => out.push(chunk));
  child.stderr.on('data', chunk => err.push(chunk));
  child.stdin.end();
  const [code] = await once(child, 'close');
  return { code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
}

test('skill prints the platform guide without connecting to the service', async () => {
  const result = await run(['skill']);
  assert.equal(result.code, 0);
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : null;
  if (platform) assert.match(result.stdout, new RegExp(`^\\[open-browser:skill\\] open-browser usage guide \\(${platform}\\)`));
  else assert.match(result.stdout, /^---/);
  assert.equal(result.stderr, '');
});

test('skill rejects extra arguments', async () => {
  const result = await run(['skill', 'extra']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /INVALID_PARAMS/);
});
