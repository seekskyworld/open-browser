const profileIndex = process.argv.findIndex(value => value === '--profile');
if (profileIndex >= 0) {
  const profile = process.argv[profileIndex + 1];
  if (!['dev', 'stable'].includes(profile)) throw new Error('--profile must be dev or stable');
  process.env.OPEN_BROWSER_BUILD_PROFILE = profile;
}
const archIndex = process.argv.findIndex(value => value === '--arch');
if (archIndex >= 0) process.env.OPEN_BROWSER_TARGET_ARCH = process.argv[archIndex + 1];
if (process.platform === 'darwin') {
  await import('./build-macos.mjs');
} else {
  await import('./build-portable.mjs');
}
