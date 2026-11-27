import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { pidPath, socketPath } from '../paths.mjs';
import { isDevelopmentBuild } from '../build-profile.mjs';

async function wakeExisting() {
  try {
    const pid = Number(readFileSync(pidPath, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    const active = await new Promise(resolve => {
      const probe = net.connect(socketPath);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (!active) return false;
    process.kill(pid, 'SIGUSR2');
    return true;
  } catch { return false; }
}

if (await wakeExisting()) process.exit(0);

if (process.platform === 'darwin') {
  const bundleName = isDevelopmentBuild ? 'open-browser-dev.app' : process.arch === 'x64' ? 'open-browser-x64.app' : 'open-browser.app';
  const bundle = fileURLToPath(new URL('../dist/' + bundleName, import.meta.url));
  if (!existsSync(bundle)) await import('./build.mjs');
  execFileSync('open', [bundle], { stdio: 'inherit' });
} else {
  const service = fileURLToPath(new URL('../service.mjs', import.meta.url));
  execFileSync(process.execPath, [service, '--chromium'], { stdio: 'inherit' });
}
