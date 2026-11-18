'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { dispatch } = require('../../src/dispatcher');
const plugin = path.resolve(__dirname, '../../src/plugin');
const lib = path.join(plugin, 'hooks/lib');
const POLICY_STDIN_LIMIT_BYTES = require('../../src/protocol').MAX_POLICY_INPUT_BYTES;

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-hook-input-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  const data = path.join(base, 'data');
  fs.mkdirSync(project);
  fs.mkdirSync(data, { mode: 0o700 });
  const sessionId = crypto.randomUUID();
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE_|ZENSU_|COPILOT_)/.test(key) || ['PLUGIN_ROOT', 'PLUGIN_DATA', 'NODE_OPTIONS'].includes(key)) delete env[key];
  }
  Object.assign(env, { HOME: base, COPILOT_HOME: path.join(base, 'copilot'), COPILOT_PLUGIN_ROOT: plugin,
    COPILOT_PLUGIN_DATA: data, COPILOT_PROJECT_DIR: project, COPILOT_SESSION_ID: sessionId });
  const bind = () => {
    const result = spawnSync(process.execPath, [path.join(lib, 'copilot-session-control-v1.js')], { cwd: project, env,
      input: JSON.stringify({ eventName: 'sessionStart', source: 'new', sessionId, cwd: project }), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  return { project, data, sessionId, env, bind };
}

function run(f, raw, real = []) {
  const spawns = [];
  const output = dispatch('preToolUse', { sessionId: f.sessionId, cwd: f.project, timestamp: 1, ...raw }, {
    root: plugin, env: f.env, spawnSync: (file, args, options) => {
      const hook = path.basename(args[0]);
      spawns.push({ hook, input: options.input, env: options.env });
      return real.includes(hook) ? spawnSync(file, args, options) : { status: 0, stdout: '{}' };
    },
  });
  return { output, spawns, operations: [...new Map(spawns.map(spawn => [spawn.input, spawn])).values()] };
}

const lines = (tag, kib) => Array.from({ length: kib * 16 }, (_, index) => `const ${tag}${index} = '${'q'.repeat(44)}';`);
const added = text => text.map(line => `+${line}`);
const removed = text => text.map(line => `-${line}`);
const add = (file, text) => [`*** Add File: ${file}`, ...added(text)];
const update = (file, before, after) => [`*** Update File: ${file}`, '@@', ...removed(before), ...added(after)];
const move = (file, destination, before, after) => [`*** Update File: ${file}`, `*** Move to: ${destination}`, '@@',
  ...removed(before), ...added(after)];
const remove = file => [`*** Delete File: ${file}`];
const patchOf = (...files) => ['*** Begin Patch', ...files.flat(), '*** End Patch', ''].join('\n');

test('a multi-file patch far below the 1 MiB policy stdin limit reaches the capability gate and session binder within it', t => {
  const f = fixture(t);
  f.bind();
  const patch = patchOf(add('src/added.js', lines('a', 32)), update('src/updated.js', lines('u', 16), lines('v', 16)),
    move('src/moved.js', 'src/destination.js', ['old'], ['new']), remove('src/deleted.js'), add('src/second.js', lines('s', 32)));
  assert.ok(Buffer.byteLength(patch) * 8 < POLICY_STDIN_LIMIT_BYTES, `the patch itself is ${Buffer.byteLength(patch)} bytes`);
  const { output, operations } = run(f, { toolName: 'apply_patch', toolArgs: patch }, ['pre-reviewer-capability-gate.sh']);
  assert.equal(operations.length, 6);
  assert.notEqual(output.permissionDecision, 'deny', output.permissionDecisionReason);
  for (const { input, env } of operations) {
    const bound = spawnSync(process.execPath, ['./copilot-hook-session-v1.js'], { cwd: lib, env, input, encoding: 'utf8' });
    assert.equal(bound.status, 0, `${Buffer.byteLength(input)}-byte operation input: ${bound.stderr}`);
  }
});

test('a single create reaches the capability gate with its content once', t => {
  const f = fixture(t);
  f.bind();
  const content = lines('c', 400).join('\n');
  assert.ok(Buffer.byteLength(content) * 2 < POLICY_STDIN_LIMIT_BYTES);
  const { output, operations } = run(f, { toolName: 'create', toolArgs: { path: 'src/generated.js', content } },
    ['pre-reviewer-capability-gate.sh']);
  assert.equal(operations.length, 1);
  const input = JSON.parse(operations[0].input);
  assert.deepEqual(input.toolArgs, { path: 'src/generated.js', content });
  assert.equal(Object.hasOwn(input, 'toolCalls'), false);
  assert.notEqual(output.permissionDecision, 'deny', output.permissionDecisionReason);
});

test('an added file larger than half the policy stdin limit reaches the capability gate and session binder', t => {
  const f = fixture(t);
  f.bind();
  const text = lines('p', 600);
  const content = text.join('\n');
  assert.ok(Buffer.byteLength(content) * 2 > POLICY_STDIN_LIMIT_BYTES && Buffer.byteLength(content) < POLICY_STDIN_LIMIT_BYTES);
  const { output, operations } = run(f, { toolName: 'apply_patch', toolArgs: patchOf(add('src/fixture.js', text)) },
    ['pre-reviewer-capability-gate.sh']);
  assert.equal(operations.length, 1);
  assert.deepEqual(JSON.parse(operations[0].input).toolArgs, { path: 'src/fixture.js', content, operation: 'add' });
  assert.notEqual(output.permissionDecision, 'deny', output.permissionDecisionReason);
  const bound = spawnSync(process.execPath, ['./copilot-hook-session-v1.js'], { cwd: lib, env: operations[0].env,
    input: operations[0].input, encoding: 'utf8' });
  assert.equal(bound.status, 0, bound.stderr);
});

test('an operation over the policy stdin limit is denied before any policy runs, naming its path and size', t => {
  const f = fixture(t);
  const content = lines('o', 1100).join('\n');
  assert.ok(Buffer.byteLength(content) > POLICY_STDIN_LIMIT_BYTES);
  const { output, spawns } = run(f, { toolName: 'create', toolArgs: { path: 'src/huge.js', content } });
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason,
    new RegExp(`create operation on "src/huge\\.js": its policy input is \\d+ bytes and Zensu policies accept at most ${POLICY_STDIN_LIMIT_BYTES}\\.`));
  assert.equal(spawns.length, 0);
});

test('an oversize operation after a smaller one is denied before any policy of the patch runs', t => {
  const f = fixture(t);
  const patch = patchOf(update('src/updated.js', ['old'], ['new']), add('src/huge.js', lines('o', 1100)));
  const { output, spawns } = run(f, { toolName: 'apply_patch', toolArgs: patch });
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason,
    new RegExp(`create operation on "src/huge\\.js": its policy input is \\d+ bytes and Zensu policies accept at most ${POLICY_STDIN_LIMIT_BYTES}\\.`));
  assert.equal(spawns.length, 0);
});

