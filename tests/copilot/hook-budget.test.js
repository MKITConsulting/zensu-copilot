'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dispatch, matchingHooks, eventBudget } = require('../../src/dispatcher');

const plugin = path.resolve(__dirname, '../../src/plugin');
const EDIT_HOOKS = ['pre-reviewer-capability-gate.sh', 'pre-write-plugin-data-guard.sh', 'pre-edit-tdd-reminder.sh',
  'pre-write-secret-scan.sh', 'pre-work-order-gate.sh'];
const DEADLINE = 'Zensu internal hook deadline exceeded; retry after resolving the slow hook.';
const patch = names => ['*** Begin Patch',
  ...names.flatMap(name => [`*** Update File: src/${name}.js`, '@@', '-old', '+new']), '*** End Patch'].join('\n');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-hook-budget-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  const env = { COPILOT_HOME: path.join(base, 'home'), COPILOT_PLUGIN_DATA: path.join(base, 'data') };
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const spawns = [];
  const run = (toolName, toolArgs, cost, event = 'preToolUse', extra = {}) => dispatch(event, { sessionId: 'hook-budget-fixture', cwd: project, toolName, toolArgs, ...extra }, {
    root: plugin, env, spawnSync: (_exe, args, options) => {
      const spawn = { hook: path.basename(args[0]), file: JSON.parse(options.input).toolArgs.path, timeout: options.timeout };
      spawns.push(spawn);
      const { ms, result } = cost(spawn);
      now += ms;
      return result || { status: 0, stdout: '' };
    },
  });
  return { spawns, run };
}

test('tool event budgets grow with every normalized operation up to their cap', () => {
  assert.equal(eventBudget('preToolUse', 1), 50000);
  assert.equal(eventBudget('preToolUse', 2), 100000);
  assert.equal(eventBudget('preToolUse', 5), 250000);
  assert.equal(eventBudget('preToolUse', 1000), 250000);
  assert.equal(eventBudget('postToolUse', 1), 35000);
  assert.equal(eventBudget('postToolUse', 5), 175000);
  assert.equal(eventBudget('postToolUse', 1000), 250000);
  for (const event of ['postToolUseFailure', 'agentStop', 'subagentStop', 'sessionStart', 'constructor']) {
    assert.equal(eventBudget(event, 5), 35000, event);
  }
});

test('every internal deadline expires at least ten seconds before the fail-open Copilot hook timeout', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(plugin, 'com.github.copilot/hooks/hooks.json'), 'utf8')).hooks;
  for (const [event, entries] of Object.entries(hooks)) {
    assert.ok(entries[0].timeoutSec * 1000 - eventBudget(event, Number.MAX_SAFE_INTEGER) >= 10000, event);
  }
});

test('a five-file patch completes a policy pass longer than the single-call budget and every edit hook sees every file', t => {
  const f = fixture(t);
  const names = ['a', 'b', 'c', 'd', 'e'];
  const output = f.run('apply_patch', { patch: patch(names) }, () => ({ ms: 3000 }));
  assert.deepEqual(output, {});
  const hooks = matchingHooks(plugin, 'preToolUse', 'edit').map(hook => hook.name);
  assert.deepEqual(hooks, EDIT_HOOKS);
  assert.deepEqual(f.spawns.map(spawn => [spawn.hook, spawn.file]),
    names.flatMap(name => hooks.map(hook => [hook, `src/${name}.js`])));
  assert.ok(f.spawns.every(spawn => spawn.timeout === 60000));
});

test('a genuinely slow hook still denies a single edit at the unchanged fifty-second deadline', t => {
  const f = fixture(t);
  const output = f.run('edit', { path: 'src/a.js', old_str: 'old', new_str: 'new' }, () => ({ ms: 50000 }));
  assert.deepEqual(output, { permissionDecision: 'deny', permissionDecisionReason: DEADLINE });
  assert.deepEqual(f.spawns.map(spawn => [spawn.hook, spawn.timeout]), [['pre-reviewer-capability-gate.sh', 50000]]);
});

