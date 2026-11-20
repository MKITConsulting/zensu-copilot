'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const aiWork = require('../../src/ai-work');
const { dispatch, eventBudget, stopCheckerSeconds } = require('../../src/dispatcher');

const plugin = path.resolve(__dirname, '../../src/plugin');
const STOP_HOOKS = ['stop-chain-enforcer.sh', 'stop-work-order.sh', 'user-prompt-zen-mode.sh'];
const timedOut = () => ({ status: null, signal: 'SIGKILL', error: Object.assign(new Error('spawnSync bash ETIMEDOUT'), { code: 'ETIMEDOUT' }) });

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-stop-deadline-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  const env = { PATH: process.env.PATH, HOME: base, COPILOT_HOME: path.join(base, 'home'), COPILOT_PLUGIN_DATA: path.join(base, 'data') };
  t.mock.method(aiWork, 'run', () => ({ status: 'not_started' }));
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const warnings = [];
  t.mock.method(process.stderr, 'write', text => { warnings.push(String(text)); return true; });
  const spawns = [];
  const stop = (cost, extraEnv = {}) => {
    now = 0;
    spawns.length = 0;
    warnings.length = 0;
    return dispatch('agentStop', { sessionId: 'stop-deadline-fixture', cwd: project, stopReason: 'end_turn' }, {
      root: plugin, env: { ...env, ...extraEnv }, spawnSync: (_exe, args, options) => {
        const spawn = { hook: path.basename(args[0]), timeout: options.timeout, deadline: options.env.ZENSU_STOP_DEADLINE_SECONDS };
        spawns.push(spawn);
        const { ms = 0, result } = cost(spawn) || {};
        now += ms;
        return result || { status: 0, stdout: '' };
      },
    });
  };
  return { spawns, warnings, stop, project, base, env };
}

test('agentStop has eighty seconds inside a ninety-second native registration', () => {
  assert.equal(eventBudget('agentStop', 1), 80000);
  assert.equal(eventBudget('agentStop', 1000), 80000);
  const hooks = JSON.parse(fs.readFileSync(path.join(plugin, 'com.github.copilot/hooks/hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.agentStop[0].timeoutSec, 90);
});

test('the shared stop checker gets a deadline that ends inside the dispatcher budget', t => {
  const f = fixture(t);
  for (const [requested, expected] of [[undefined, '45'], ['30', '30'], ['75', '60'], ['5', '10'], ['abc', '45']]) {
    assert.deepEqual(f.stop(() => ({}), requested === undefined ? {} : { ZENSU_STOP_DEADLINE_SECONDS: requested }), {}, String(requested));
    assert.deepEqual(f.spawns.map(spawn => spawn.hook), STOP_HOOKS);
    assert.equal(f.spawns[0].deadline, expected, String(requested));
    assert.equal(f.spawns[0].timeout, 80000);
  }
  assert.equal(stopCheckerSeconds('75', 50000), '30');
  assert.equal(stopCheckerSeconds(undefined, 59999), '39');
  assert.equal(stopCheckerSeconds(undefined, 25000), '10');
});

test('the handed deadline also ends inside a stop check with a shorter registry timeout', t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-stop-registry-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'plugin');
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(root, 'hooks/registry.json'), JSON.stringify({ agentStop: [{ script: 'hooks/stop-chain-enforcer.sh', timeout: 40 }] }));
  const seen = [];
  const output = dispatch('agentStop', { sessionId: 'stop-registry-fixture', cwd: project, stopReason: 'end_turn' }, {
    root, env: { PATH: process.env.PATH, HOME: base, COPILOT_HOME: path.join(base, 'home'), COPILOT_PLUGIN_DATA: path.join(base, 'data') },
    spawnSync: (_exe, _args, options) => { seen.push([options.timeout, options.env.ZENSU_STOP_DEADLINE_SECONDS]); return { status: 0, stdout: '' }; },
  });
  assert.deepEqual(output, {});
  assert.deepEqual(seen, [[40000, '20']]);
});

test('the handed deadline follows the shared shell clamp for every requested value', () => {
  const lib = path.join(plugin, 'hooks/lib/zensu-stop-deadline.sh');
  for (const value of ['', 'abc', '12a', '-5', ' 45', '0', '000', '5', '9', '10', '45', '0045', '75', '76', '450', '9999999']) {
    const shell = spawnSync('bash', ['-c', 'source "$1"; zensu_stop_deadline_seconds', 'zensu-stop-deadline', lib], {
      env: { PATH: process.env.PATH, ZENSU_STOP_DEADLINE_SECONDS: value }, encoding: 'utf8',
    });
    assert.equal(shell.status, 0, JSON.stringify(value));
    assert.equal(stopCheckerSeconds(value, Infinity), shell.stdout.trim(), JSON.stringify(value));
  }
});

