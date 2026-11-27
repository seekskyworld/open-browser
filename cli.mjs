#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { socketPath, adminTokenPath } from './paths.mjs';
import { localRequest, agentMethods, OpenBrowserClient, OpenBrowserError } from './sdk.mjs';

const help = `open-browser <method> [< params.json]

每个命令从标准输入读取一个 JSON 对象，向本地服务发起调用，将结果写到标准输出。
可用方法：${agentMethods.join('、')}

最短路径：
  printf '%s\\n' '{"url":"https://example.org","name":"页面检查"}' | open-browser open
  printf '%s\\n' '{"workspaceId":"WORKSPACE_ID","pageId":"PAGE_ID"}' | open-browser observe
  printf '%s\\n' '{"workspaceId":"WORKSPACE_ID","operationId":"finish-UNIQUE-ID","keepPageIds":[]}' | open-browser finishWorkspace

  open-browser session   # 每行读取 {"id":1,"method":"observe","params":{...}}，直到 stdin 关闭

  echo '{"name":"网页检查","agentName":"研究助手"}' | node cli.mjs createWorkspace
  echo '{"url":"https://example.org","name":"网页检查"}' | node cli.mjs open
  node cli.mjs listWorkspaces
  echo '{"workspaceId":"WORKSPACE_ID","url":"https://example.org"}' | node cli.mjs openPage
  echo '{"workspaceId":"WORKSPACE_ID","pageId":"PAGE_ID"}' | node cli.mjs observe

失败输出包含 code、message 和可用时的 nextAction。动作超时后优先使用同一 operationId 查询 getOperation。
需要完整参数契约时运行：node cli.mjs --schema
本机管理命令：admin.pair、admin.list、admin.grant、admin.revoke、admin.revokeClient、admin.clearHistory、admin.scheduler、admin.setPixelPermission。
凭据在可信的本地控制台设置；使用 fillCredential 和 credentialRef 填写登录字段。
  open-browser skill       # 输出与当前包版本匹配的 Skill 指南
`;

async function printSkillGuide() {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : null;
  const candidates = platform
    ? [`skills/open-browser/SKILL.${platform}.md`, 'skills/open-browser/SKILL.md']
    : ['skills/open-browser/SKILL.md'];
  for (const relative of candidates) {
    try {
      const guide = await readFile(new URL(relative, import.meta.url), 'utf8');
      process.stdout.write(guide.endsWith('\n') ? guide : guide + '\n');
      return;
    } catch {}
  }
  throw new OpenBrowserError('SKILL_GUIDE_NOT_FOUND', `未找到 Skill 指南。已检查：${candidates.join('、')}`);
}

async function readParams() {
  const chunks = [];
  let bytes = 0;
  if (process.stdin.isTTY) return {};
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new OpenBrowserError('REQUEST_TOO_LARGE', '标准输入超过 1 MiB。');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch { throw new OpenBrowserError('INVALID_JSON', '标准输入必须是 JSON 对象。'); }
}

async function sessionMain() {
  const api = new OpenBrowserClient({ fallbackName: 'CLI session' });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let tail = Promise.resolve();
  const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
  input.on('line', line => {
    tail = tail.then(async () => {
      let frame;
      try { frame = JSON.parse(line); } catch { send({ id: null, error: { code: 'INVALID_JSON', message: '每行必须是 JSON 请求。' } }); return; }
      const id = frame?.id;
      if (!(typeof id === 'string' || Number.isSafeInteger(id)) || typeof frame?.method !== 'string' || !frame.method ||
          (frame.params !== undefined && (!frame.params || typeof frame.params !== 'object' || Array.isArray(frame.params)))) {
        send({ id: id ?? null, error: { code: 'INVALID_PARAMS', message: 'session 请求需要 id、method 和对象 params。' } });
        return;
      }
      try {
        const result = await api.call(frame.method, frame.params ?? {});
        send({ id, result: result ?? null });
      } catch (error) {
        send({ id, error: { code: error.code ?? 'CLI_ERROR', message: error.message,
          ...(error.nextAction ? { nextAction: error.nextAction } : {}) } });
      }
    });
  });
  await new Promise(resolve => input.once('close', resolve));
  await tail;
  api.close();
}

async function main() {
  const [method, ...extra] = process.argv.slice(2);
  if (method === 'session') {
    if (extra.length) throw new OpenBrowserError('INVALID_PARAMS', 'session 不接受额外参数。');
    await sessionMain();
    return;
  }
  if (method === '--schema') {
    const { tools } = await import('./api-contract.mjs');
    process.stdout.write(JSON.stringify(tools, null, 2) + '\n');
    return;
  }
  if (method === 'skill') {
    if (extra.length) throw new OpenBrowserError('INVALID_PARAMS', 'skill 不接受额外参数。');
    await printSkillGuide();
    return;
  }
  if (!method || method === '--help' || method === '-h') {
    process.stdout.write(help);
    return;
  }
  if (extra.length) throw new OpenBrowserError('INVALID_PARAMS', '请通过标准输入提供 JSON 参数。');
  if (method.startsWith('admin.')) {
    if (process.env.OPEN_BROWSER_CLIENT_TOKEN_FILE) throw new OpenBrowserError('forbidden', '请从本机管理会话运行。');
    const params = await readParams();
    const {tokenFile, ...args} = params;
    const admin = (name, values) => localRequest(socketPath,adminTokenPath,'/v1/admin',name,values);
    if (method === 'admin.pair' && (typeof tokenFile !== 'string' || !tokenFile)) throw new OpenBrowserError('INVALID_PARAMS','需要新令牌文件路径 tokenFile');
    const result = await admin(method.slice(6),args);
    if (method === 'admin.pair') {
      try { await writeFile(tokenFile,result.token + '\n',{flag:'wx',mode:0o600}); }
      catch (error) { await admin('revokeClient',{principalId:result.principalId}); throw error; }
      delete result.token;
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (!agentMethods.includes(method)) throw new OpenBrowserError('UNKNOWN_METHOD', '未知的方法，请用 --help 查看命令。');
  const api = new OpenBrowserClient({ fallbackName: 'CLI' });
  const params = await readParams();
  const result = method === 'capabilities' ? await api.capabilities() : await api.call(method, params);
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch(error => {
  process.stderr.write(JSON.stringify({ error: {
    code: error.code ?? 'CLI_ERROR', message: error.message,
    ...(error.nextAction ? { nextAction: error.nextAction } : {}),
  } }) + '\n');
  process.exitCode = 1;
});
