'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const nativeModule = relative => require(path.resolve(__dirname, '../../src/plugin', relative));
test('native session selector is protected in every recognized assignment and export form', () => {
  const parser = nativeModule('hooks/lib/bash-source-write-parse.js');
  const commands = [
    'COPILOT_SESSION_ID=other node helper.js', 'env COPILOT_SESSION_ID=other node helper.js',
    'command env COPILOT_SESSION_ID=other node helper.js', 'export COPILOT_SESSION_ID=other',
    'readonly COPILOT_SESSION_ID=other', 'declare -x COPILOT_SESSION_ID=other',
    'typeset COPILOT_SESSION_ID=other', 'local COPILOT_SESSION_ID=other',
    'unset COPILOT_SESSION_ID', 'printf -v COPILOT_SESSION_ID %s other', 'read COPILOT_SESSION_ID',
  ];
  for (const command of commands) assert.match(parser.detectControlMutation(command), /protected Session Control input COPILOT_SESSION_ID/, command);
  assert.equal(parser.detectControlMutation('COPILOT_PLUGIN_DATA=/data COPILOT_PROJECT_DIR=/project bash helper.sh'), '');
  assert.equal(parser.detectControlMutation('printf "%s" "COPILOT_SESSION_ID=example"'), '');
});


test('subagent shell protection recognizes native session and plugin selectors', () => {
  const guard = nativeModule('hooks/lib/subagent-shell-guard-v1.js');
  const trusted = { projectRoot: '/workspace/project', toolCwd: '/workspace/project', pluginRoot: '/installation/plugin', pluginData: '/private/plugin-data' };
  for (const command of ['printenv COPILOT_SESSION_ID', 'COPILOT_SESSION_ID=other true',
    'printf "%s" "$COPILOT_PLUGIN_DATA"', 'node -p "process.env.COPILOT_SESSION_ID"']) {
    assert.equal(guard.accidentReason({ toolArgs: { command } }, trusted, {}), guard.REASONS.selector, command);
  }
});

test('native helper refuses missing or conflicting protected session binding before binding', () => {
  const { main } = require('../../src/helper');
  for (const privateId of [undefined, 'other']) {
    assert.throws(() => main(['runtime', 'zensu-log.sh', '--tdd-begin'], {
      COPILOT_SESSION_ID: 'session', ZENSU_BOUND_SESSION_ID: privateId,
    }), /session binding mismatch/);
  }
});

