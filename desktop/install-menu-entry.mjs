// Install the portable package at its current location in the user's Linux menu.
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = path.dirname(fileURLToPath(import.meta.url));
const menu = path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local/share'), 'applications');
const entry = path.join(menu, 'open-browser.desktop');
// Exec has its own quoting rules in addition to desktop-entry string escaping.
const escapeValue = value => value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t');
const executable = path.join(folder, 'open-browser').replace(/["`$\\]/g, '\\$&').replaceAll('%', '%%');
const icon = path.join(folder, 'app/browser-extension/icons/open-browser-128.png');
const content = [
  '[Desktop Entry]', 'Type=Application', 'Name=open-browser',
  'Exec="' + escapeValue(executable) + '"', 'Icon=' + escapeValue(icon),
  'Terminal=false', 'Categories=Network;WebBrowser;', 'StartupWMClass=open-browser', '',
].join('\n');
await mkdir(menu, { recursive: true });
const temporary = entry + '.' + process.pid;
await writeFile(temporary, content, { flag: 'wx' });
await chmod(temporary, 0o755);
await rename(temporary, entry);
console.log(entry);
