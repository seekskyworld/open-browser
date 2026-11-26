import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.platform === 'darwin') {
  const bundle = fileURLToPath(new URL('../dist/open-browser.app', import.meta.url));
  if (!existsSync(bundle)) await import('./build.mjs');
  execFileSync('open', [bundle], { stdio: 'inherit' });
} else {
  const service = fileURLToPath(new URL('../service.mjs', import.meta.url));
  execFileSync(process.execPath, [service, '--chromium'], { stdio: 'inherit' });
}
