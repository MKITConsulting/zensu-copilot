'use strict';
// Deterministic timing and real native-shell regressions, not live model evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { dispatch } = require('../../src/dispatcher');
const contextLoad = require('../../src/plugin/hooks/lib/context-auto-load-v1');
const plugin = path.resolve(__dirname, '../../src/plugin');

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-hook-budget-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(base, 'data'), { mode: 0o700 });
  const sessionId = crypto.randomUUID();
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE_|ZENSU_|COPILOT_)/.test(key) || ['PLUGIN_ROOT', 'PLUGIN_DATA', 'NODE_OPTIONS'].includes(key)) delete env[key];
  }
  Object.assign(env, { HOME: base, COPILOT_HOME: path.join(base, 'copilot'),
    COPILOT_PLUGIN_ROOT: plugin, COPILOT_PLUGIN_DATA: path.join(base, 'data'),
    COPILOT_PROJECT_DIR: project, COPILOT_SESSION_ID: sessionId });
  const payload = { eventName: 'sessionStart', source: 'resume', sessionId, cwd: project };
  const run = (extra = {}, extraEnv = {}) => spawnSync('bash', [path.join(plugin, 'hooks/session-start-autopilot-resume.sh')], {
    cwd: project, env: { ...env, ...extraEnv }, input: JSON.stringify({ ...payload, ...extra }), encoding: 'utf8', timeout: 60000,
  });
  const bind = () => {
    const r = spawnSync(process.execPath, [path.join(plugin, 'hooks/lib/copilot-session-control-v1.js')], {
      cwd: project, env, input: JSON.stringify({ ...payload, source: 'new' }), encoding: 'utf8', timeout: 30000,
    });
    assert.equal(r.status, 0, r.stderr);
  };
  return { base, project, sessionId, env, payload, run, bind };
}

test('startup retains the initial Zen contract after 35 seconds of valid sequential hook work', t => {
  const f = fixture(t); let now = 0; const calls = [];
  t.mock.method(Date, 'now', () => now);
  const output = dispatch('sessionStart', f.payload, { root: plugin, env: f.env, spawnSync: (_exe, args, options) => {
    calls.push(path.basename(args[0])); now += 5000;
    assert(options.timeout > 0);
    return { status: 0, stdout: JSON.stringify({ additionalContext: args[0].endsWith('user-prompt-zen-mode.sh') ? 'zen-mode is ACTIVE' : 'startup context' }) };
  } });
  assert.equal(calls.length, 9);
  assert.match(output.additionalContext, /zen-mode is ACTIVE/);
  assert.doesNotMatch(output.additionalContext, /deadline exceeded/);
});

test('a late startup deadline preserves earlier context and reports unfinished hooks', t => {
  const f = fixture(t); let now = 0;
  t.mock.method(Date, 'now', () => now);
  const output = dispatch('sessionStart', f.payload, { root: plugin, env: f.env, spawnSync: (_exe, args) => {
    if (args[0].endsWith('user-prompt-zen-mode.sh')) now = 100000;
    return { status: 0, stdout: JSON.stringify({ additionalContext: 'zen-mode is ACTIVE' }) };
  } });
  assert.match(output.additionalContext, /zen-mode is ACTIVE/);
  assert.match(output.additionalContext, /deadline exceeded.*user-prompt-best-solution-first\.sh/i);
});

test('prompt discovery and sequential hooks fit inside their nested native deadlines', t => {
  const f = fixture(t); let now = 0; const budgets = {};
  t.mock.method(Date, 'now', () => now);
  const output = dispatch('userPromptTransformed', { ...f.payload, prompt: 'Investigate startup delays', transformedPrompt: 'Investigate startup delays' }, {
    root: plugin, env: f.env, spawnSync: (_exe, args, options) => {
      budgets[path.basename(args[0])] = options.timeout;
      now += args[0].endsWith('user-prompt-context-auto-load.sh') ? 25000 : 7000;
      return { status: 0, stdout: '{}' };
    },
  });
  assert.equal(contextLoad.BUDGET_MS, 20000);
  assert(budgets['user-prompt-context-auto-load.sh'] >= contextLoad.BUDGET_MS + 10000);
  assert.equal(Object.keys(budgets).length, 5);
  assert.doesNotMatch(output.modifiedTransformedPrompt || '', /deadline exceeded/);
  const host = JSON.parse(fs.readFileSync(path.join(plugin, 'com.github.copilot/hooks/hooks.json'))).hooks;
  for (const event of ['sessionStart', 'userPromptTransformed']) assert(host[event][0].timeoutSec >= 90);
  assert.equal(host.preToolUse[0].timeoutSec, 60, 'tool policy deadlines are not enlarged');
});

