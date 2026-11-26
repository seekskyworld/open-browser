import { cp, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Data, Resource, NtExecutable, NtExecutableResource } from 'resedit';

// The pinned CFT build carries the Explorer icon in the executable and the
// native window icon in chrome.dll. Both files in this distribution are unsigned.
const iconFile = new URL('./icons/open-browser.ico', import.meta.url);

export async function brandWindowsIcons(engine) {
  const ico = await readFile(iconFile);
  const images = Data.IconFile.from(ico).icons.map(frame => frame.data);
  for (const [name, id] of [['chrome.exe', 'IDR_MAINFRAME'], ['chrome.dll', 101]]) {
    const file = path.join(engine, name);
    const pe = NtExecutable.from(await readFile(file));
    const resources = NtExecutableResource.from(pe);
    if (!resources.entries.some(e => e.type === 14 && e.id === id && e.lang === 1033))
      throw new Error('Missing Chromium application icon in ' + name);
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, id, 1033, images);
    resources.outputResource(pe);
    await writeFile(file, Buffer.from(pe.generate()));
  }
}

// Publish a branded sibling of Playwright's cache without modifying its downloads.
// Only fully written directories are visible to concurrent or repeat installs.
export async function installWindowsIcons(executable) {
  const source = path.dirname(executable);
  const digest = createHash('sha256').update(await readFile(iconFile)).digest('hex').slice(0, 16);
  const target = source + '-open-browser-' + digest;
  const binary = path.join(target, path.basename(executable));
  async function installed() {
    try { return (await stat(binary)).isFile(); }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  }
  if (await installed()) return binary;
  const staging = await mkdtemp(source + '-open-browser-build-');
  try {
    await cp(source, staging, { recursive: true });
    await brandWindowsIcons(staging);
    try { await rename(staging, target); }
    catch (e) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(e.code) ||
          !(await installed())) throw e;
    }
    return binary;
  } finally { await rm(staging, { force: true, recursive: true }); }
}
