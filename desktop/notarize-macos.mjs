import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultApp = path.join(root, 'dist', 'open-browser.app');

function usage() {
  console.log(`用法：node desktop/notarize-macos.mjs [app-path] [--zip zip-path]

提交并公证 macOS 应用，固化票据后生成可上传的 GitHub ZIP。
凭据优先使用 OPEN_BROWSER_NOTARY_PROFILE，其次使用 App Store Connect API Key，
最后使用 Apple ID 加应用专用密码。凭据只从环境变量或本机钥匙串读取。`);
}

function parseArgs(argv) {
  let app = process.env.OPEN_BROWSER_APP_PATH || defaultApp;
  let zip = process.env.OPEN_BROWSER_NOTARY_ZIP;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') return { help: true };
    if (value === '--zip') {
      zip = argv[++index];
      if (!zip) throw new Error('--zip 需要文件路径。');
      continue;
    }
    if (value.startsWith('--')) throw new Error('未知参数：' + value);
    if (app !== defaultApp && app !== process.env.OPEN_BROWSER_APP_PATH)
      throw new Error('只能指定一个应用路径。');
    app = value;
  }
  if (!zip) zip = path.join(path.dirname(app), `open-browser-macos-${process.arch}.zip`);
  return { app: path.resolve(app), zip: path.resolve(zip), help: false };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'inherit', ...options });
}

function commandPath(name, fallback) {
  try {
    return execFileSync('/usr/bin/xcrun', ['--find', name], { encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

async function requirePath(target, label) {
  try {
    await access(target);
  } catch {
    throw new Error(`${label}不存在：${target}`);
  }
}

function notaryCredentials() {
  const profile = process.env.OPEN_BROWSER_NOTARY_PROFILE;
  const key = process.env.OPEN_BROWSER_NOTARY_KEY || process.env.APPLE_API_KEY_PATH;
  const keyId = process.env.OPEN_BROWSER_NOTARY_KEY_ID || process.env.APPLE_API_KEY;
  const issuer = process.env.OPEN_BROWSER_NOTARY_ISSUER || process.env.APPLE_API_ISSUER;
  const appleId = process.env.OPEN_BROWSER_NOTARY_APPLE_ID || process.env.APPLE_ID;
  const teamId = process.env.OPEN_BROWSER_NOTARY_TEAM_ID || process.env.APPLE_TEAM_ID;
  const password = process.env.OPEN_BROWSER_NOTARY_PASSWORD || process.env.APPLE_PASSWORD;

  const apiKeyFields = [key, keyId, issuer].filter(Boolean).length;
  const hasApiKey = Boolean(key || keyId || issuer);
  const hasAppleId = Boolean(appleId || password);
  if (profile && (hasApiKey || hasAppleId || teamId))
    throw new Error('OPEN_BROWSER_NOTARY_PROFILE 不能和其他凭据模式同时设置。');
  if (hasApiKey && hasAppleId)
    throw new Error('API Key 和 Apple ID 公证凭据不能混用。');
  if (profile) return ['--keychain-profile', profile];
  if (hasApiKey) {
    if (!key || !keyId) throw new Error('API Key 模式需要 OPEN_BROWSER_NOTARY_KEY 和 OPEN_BROWSER_NOTARY_KEY_ID。');
    if (!issuer && apiKeyFields === 3) throw new Error('团队 API Key 模式需要 OPEN_BROWSER_NOTARY_ISSUER。');
    const args = ['--key', key, '--key-id', keyId];
    if (issuer) args.push('--issuer', issuer);
    return args;
  }
  if (!appleId && !teamId && !password) {
    throw new Error('缺少公证凭据。优先设置 OPEN_BROWSER_NOTARY_PROFILE，或提供 API Key，' +
      '或设置 OPEN_BROWSER_NOTARY_APPLE_ID、OPEN_BROWSER_NOTARY_TEAM_ID 和应用专用密码。');
  }
  if (!appleId || !teamId) throw new Error('Apple ID 模式需要 OPEN_BROWSER_NOTARY_APPLE_ID 和 OPEN_BROWSER_NOTARY_TEAM_ID。');
  let resolvedPassword = password;
  if (!resolvedPassword) {
    const service = process.env.OPEN_BROWSER_NOTARY_PASSWORD_SERVICE || 'open-browser-notary';
    try {
      resolvedPassword = execFileSync('/usr/bin/security', [
        'find-generic-password', '-a', appleId, '-s', service, '-w'
      ], { encoding: 'utf8' }).trim();
    } catch {
      throw new Error(`未找到 Apple ID 应用专用密码。请将密码保存到钥匙串服务 ${service}，或设置 OPEN_BROWSER_NOTARY_PASSWORD。`);
    }
  }
  if (!resolvedPassword) throw new Error('Apple ID 应用专用密码为空。');
  return ['--apple-id', appleId, '--team-id', teamId, '--password', resolvedPassword];
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    usage();
    return;
  }
  if (process.platform !== 'darwin') throw new Error('macOS 公证只能在 macOS 构建机执行。');
  await requirePath(parsed.app, '应用');
  if (!parsed.app.endsWith('.app')) throw new Error('公证输入必须是 .app 应用包。');
  await requirePath('/usr/bin/codesign', 'codesign');
  await requirePath('/usr/bin/xcrun', 'xcrun');

  const notarytool = commandPath('notarytool', '/usr/bin/xcrun');
  const stapler = commandPath('stapler', '/usr/bin/xcrun');
  const spctl = commandPath('spctl', '/usr/sbin/spctl');
  run('/usr/bin/codesign', ['--verify', '--strict', '--deep', '--verbose=2', parsed.app]);

  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--sequesterRsrc', parsed.app, parsed.zip]);
  const credentials = notaryCredentials();
  run(notarytool, notarytool === '/usr/bin/xcrun'
    ? ['notarytool', 'submit', parsed.zip, '--wait', ...credentials]
    : ['submit', parsed.zip, '--wait', ...credentials]);

  run(stapler, stapler === '/usr/bin/xcrun' ? ['stapler', 'staple', parsed.app] : ['staple', parsed.app]);
  run(stapler, stapler === '/usr/bin/xcrun' ? ['stapler', 'validate', parsed.app] : ['validate', parsed.app]);
  run(spctl, ['--assess', '--type', 'execute', '--verbose=4', parsed.app]);

  // The first archive is the notarization input. Recreate it after stapling so
  // the GitHub download contains the ticket and passes offline Gatekeeper checks.
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--sequesterRsrc', parsed.app, parsed.zip]);
  const digest = await sha256(parsed.zip);
  await writeFile(parsed.zip + '.sha256', `${digest}  ${path.basename(parsed.zip)}\n`);
  console.log(`${parsed.zip}\nSHA-256 ${digest}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
