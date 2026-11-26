import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(root, 'browser-extension/manifest.json'), 'utf8'));
const plist = await readFile(path.join(root, 'desktop/Info.plist'), 'utf8');
const expected = packageInfo.version;
if (manifest.version !== expected || !plist.includes(`<key>CFBundleShortVersionString</key><string>${expected}</string>`))
  throw new Error(`Version mismatch. package=${expected}, extension=${manifest.version}`);
console.log(`open-browser version ${expected} is consistent`);
