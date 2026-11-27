import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { buildProfile, scopedBuildRoot } from './build-profile.mjs';

export const profileId = process.env.OPEN_BROWSER_PROFILE || 'default';
const base = scopedBuildRoot(path.resolve(process.env.OPEN_BROWSER_STATE_DIR || path.join(homedir(), '.open-browser')));

export function pathsForProfile(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)) throw new Error('invalid_profile');
  const stateDir = id === 'default' ? base : path.join(base, 'profiles', id);
  const instance = createHash('sha256').update(stateDir).digest('hex').slice(0, 16);
  const socketFile = path.join(stateDir, 'open-browser.sock');
  const socketPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\open-browser-' + instance
    : Buffer.byteLength(socketFile) < 100 ? socketFile : path.join('/tmp', 'open-browser-' + process.getuid() + '-' + instance + '.sock');
  return {stateDir, socketPath, tokenPath:path.join(stateDir, 'open-browser.token'), pidPath:path.join(stateDir, 'open-browser.pid')};
}

export { buildProfile };
export const {stateDir, socketPath, tokenPath, pidPath} = pathsForProfile(profileId);
export const adminTokenPath = path.join(stateDir, 'open-browser-admin.token');
