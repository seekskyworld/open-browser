import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OutputStore } from './output-store.mjs';

test('OutputStore confines workspace and output paths to UUID segments', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'open-browser-output-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new OutputStore(root);
  const workspaceId = randomUUID();
  const source = path.join(root, 'source.txt');
  await writeFile(source, 'private output');
  const manifest = await store.publishFile(workspaceId, source, 'result.txt', 'text/plain');
  assert.equal((await store.list(workspaceId))[0].id, manifest.id);
  assert.equal(Buffer.from((await store.read(workspaceId, manifest.id)).data, 'base64').toString(), 'private output');
  for (const invalid of ['../../other', '../' + randomUUID(), 'workspace', '', randomUUID().toUpperCase()]) {
    await assert.rejects(store.list(invalid), { code: 'output_not_found' });
    await assert.rejects(store.read(invalid, manifest.id), { code: 'output_not_found' });
  }
  await assert.rejects(store.read(workspaceId, '../' + randomUUID()), { code: 'output_not_found' });
});
