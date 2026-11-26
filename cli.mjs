#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { socketPath, adminTokenPath } from './paths.mjs';
import { localRequest, agentMethods, OpenBrowserClient, OpenBrowserError } from './sdk.mjs';

const help = `open-browser <method> [< params.json]

每个命令从标准输入读取一个 JSON 对象，向本地服务发起调用，将结果写到标准输出。
可用方法：${agentMethods.join('、')}

最短路径：
  printf '%s\\n' '{"url":"https://example.org","name":"页面检查"}' | open-browser open
  printf '%s\\n' '{"workspaceId":"WORKSPACE_ID","pageId":"PAGE_ID"}' | open-browser observe
  printf '%s\\n' '{"workspaceId":"WORKSPACE_ID","operationId":"finish-UNIQUE-ID","keepPageIds":[]}' | open-browser finishWorkspace

  echo '{"name":"网页检查","agentName":"研究助手"}' | node cli.mjs createWorkspace
  echo '{"url":"https://example.org","name":"网页检查"}' | node cli.mjs open
  node cli.mjs listWorkspaces
  echo '{"workspaceId":"WORKSPACE_ID","url":"https://example.org"}' | node cli.mjs openPage
  echo '{"workspaceId":"WORKSPACE_ID","pageId":"PAGE_ID"}' | node cli.mjs observe

失败输出包含 code、message 和可用时的 nextAction。动作超时后优先使用同一 operationId 查询 getOperation。
需要完整参数契约时运行：node cli.mjs --schema
本机管理命令：admin.pair、admin.list、admin.grant、admin.revoke、admin.revokeClient、admin.clearHistory、admin.scheduler、admin.setPixelPermission。
凭据在可信的本地控制台设置；使用 fillCredential 和 credentialRef 填写登录字段。
`;

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

async function main() {
  const [method, ...extra] = process.argv.slice(2);
  if (method === '--schema') {
    const { tools } = await import('./api-contract.mjs');
    process.stdout.write(JSON.stringify(tools, null, 2) + '\n');
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
