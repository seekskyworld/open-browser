import { chmod, copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const maxReadBytes = 64 * 1024;
const maxOutputBytes = 128 * 1024 * 1024;
const retentionMs = 24 * 3600_000;

function fail(code) { throw Object.assign(new Error(code), { code }); }

function safeId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/.test(value)) fail('output_not_found');
  return value;
}

function safeWorkspaceId(value) {
  return safeId(value);
}

function safePart(value) {
  if (typeof value !== 'string' || !value.length || value.length > 180 || value === '.' || value === '..' ||
      /[\\/\p{Cc}\p{Bidi_Control}]/u.test(value)) fail('output_not_found');
  return value;
}

export class OutputStore {
  constructor(root) { this.root = root; }

  directory(workspaceId, outputId) {
    safeWorkspaceId(workspaceId);
    safeId(outputId);
    return path.join(this.root, workspaceId, outputId);
  }

  async publishFile(workspaceId, source, name, mimeType = 'application/octet-stream') {
    const bytes = (await stat(source)).size;
    if (!Number.isSafeInteger(bytes) || bytes > maxOutputBytes) fail('output_too_large');
    const outputId = randomUUID();
    const directory = this.directory(workspaceId, outputId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const filename = safePart(name);
      const dataPath = path.join(directory, 'part-0');
      await copyFile(source, dataPath);
      await chmod(dataPath, 0o600);
      const manifest = { id: outputId, expiresAt: Date.now() + retentionMs,
        parts: [{ name: filename, mimeType, bytes }] };
      const manifestPath = path.join(directory, 'manifest.json');
      const temporaryManifest = manifestPath + '.' + randomUUID() + '.tmp';
      await writeFile(temporaryManifest, JSON.stringify(manifest) + '\n', { mode: 0o600 });
      await rename(temporaryManifest, manifestPath);
      await chmod(directory, 0o700);
      return manifest;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async read(workspaceId, outputId, { partName, offset = 0, limit = maxReadBytes } = {}) {
    const directory = this.directory(workspaceId, outputId);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > maxReadBytes)
      fail('invalid_params');
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')); }
    catch { fail('output_not_found'); }
    if (manifest.expiresAt <= Date.now()) fail('output_expired');
    const part = manifest.parts.find(entry => entry.name === (partName ?? manifest.parts[0]?.name));
    if (!part) fail('output_part_not_found');
    const file = path.join(directory, 'part-0');
    if (offset > part.bytes) fail('invalid_offset');
    const handle = await open(file, 'r');
    const chunk = Buffer.alloc(Math.min(limit, Math.max(0, part.bytes - offset)));
    try { await handle.read(chunk, 0, chunk.length, offset); }
    finally { await handle.close(); }
    const nextOffset = offset + chunk.length < part.bytes ? offset + chunk.length : null;
    return { outputId, part: { ...part }, offset, bytes: chunk.length,
      nextOffset, done: nextOffset === null, data: chunk.toString('base64') };
  }

  async list(workspaceId) {
    safeWorkspaceId(workspaceId);
    let entries = [];
    for (const outputId of await readdir(path.join(this.root, workspaceId), { withFileTypes: true }).catch(() => [])) {
      if (!outputId.isDirectory()) continue;
      try {
        const manifest = JSON.parse(await readFile(path.join(this.root, workspaceId, outputId.name, 'manifest.json'), 'utf8'));
        if (manifest.expiresAt > Date.now()) entries.push(manifest);
        else await rm(path.join(this.root, workspaceId, outputId.name), { recursive: true, force: true });
      } catch {}
    }
    return entries;
  }
}

export const outputLimits = Object.freeze({ maxReadBytes, maxOutputBytes, retentionMs });
