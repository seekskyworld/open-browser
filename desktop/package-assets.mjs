import { copyFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));

export async function copyApplication(app) {
  await mkdir(app, { recursive: true });
  const code = (await readdir(root)).filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs'));
  for (const name of [...code, 'package.json', 'package-lock.json'])
    await copyFile(path.join(root, name), path.join(app, name));
  for (const name of ['browser-extension', 'studio', 'skills'])
    await cp(path.join(root, name), path.join(app, name), { recursive: true, filter: file => !file.endsWith('.test.mjs') });
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  await cp(path.join(root, 'node_modules'), path.join(app, 'node_modules'), {
    recursive: true, verbatimSymlinks: true, filter: file => path.basename(file) !== '.bin' &&
      !lock.packages[path.relative(root, file).split(path.sep).join('/')]?.dev,
  });
  await copyFile(path.join(root, 'Docs/THIRD-PARTY-NOTICES.md'), path.join(app, 'THIRD-PARTY-NOTICES.md'));
  await copyFile(path.join(root, 'LICENSE'), path.join(app, 'LICENSE'));
  const licenses = [];
  for (const [location, info] of Object.entries(lock.packages)) {
    if (!location || info.dev) continue;
    const entries = await readdir(path.join(app, location)).catch(error => {
      if (info.optional && error.code === 'ENOENT') return [];
      throw error;
    });
    if (entries.length) licenses.push({
      location, version: info.version, license: info.license || 'see package',
      notices: entries.filter(file => /license|copying|notice|copyright/i.test(file)).sort(),
    });
  }
  await writeFile(path.join(app, 'third-party-packages.json'), JSON.stringify(licenses, null, 2) + '\n');
}
