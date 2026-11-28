import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultApp = path.join(root, 'dist', 'open-browser.app');

function commandPath(name, fallback) {
  try {
    return execFileSync('/usr/bin/xcrun', ['--find', name], { encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('用法：node desktop/verify-macos-release.mjs [app-path] [--zip zip-path] [--dmg dmg-path]');
    return;
  }
  if (process.platform !== 'darwin') throw new Error('macOS 发行验收只能在 macOS 执行。');
  const app = path.resolve(process.argv[2] || process.env.OPEN_BROWSER_APP_PATH || defaultApp);
  await access(app);
  if (!app.endsWith('.app')) throw new Error('验收输入必须是 .app 应用包。');
  run('/usr/bin/codesign', ['--verify', '--strict', '--deep', '--verbose=2', app]);
  const details = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', app], { encoding: 'utf8' });
  if (details.status !== 0) throw new Error(details.stderr || '无法读取应用签名详情。');
  const signatureDetails = details.stdout + details.stderr;
  if (!/CodeDirectory.*\bruntime\b/.test(signatureDetails))
    throw new Error('应用没有启用 Hardened Runtime。');
  const stapler = commandPath('stapler', '/usr/bin/xcrun');
  run(stapler, stapler === '/usr/bin/xcrun' ? ['stapler', 'validate', app] : ['validate', app]);
  run(commandPath('spctl', '/usr/sbin/spctl'), ['--assess', '--type', 'execute', '--verbose=4', app]);

  const appArch = app.endsWith('-x64.app') ? 'x64' : app.endsWith('-arm64.app') ? 'arm64' : process.env.OPEN_BROWSER_TARGET_ARCH || process.arch;
  const zipArg = process.argv.indexOf('--zip');
  const dmgArg = process.argv.indexOf('--dmg');
  const zip = zipArg >= 0 ? process.argv[zipArg + 1] : process.env.OPEN_BROWSER_NOTARY_ZIP || path.join(path.dirname(app), `open-browser-macos-${appArch}.zip`);
  const dmg = dmgArg >= 0 ? process.argv[dmgArg + 1] : process.env.OPEN_BROWSER_NOTARY_DMG || path.join(path.dirname(app), `open-browser-macos-${appArch}.dmg`);
  for (const [kind, file] of [['ZIP', zip], ['DMG', dmg]]) {
    try {
      await access(file);
      const checksumFile = file + '.sha256';
      await access(checksumFile);
      const expected = (await readFile(checksumFile, 'utf8')).trim().split(/\s+/)[0];
      const actual = createHash('sha256').update(await readFile(file)).digest('hex');
      if (expected !== actual) throw new Error(`${kind} SHA-256 不匹配：${file}`);
      console.log(`${file}\nSHA-256 ${actual}`);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`缺少已公证的 ${kind} 或校验和：${file}`);
      throw error;
    }
  }
  console.log(`macOS 发行验收通过：${app}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
