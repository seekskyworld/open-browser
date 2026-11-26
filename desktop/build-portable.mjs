import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { copyApplication, root } from './package-assets.mjs';

const platforms = {
  'linux-x64': { chrome: 'linux64', executable: 'chrome', node: 'linux-x64.tar.xz',
    nodeHash: 'cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8',
    chromeHash: '370601106c1b5619aae5f06f7a3fdc60836486135934779461e2a208d777f596' },
  'win32-x64': { chrome: 'win64', executable: 'chrome.exe', node: 'win-x64.zip',
    nodeHash: '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3',
    chromeHash: '3e2514fddb71f6727e2079369e03a6a4e105adcb28f05a6bfd875b782bddc431' },
};
const platform = process.argv[2] || process.platform + '-' + process.arch;
const spec = platforms[platform];
if (!spec) throw new Error('Use node desktop/build-portable.mjs linux-x64 or win32-x64');
const chromeVersion = '159.0.8154.6';
const nodeVersion = '22.23.5';
const info = JSON.parse(await readFile(path.join(root, 'node_modules/playwright-core/browsers.json'), 'utf8')).browsers.find(b => b.name === 'chromium');
if (info.browserVersion !== chromeVersion) throw new Error('Refresh the pinned Chrome archive version and SHA-256.');
const playwright = JSON.parse(await readFile(path.join(root, 'node_modules/playwright-core/package.json'), 'utf8'));
const cache = path.join(root, '.open-browser', 'build-cache', 'portable');
const output = path.join(root, 'dist');
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });
const python = process.platform === 'win32' ? 'python' : 'python3';
const pythonArchive = (...args) => execFileSync(python, [path.join(root, 'desktop/portable-archive.py'), ...args], { stdio: 'inherit' });

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function cached(name, url, sum) {
  const file = path.join(cache, name);
  if (await digest(file).catch(() => '') === sum) return file;
  const tmp = file + '.' + randomUUID();
  try {
    execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--fail', '--location', '--retry', '2', '--output', tmp, url], { stdio: 'inherit' });
    if (await digest(tmp) !== sum) throw new Error('SHA-256 mismatch: ' + name);
    await rename(tmp, file);
    return file;
  } finally { await rm(tmp, { force: true }); }
}
const nodeName = 'node-v' + nodeVersion + '-' + spec.node;
const nodeArchive = await cached(nodeName, 'https://nodejs.org/dist/v' + nodeVersion + '/' + nodeName, spec.nodeHash);
const chromeArchive = await cached('chrome-' + spec.chrome + '-' + chromeVersion + '.zip',
  'https://cdn.playwright.dev/builds/cft/' + chromeVersion + '/' + spec.chrome + '/chrome-' + spec.chrome + '.zip', spec.chromeHash);
const staging = await mkdtemp(path.join(output, '.open-browser-portable-'));
const folder = 'open-browser-' + platform;
const bundle = path.join(staging, folder), app = path.join(bundle, 'app'), node = path.join(bundle, 'node');
const windows = platform === 'win32-x64';
try {
  await copyApplication(app);
  await mkdir(node);
  if (windows) {
    pythonArchive('extract', nodeArchive, staging);
    const upstream = path.join(staging, 'node-v' + nodeVersion + '-win-x64');
    for (const file of ['node.exe', 'LICENSE']) await copyFile(path.join(upstream, file), path.join(node, file));
  } else {
    const prefix = 'node-v' + nodeVersion + '-linux-x64';
    execFileSync('tar', ['-xf', nodeArchive, '-C', node, '--strip-components', '1', prefix + '/bin/node', prefix + '/LICENSE']);
  }
  const engine = path.join(app, '.open-browser', 'engine');
  const build = 'chromium-' + info.revision;
  await mkdir(path.join(engine, build), { recursive: true });
  pythonArchive('extract', chromeArchive, path.join(engine, build));
  const executable = [build, 'chrome-' + spec.chrome, spec.executable].join('/');
  await writeFile(path.join(engine, 'engine-' + playwright.version + '-' + platform + '.json'), JSON.stringify({ executable }) + '\n');
  if (windows) {
    const { brandWindowsIcons } = await import('./brand-windows-icons.mjs');
    await brandWindowsIcons(path.dirname(path.join(engine, executable)));
    await copyFile(path.join(root, 'desktop/icons/open-browser.ico'), path.join(bundle, 'open-browser.ico'));
    await copyFile(path.join(root, 'desktop/create-shortcut.ps1'), path.join(bundle, 'create-shortcut.ps1'));
    await writeFile(path.join(bundle, 'open-browser.cmd'), '@echo off\r\n"%~dp0node\\node.exe" "%~dp0app\\service.mjs" --chromium %*\r\n');
  } else {
    await copyFile(path.join(root, 'desktop/install-menu-entry.mjs'), path.join(bundle, 'install-menu-entry.mjs'));
    await copyFile(path.join(app, 'browser-extension/icons/open-browser-48.png'),
      path.join(engine, build, 'chrome-' + spec.chrome, 'product_logo_48.png'));
    const launcher = path.join(bundle, 'open-browser');
    await writeFile(launcher, '#!/bin/sh\nset -eu\nbase=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$base/node/bin/node" "$base/app/service.mjs" --chromium "$@"\n');
    await chmod(launcher, 0o755);
  }
  await copyFile(path.join(root, 'Docs/跨平台试用与发行.md'), path.join(bundle, 'README.md'));
  await copyFile(path.join(root, 'desktop/smoke-portable.mjs'), path.join(bundle, 'verify.mjs'));
  const name = folder + (windows ? '.zip' : '.tar.gz'), archive = path.join(staging, name);
  if (windows) pythonArchive('pack', bundle, archive);
  else execFileSync('tar', ['--no-xattrs', '-czf', archive, '-C', staging, folder], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const hash = await digest(archive);
  await rename(archive, path.join(output, name));
  await writeFile(path.join(output, name + '.sha256'), hash + '  ' + name + '\n');
  console.log(path.join(output, name), hash);
} finally { await rm(staging, { recursive: true, force: true }); }
