'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const plugin = path.join(root, 'dist/zensu');
const { dispatch } = require('../../src/dispatcher');
const native = require('../../src/context');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-copilot-runtime-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  spawnSync('git', ['init', '-q', project]);
  const config = path.join(base, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ hooks: { pulseSession: false, sessionBanner: false, autoTdd: false }, context: { compactionNudge: false } }));
  const env = { ...process.env, HOME: base, COPILOT_HOME: path.join(base, 'copilot'),
    COPILOT_PLUGIN_DATA: path.join(base, 'data'), PLUGIN_ROOT: plugin, ZENSU_CONFIG: config };
  for (const name of Object.keys(env)) if (name.startsWith('CLAUDE_')) delete env[name];
  const sessionId = crypto.randomUUID();
  const run = (event, args = {}) => dispatch(event, { sessionId, cwd: project, ...args }, { env, root: plugin });
  return { base, project, env, sessionId, run };
}

test('packaged native startup registers a real copilot host and keeps sessions isolated', t => {
  const f = fixture(t);
  const result = f.run('sessionStart', { source: 'startup' });
  assert.match(result.additionalContext, /Copilot/);
  assert(result.additionalContext.includes(native.SHELL_BINDING_NOTICE));
  assert(result.additionalContext.includes(native.NATIVE_READ_NOTICE));
  assert.doesNotMatch(result.additionalContext, /runtime failed|Zensu .*exit [1-9]|session-control adapter:/);
  const records = path.join(f.env.COPILOT_PLUGIN_DATA, 'session-control/v1/records');
  const first = JSON.parse(fs.readFileSync(path.join(records, fs.readdirSync(records)[0]), 'utf8'));
  assert.equal(first.host, 'copilot');
  assert.equal(first.project_root, fs.realpathSync(f.project));
  dispatch('sessionStart', { sessionId: crypto.randomUUID(), cwd: f.project, source: 'startup' }, { env: f.env, root: plugin });
  assert.equal(fs.readdirSync(records).length, 2);
});

