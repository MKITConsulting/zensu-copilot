'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const plugin = path.resolve(__dirname, '../../src/plugin');
const lib = path.join(plugin, 'hooks/lib');
const principal = require(path.join(lib, 'copilot-principal-v1'));
const shell = require(path.join(lib, 'bash-source-write-parse'));
const grants = require(path.join(lib, 'reviewer-spawn-allow-v1'));
const reanchor = require(path.join(lib, 'session-reanchor-v1'));
const { normalizeTool } = require('../../src/protocol');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-native-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project'); const data = path.join(dir, 'data');
  fs.mkdirSync(project); fs.mkdirSync(data, { mode: 0o700 });
  const id = crypto.randomUUID();
  const env = { ...process.env, HOME: dir, COPILOT_HOME: path.join(dir, 'copilot'), COPILOT_PLUGIN_ROOT: plugin,
    PLUGIN_ROOT: plugin, COPILOT_PLUGIN_DATA: data, COPILOT_PROJECT_DIR: project, COPILOT_SESSION_ID: id, ZENSU_BOUND_SESSION_ID: id };
  for (const key of Object.keys(env)) if (key.startsWith('CLAUDE_') || key.startsWith('ZENSU_SESSION_')) delete env[key];
  const run = (file, payload, extra = {}) => spawnSync('node', [path.join(lib, file)], { cwd: project, env: { ...env, ...extra }, input: JSON.stringify(payload), encoding: 'utf8' });
  return { dir, project, data, id, env, run };
}

test('native principal refuses every partial or unclassified child identity', () => {
  assert.equal(principal.classifyPreToolPayload({}), 'main-v1');
  for (const fields of [{ isChild: true }, { parentAgentId: 'parent' }, { agentName: 'unknown' }, { agentId: 'child' }, { agentType: '' }]) {
    assert.equal(principal.classifyPreToolPayload(fields), 'host-profile-v1');
  }
  assert.equal(principal.classifyPreToolPayload({ agentId: 'r', agentType: 'zensu:review-aspect', isChild: true }), 'reviewer-readonly-v1');
});

test('native session control binds helpers and rejects independently changed selectors', t => {
  const f = fixture(t);
  const start = f.run('copilot-session-control-v1.js', { eventName: 'sessionStart', sessionId: f.id, cwd: f.project, source: 'new' });
  assert.equal(start.status, 0, start.stderr);
  assert.match(JSON.parse(start.stdout).additionalContext, /zensu-session-context/);
  const helper = extra => spawnSync('node', [path.join(lib, 'copilot-hook-session-v1.js'), 'model-bind'], { env: { ...f.env, ...extra }, cwd: f.project, encoding: 'utf8' });
  assert.equal(helper({}).status, 0);
  const mismatch = helper({ COPILOT_SESSION_ID: crypto.randomUUID() });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /selector mismatch/);
  const legacy = f.run('copilot-session-control-v1.js', { hook_event_name: 'SessionStart', session_id: f.id, cwd: f.project, source: 'startup' });
  assert.notEqual(legacy.status, 0);
});

test('source-write parser guards both native identity selectors', () => {
  for (const name of ['COPILOT_SESSION_ID', 'ZENSU_BOUND_SESSION_ID']) {
    assert.match(shell.detectControlMutation(`${name}=other bash helper.sh`), /Blocked/);
    assert.match(shell.detectControlMutation(`export ${name}=other`), /Blocked/);
  }
  assert.equal(shell.detectControlMutation('printf test'), '');
});

test('native edit secret scanning observes new_str and native fixture exemptions', t => {
  const f = fixture(t); const secret = 'ghp_' + 'q'.repeat(36);
  const denied = f.run('secret-scan-decide.js', { toolName: 'edit', toolArgs: { path: 'src/a.js', old_str: 'old', new_str: secret } });
  assert.equal(denied.status, 0); assert.notEqual(denied.stdout.trim(), '');
  const fixtureEdit = f.run('secret-scan-decide.js', { toolName: 'edit', toolArgs: { path: 'tests/example.js', old_str: 'old', new_str: secret } });
  assert.equal(fixtureEdit.stdout, '');
});

test('reviewer grant inspects actual native agent frontmatter and task agent_type', () => {
  assert.equal(grants.CONFINED_REVIEWER_AGENTS.length, 5);
  assert.equal(JSON.parse(grants.decide(JSON.stringify({ toolName: 'task', toolArgs: { agent_type: 'zensu:code-reviewer' } }))).permissionDecision, 'allow');
  assert.equal(grants.decide(JSON.stringify({ toolName: 'task', toolArgs: { agent_type: 'general-purpose' } })), '');
});

