'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
test('automatic feature context uses bounded tracked reads and native prompt output', () => {
  const result = spawnSync('bash', ['tests/structure/test-context-auto-load.sh'], {
    cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
