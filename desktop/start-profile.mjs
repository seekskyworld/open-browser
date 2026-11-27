#!/usr/bin/env node
const [profile] = process.argv.slice(2);
if (!['dev', 'stable'].includes(profile)) throw new Error('usage: start-profile.mjs <dev|stable>');
process.env.OPEN_BROWSER_BUILD_PROFILE = profile;
await import('./start.mjs');
