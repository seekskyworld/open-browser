import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyApplication } from './package-assets.mjs';
import { engineExecutable } from '../runtime.mjs';
import { signBundle, signingIdentity, verifyUpgrade } from './sign.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sums = {
  arm64: 'e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d',
  x64: 'c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422',
};
if (process.platform !== 'darwin' || !sums[process.arch]) throw new Error('macOS arm64 or x64 required');
const identity = signingIdentity();
await engineExecutable();
const out = path.join(root, 'dist');
const cache = path.join(root, '.open-browser', 'build-cache');
await mkdir(out, { recursive: true });
await mkdir(cache, { recursive: true });
const filename = 'node-v22.23.5-darwin-' + process.arch + '.tar.gz';
const archive = path.join(cache, filename);
const checksum = async p => createHash('sha256').update(await readFile(p)).digest('hex');
if ((await checksum(archive).catch(() => '')) !== sums[process.arch]) {
  const temp = archive + '.' + process.pid;
  execFileSync('curl', ['--fail', '--location', '--retry', '2', '--output', temp,
    'https://nodejs.org/dist/v22.23.5/' + filename], { stdio: 'inherit' });
  if (await checksum(temp) !== sums[process.arch]) throw new Error('Node archive integrity check failed');
  await rename(temp, archive);
}

const staging = await mkdtemp(path.join(out, '.open-browser-build-'));
const bundle = path.join(staging, 'open-browser.app');
const contents = path.join(bundle, 'Contents');
const resources = path.join(contents, 'Resources');
const app = path.join(resources, 'app');
const copyTree = (a, b) => execFileSync('ditto', ['--noqtn', '--noextattr', a, b]);
try {
  await mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await mkdir(app, { recursive: true });
  const node = path.join(resources, 'node');
  await mkdir(node);
  const prefix = filename.slice(0, -7);
  execFileSync('tar', ['-xzf', archive, '-C', node, '--strip-components', '1',
    prefix + '/bin/node', prefix + '/LICENSE']);
  await copyFile(path.join(root, 'desktop/Info.plist'), path.join(contents, 'Info.plist'));
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-O2', '-framework', 'AppKit', '-framework', 'CoreGraphics',
    path.join(root, 'desktop/Launcher.m'), path.join(root, 'desktop/OBControlBar.m'),
    '-o', path.join(contents, 'MacOS/open-browser')], { stdio: 'inherit' });
  await copyFile(path.join(root, 'desktop/icons/open-browser.icns'), path.join(resources, 'open-browser.icns'));
  await copyApplication(app);
  const engine = path.join(app, '.open-browser', 'engine');
  await mkdir(engine, { recursive: true });
  const sourceEngine = path.join(root, '.open-browser', 'engine');
  const executable = path.relative(sourceEngine, await engineExecutable());
  const build = executable.split(path.sep)[0];
  copyTree(path.join(sourceEngine, build), path.join(engine, build));
  // Brand the packaged browser, which owns the visible window and Dock entry.
  const originalBinary = path.join(engine, executable);
  const originalBundle = path.resolve(path.dirname(originalBinary), '../..');
  const browserBundle = path.join(path.dirname(originalBundle), 'open-browser.app');
  await rename(originalBundle, browserBundle);
  const binary = path.join(browserBundle, 'Contents/MacOS/open-browser');
  await rename(path.join(path.dirname(binary), path.basename(originalBinary)), binary);
  const plist = path.join(browserBundle, 'Contents/Info.plist');
  for (const key of ['CFBundleName', 'CFBundleDisplayName', 'CFBundleExecutable'])
    execFileSync('plutil', ['-replace', key, '-string', 'open-browser', plist]);
  execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', 'local.open-browser.chromium', plist]);
  execFileSync('python3', [path.join(root, 'desktop/brand-locales.py'), browserBundle], { stdio: 'inherit' });
  execFileSync('python3', [path.join(root, 'desktop/brand-keychain.py'), browserBundle], { stdio: 'inherit' });
  execFileSync('python3', [path.join(root, 'desktop/brand-macos-icons.py'), browserBundle], { stdio: 'inherit' });
  signBundle(browserBundle, identity, true);
  const packageInfo = JSON.parse(await readFile(path.join(root, 'node_modules/playwright-core/package.json'), 'utf8'));
  const manifest = 'engine-' + packageInfo.version + '-' + process.platform + '-' + process.arch + '.json';
  await writeFile(path.join(engine, manifest), JSON.stringify({ executable: path.relative(engine, binary), profileVersion: 2 }) + '\n');
  signBundle(bundle, identity);
  const target = path.join(out, 'open-browser.app');
  const priorEngine = path.join(target, 'Contents/Resources/app/.open-browser/engine');
  const entries = await readdir(priorEngine).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  for (const entry of entries.filter(name => /^engine-.*-darwin-(arm64|x64)\.json$/.test(name))) {
    const prior = JSON.parse(await readFile(path.join(priorEngine, entry), 'utf8'));
    if (prior.profileVersion !== 2) continue;
    const previousBrowser = path.resolve(priorEngine, prior.executable, '../../..');
    if (!previousBrowser.startsWith(priorEngine + path.sep) || path.basename(previousBrowser) !== 'open-browser.app')
      throw new Error('旧版本 Chromium 路径无效。');
    verifyUpgrade(previousBrowser, browserBundle);
  }
  const old = path.join(staging, 'previous.app');
  try { await rename(target, old); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { await rename(bundle, target); }
  catch (e) { await rename(old, target).catch(() => {}); throw e; }
  console.log(target);
} finally {
  await rm(staging, { recursive: true, force: true });
}
