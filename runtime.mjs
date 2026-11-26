import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const version = require('playwright-core/package.json').version;
const engineDir = fileURLToPath(new URL('./.open-browser/engine/', import.meta.url));
const manifest = path.join(engineDir, `engine-${version}-${process.platform}-${process.arch}.json`);

export async function engineExecutable() {
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
  const temp = manifest + '.' + randomUUID();
  await writeFile(temp, JSON.stringify({ executable }) + '\n', { flag: 'wx' });
  await rename(temp, manifest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await install();
}
