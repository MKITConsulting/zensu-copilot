'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
test('packaged context retrieval preserves hydration and the CLI read boundary', () => {
  const result = spawnSync('bash', ['tests/knowledge-context.sh'], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
