'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '../../dist/zensu');
const capture = require('../../src/ai-work');
const native = require('../../src/context');
const { dispatch } = require('../../src/dispatcher');
function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-capture-native-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const env = { ...process.env, PLUGIN_ROOT: root, COPILOT_PLUGIN_ROOT: root, COPILOT_PLUGIN_DATA: path.join(project, 'data'), COPILOT_HOME: path.join(project, 'home') };
  const context = native.resolveContext({ sessionId: 'main-session', cwd: project }, env, root);
  context.captureMain = true;
  return { project, env, context, raw: { sessionId: 'main-session', cwd: project } };
}
test('capture selectors derive only from native main identity and bound workspace', t => {
  const f = fixture(t);
  const value = capture.options(f.context, ['--task', 'goal', '--title', 'Agreed goal', '--criteria', 'v1']);
  assert.equal(value.workspace, fs.realpathSync(f.project));
  assert.equal(value['cross-product-reason'], undefined);
  assert.equal(capture.options(f.context, ['--cross-product-reason', 'Explicit shared goal'])['cross-product-reason'], 'Explicit shared goal');
  assert.match(capture.primer(f.context), /explicit human confirmation/);
  assert.equal(value.session, capture.key('main-session'));
  assert.notEqual(value.session, capture.key('other-session'));
  assert.throws(() => capture.options(f.context, ['--session', 'other']), /Invalid/);
  assert.throws(() => capture.options({ ...f.context, nativeSessionId: 'child' }), /main session/);
  assert.throws(() => capture.options({ ...f.context, parentId: 'parent' }), /main session/);
  assert.throws(() => capture.options({ ...f.context, record: { cwd: os.tmpdir() } }), /workspace changed/);
});
test('unknown and partial host identities never become capture principals', () => {
  assert.equal(capture.mainPrincipal({}, root), true);
  assert.equal(capture.mainPrincipal({}, path.join(root, 'missing-package')), false);
  for (const raw of [{ agentId: '' }, { agentType: '' }, { agentName: 'unknown' }, { parentAgentId: null }, { isChild: true }]) assert.equal(capture.mainPrincipal(raw, root), false);
});
test('native Bash binding carries main authority and overwrites ambient capture selectors', t => {
  const f = fixture(t);
  const result = dispatch('preToolUse', { ...f.raw, toolName: 'bash', toolArgs: { command: 'printf ok' } }, {
    root, env: { ...f.env, ZENSU_CAPTURE_MAIN: '0', ZENSU_CAPTURE_NATIVE_SESSION_ID: 'foreign' }, spawnSync: () => ({ status: 0, stdout: '{}' }),
  });
  assert.match(result.modifiedArgs.command, /ZENSU_CAPTURE_MAIN='1'/);
  assert.match(result.modifiedArgs.command, /ZENSU_CAPTURE_NATIVE_SESSION_ID='main-session'/);
  assert.doesNotMatch(result.modifiedArgs.command, /foreign/);
  const child = native.nativeEnv({ ...f.context, nativeSessionId: 'child', captureMain: false }, f.env);
  assert.equal(child.ZENSU_CAPTURE_MAIN, '0'); assert.equal(child.ZENSU_CAPTURE_NATIVE_SESSION_ID, 'child');
  const shell = require(path.join(root, 'hooks/lib/bash-source-write-parse'));
  for (const selector of ['ZENSU_CAPTURE_MAIN', 'ZENSU_CAPTURE_NATIVE_SESSION_ID']) assert.match(shell.detectControlMutation(`${selector}=forged node helper.js`), /Blocked/);
});
test('agentStop reports only the main session and never converts delivery failure into a Stop block', t => {
  const f = fixture(t);
  const engine = require(path.join(root, 'hooks/lib/ai-work-capture-v1.js'));
  const previous = engine.run, calls = [];
  t.after(() => { engine.run = previous; });
  engine.run = (action, options, budget) => { calls.push({ action, options, budget }); return { status: 'not_started' }; };
  const settings = { root, env: f.env, spawnSync: () => ({ status: 0, stdout: '{}' }) };
  assert.notEqual(dispatch('agentStop', f.raw, settings).decision, 'block');
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'checkpoint');
  assert.equal(calls[0].options.session, capture.key(f.raw.sessionId));
  assert(calls[0].budget > 0 && calls[0].budget <= 20000);
  dispatch('agentStop', { ...f.raw, agentId: 'child', agentType: 'custom-agent', isChild: true }, settings);
  assert.equal(calls.length, 1);
  engine.run = () => { throw new Error('sensitive response'); };
  assert.notEqual(dispatch('agentStop', f.raw, settings).decision, 'block');
});
test('packaged model helper refuses unbound and child capture without invoking the CLI', t => {
  const f = fixture(t);
  for (const values of [{}, { ZENSU_CAPTURE_MAIN: '0' }, { ZENSU_CAPTURE_MAIN: '1', ZENSU_CAPTURE_NATIVE_SESSION_ID: 'child' }]) {
    const env = { ...native.nativeEnv({ ...f.context, captureMain: false }, f.env), ...values };
    const result = cp.spawnSync(process.execPath, [path.join(root, 'hooks/native/helper.js'), 'ai-work', 'begin'], { env, cwd: f.project, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /native main session/);
  }
});

test('packaged capture write gate permits only main reporting and preserves unrelated write denials', t => {
  const f = fixture(t);
  cp.spawnSync('git', ['init', '-q', f.project]);
  const config = path.join(f.project, 'test-config.json');
  fs.writeFileSync(config, JSON.stringify({ hooks: { pulseSession: false, sessionBanner: false, autoTdd: false }, context: { compactionNudge: false } }));
  f.env.ZENSU_CONFIG = config;
  dispatch('sessionStart', { ...f.raw, source: 'startup' }, { root, env: f.env });
  for (const [command, actor, denied] of [
    ['zensu ai-work start --id goal --title agreed', {}, false],
    ['zensu ai-work bind --product product --confirm', {}, false],
    ['zensu ai-work bind --product product --confirm', { agentId: 'child', agentType: 'general-purpose' }, true],
    ['zensu ai-work submit goal --event-id event', {}, false],
    ['zensu ai-work context && zensu ai-work get goal', {}, false],
    ['zensu ai-work start --id goal && zensu security classify f1', {}, true],
    ['zensu ai-work start --id goal', { agentId: 'child', agentType: 'general-purpose' }, true],
    ['zensu ai-work submit goal', { agentId: 'child', agentType: 'general-purpose' }, true],
  ]) {
    const result = cp.spawnSync('bash', [path.join(root, 'hooks/pre-bash-zensu-gate.sh')], {
      input: JSON.stringify({ ...f.raw, ...actor, toolName: 'bash', toolArgs: { command } }),
      env: native.nativeEnv(f.context, f.env), cwd: f.project, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    const verdict = result.stdout.trim() ? JSON.parse(result.stdout) : {};
    assert.equal(verdict.permissionDecision === 'deny', denied, command + ': ' + result.stdout);
  }
});