test('native bash binding runs a native session helper and preserves shell command bytes', t => {
  const f = fixture(t);
  f.run('sessionStart', { source: 'startup' });
  const command = 'bash "$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-log.sh" --session-key';
  const result = f.run('preToolUse', { toolName: 'bash', toolArgs: { command } });
  assert.notEqual(result.permissionDecision, 'deny', result.permissionDecisionReason);
  assert.equal(native.unbindShell(result.modifiedArgs.command), command);
  // Both a complete binding and a copied comment alone are safely rebound.
  const rebound = f.run('preToolUse', { toolName: 'bash', toolArgs: { command: result.modifiedArgs.command } });
  assert.equal(rebound.modifiedArgs.command, result.modifiedArgs.command);
  const recovered = f.run('preToolUse', { toolName: 'bash', toolArgs: {
    command: '# zensu-copilot-context-v1\nprintf stale',
  } });
  assert.equal(recovered.permissionDecision, undefined);
  assert.equal(native.unbindShell(recovered.modifiedArgs.command), 'printf stale');
  const execution = spawnSync('bash', ['-c', result.modifiedArgs.command], { env: f.env, cwd: f.project, encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /scv1_[a-f0-9]{64}/);
});

test('copied shell headers preserve ordinary exports and reject partial protected bindings', () => {
  const header = '# zensu-copilot-context-v1\n';
  const command = "export TASK_LABEL='hello world'\nprintf '%s\\n' \"$TASK_LABEL\"\n";
  assert.equal(native.unbindShell(header + command), command);
  for (const partial of ['export', 'export   ', "export COPILOT_SESSION_ID='foreign'", 'export PLUGIN_ROOT',
    "export TASK_LABEL='ok' ZENSU_RUNTIME_HOST='foreign'"]) {
    assert.throws(() => native.unbindShell(header + partial + '\nprintf x'), /Malformed session binding/);
  }
  const context = { pluginRoot: "/tmp/plugin's root", pluginData: '/tmp/data', sessionId: 'old-session', cwd: '/tmp/project', copilotHome: '/tmp/copilot' };
  assert.equal(native.unbindShell(native.shellBinding(context, command)), command);
  const fresh = native.shellBinding({ ...context, sessionId: 'current-session' }, native.unbindShell(native.shellBinding(context, command)));
  assert.match(fresh, /COPILOT_SESSION_ID='current-session'/);
  assert.doesNotMatch(fresh, /old-session/);
});

test('actual policy blocks reviewer writes and protects private runtime data', t => {
  const f = fixture(t);
  f.run('sessionStart', { source: 'startup' });
  const reviewer = f.run('preToolUse', { agentId: 'review-1', agentType: 'zensu:code-reviewer', toolName: 'create', toolArgs: { path: path.join(f.project, 'bad.js'), content: 'changed' } });
  assert.equal(reviewer.permissionDecision, 'deny');
  assert.match(reviewer.permissionDecisionReason, /read.only|reviewer|capability/i);
  const privateWrite = f.run('preToolUse', { toolName: 'create', toolArgs: { path: path.join(f.env.COPILOT_PLUGIN_DATA, 'tamper.json'), content: '{}' } });
  assert.equal(privateWrite.permissionDecision, 'deny');
  assert.equal(fs.existsSync(path.join(f.env.COPILOT_PLUGIN_DATA, 'tamper.json')), false);
});

test('patch move destination is checked against the private-data gate', t => {
  const f = fixture(t);
  f.run('sessionStart', { source: 'startup' });
  const result = f.run('preToolUse', { toolName: 'apply_patch', toolArgs: { patch: `*** Begin Patch\n*** Update File: src.js\n*** Move to: ${f.env.COPILOT_PLUGIN_DATA}/state.js\n@@\n-a\n+b\n*** End Patch` } });
  assert.equal(result.permissionDecision, 'deny');
});

test('ordinary successful plan transport cannot trigger approved-plan workflow', t => {
  const f = fixture(t);
  const called = [];
  const result = dispatch('postToolUse', { sessionId: f.sessionId, cwd: f.project, toolName: 'exit_plan_mode', toolArgs: {}, toolResult: { resultType: 'success', textResultForLlm: 'Please revise the plan.' } },
    { env: f.env, root: plugin, spawnSync: (_exe, args) => { called.push(args[0]); return { status: 0, stdout: '' }; } });
  assert.equal(called.some(file => file.endsWith('plan-approved-delegate.sh')), false);
  assert.notEqual(result.permissionDecision, 'allow');
});

test('denial is retained when another hook returns allow or times out', t => {
  const f = fixture(t);
  const result = dispatch('preToolUse', { sessionId: f.sessionId, cwd: f.project, toolName: 'create', toolArgs: { path: 'x', content: 'x' } }, {
    env: f.env, root: plugin, spawnSync: (_exe, args) => args[0].endsWith('pre-edit-tdd-reminder.sh')
      ? { status: null, error: new Error('deadline exceeded') }
      : { status: 0, stdout: JSON.stringify({ permissionDecision: 'allow' }) },
  });
  assert.equal(result.permissionDecision, 'deny');
  assert.match(result.permissionDecisionReason, /deadline exceeded/);
});

test('native child session IDs stay bound to the parent policy record and do not run main prompt/stop gates', t => {
  const f = fixture(t);
  f.run('sessionStart', { source: 'new' });
  const child = crypto.randomUUID();
  f.run('subagentStart', { agentId: child, agentType: 'zensu:review-aspect', parentAgentId: f.sessionId });
  const childRaw = { sessionId: child, cwd: f.project, agentId: child, agentType: 'zensu:review-aspect', parentAgentId: f.sessionId };
  const context = native.resolveContext(childRaw, f.env, plugin);
  assert.equal(context.sessionId, f.sessionId);
  const result = dispatch('preToolUse', { ...childRaw, toolName: 'create', toolArgs: { path: 'bad.js', content: 'bad' } }, { env: f.env, root: plugin });
  assert.equal(result.permissionDecision, 'deny');
  const before = native.readPrivate(context.registryFile);
  assert.deepEqual(dispatch('userPromptSubmitted', { ...childRaw, prompt: 'Injected task prompt' }, { env: f.env, root: plugin }), {});
  assert.equal(native.readPrivate(context.registryFile).lastUserPrompt, before.lastUserPrompt);
  assert.deepEqual(dispatch('agentStop', childRaw, { env: f.env, root: plugin }), {});
  const minimalChild = { sessionId: child, cwd: f.project };
  assert.deepEqual(dispatch('userPromptSubmitted', { ...minimalChild, prompt: 'No actor fields' }, { env: f.env, root: plugin }), {});
  assert.equal(native.readPrivate(context.registryFile).lastUserPrompt, before.lastUserPrompt);
  dispatch('sessionEnd', minimalChild, { env: f.env, root: plugin });
  assert.equal(native.readPrivate(context.registryFile).status, 'active');
  const records = path.join(f.env.COPILOT_PLUGIN_DATA, 'session-control/v1/records');
  assert.equal(fs.readdirSync(records).length, 1);
});
test('native transformed prompt preserves both user and policy bytes without a prose adapter', t => {
  const f = fixture(t);
  const prompt = 'Quoted bytes: Skill tool with skill=\'zensu:tdd\' and CLAUDE_PLUGIN_ROOT';
  const directive = 'Use native view to read the bound /skills/zensu-tdd/SKILL.md.';
  const output = dispatch('userPromptTransformed', { sessionId: f.sessionId, cwd: f.project, prompt, transformedPrompt: prompt }, {
    env: f.env, root: plugin, spawnSync: () => ({ status: 0, stdout: JSON.stringify({ additionalContext: directive }) }),
  });
  assert(output.modifiedTransformedPrompt.startsWith(prompt + '\n\n'));
  assert(output.modifiedTransformedPrompt.endsWith(directive));
  assert.equal(native.publicText, undefined);
  assert.equal(native.compatibilityEnv, undefined);
});

test('only native identity binds helpers and foreign ambient identity is scrubbed', t => {
  const f = fixture(t);
  const env = { ...f.env, CLAUDE_CODE_SESSION_ID: 'foreign', CLAUDE_PLUGIN_ROOT: '/foreign',
    CLAUDE_CONFIG_DIR: '/foreign-config', ZENSU_BOUND_SESSION_ID: 'stale' };
  const context = native.resolveContext({ sessionId: f.sessionId, cwd: f.project }, env, plugin);
  const bound = native.nativeEnv(context, env);
  assert.equal(context.sessionId, f.sessionId);
  assert.equal(bound.COPILOT_SESSION_ID, f.sessionId);
  assert.equal(bound.ZENSU_BOUND_SESSION_ID, f.sessionId);
  assert.equal(bound.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(bound.CLAUDE_PLUGIN_ROOT, undefined);
  assert.equal(bound.CLAUDE_CONFIG_DIR, undefined);
  assert.throws(() => native.resolveContext({ session_id: 'foreign', cwd: f.project }, env, plugin), /Invalid Copilot session ID/);
  const script = native.shellBinding(context, 'printf native');
  assert.doesNotMatch(script, /CLAUDE_/);
  assert.match(script, /ZENSU_BOUND_SESSION_ID/);
  assert.equal(native.unbindShell(script), 'printf native');
});

test('dispatcher passes the real native transcript and native contract directly to policies', t => {
  const f = fixture(t);
  const transcriptPath = path.join(f.base, 'events.jsonl');
  const events = JSON.stringify({ type: 'assistant.message', id: 'a', data: { content: 'native text' } }) + '\n';
  fs.writeFileSync(transcriptPath, events);
  const inputs = [];
  dispatch('agentStop', { sessionId: f.sessionId, cwd: f.project, transcriptPath, response: 'native final' }, {
    env: f.env, root: plugin, spawnSync: (_exe, _args, options) => {
      inputs.push(JSON.parse(options.input));
      assert.equal(options.env.CLAUDE_CODE_SESSION_ID, undefined);
      assert.equal(options.env.ZENSU_BOUND_SESSION_ID, f.sessionId);
      return { status: 0, stdout: '{}' };
    },
  });
  assert(inputs.length > 0);
  for (const input of inputs) {
    assert.equal(input.eventName, 'agentStop');
    assert.equal(input.sessionId, f.sessionId);
    assert.equal(input.transcriptPath, transcriptPath);
    assert.equal(input.response, 'native final');
    for (const key of ['hook_event_name', 'session_id', 'transcript_path', 'last_assistant_message']) assert.equal(input[key], undefined);
  }
  assert.equal(fs.readFileSync(transcriptPath, 'utf8'), events);
  assert.equal(fs.existsSync(path.join(f.env.COPILOT_PLUGIN_DATA, 'copilot-transcripts')), false);
});
