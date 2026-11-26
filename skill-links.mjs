import { lstat, mkdir, realpath, symlink, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultSkillSource = path.join(sourceRoot, 'skills', 'open-browser');

const agentRoots = [
  ['codex', '.codex'],
  ['claude-code', '.claude'],
  ['cursor', '.cursor'],
  ['windsurf', path.join('.codeium', 'windsurf')],
  ['windsurf-legacy', '.windsurf'],
  ['gemini-cli', '.gemini'],
  ['cline', '.cline'],
  ['roo-code', '.roo'],
  ['opencode', path.join('.config', 'opencode')],
].map(([name, relative]) => ({
  name,
  detect: path.join(os.homedir(), relative),
  root: path.join(os.homedir(), relative, 'skills'),
}));

function configuredRoots() {
  const extra = (process.env.OPEN_BROWSER_AGENT_SKILL_DIRS || '')
    .split(path.delimiter)
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => path.resolve(value));
  return [...agentRoots, ...extra.map(root => ({ name: 'configured', root, configured: true }))];
}

async function isDirectory(pathname) {
  try {
    return (await lstat(pathname)).isDirectory();
  } catch {
    return false;
  }
}

async function linkSkill(root, source) {
  const link = path.join(root, 'open-browser');
  const relativeSource = path.relative(root, source) || '.';
  try {
    const entry = await lstat(link);
    if (!entry.isSymbolicLink()) return { status: 'skipped_conflict', path: link };
    try {
      const current = await realpath(link);
      if (current === source) return { status: 'existing', path: link };
    } catch {
      // Replace a broken open-browser link with the current source.
    }
    await unlink(link);
    await symlink(relativeSource, link, 'dir');
    return { status: 'linked', path: link };
  } catch (error) {
    if (error.code !== 'ENOENT') return { status: 'skipped_error', path: link, code: error.code };
    await mkdir(root, { recursive: true });
    await symlink(relativeSource, link, 'dir');
    return { status: 'linked', path: link };
  }
}

export async function installAgentSkillLinks({ source = defaultSkillSource } = {}) {
  if (process.env.OPEN_BROWSER_AUTO_INSTALL_SKILLS === '0') return { disabled: true, links: [] };
  if (!(await isDirectory(source))) return { disabled: false, links: [], sourceMissing: true };
  const links = [];
  const seen = new Set();
  for (const agent of configuredRoots()) {
    if (!agent.configured && !(await isDirectory(agent.detect))) continue;
    const root = path.resolve(agent.root);
    if (seen.has(root)) continue;
    seen.add(root);
    const result = await linkSkill(root, source).catch(error => ({
      status: 'skipped_error', path: path.join(root, 'open-browser'), code: error.code || 'unknown',
    }));
    links.push({ agent: agent.name, ...result });
  }
  return { disabled: false, links, source: path.resolve(source) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  installAgentSkillLinks().then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
  }).catch(error => {
    process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  });
}