test('native rg alias retains grep protected traversal, content regex and neutral-child boundaries', t => {
  const f = fixture(t);
  const start = f.run('copilot-session-control-v1.js', { eventName: 'sessionStart', sessionId: f.id, cwd: f.project, source: 'new' });
  assert.equal(start.status, 0, start.stderr);
  const source = path.join(f.project, 'src'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'index.js'), 'const marker = "../.zensu/state";\n');
  const alias = path.join(f.project, 'state-alias'); fs.symlinkSync(path.join(f.project, '.zensu'), alias);
  const check = (agentType, args) => {
    const normalized = normalizeTool('rg', args);
    assert.deepEqual(normalized.normalizationErrors, []);
    // Evidence leases and every other policy receive the exact same native call.
    assert.deepEqual(normalized.toolCalls, normalizeTool('grep', args).toolCalls);
    return normalized.toolCalls.map(call => {
      const result = f.run('reviewer-capability-v1.js', { eventName: 'preToolUse', sessionId: f.id,
        cwd: f.project, agentId: 'read-child', isChild: true, agentType, ...call });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout || '{}');
    });
  };
  for (const agent of ['zensu:review-aspect', 'zensu-review-domain']) {
    const safe = check(agent, { paths: [source], pattern: '../.zensu/state|spawnSync', output_mode: 'content', '-n': true, glob: '*.js' });
    assert.ok(safe.every(result => result.permissionDecision !== 'deny'), JSON.stringify(safe));
    for (const args of [
      { pattern: 'value' }, { paths: f.project, pattern: 'value' },
      { paths: [source, path.join(f.project, '.zensu')], pattern: 'value' },
      { paths: alias, pattern: 'value' }, { paths: f.dir, pattern: 'value' },
      ...['glob', 'include', 'exclude'].flatMap(field => ['../.zensu/**', '.zensu/**', path.join(f.project, '.zensu', '*')]
        .map(filter => ({ paths: source, pattern: 'value', [field]: filter }))),
    ]) {
      const decisions = check(agent, args);
      assert.ok(decisions.some(result => result.permissionDecision === 'deny'), agent + ': ' + JSON.stringify(args));
    }
  }
});

test('reanchor conservatively preserves unclosed native workspace ownership', t => {
  const f = fixture(t); const registry = path.join(f.data, 'copilot-sessions'); fs.mkdirSync(registry, { mode: 0o700 });
  const write = entry => fs.writeFileSync(path.join(registry, crypto.createHash('sha256').update(entry.sessionId).digest('hex') + '.json'), JSON.stringify({ schemaVersion: 1, cwd: f.project, ...entry }), { mode: 0o600 });
  write({ sessionId: f.id, status: 'active' });
  const foreign = crypto.randomUUID(); write({ sessionId: foreign, status: 'active', updatedAt: '2000-01-01T00:00:00Z', pid: 999999 });
  const options = { environment: f.env, recordsDir: path.join(f.data, 'records'), sessionId: f.id };
  let claims = reanchor.registryClaims(options);
  assert.equal(claims.unverifiable.length, 0); assert.equal(claims.claims.length, 1);
  assert.equal(claims.claims[0].session, foreign);
  write({ sessionId: foreign, status: 'ended' });
  claims = reanchor.registryClaims(options); assert.equal(claims.claims.length, 0);
  fs.writeFileSync(path.join(registry, 'a'.repeat(64) + '.json'), '{}');
  assert.notEqual(reanchor.registryClaims(options).unverifiable.length, 0);
});

test('approved plan reads only bytes from the correlated native human receipt', () => {
  const { resolveApprovedPlan } = require(path.join(lib, 'plan-payload-v1'));
  const payload = { planApproved: true, toolArgs: { plan: 'model replacement', planFilePath: '/do-not-read' }, toolResult: { approved: true, isAgent: false, plan: 'human approved plan' } };
  assert.equal(resolveApprovedPlan(payload).plan, 'human approved plan');
  assert.equal(resolveApprovedPlan({ ...payload, planApproved: false }).ok, false);
  assert.equal(resolveApprovedPlan({ ...payload, toolResult: { resultType: 'success', plan: 'transport success' } }).ok, false);
  assert.equal(resolveApprovedPlan({ ...payload, toolResult: { approved: true, isAgent: true, plan: 'agent claim' } }).ok, false);
});

test('browser consent readiness requires both native dispatcher and policy registration', t => {
  const consent = require(path.join(lib, 'verify-consent-v1'));
  assert.equal(consent.consentHookRegistered(plugin), 'registered');
  assert.equal(consent.consentRecorderRegistered(plugin), 'registered');
  const f = fixture(t); const packageRoot = path.join(f.dir, 'package');
  fs.mkdirSync(path.join(packageRoot, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'com.github.copilot/hooks'), { recursive: true });
  fs.copyFileSync(path.join(plugin, 'hooks/pre-browser-navigation-consent.sh'), path.join(packageRoot, 'hooks/pre-browser-navigation-consent.sh'));
  const hostFile = path.join(packageRoot, 'com.github.copilot/hooks/hooks.json');
  const registryFile = path.join(packageRoot, 'hooks/registry.json');
  fs.copyFileSync(path.join(plugin, 'com.github.copilot/hooks/hooks.json'), hostFile);
  fs.copyFileSync(path.join(plugin, 'hooks/registry.json'), registryFile);
  assert.equal(consent.consentHookRegistered(packageRoot), 'registered');
  const registry = JSON.parse(fs.readFileSync(registryFile));
  registry.preToolUse = registry.preToolUse.filter(entry => !entry.script.endsWith('pre-browser-navigation-consent.sh'));
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  assert.equal(consent.consentHookRegistered(packageRoot), 'unregistered');
  fs.copyFileSync(path.join(plugin, 'hooks/registry.json'), registryFile);
  fs.writeFileSync(hostFile, JSON.stringify({ version: 1, hooks: { preToolUse: [] } }));
  assert.equal(consent.consentHookRegistered(packageRoot), 'unregistered');
});
