import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const version = require('playwright-core/package.json').version;
const engineDir = fileURLToPath(new URL('./.open-browser/engine/', import.meta.url));
function targetArch() {
  return process.env.OPEN_BROWSER_TARGET_ARCH?.trim() || process.arch;
}

export async function engineExecutable() {
  const arch = targetArch();
  const manifest = path.join(engineDir, `engine-${version}-${process.platform}-${arch}.json`);
  if (process.platform === 'darwin' && !['arm64', 'x64'].includes(arch))
    throw new Error('macOS 引擎目标架构必须是 arm64 或 x64。');
  try {
    const entry = JSON.parse(await readFile(manifest, 'utf8'));
    const executable = await realpath(path.join(engineDir, entry.executable));
    const relative = path.relative(await realpath(engineDir), executable);
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      throw new Error('Invalid engine path');
    return executable;
  } catch {
    throw new Error('open-browser engine unavailable. Run npm run browser:install.');
  }
}

async function install() {
  if (process.platform === 'darwin' && targetArch() !== process.arch)
    throw new Error(`当前 Node 是 ${process.arch}，不能下载并登记 ${targetArch()} 引擎。请在对应架构的 macOS 或 Rosetta x64 Node 下运行。`);
  process.env.PLAYWRIGHT_BROWSERS_PATH = engineDir;
  const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  execFileSync(process.execPath, [cli, 'install', 'chromium', '--no-shell'], { stdio: 'inherit' });
  const { chromium } = await import('playwright-core');
  let binary = await realpath(chromium.executablePath());
  if (process.platform === 'win32') {
    const { installWindowsIcons } = await import('./desktop/brand-windows-icons.mjs');
    binary = await installWindowsIcons(binary);
  }
  const executable = path.relative(engineDir, binary);
  const manifest = path.join(engineDir, `engine-${version}-${process.platform}-${targetArch()}.json`);
  const temp = manifest + '.' + randomUUID();
  await writeFile(temp, JSON.stringify({ executable }) + '\n', { flag: 'wx' });
  await rename(temp, manifest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await install();
}
