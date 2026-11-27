import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyExtensionFailure } from './chromium-host.mjs';

test('classifies an unserved request as extension unavailable', () => {
  assert.deepEqual(classifyExtensionFailure(), {
    code: 'host_unavailable',
    message: 'open-browser 扩展未连接到本机服务，请先启动应用后重试。',
  });
});

test('classifies a dispatched request as host timeout', () => {
  assert.deepEqual(classifyExtensionFailure({ dispatched: true }), {
    code: 'host_timeout',
    message: 'open-browser 扩展已收到请求，但本机服务未在时限内返回。请检查服务状态后重试。',
  });
});