test('two real sessions cannot switch workflow ownership through the native helper', t => {
  const { dispatch } = require('../../src/dispatcher');
  const context = require('../../src/context');
  const repository = path.resolve(__dirname, '../..');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-native-session-binding-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'plugin');
  // Use an isolated package copy: the active live-probe installation must not
  // change, and both records are minted against this native runtime digest.
  fs.cpSync(path.join(repository, 'dist/zensu'), root, { recursive: true });
  fs.copyFileSync(path.join(repository, 'src/helper.js'), path.join(root, 'hooks/native/helper.js'));
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  assert.equal(spawnSync('git', ['init', '-q', project]).status, 0);
  const config = path.join(base, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ hooks: { pulseSession: false, sessionBanner: false, autoTdd: false }, context: { compactionNudge: false } }));
  const env = { ...process.env, HOME: base, COPILOT_HOME: path.join(base, 'copilot'),
    COPILOT_PLUGIN_DATA: path.join(base, 'data'), COPILOT_PLUGIN_ROOT: root, PLUGIN_ROOT: root, ZENSU_CONFIG: config };
  for (const name of Object.keys(env)) if (name.startsWith('CLAUDE_')) delete env[name];
  const sessions = [crypto.randomUUID(), crypto.randomUUID()];
  for (const sessionId of sessions) {
    const startup = dispatch('sessionStart', { sessionId, cwd: project, source: 'new' }, { env, root });
    assert.doesNotMatch(startup.additionalContext, /adapter failed|Zensu .*exit [1-9]/);
  }
  const bound = sessions.map(sessionId => context.nativeEnv(context.resolveContext({ sessionId, cwd: project }, env, root), env));
  const helper = path.join(root, 'hooks/native/helper.js');
  const run = (environment, verb) => spawnSync(process.execPath, [helper, 'runtime', 'zensu-log.sh', verb], {
    env: environment, cwd: project, encoding: 'utf8', timeout: 20000,
  });
  const keys = bound.map(environment => {
    const key = run(environment, '--session-key');
    assert.equal(key.status, 0, key.stderr);
    assert.match(key.stdout.trim(), /^scv1_[a-f0-9]{64}$/);
    return key.stdout.trim();
  });
  assert.notEqual(keys[0], keys[1]);
  const state = key => path.join(project, '.zensu/state', `tdd-phase-${key}.json`);
  const beforeB = fs.readFileSync(state(keys[1]), 'utf8');
  const attack = `COPILOT_SESSION_ID=${context.quote(sessions[1])} node "$COPILOT_PLUGIN_ROOT/hooks/native/helper.js" runtime zensu-log.sh --tdd-begin`;
  const denied = dispatch('preToolUse', { sessionId: sessions[0], cwd: project, toolName: 'bash', toolArgs: { command: attack } }, { env, root });
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /COPILOT_SESSION_ID/);
  const direct = run({ ...bound[0], COPILOT_SESSION_ID: sessions[1] }, '--tdd-begin');
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /session binding mismatch/);
  assert.equal(fs.readFileSync(state(keys[1]), 'utf8'), beforeB);
  const legitimate = `COPILOT_PLUGIN_DATA=${context.quote(env.COPILOT_PLUGIN_DATA)} COPILOT_PROJECT_DIR=${context.quote(project)} node "$COPILOT_PLUGIN_ROOT/hooks/native/helper.js" runtime zensu-log.sh --tdd-begin`;
  const allowed = dispatch('preToolUse', { sessionId: sessions[0], cwd: project, toolName: 'bash', toolArgs: { command: legitimate } }, { env, root });
  assert.notEqual(allowed.permissionDecision, 'deny', allowed.permissionDecisionReason);
  const execution = spawnSync('bash', ['-c', allowed.modifiedArgs.command], { env, cwd: project, encoding: 'utf8', timeout: 20000 });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(JSON.parse(fs.readFileSync(state(keys[0]), 'utf8')).active, true);
  assert.equal(fs.readFileSync(state(keys[1]), 'utf8'), beforeB);
});

test('native remote browser navigation asks the host without inventing a permission mode', () => {
  const consent = nativeModule('hooks/lib/verify-consent-v1.js');
  const decision = consent.evaluate({ command: 'playwright-cli -s=zensu-verify-fixture goto https://example.com/',
    payload: { nativePermissionPrompt: true }, env: {}, records: [], policy: null });
  assert.equal(decision.verdict, 'ask');
  assert.equal(consent.preEnvelope(decision).permissionDecision, 'ask');
  const denied = consent.evaluate({ command: 'playwright-cli -s=zensu-verify-fixture goto http://10.0.0.1/',
    payload: { nativePermissionPrompt: true }, env: {}, records: [], policy: null });
  assert.equal(denied.verdict, 'deny');
});
test('repo persona discovery accepts native .agent.md names and keeps activation matching', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-persona-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'zensu-review-api.agent.md'), '---\nname: zensu-review-api\ndescription: API contracts\nactivation: "src/api/**"\n---\nReview only.\n');
  const persona = nativeModule('hooks/lib/persona-activation.js');
  assert.deepEqual(persona.decide(dir, ['src/api/index.js']), ['spawn zensu-review-api']);
  assert.deepEqual(persona.decide(dir, ['README.md']), ['skip zensu-review-api no-activation-match']);
});