test('each operation reaches its policies with its own path and content and nothing of the other operations', t => {
  const f = fixture(t);
  const moved = move('src/moved.js', 'src/destination.js', ['old line'], ['new line']);
  const alone = run(f, { toolName: 'apply_patch', toolArgs: patchOf(moved) }).operations.map(spawn => spawn.input);
  const among = run(f, { toolName: 'apply_patch',
    toolArgs: patchOf(add('src/added.js', lines('a', 4)), moved, remove('src/deleted.js')) }).operations.map(spawn => spawn.input);
  assert.equal(alone.length, 2);
  assert.equal(among.length, 4);
  const [source, destination] = alone.map(input => JSON.parse(input));
  assert.deepEqual([source.toolName, source.toolArgs], ['edit',
    { path: 'src/moved.js', new_str: 'new line', old_str: 'old line', operation: 'update' }]);
  assert.deepEqual([destination.toolName, destination.toolArgs], ['edit',
    { path: 'src/destination.js', new_str: 'new line', old_str: 'old line', operation: 'move-destination', sourcePath: 'src/moved.js' }]);
  const created = JSON.parse(among[0]);
  assert.deepEqual([created.toolName, Object.keys(created.toolArgs).sort()], ['create', ['content', 'operation', 'path']]);
  assert.equal(created.toolArgs.content, lines('a', 4).join('\n'));
  for (const input of [source, destination, created]) {
    assert.deepEqual([input.eventName, input.sessionId, input.cwd, input.isChild], ['preToolUse', f.sessionId, f.project, false]);
    assert.equal(typeof input.transcriptPath, 'string');
    assert.equal(typeof input.nativeSessionId, 'string');
    assert.equal(Object.hasOwn(input, 'toolCalls') || Object.hasOwn(input, 'toolChanges'), false);
  }
  assert.deepEqual(among.slice(1, 3), alone);
});

