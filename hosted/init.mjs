import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function initialize(directory) {
  const home = path.resolve(directory);
  if (Buffer.byteLength(path.join(home, 'node-a/open-browser.sock')) >= 100)
    throw new Error('请选择较短的托管数据目录，以容纳 Unix socket 路径。');
  await mkdir(path.dirname(home), { recursive: true });
  await mkdir(home, { mode: 0o700 });
  const token = async name => {
    const file = path.join(home, name + '.token');
    await writeFile(file, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    return file;
  };
  const adminTokenFile = await token('admin');
  const digestKeyFile = await token('request-digest');
  const tenants = [];
  const nodes = [];
  for (const suffix of ['a', 'b']) {
    const tenant = 'tenant-' + suffix;
    const id = 'node-' + suffix;
    const state = path.join(home, id);
    tenants.push({ id: tenant, tokenFile: await token(tenant) });
    nodes.push({ id, tenants: [tenant], socketPath: path.join(state, 'open-browser.sock'),
      tokenPath: path.join(state, 'open-browser.token') });
  }
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ adminTokenFile, digestKeyFile, tenants, nodes }, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  return home;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(await initialize(process.argv[2] || process.env.OPEN_BROWSER_HOSTED_DIR)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