test('a genuinely slow policy pass still denies a five-file patch once the scaled budget is spent', t => {
  const f = fixture(t);
  const output = f.run('apply_patch', { patch: patch(['a', 'b', 'c', 'd', 'e']) }, () => ({ ms: 11000 }));
  assert.deepEqual(output, { permissionDecision: 'deny', permissionDecisionReason:
    `${DEADLINE} This call normalized to 5 file or search-root operations; a call with fewer operations needs less time.` });
  assert.equal(f.spawns.length, 23);
  assert.equal(f.spawns.at(-1).timeout, 8000);
});

test('a hook that times out on one file denies the whole patch while every other file is still checked', t => {
  const f = fixture(t);
  const names = ['a', 'b', 'c'];
  const output = f.run('apply_patch', { patch: patch(names) }, spawn => spawn.hook === 'pre-write-secret-scan.sh' && spawn.file === 'src/b.js'
    ? { ms: spawn.timeout, result: { status: null, signal: 'SIGTERM', error: new Error('spawnSync bash ETIMEDOUT') } }
    : { ms: 1000 });
  assert.equal(output.permissionDecision, 'deny');
  assert.equal(output.permissionDecisionReason, 'Zensu pre-write-secret-scan.sh: spawnSync bash ETIMEDOUT');
  assert.deepEqual(f.spawns.map(spawn => [spawn.hook, spawn.file]), names.flatMap(name => EDIT_HOOKS.map(hook => [hook, `src/${name}.js`])));
});

test('the scaled budget stops growing at its cap', t => {
  const f = fixture(t);
  const output = f.run('apply_patch', { patch: patch('abcdefghijkl'.split('')) }, () => ({ ms: 6000 }));
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /normalized to 12 file or search-root operations/);
  assert.equal(f.spawns.length, 42);
  assert.equal(f.spawns.at(-1).timeout, 4000);
});

test('a five-file patch completes a post-tool pass longer than the single-call budget and every post hook sees every file', t => {
  const f = fixture(t);
  const names = ['a', 'b', 'c', 'd', 'e'];
  assert.doesNotThrow(() => f.run('apply_patch', { patch: patch(names) }, () => ({ ms: 5000 }), 'postToolUse',
    { toolResult: { resultType: 'success', textResultForLlm: 'Files updated.' } }));
  assert.deepEqual(f.spawns.map(spawn => [spawn.hook, spawn.file]), names.flatMap(name => [
    ['post-artifact-redact.sh', `src/${name}.js`], ['post-work-order.sh', `src/${name}.js`],
    ...(name === 'a' ? [['user-prompt-zen-mode.sh', 'src/a.js']] : [])]));
});

test('a hook that traps TERM past its timeout is killed and the call is denied before the host margin', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-hook-kill-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'plugin');
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(root, 'hooks/registry.json'), JSON.stringify({ preToolUse: [{
    script: 'hooks/trapped-gate.sh', matcher: 'edit', timeout: 1 }] }));
  fs.writeFileSync(path.join(root, 'hooks/trapped-gate.sh'),
    "#!/bin/bash\ntrap 'true' EXIT HUP INT TERM\ncat >/dev/null\nsleep 20\nprintf '{\"permissionDecision\":\"allow\"}\\n'\n");
  const started = process.hrtime.bigint();
  const output = dispatch('preToolUse', { sessionId: 'hook-kill-fixture', cwd: project, toolName: 'edit',
    toolArgs: { path: 'src/a.js', old_str: 'old', new_str: 'new' } },
  { root, env: { PATH: process.env.PATH, COPILOT_HOME: path.join(base, 'home'), COPILOT_PLUGIN_DATA: path.join(base, 'data') } });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /^Zensu trapped-gate\.sh: /);
  assert.ok(elapsed < 10000, `dispatch returned after ${Math.round(elapsed)} ms`);
});
