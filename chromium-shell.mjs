import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { stateDir } from './paths.mjs';
import { engineExecutable } from './runtime.mjs';
import { chromiumPrivacyArgs } from './privacy-config.mjs';

const extensionDir = fileURLToPath(new URL('./browser-extension', import.meta.url));
const extensionId = 'ehmdmliolflappfnmopemgojhbiilmpl';

const mac = process.platform === 'darwin';
const defaultProfile = path.join(stateDir, mac ? 'open-browser-profile-v2' : 'open-browser-profile');
const run = promisify(execFile);
const cockpitUrl = `chrome-extension://${extensionId}/newtab.html`;

async function routeNewTab(page) {
  try {
    if (!['chrome://newtab/', 'chrome://newtab', 'chrome://new-tab-page/'].includes(page.url())) return;
    await page.goto(cockpitUrl, { waitUntil: 'domcontentloaded' });
  } catch {
    // A tab can be closed while Chromium is creating it. The browser remains usable.
  }
}

async function macPersistentEngine() {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const appCode = path.join('Contents', 'Resources', 'app');
  const packaged = path.normalize(here).endsWith(path.sep + appCode + path.sep);
  const outer = packaged ? path.resolve(here, '../../..') : path.join(here, 'dist', 'open-browser.app');
  try {
    const engineDir = await realpath(path.join(outer, appCode, '.open-browser', 'engine'));
    const { version } = createRequire(import.meta.url)('playwright-core/package.json');
    const manifest = JSON.parse(await readFile(path.join(engineDir, `engine-${version}-darwin-${process.arch}.json`), 'utf8'));
    if (manifest.profileVersion !== 2) throw new Error('v2 engine manifest required');
    const executable = await realpath(path.resolve(engineDir, manifest.executable));
    const relative = path.relative(engineDir, executable);
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
        !relative.endsWith('/open-browser.app/Contents/MacOS/open-browser')) throw new Error('invalid branded engine path');
    const { stderr } = await run('/usr/bin/codesign', ['-dv', '--verbose=2', outer]);
    const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(stderr)?.[1];
    if (!team) throw new Error('Developer ID team required');
    const requirement = 'identifier "local.open-browser.chromium" and anchor apple generic and ' +
      'certificate 1[field.1.2.840.113635.100.6.2.6] exists and ' +
      'certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "' + team + '"';
    await run('/usr/bin/codesign', ['--verify', '-R=' + requirement, path.resolve(executable, '../../..')]);
    return executable;
  } catch (cause) {
    throw new Error('macOS 持久浏览需要已用 Developer ID 签名的 open-browser v2 引擎。请在项目目录执行 npm run build，再重新启动。', { cause });
  }
}

async function copyLegacyBookmarks(destination) {
  const legacy = path.join(stateDir, 'open-browser-profile');
  const profile = path.join(legacy, 'Default');
  const bookmarks = path.join(profile, 'Bookmarks');
  try {
    if (!(await lstat(legacy)).isDirectory() || !(await lstat(profile)).isDirectory() ||
        !(await lstat(bookmarks)).isFile()) return;
    await copyFile(bookmarks, path.join(destination, 'Default', 'Bookmarks'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function prepareProfile(profileDir) {
  if (!mac || path.resolve(profileDir) !== defaultProfile) return seedProfile(profileDir);
  // Publish a complete v2 directory at once, including the optional bookmark copy.
  // Its existence is the migration record, even if the user later deletes all bookmarks.
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  try {
    if (!(await lstat(profileDir)).isDirectory()) throw new Error('无效的 open-browser v2 资料目录。');
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = await mkdtemp(path.join(stateDir, '.open-browser-profile-v2-'));
  try {
    await seedProfile(staging);
    await copyLegacyBookmarks(staging);
    try { await rename(staging, profileDir); }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function seedProfile(profileDir) {
  const directory = path.join(profileDir, 'Default');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, 'open-browser-preferences-' + randomUUID());
  const defaults = {
    // The cockpit is an intentional first-party new-tab surface. Mark the
    // built-in override as acknowledged so a fresh open-browser profile does
    // not show Chromium's "use this extension for new tabs" bubble.
    ack_existing_ntp_extensions: true,
    vertical_tabs: { enabled: true },
    bookmark_bar: { show_tab_groups: false },
    extensions: { pinned_extensions: [extensionId] },
    autofill: { enabled: false, profile_enabled: false },
    credentials_enable_service: false,
    profile: { password_manager_enabled: false },
    signin: { allowed: false },
    sync: { disabled: true },
  };
  // Publish the initial preferences once. Chromium owns subsequent writes,
  // including the user's choice to switch back to horizontal tabs.
  await writeFile(temporary, JSON.stringify(defaults), { flag: 'wx', mode: 0o600 });
  try { await link(temporary, path.join(directory, 'Preferences')); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { await rm(temporary, { force: true }); }
}

export async function launchChromiumShell({ profileDir = defaultProfile, headless = false, netLogPath } = {}) {
  const executablePath = mac ? await macPersistentEngine() : await engineExecutable();
  await prepareProfile(profileDir);
  const preferences = path.join(profileDir, 'Default', 'Preferences');
  const raw = await readFile(preferences,'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '{}';
  });
  let stored;
  try { stored = JSON.parse(raw); } catch { /* Chromium recovers malformed preferences. */ }
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath, headless, chromiumSandbox: true, viewport: null,
    // Start with a local page so extensions and the profile initialize before
    // the first visible tab is redirected to the open-browser cockpit.
    ignoreDefaultArgs: ['--disable-extensions', '--disable-popup-blocking',
      '--use-mock-keychain', '--password-store=basic'],
    args: [...chromiumPrivacyArgs(), '--load-extension=' + extensionDir, '--window-size=1240,860',
      ...(process.platform === 'linux' ? ['--class=open-browser', '--name=open-browser'] : []),
      ...(netLogPath ? ['--log-net-log=' + netLogPath, '--net-log-capture-mode=Default'] : [])],
  });
  context.on('page', page => { void routeNewTab(page); });
  if (stored?.bookmark_bar?.show_tab_groups !== false) {
    // Let Chromium migrate its own live preference store; it also owns the
    // user's bookmarks, toolbar visibility, and any concurrent profile writes.
    const session = await context.browser().newBrowserCDPSession();
    let targetId;
    try {
      const marker = 'about:blank#open-browser-settings-' + randomUUID();
      const ready = context.waitForEvent('page', {predicate: page => page.url() === marker,timeout:10000});
      const [page] = await Promise.all([ready, session.send('Target.createTarget',
        {url:marker,background:true,focus:false}).then(target => { targetId = target.targetId; })]);
      await page.goto('chrome://settings/appearance');
      const applied = await page.evaluate(() => chrome.settingsPrivate.setPref('bookmark_bar.show_tab_groups',false,''));
      if (!applied) throw new Error('无法设置书签栏的标签组显示方式。');
    } catch (error) {
      await context.close();
      throw error;
    } finally {
      if (targetId) await session.send('Target.closeTarget',{targetId}).catch(() => {});
      await session.detach().catch(() => {});
    }
  }
  // Chromium starts a persistent context with an ordinary blank document.
  // The first visible tab should use the same cockpit as subsequent new tabs.
  const initialPage = context.pages()[0];
  if (initialPage?.url() === 'about:blank') {
    await initialPage.goto('chrome://newtab/', { waitUntil: 'domcontentloaded' });
  }
  await routeNewTab(initialPage);
  return context;
}
