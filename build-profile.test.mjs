import assert from 'node:assert/strict';
import test from 'node:test';
import { scopedBuildRoot } from './build-profile.mjs';

test('stable builds keep the normal state root', () => {
  assert.equal(scopedBuildRoot('/tmp/open-browser'), '/tmp/open-browser');
});

test('development builds use a separate state root', () => {
  assert.equal(scopedBuildRoot('/tmp/open-browser', 'dev'), '/tmp/open-browser/dev');
  assert.equal(scopedBuildRoot('/tmp/open-browser', 'stable'), '/tmp/open-browser');
});
