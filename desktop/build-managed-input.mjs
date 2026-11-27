// Build the Dev engine in an already synced Chromium checkout on its native OS.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const revision = '98a2592026af8d673b9fa83b626ac68bdf4ae78a';
const patch = fileURLToPath(new URL('./patches/chromium-managed-input.patch', import.meta.url));
const arg = process.argv[2];
if (!arg || process.argv.length !== 3) throw Error('Usage: node desktop/build-managed-input.mjs <chromium-src>');
const src = realpathSync(arg);
const run = (file, args, options = {}) => execFileSync(file, args, {cwd:src, stdio:'inherit', ...options});
const head = run('git', ['rev-parse', 'HEAD'], {stdio:'pipe', encoding:'utf8'}).trim();
if (head !== revision) throw Error('Input guard requires Chromium revision ' + revision);
try { run('git', ['apply', '--reverse', '--check', patch], {stdio:'pipe'}); }
catch {
  run('git', ['apply', '--check', patch]);
  run('git', ['apply', patch]);
}
const out = 'out/OpenBrowserInput';
const args = 'is_debug=false is_component_build=false symbol_level=0';
const windows = process.platform === 'win32';
// On Windows depot_tools ships GN as a batch wrapper. Pass only fixed arguments
// through cmd.exe, with the checkout supplied as cwd.
if (windows) {
  run('cmd.exe', ['/d', '/c', 'gn gen out/OpenBrowserInput "--args=' + args + '"']);
  run('cmd.exe', ['/d', '/c', 'autoninja -C out/OpenBrowserInput chrome content_browsertests']);
} else {
  run('gn', ['gen', out, '--args=' + args]);
  run('autoninja', ['-C', out, 'chrome', 'content_browsertests']);
}
const tests = path.join(src, out, windows ? 'content_browsertests.exe' : 'content_browsertests');
run(tests, ['--gtest_filter=SyntheticMouseEventTest.OpenBrowserInputGuard']);
const engine = path.join(src, out, windows ? 'chrome.exe' : process.platform === 'darwin'
  ? 'Chromium.app/Contents/MacOS/Chromium' : 'chrome');
if (!existsSync(engine)) throw Error('Chromium build did not produce ' + engine);
console.log('Dev engine for OPEN_BROWSER_DEV_CHROMIUM:', engine);