test('a stop check that runs out of time without a decision releases the stop instead of re-prompting', t => {
  const f = fixture(t);
  const output = f.stop(spawn => spawn.hook === 'stop-chain-enforcer.sh' ? { ms: spawn.timeout, result: timedOut() } : {});
  assert.deepEqual(output, {});
  assert.deepEqual(f.spawns.map(spawn => spawn.hook), ['stop-chain-enforcer.sh']);
  const notice = f.warnings.join('');
  assert.match(notice, /releasing agentStop/);
  assert.match(notice, /stop-chain-enforcer\.sh/);
  assert.match(notice, /no completion was proven/);
  assert.doesNotMatch(notice, /runtime failed/);
});

test('a budget that runs out after every check allowed the stop releases it with the same notice', t => {
  const f = fixture(t);
  const output = f.stop(spawn => spawn.hook === 'stop-chain-enforcer.sh' ? { ms: 80000 } : {});
  assert.deepEqual(output, {});
  assert.deepEqual(f.spawns.map(spawn => spawn.hook), ['stop-chain-enforcer.sh']);
  assert.match(f.warnings.join(''), /releasing agentStop.*before stop-work-order\.sh.*no completion was proven/s);
});

test('a stop decision already reached stands when the budget runs out after it', t => {
  const f = fixture(t);
  const output = f.stop(spawn => spawn.hook === 'stop-chain-enforcer.sh'
    ? { ms: 80000, result: { status: 0, stdout: JSON.stringify({ decision: 'block', reason: 'Review is pending.' }) } } : {});
  assert.deepEqual(output, { decision: 'block', reason: 'Review is pending.' });
  assert.deepEqual(f.spawns.map(spawn => spawn.hook), ['stop-chain-enforcer.sh']);
  const notice = f.warnings.join('');
  assert.match(notice, /decision already reached stands/);
  assert.doesNotMatch(notice, /releasing agentStop/);
});

test('a later check that times out leaves an earlier stop decision in place', t => {
  const f = fixture(t);
  const output = f.stop(spawn => {
    if (spawn.hook === 'stop-chain-enforcer.sh') return { ms: 1000, result: { status: 0, stdout: JSON.stringify({ decision: 'block', reason: 'Review is pending.' }) } };
    if (spawn.hook === 'stop-work-order.sh') return { ms: spawn.timeout, result: timedOut() };
    return {};
  });
  assert.deepEqual(output, { decision: 'block', reason: 'Review is pending.' });
  assert.deepEqual(f.spawns.map(spawn => spawn.hook), ['stop-chain-enforcer.sh', 'stop-work-order.sh']);
  assert.match(f.warnings.join(''), /decision already reached stands/);
});

test('a stop check that fails still keeps the workflow pending', t => {
  const f = fixture(t);
  const output = f.stop(spawn => spawn.hook === 'stop-chain-enforcer.sh' ? { result: { status: 1, stdout: '', stderr: 'boom' } } : {});
  assert.deepEqual(output, { decision: 'block', reason: 'Zensu stop-chain-enforcer.sh: boom. The workflow is still pending; repair it before claiming completion.' });
  assert.doesNotMatch(f.warnings.join(''), /releasing agentStop/);
});

test('the shared checker notice for a released stop reaches the native hook stderr', t => {
  const f = fixture(t);
  const notice = 'zensu chain-enforcer: releasing agentStop — the agentStop checks did not finish within 45s and were stopped before reaching a decision.';
  const output = f.stop(spawn => spawn.hook === 'stop-chain-enforcer.sh' ? { ms: 46000, result: { status: 0, stdout: '', stderr: `${notice}\n` } } : {});
  assert.deepEqual(output, {});
  assert.deepEqual(f.spawns.map(spawn => spawn.hook), STOP_HOOKS);
  assert.ok(f.warnings.some(text => text.includes(notice)));
});

test('a real stop hook killed at its timeout releases the stop', t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-stop-kill-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'plugin');
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(root, 'hooks/registry.json'), JSON.stringify({ agentStop: [{ script: 'hooks/slow-stop.sh', timeout: 1 }] }));
  fs.writeFileSync(path.join(root, 'hooks/slow-stop.sh'),
    "#!/bin/bash\ntrap 'true' EXIT HUP INT TERM\ncat >/dev/null\nsleep 20\nprintf '{\"decision\":\"block\",\"reason\":\"late\"}\\n'\n");
  const warnings = [];
  t.mock.method(process.stderr, 'write', text => { warnings.push(String(text)); return true; });
  const started = process.hrtime.bigint();
  const output = dispatch('agentStop', { sessionId: 'stop-kill-fixture', cwd: project, stopReason: 'end_turn' },
    { root, env: { PATH: process.env.PATH, HOME: base, COPILOT_HOME: path.join(base, 'home'), COPILOT_PLUGIN_DATA: path.join(base, 'data') } });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepEqual(output, {});
  assert.match(warnings.join(''), /releasing agentStop.*slow-stop\.sh.*no completion was proven/s);
  assert.ok(elapsed < 10000, `dispatch returned after ${Math.round(elapsed)} ms`);
});
