#!/usr/bin/env node
const [profile, ...args] = process.argv.slice(2);
if (!['dev', 'stable'].includes(profile)) throw new Error('usage: build-profile.mjs <dev|stable> [build arguments]');
process.env.OPEN_BROWSER_BUILD_PROFILE = profile;
process.argv = [process.argv[0], process.argv[1], ...args];
await import('./build.mjs');
