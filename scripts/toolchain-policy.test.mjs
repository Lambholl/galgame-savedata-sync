import assert from 'node:assert/strict';
import test from 'node:test';
import { isNodeSecurityBaselineMet } from './toolchain-policy.mjs';

test('security patch boundaries reject old patches but admit patched LTS versions', () => {
  for (const version of ['22.17.0', '22.23.3', '24.21.0', '24.22.0']) {
    assert.equal(isNodeSecurityBaselineMet(version), false, version);
  }
  for (const version of ['22.23.4', '22.24.0', '24.22.1', '24.23.0']) {
    assert.equal(isNodeSecurityBaselineMet(version), true, version);
  }
});

test('unknown majors, malformed inputs and prereleases do not silently pass the gate', () => {
  for (const version of [
    '20.99.0',
    '23.9.0',
    '25.0.0',
    '26.0.0',
    'v22.23.4',
    '22.23',
    '22.23.4-rc.1',
    '22.x.4',
  ]) {
    assert.equal(isNodeSecurityBaselineMet(version), false, version);
  }
});
