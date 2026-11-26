import path from 'node:path';
import { localRequest } from '../sdk.mjs';

try {
  const method = process.argv[2];
  const home = process.env.OPEN_BROWSER_HOSTED_DIR;
  const token = process.env.OPEN_BROWSER_HOSTED_TOKEN_FILE;
  if (!method || !home || !token) throw new Error('请设置 OPEN_BROWSER_HOSTED_DIR 和 OPEN_BROWSER_HOSTED_TOKEN_FILE，然后指定方法。');
  let input = '';
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) input += chunk;
  }
  const endpoint = method === 'review' ? '/v1/admin' : '/v1/call';
  const result = await localRequest(path.join(home, 'control.sock'), token, endpoint, method, JSON.parse(input.trim() || '{}'));
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.code || error.message); process.exitCode = 1; }
