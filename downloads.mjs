import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from './paths.mjs';

function fail(code) { throw Object.assign(new Error(code), {code}); }

function safeName(value) {
  const leaf = value.split(/[\\/]/).at(-1).replace(/[<>:"|?*\p{Cc}\p{Bidi_Control}]/gu,'_').replace(/^[. ]+|[. ]+$/g,'');
  if (!leaf || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(leaf)) return 'download';
  let name = '';
  for (const char of leaf) {
    if (Buffer.byteLength(name + char) > 180) break;
    name += char;
  }
  return name;
}

async function discard(artifact) {
  await artifact.cancel().catch(() => {});
  // Chromium removes incomplete files on cancellation. Playwright.delete()
  // only exposes the path of a successfully completed artifact.
  if (!await artifact.failure()) await artifact.delete();
}

export class WorkspaceDownloads {
  constructor(ws, outputs) {
    this.workspace = ws;
    this.entries = new Map();
    this.closed = false;
    this.outputs = outputs;
    if (!this.outputs) throw new Error('output_store_required');
  }

  receive(pageId, artifact) {
    const ws = this.workspace;
    const url = URL.parse(artifact.url());
    if (this.closed || ws.finishing || ws.mode === 'closed' || !url || !['http:','https:','blob:'].includes(url.protocol)
        || !ws.origins.has(url.origin) || this.entries.size >= 128) {
      void discard(artifact).catch(() => {});
      return;
    }
    // Playwright has already bound this Download to its Chromium GUID and page.
    // Keep that handle for every cancel/save/delete, including equal filenames.
    const downloadId = randomUUID();
    const info = { downloadId, workspaceId:ws.id, pageId, filename:safeName(artifact.suggestedFilename()), state:'receiving' };
    const entry = { info, artifact };
    this.entries.set(downloadId, entry);
    entry.settled = artifact.failure().then(failure => {
      if (info.state === 'receiving') info.state = failure ? 'failed' : 'ready';
    }, () => { if (info.state === 'receiving') info.state = 'failed'; });
    return downloadId;
  }

  list() { return [...this.entries.values()].map(entry => ({...entry.info})); }

  get(id) {
    const entry = this.entries.get(id);
    if (!entry) fail('download_not_found');
    return entry;
  }

  async cancel(id) {
    const entry = this.get(id);
    if (entry.saving || entry.info.state === 'kept') fail('download_already_kept');
    entry.info.state = 'cancelled';
    entry.discarded ??= discard(entry.artifact);
    await entry.discarded;
    return {...entry.info};
  }

  async keep(id) {
    const entry = this.get(id);
    if (entry.saving) return entry.saving;
    if (entry.info.state !== 'ready') fail('download_not_ready');
    const directory = path.join(stateDir,'open-browser-deliveries',this.workspace.id,id);
    const destination = path.join(directory,entry.info.filename);
    entry.saving = (async () => {
      const partial = path.join(directory,'.' + randomUUID() + '.part');
      try {
        await mkdir(directory,{recursive:true, mode:0o700});
        await entry.artifact.saveAs(partial);
        await chmod(partial,0o600);
        await rename(partial, destination);
        entry.info.state = 'kept';
        const output = await this.outputs.publishFile(this.workspace.id, destination, entry.info.filename, 'application/octet-stream');
        return {download:{...entry.info},path:destination,output};
      } catch (error) {
        await rm(partial,{force:true});
        entry.saving = undefined;
        throw error;
      }
    })();
    return entry.saving;
  }

  listOutputs() { return this.outputs.list(this.workspace.id); }

  readOutput(outputId, params) { return this.outputs.read(this.workspace.id, outputId, params); }

  async close() {
    this.closed = true;
    await Promise.all([...this.entries.values()].map(async entry => {
      await entry.saving?.catch(() => {});
      await (entry.discarded || discard(entry.artifact));
      await entry.settled;
    }));
    this.entries.clear();
  }
}
