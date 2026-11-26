import { execFileSync } from 'node:child_process';

export function signingIdentity(requested = process.env.OPEN_BROWSER_SIGN_IDENTITY) {
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
  const args = ['--force', '--timestamp=none', '--sign', identity];
  if (nested) args.push('--deep', '--preserve-metadata=entitlements');
  execFileSync('/usr/bin/codesign', [...args, bundle], { stdio: 'inherit' });
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
