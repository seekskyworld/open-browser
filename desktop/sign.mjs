import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entitlements = process.env.OPEN_BROWSER_MACOS_ENTITLEMENTS ||
  fileURLToPath(new URL('./macos-entitlements.plist', import.meta.url));

function nestedCodePaths(bundle) {
  const files = execFileSync('/usr/bin/find', [bundle, '-type', 'f', '-print0']);
  const candidates = files.toString('utf8').split('\0').filter(Boolean);
  const machO = candidates.filter(file => {
    try {
      return execFileSync('/usr/bin/file', ['-b', file], { encoding: 'utf8' }).includes('Mach-O');
    } catch {
      return false;
    }
  });
  const bundles = new Set();
  for (const file of machO) {
    let current = file;
    while (current.startsWith(bundle + '/') && current !== bundle) {
      if (/\.(app|framework|xpc|bundle)$/.test(current)) bundles.add(current);
      current = current.slice(0, current.lastIndexOf('/'));
    }
  }
  return [
    ...machO.sort((a, b) => b.length - a.length),
    ...[...bundles].sort((a, b) => b.length - a.length),
  ];
}

function signCode(path, identity, preserveEntitlements = false) {
  const timestamp = process.env.OPEN_BROWSER_CODESIGN_TIMESTAMP === 'none'
    ? '--timestamp=none'
    : '--timestamp';
  const args = ['--force', timestamp, '--options', 'runtime', '--entitlements', entitlements, '--sign', identity];
  if (preserveEntitlements) args.push('--preserve-metadata=entitlements');
  for (let attempt = 0; ; attempt += 1) {
    try {
      execFileSync('/usr/bin/codesign', [...args, path], { stdio: 'inherit' });
      return;
    } catch (error) {
      if (timestamp === '--timestamp=none' || attempt >= 2) throw error;
      execFileSync('/bin/sleep', ['1']);
    }
  }
}

export function signingIdentity(requested = process.env.OPEN_BROWSER_SIGN_IDENTITY || process.env.APPLE_SIGNING_IDENTITY) {
  const listing = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const identities = [...listing.matchAll(/^\s*\d+\) ([0-9A-F]{40}) "([^"]+)"\s*$/gm)];
  const matches = identities.filter(([, hash, name]) => name.startsWith('Developer ID Application:') &&
    (!requested || hash === requested.trim().toUpperCase() || name === requested.trim()));
  if (matches.length !== 1) throw new Error(
    'macOS 构建需要稳定的签名身份。请在构建钥匙串中安装有效的 Developer ID Application 证书及配对私钥。' +
    '可用 security find-identity -v -p codesigning 查看身份。' +
    '有多项 Developer ID Application 身份时，请将 OPEN_BROWSER_SIGN_IDENTITY 设为完整证书名称或其 40 位 SHA-1。');
  return matches[0][1];
}

export function signBundle(bundle, identity, nested = false) {
  for (const path of nestedCodePaths(bundle)) signCode(path, identity);
  signCode(bundle, identity, nested);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', bundle], { stdio: 'inherit' });
}

export function verifyUpgrade(previous, candidate) {
  // Keychain ACLs use the requesting executable's designated requirement.
  // Validate each bundle against the other build, including certificate renewals
  // where the team and bundle identifier remain the same.
  for (const [origin, target] of [[previous, candidate], [candidate, previous]]) {
    const output = execFileSync('/usr/bin/codesign', ['-d', '-r-', origin], { encoding: 'utf8' });
    const line = output.split('\n').find(value => value.startsWith('designated => '));
    if (!line) throw new Error('无法读取现有版本的签名要求。');
    const requirement = line.slice('designated => '.length);
    execFileSync('/usr/bin/codesign', ['--verify', '-R', '=' + requirement, target], { stdio: 'inherit' });
  }
}
