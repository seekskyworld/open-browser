import assert from 'node:assert/strict';
import test from 'node:test';

import { chromiumPrivacyArgs, privacyCapabilities, redactSensitiveText } from './privacy-config.mjs';

test('strict privacy profile disables Chromium background service paths', () => {
  delete process.env.OPEN_BROWSER_PRIVACY_PROFILE;
  const args = chromiumPrivacyArgs();
  for (const flag of [
    '--disable-background-networking', '--disable-component-update',
    '--disable-domain-reliability', '--disable-breakpad', '--disable-sync', '--no-pings',
  ]) assert.ok(args.includes(flag), flag);
  assert.match(args.find(value => value.startsWith('--disable-features=')), /OptimizationHints/);
  assert.ok(!args.includes('--disable-client-side-phishing-detection'));
  assert.equal(privacyCapabilities().profile, 'strict');
  assert.equal(privacyCapabilities().chromiumServices, 'reduced');
});

test('compatibility profile is explicit and visible', () => {
  process.env.OPEN_BROWSER_PRIVACY_PROFILE = 'compatibility';
  assert.deepEqual(chromiumPrivacyArgs(), []);
  assert.equal(privacyCapabilities().chromiumServices, 'compatibility');
  delete process.env.OPEN_BROWSER_PRIVACY_PROFILE;
});

test('sensitive observation text removes credentials, URL state and authorization tokens', () => {
  const input = [
    'password=secret-value',
    'https://example.test/callback?code=oauth-code&view=summary#access_token=fragment',
    'Bearer abcdefgh123456',
    'eyJheader.payloadvalue.signaturevalue',
  ].join(' ');
  const output = redactSensitiveText(input, ['secret-value']);
  assert.doesNotMatch(output, /secret-value|oauth-code|fragment|abcdefgh123456|eyJheader/);
  assert.match(output, /code=\[redacted\]/);
  assert.match(output, /view=summary/);
});
