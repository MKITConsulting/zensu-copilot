'use strict';

// Exercise the actual CLI error boundary and native persistence, not live Copilot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { dispatch } = require('../../src/dispatcher');
const native = require('../../src/context');
const dispatcher = path.resolve(__dirname, '../../src/dispatcher.js');
const plugin = path.resolve(__dirname, '../../src/plugin');

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-dispatcher-errors-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE_|COPILOT_|ZENSU_)/.test(key) || ['PLUGIN_ROOT', 'PLUGIN_DATA', 'NODE_OPTIONS'].includes(key)) delete env[key];
  }
  Object.assign(env, { HOME: base, COPILOT_HOME: path.join(base, 'copilot'),
    COPILOT_PLUGIN_DATA: path.join(base, 'data') });
  return { base, env };
}

const events = [
  { event: 'preToolUse', exit: 2, decision: { permissionDecision: 'deny' }, reasonKey: 'permissionDecisionReason' },
  { event: 'agentStop', exit: 0, decision: { decision: 'block' }, reasonKey: 'reason' },
  { event: 'subagentStop', exit: 0, decision: { decision: 'block' }, reasonKey: 'reason' },
  { event: 'sessionStart', exit: 0, decision: {}, reasonKey: 'additionalContext' },
];
const invalidInputs = [
  { name: 'empty input', input: '', reason: /Hook payload empty or exceeds 2 MiB/ },
  { name: 'oversized input', input: ' '.repeat(2 * 1024 * 1024 + 1), reason: /Hook payload empty or exceeds 2 MiB/ },
  { name: 'malformed JSON', input: '{', reason: /JSON/ },
  { name: 'missing native identity', input: '{}', reason: /Invalid Copilot session ID/ },
];

for (const { event, exit, decision, reasonKey } of events) {
  for (const { name, input, reason } of invalidInputs) {
    test(`${event} CLI rejects ${name} with the native failure contract`, t => {
      const f = fixture(t);
      const result = spawnSync(process.execPath, [dispatcher, event], {
        cwd: f.base, env: f.env, input, encoding: 'utf8', timeout: 30000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, exit, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(typeof output[reasonKey], 'string');
      assert.match(output[reasonKey], /^Zensu Copilot runtime failed: /);
      assert.match(output[reasonKey], reason);
      assert.deepEqual(output, { ...decision, [reasonKey]: output[reasonKey] });
      assert.equal(result.stderr, output[reasonKey] + '\n');
      assert.equal(fs.existsSync(f.env.COPILOT_PLUGIN_DATA), false,
        'invalid input must not create a session or workflow record');
    });
  }
}

test('native prompt capture retains exact input and writes only the bound session prompt', t => {
  const f = fixture(t);
  const capture = path.join(f.base, 'capture');
  f.env.ZENSU_COPILOT_CAPTURE_DIR = capture;
  const sessionId = crypto.randomUUID();
  const payload = { sessionId, cwd: f.base, prompt: 'Check "quoted" input.\nKeep the second line.' };
  const options = { root: plugin, env: f.env };
  assert.deepEqual(dispatch('userPromptSubmitted', payload, options), {});

  const context = native.resolveContext(payload, f.env, plugin);
  const record = native.readPrivate(context.registryFile);
  assert.equal(record.sessionId, sessionId);
  assert.equal(record.lastUserPrompt, payload.prompt);
  const captures = fs.readdirSync(capture);
  assert.equal(captures.length, 1);
  const captured = native.readPrivate(path.join(capture, captures[0]));
  assert.deepEqual(captured, { event: 'userPromptSubmitted', payload,
    environment: { pluginRoot: plugin, pluginData: f.env.COPILOT_PLUGIN_DATA } });
  assert.deepEqual(fs.readdirSync(path.dirname(context.registryFile)), [path.basename(context.registryFile)]);
  assert.equal(fs.existsSync(path.join(f.base, '.zensu/state')), false,
    'recording a human prompt does not start a workflow');
});
