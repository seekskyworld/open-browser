import assert from 'node:assert/strict';
import test from 'node:test';
import { agentMethods, capabilityProfiles } from './api-contract.mjs';

test('capability profiles only expose methods in the public contract', () => {
  const known = new Set(agentMethods);
  for (const method of capabilityProfiles.read) assert.ok(known.has(method), method);
  assert.ok(capabilityProfiles.desktop.includes('getWorkspace'));
  assert.ok(capabilityProfiles.desktop.includes('takeControl'));
});
