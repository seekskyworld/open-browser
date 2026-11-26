// Privacy defaults are deliberately local-first. Page traffic is still
// governed by network-policy.mjs and the user's explicit target origins.
const serviceFeatures = [
  'AutofillServerCommunication',
  'OptimizationHints',
  'MediaRouter',
  'Translate',
  'CertificateTransparencyComponentUpdater',
  'InterestFeedContentSuggestions',
  'Reporting',
  'NetworkTimeServiceQuery',
  'Topics',
  'Fledge',
  'NewTabPage',
  'Signin',
  'AccountConsistency',
].join(',');

const strictArgs = Object.freeze([
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-default-apps',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--disable-sync',
  '--disable-account-consistency',
  '--disable-signin-promo',
  '--disable-search-engine-choice-screen',
  '--disable-network-time',
  '--disable-variations',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-pings',
  `--disable-features=${serviceFeatures}`,
]);

export function privacyProfile() {
  return process.env.OPEN_BROWSER_PRIVACY_PROFILE?.trim().toLowerCase() || 'strict';
}

export function chromiumPrivacyArgs() {
  // A deliberate opt-in exists for compatibility testing with Chromium
  // services. The shipped default remains strict and has no telemetry path.
  return privacyProfile() === 'compatibility' ? [] : [...strictArgs];
}

export function privacyCapabilities() {
  const profile = privacyProfile();
  return {
    profile,
    telemetry: 'disabled',
    chromiumServices: profile === 'compatibility' ? 'compatibility' : 'reduced',
    taskNetwork: 'explicit-origins',
    diagnostics: 'redacted',
    credentials: 'memory-scoped',
  };
}

const secretKey = '(?:password|passwd|passcode|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|auth|session(?:id)?|sid|cookie|csrf|xsrf|otp|pin|code|signature|credential|private[_-]?key)';
const keyValue = new RegExp(`(\\b${secretKey}\\b\\s*(?:=|:|->)\\s*)([^\\s,;&]+)`, 'giu');
const bearer = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{8,}\b/giu;
const jwt = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/gu;

function redactUrl(value) {
  let url;
  try { url = new URL(value); } catch { return value; }
  if (!['http:', 'https:'].includes(url.protocol)) return value;
  for (const key of url.searchParams.keys()) {
    if (new RegExp(`^${secretKey}$`, 'iu').test(key)) url.searchParams.set(key, '[redacted]');
  }
  // Fragments are client-side state and frequently contain OAuth tokens.
  url.hash = '';
  return url.href;
}

export function redactSensitiveText(value, knownSecrets = []) {
  if (typeof value !== 'string' || !value) return value;
  let text = value;
  for (const secret of knownSecrets) {
    if (typeof secret === 'string' && secret.length) text = text.replaceAll(secret, '[redacted]');
  }
  text = text.replace(/https?:\/\/[^\s<>"']+/giu, redactUrl);
  text = text.replace(keyValue, '$1[redacted]');
  text = text.replace(bearer, '[redacted authorization]');
  text = text.replace(jwt, '[redacted token]');
  return text;
}

export const privacyDocumentation = Object.freeze({
  defaultProfile: 'strict',
  optInProfile: 'compatibility',
  optInVariable: 'OPEN_BROWSER_PRIVACY_PROFILE=compatibility',
  outbound: 'Chromium background services are reduced by default. Task navigation still requires explicit origins.',
});
