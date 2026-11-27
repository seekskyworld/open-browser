import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const allowedProfiles = new Set(['dev', 'stable']);

function packagedProfile() {
  try { return readFileSync(fileURLToPath(new URL('./.open-browser-build-profile', import.meta.url)), 'utf8').trim().toLowerCase(); }
  catch { return undefined; }
}

export const buildProfile = (process.env.OPEN_BROWSER_BUILD_PROFILE || packagedProfile() || 'stable').trim().toLowerCase();

if (!allowedProfiles.has(buildProfile)) {
  throw new Error('OPEN_BROWSER_BUILD_PROFILE must be dev or stable');
}

export const isDevelopmentBuild = buildProfile === 'dev';

export function scopedBuildRoot(base, profile = buildProfile) {
  if (!allowedProfiles.has(profile)) throw new Error('build profile must be dev or stable');
  return profile === 'dev' ? path.join(base, 'dev') : base;
}