test('empty autopilot inventory avoids repeated Node startup and state-worker work', t => {
  const f = fixture(t); f.bind();
  const stateDir = path.join(f.project, '.zensu/state'); fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'unrelated-workflow.json'), '{}');
  const counter = path.join(f.base, 'node-starts'); const observer = path.join(f.base, 'observer.cjs');
  fs.writeFileSync(observer, `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'start\\n');`);
  const r = f.run({}, { NODE_OPTIONS: `--require ${JSON.stringify(observer)}` });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '');
  const count = fs.readFileSync(counter, 'utf8').trim().split('\n').length;
  assert(count <= 3, `An absent-state resume started ${count} Node processes; expected at most three authenticated preflight reads.`);
  assert.deepEqual(fs.readdirSync(stateDir).filter(name => name.startsWith('autopilot-')), []);
  assert.equal(fs.readFileSync(path.join(stateDir, 'unrelated-workflow.json'), 'utf8'), '{}');
  const bin = path.join(f.base, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\nprintf "UnsupportedHost\\n"\n', { mode: 0o755 });
  fs.writeFileSync(counter, '');
  const unknownHost = f.run({}, { NODE_OPTIONS: `--require ${JSON.stringify(observer)}`, PATH: bin + path.delimiter + f.env.PATH });
  assert.equal(unknownHost.status, 0, unknownHost.stderr);
  assert.equal(unknownHost.stdout, '');
  assert(fs.readFileSync(counter, 'utf8').trim().split('\n').length > 3, 'unrecognized platforms retain the full storage validator');
});

test('resume checks only the authenticated project and never promotes a child', t => {
  const f = fixture(t); f.bind();
  const foreign = path.join(f.base, 'foreign'); fs.mkdirSync(path.join(foreign, '.zensu/state'), { recursive: true });
  fs.writeFileSync(path.join(foreign, '.zensu/state/autopilot-active.json'), 'corrupt');
  assert.equal(f.run({ cwd: foreign }).stdout, '', 'payload cwd cannot select a different project');
  for (const extra of [{ agentId: 'child' }, { agentType: '' }, { isChild: true }, { source: 'fork' }, { eventName: 'preToolUse' }]) {
    const r = f.run(extra); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '');
  }
});

test('existing or unsafe autopilot storage still reaches the corruption guard', t => {
  const f = fixture(t); f.bind();
  const stateDir = path.join(f.project, '.zensu/state'); fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'autopilot-active.json'), 'corrupt');
  const corrupt = f.run(); assert.equal(corrupt.status, 0, corrupt.stderr);
  assert.match(corrupt.stdout, /CORRUPT_ACTIVE_STATE/);
  fs.rmSync(stateDir, { recursive: true });
  const foreign = path.join(f.base, 'unsafe-state'); fs.mkdirSync(foreign); fs.symlinkSync(foreign, stateDir);
  const linked = f.run(); assert.equal(linked.status, 0, linked.stderr);
  assert.match(linked.stdout, /CORRUPT_ACTIVE_STATE/);
  assert.deepEqual(fs.readdirSync(foreign), [], 'unsafe storage must remain untouched');
  fs.unlinkSync(stateDir); fs.mkdirSync(stateDir);
  fs.symlinkSync(path.join(foreign, 'missing-lock'), path.join(stateDir, 'autopilot.lock'));
  const unsafeLease = f.run(); assert.equal(unsafeLease.status, 0, unsafeLease.stderr);
  assert.match(unsafeLease.stdout, /CORRUPT_ACTIVE_STATE/, 'lease artifacts cannot be mistaken for an empty inventory');
});