test('a confined child still cannot move a file into or out of protected workflow state', t => {
  const f = fixture(t);
  f.bind();
  const child = { agentId: 'child-1', agentType: 'general-purpose', toolName: 'apply_patch' };
  const decide = patch => run(f, { ...child, toolArgs: patch }, ['pre-reviewer-capability-gate.sh']).output;
  const harmless = decide(patchOf(add('src/added.js', ['const a = 1;']), move('src/moved.js', 'src/destination.js', ['old'], ['new'])));
  assert.notEqual(harmless.permissionDecision, 'deny', harmless.permissionDecisionReason);
  for (const patch of [patchOf(add('src/added.js', ['const a = 1;']), move('src/moved.js', '.zensu/state/forged.json', ['old'], ['new'])),
    patchOf(add('src/added.js', ['const a = 1;']), move('.zensu/state/workflow.json', 'src/stolen.json', ['old'], ['new']))]) {
    const output = decide(patch);
    assert.equal(output.permissionDecision, 'deny');
    assert.match(output.permissionDecisionReason, /^reviewer-capability-v1 deny: host-profile-v1 cannot /);
  }
});

test('a patch header hidden behind a lone CR, U+2028 or U+2029 is denied before any policy runs', t => {
  const f = fixture(t);
  for (const separator of [13, 0x2028, 0x2029].map(code => String.fromCharCode(code))) {
    for (const hidden of [` ctx${separator}*** Add File: .zensu/state/forged.json`, `@@ ${separator}*** Move to: .zensu/state/forged.json`]) {
      for (const identity of [{}, { agentId: 'child-1', agentType: 'general-purpose' }]) {
        const patch = patchOf(['*** Update File: src/updated.js', hidden, '-old', '+new']);
        const { output, spawns } = run(f, { ...identity, toolName: 'apply_patch', toolArgs: patch });
        assert.equal(output.permissionDecision, 'deny');
        assert.match(output.permissionDecisionReason, /could not safely interpret preToolUse: .*patch-ambiguous-line-break/);
        assert.equal(spawns.length, 0);
      }
    }
  }
});

test('a later operation that writes the plugin store or carries a secret is still denied', t => {
  const f = fixture(t);
  f.bind();
  const key = ['AKIA', 'Q7W3E9R2T5Y8U1I4'].join('');
  const patch = patchOf(add('src/added.js', ['const a = 1;']), add('src/config.js', [`const key = '${key}';`]),
    add(path.join(f.data, 'session-control', 'forged.json'), ['{}']));
  const { output } = run(f, { toolName: 'apply_patch', toolArgs: patch }, ['pre-write-plugin-data-guard.sh', 'pre-write-secret-scan.sh']);
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /secret pattern\(s\): aws-access-key-id/);
  assert.match(output.permissionDecisionReason, /Plugin-Data-Guard: writing into the Zensu plugin's private data store is blocked/);
});

test('an unaccounted mutating schema is still denied before any policy runs', t => {
  const f = fixture(t);
  for (const [toolName, toolArgs] of [['apply_patch', { patch: 'diff --git a/x b/x' }], ['str_replace_editor', { path: 'x', command: 'undo_edit' }]]) {
    const { output, spawns } = run(f, { toolName, toolArgs });
    assert.equal(output.permissionDecision, 'deny');
    assert.match(output.permissionDecisionReason, /could not safely interpret preToolUse/);
    assert.equal(spawns.length, 0);
  }
});
