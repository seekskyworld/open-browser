#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.join(root, 'dist');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const arch = option('--arch', process.arch);
const format = option('--format', 'both');
if (!['arm64', 'x64'].includes(arch)) throw new Error('--arch must be arm64 or x64');
if (!['dmg', 'zip', 'both'].includes(format)) throw new Error('--format must be dmg, zip or both');
if (process.platform !== 'darwin') throw new Error('macOS packages must be created on macOS');

const appName = arch === 'x64' ? 'open-browser-x64.app' : 'open-browser.app';
const app = path.join(output, appName);
const baseName = `open-browser-macos-${arch}`;
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const packagePath = kind => path.join(output, `${baseName}.${kind}`);

execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', app], { stdio: 'inherit' });

if (format === 'zip' || format === 'both') {
  const zip = packagePath('zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--sequesterRsrc', app, zip], { stdio: 'inherit' });
  await writeFile(zip + '.sha256', `${await digest(zip)}  ${path.basename(zip)}\n`);
  console.log(zip);
}

if (format === 'dmg' || format === 'both') {
  const staging = await mkdtemp(path.join(output, '.open-browser-dmg-'));
  const volume = path.join(staging, `open-browser ${packageInfo.version}`);
  try {
    execFileSync('/bin/mkdir', ['-p', volume]);
    execFileSync('/usr/bin/ditto', [app, path.join(volume, appName)], { stdio: 'inherit' });
    execFileSync('/bin/ln', ['-s', '/Applications', path.join(volume, 'Applications')]);
    const dmg = packagePath('dmg');
    execFileSync('/usr/bin/hdiutil', ['create', '-volname', `open-browser ${packageInfo.version}`, '-srcfolder', volume,
      '-ov', '-format', 'UDZO', dmg], { stdio: 'inherit' });
    await writeFile(dmg + '.sha256', `${await digest(dmg)}  ${path.basename(dmg)}\n`);
    console.log(dmg);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
