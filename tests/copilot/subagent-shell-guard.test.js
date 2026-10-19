'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('../../src/plugin/hooks/lib/subagent-shell-guard-v1.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-native-shell-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ hooks: { subagentShell: true } }));
  const environment = { HOME: root, COPILOT_PROJECT_DIR: project, ZENSU_CONFIG: config };
  const trusted = { projectRoot: project, toolCwd: project,
    pluginRoot: path.join(root, 'plugin'), pluginData: path.join(root, 'data') };
  const call = args => guard.shellViolation({ toolName: 'bash', agentType: 'general-purpose',
    agentId: 'native-child', toolArgs: { command: 'printf ready', ...args } }, trusted, environment);
  return { call };
}

test('native async shell requests are denied even with a shell grant and an innocent command', t => {
  const { call } = fixture(t);
  for (const args of [{ mode: 'async' }, { mode: 'async', detach: false },
    { mode: 'async', detach: true, initial_wait: 120 }]) {
    const result = call(args);
    assert.equal(result.kind, 'guard');
    assert.ok(result.reason.includes(guard.REASONS.background));
  }
});

test('native detachment never bypasses the subagent background restriction', t => {
  const { call } = fixture(t);
  for (const args of [{ detach: true }, { mode: 'sync', detach: true }]) {
    const result = call(args);
    assert.equal(result.kind, 'guard');
    assert.ok(result.reason.includes(guard.REASONS.background));
  }
});

test('native synchronous shell mode and its omitted default retain the existing grant', t => {
  const { call } = fixture(t);
  for (const args of [{}, { mode: 'sync' }, { mode: 'sync', detach: false },
    { mode: 'sync', initial_wait: 120 }]) {
    assert.equal(call(args), null);
  }
  assert.equal(call({ mode: 'sync', command: 'sleep 30 &' }).kind, 'guard');
});

test('unknown shell execution options fail closed instead of being treated as synchronous', t => {
  const { call } = fixture(t);
  for (const mode of [true, false, null, 1, '', 'background', 'ASYNC', [], {}]) {
    const result = call({ mode });
    assert.equal(result.kind, 'guard');
    assert.ok(result.reason.includes(guard.REASONS.executionMode));
  }
  for (const detach of ['true', 'false', null, 0, [], {}]) {
    const result = call({ mode: 'sync', detach });
    assert.equal(result.kind, 'guard');
    assert.ok(result.reason.includes(guard.REASONS.detachment));
  }
});
