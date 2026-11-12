'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const plugin = path.resolve(__dirname, '../../src/plugin');
const lib = path.join(plugin, 'hooks/lib');
const nativeGate = path.join(plugin, 'hooks/pre-edit-tdd-reminder.sh');
const shellGate = path.join(lib, 'zensu-tdd-edit-gate.sh');
const helperPath = path.join(lib, 'tdd-edit-gate-v1.js');
const helper = require(helperPath);
const core = require(path.join(lib, 'session-control-core-v1.js'));
const nativeHost = process.platform === 'darwin' || process.platform === 'linux';

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE_|ZENSU_|COPILOT_)/.test(key) || ['PLUGIN_ROOT', 'PLUGIN_DATA', 'NODE_OPTIONS', 'CDPATH'].includes(key)) delete env[key];
  }
  return env;
}

function fixture(t, mode, root = plugin) {
  const rootLib = path.join(root, 'hooks/lib');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-tdd-edit-gate-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', project]).status, 0);
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  const sessionId = crypto.randomUUID();
  const env = {
    ...cleanEnvironment(), HOME: base, COPILOT_HOME: path.join(base, 'copilot'), COPILOT_PLUGIN_ROOT: root,
    PLUGIN_ROOT: root, COPILOT_PLUGIN_DATA: data, COPILOT_PROJECT_DIR: project, COPILOT_SESSION_ID: sessionId,
    ZENSU_BOUND_SESSION_ID: sessionId, ZENSU_RUNTIME_HOST: 'copilot',
  };
  const started = spawnSync(process.execPath, [path.join(rootLib, 'copilot-session-control-v1.js')], {
    cwd: project, env, input: JSON.stringify({ eventName: 'sessionStart', sessionId, cwd: project, source: 'new' }),
    encoding: 'utf8', timeout: 120000,
  });
  assert.equal(started.status, 0, started.stderr);
  const log = (...args) => {
    const result = spawnSync('bash', [path.join(rootLib, 'zensu-log.sh'), ...args], { cwd: project, env, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  };
  if (mode === 'vanilla') log('--tdd-begin');
  if (mode === 'strict') log('--tdd-begin', '--tdd-mode', 'strict');
  const stateFile = path.join(project, '.zensu/state', `tdd-phase-${core.sessionKey(sessionId)}.json`);
  const edit = (filePath, extra = {}) => ({
    eventName: 'preToolUse', sessionId, cwd: project, toolName: 'edit',
    toolArgs: filePath === undefined ? { old_str: 'old', new_str: 'new' } : { path: filePath, old_str: 'old', new_str: 'new' },
    ...extra,
  });
  const run = (script, payload, options = {}) => spawnSync('bash', [script], {
    cwd: options.cwd || project, env: { ...env, ...(options.env || {}) },
    input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', timeout: 120000,
  });
  return { base, project, data, sessionId, env, log, stateFile, edit, run };
}

function parity(f, payload, options) {
  const shell = f.run(shellGate, payload, options);
  const native = f.run(nativeGate, payload, options);
  const label = typeof payload === 'string' ? payload : JSON.stringify(payload);
  assert.equal(native.status, shell.status, `${label}: ${native.stderr} | ${shell.stderr}`);
  assert.equal(native.stdout, shell.stdout, label);
  return native;
}

function decision(result) {
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

function expectDeny(f, payload, pattern, options) {
  const result = parity(f, payload, options);
  assert.equal(result.status, 0);
  assert.equal(decision(result).permissionDecision, 'deny', JSON.stringify(payload));
  assert.match(decision(result).permissionDecisionReason, pattern);
}

function expectAllow(f, payload, options) {
  const result = parity(f, payload, options);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '', JSON.stringify(payload));
}

test('strict mode decides like the shell reference for every path class and spelling', t => {
  const f = fixture(t, 'strict');
  const source = path.join(f.project, 'src/a.js');
  fs.writeFileSync(source, 'old\n');
  expectDeny(f, f.edit(source), /Current phase: UNINITIALIZED, step: \(none\)\./);
  expectDeny(f, f.edit(source, { toolName: 'create' }), /^TDD-Phase-Gate: create on /);
  expectDeny(f, f.edit(source, { toolName: 'edit\n' }), /^TDD-Phase-Gate: edit on /);
  expectAllow(f, f.edit(source, { toolName: 'view' }));
  expectDeny(f, f.edit('src/a.js'), /edit on src\/a\.js blocked/);
  expectDeny(f, f.edit(undefined), /edit on \(unknown\) blocked/);
  expectDeny(f, f.edit(path.join(f.project, '.zensu/state/x.json')), /direct edits to the session-state files/);
  expectDeny(f, f.edit('.zensu/state/x.json'), /direct edits to the session-state files/);
  expectDeny(f, f.edit(path.join(f.project, '.ZENSU/STATE/X.json')), /direct edits to the session-state files/);
  expectAllow(f, f.edit(path.join(f.project, '.zensu/plans/p.md')));
  expectAllow(f, f.edit('nested/.zensu'));
  expectDeny(f, f.edit(path.join(f.project, 'src/a\nb.js')), /session-state file is invalid or unreadable/);
  for (const spelling of ['C:/work/a.js', '\\\\server\\share\\a.js', 'é:/work/a.js', 'src/a.js\n', 'src/a\u0000b.js',
    'src/\ud800.js', '../outside/a.js']) {
    expectDeny(f, f.edit(spelling), /^TDD-Phase-Gate: edit on /);
  }
});

test('strict FSM phases and test-path rules decide like the shell reference', t => {
  const f = fixture(t, 'strict');
  const source = path.join(f.project, 'src/a.js');
  const write = (name, content) => {
    const file = path.join(f.project, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  write('src/a.js', 'old\n');
  const detect = write('src/detect.js', "describe('a', () => {});\n");
  const testFile = write('tests/a.test.js', 'old\n');
  const late = write('src/late.js', `${'\n'.repeat(20)}describe('a');\n`);
  const doubleBom = write('src/bom2.js', "\ufeff\ufeffdescribe('a');\n");
  const candidates = [testFile, 'tests/a.test.js', 'src/X_TEST.py', detect, late, '-dash.test.js', doubleBom];
  fs.writeFileSync(path.join(f.project, 'src/latin1.js'), Buffer.concat([Buffer.from([0xe4, 0x0a]), Buffer.from("describe('a');\n")]));
  candidates.push(path.join(f.project, 'src/latin1.js'));
  const hardSource = write('src/hard-source.js', "describe('a');\n");
  fs.linkSync(hardSource, path.join(f.project, 'src/hard.js'));
  candidates.push(path.join(f.project, 'src/hard.js'));
  fs.symlinkSync(detect, path.join(f.project, 'src/link.test.js'));
  candidates.push(path.join(f.project, 'src/link.test.js'));

  f.log('--phase', 'RED_WRITE', '--step', 's1');
  expectAllow(f, f.edit(source));
  f.log('--phase', 'RED_RUN', '--step', 's1');
  expectDeny(f, f.edit(source), /Current phase: RED_RUN, step: s1\./);
  f.log('--phase', 'RED_FAIL', '--step', 's1', '--reason', 'expected failure');
  expectDeny(f, f.edit(source), /Current phase: RED_FAIL, step: s1\./);
  const redFail = candidates.map(candidate => decision(parity(f, f.edit(candidate))).permissionDecision === 'deny');
  assert.deepEqual(redFail.slice(0, 4), [false, false, false, false]);
  assert.equal(redFail[candidates.indexOf(late)], true);
  assert.equal(redFail[candidates.indexOf(doubleBom)], true);
  assert.equal(redFail[candidates.indexOf(path.join(f.project, 'src/hard.js'))], true);
  assert.equal(redFail[candidates.indexOf(path.join(f.project, 'src/link.test.js'))], true);
  f.log('--phase', 'IMPL', '--step', 's1');
  expectAllow(f, f.edit(source));
  f.log('--phase', 'GREEN_RUN', '--step', 's1');
  expectDeny(f, f.edit(source), /Current phase: GREEN_RUN, step: s1\./);
  f.log('--phase', 'GREEN_PASS', '--step', 's1');
  expectAllow(f, f.edit(testFile));
  expectDeny(f, f.edit(source), /Current phase: GREEN_PASS, step: s1\./);
  f.log('--phase', 'REFACTOR', '--step', 's1');
  expectAllow(f, f.edit(source));
  f.log('--phase', 'RED_WRITE', '--step', 's2');
  f.log('--phase', 'RED_RUN', '--step', 's2');
  f.log('--phase', 'IMPL', '--step', 's2');
  expectDeny(f, f.edit(source), /Current phase: IMPL, step: s2\./);

  const shellLog = path.join(f.base, 'shell-hook.log');
  const nativeLog = path.join(f.base, 'native-hook.log');
  const shell = f.run(shellGate, f.edit('src/a.js'), { env: { ZENSU_HOOK_LOG: shellLog } });
  const native = f.run(nativeGate, f.edit('src/a.js'), { env: { ZENSU_HOOK_LOG: nativeLog } });
  assert.equal(native.stdout, shell.stdout);
  assert.equal(fs.readFileSync(nativeLog, 'utf8'), fs.readFileSync(shellLog, 'utf8'));
  assert.match(fs.readFileSync(nativeLog, 'utf8'), /permissionDecision=deny\n$/);

  f.log('--phase', 'RED_FAIL', '--step', '-n', '--reason', 'expected failure');
  f.log('--phase', 'IMPL', '--step', '-n');
  expectDeny(f, f.edit(source), /Current phase: IMPL, step: \(none\)\./);
});

test('vanilla, unarmed and missing or damaged session state decide like the shell reference', t => {
  const vanilla = fixture(t, 'vanilla');
  expectAllow(vanilla, vanilla.edit(path.join(vanilla.project, 'src/a.js')));
  expectDeny(vanilla, vanilla.edit(path.join(vanilla.project, '.zensu/state/x.json')), /direct edits to the session-state files/);
  expectDeny(vanilla, vanilla.edit('src/a\rb.js'), /session-state file is invalid or unreadable/);
  expectAllow(vanilla, vanilla.edit('é:/work/a.js'));

  const unarmed = fixture(t, null);
  const payload = unarmed.edit(path.join(unarmed.project, 'src/a.js'));
  expectAllow(unarmed, payload);
  expectAllow(unarmed, unarmed.edit(path.join(unarmed.project, '.zensu/state/x.json')));
  const original = fs.readFileSync(unarmed.stateFile);
  fs.writeFileSync(unarmed.stateFile, '{');
  expectDeny(unarmed, payload, /session-state file is invalid or unreadable \(.*tdd-phase-scv1_[0-9a-f]{64}\.json\)/);
  fs.rmSync(unarmed.stateFile);
  expectDeny(unarmed, payload, /session-state file is invalid or unreadable/);
  const copy = path.join(unarmed.base, 'state-copy.json');
  fs.writeFileSync(copy, original);
  fs.symlinkSync(copy, unarmed.stateFile);
  expectDeny(unarmed, payload, /session-state file is invalid or unreadable/);
});

test('principal, payload and bind failures decide like the shell reference', t => {
  const f = fixture(t, 'strict');
  const source = path.join(f.project, 'src/a.js');
  expectAllow(f, f.edit(source, { agentId: 'child', agentType: 'zensu:review-aspect', isChild: true }));
  expectAllow(f, f.edit(source, { agentName: 'unknown' }));
  expectAllow(f, f.edit(source, { eventName: 'postToolUse' }));
  expectAllow(f, 'not json');
  expectAllow(f, '');
  expectAllow(f, '[]');
  expectDeny(f, f.edit(source, { sessionId: crypto.randomUUID() }), /^Blocked: /);
  expectDeny(f, f.edit(source, { sessionId: `scv1_${'a'.repeat(64)}` }), /^Blocked: /);
  expectDeny(f, f.edit(source), /^Blocked: /, { env: { COPILOT_PLUGIN_DATA: '' } });
  expectDeny(f, f.edit(source), /^Blocked: /, { env: { COPILOT_PLUGIN_DATA: path.join(f.base, 'missing') } });
  expectDeny(f, f.edit(source), /^Blocked: /, { env: { MSYS2_ENV_CONV_EXCL: 'A=\nB=' } });
  const oversized = JSON.stringify(f.edit(source, { padding: 'x'.repeat(1024 * 1024) }));
  expectDeny(f, oversized, /^Blocked: /);
  const mismatch = f.run(nativeGate, f.edit(source), { env: { COPILOT_PLUGIN_ROOT: f.base } });
  assert.equal(mismatch.status, 2);
  assert.match(mismatch.stderr, /does not match the executing plugin/);
  const tools = path.join(f.base, 'tools-without-node');
  fs.mkdirSync(tools);
  for (const tool of ['bash', 'cat', 'dirname', 'basename', 'uname', 'tr', 'head', 'sed', 'grep', 'stat']) {
    const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) fs.symlinkSync(found, path.join(tools, tool));
  }
  const withoutNode = parity(f, f.edit(source), { env: { PATH: tools } });
  assert.equal(withoutNode.status, 0);
  assert.equal(withoutNode.stdout, '');
});

function nodeStarts(f) {
  const file = path.join(f.base, 'node-starts');
  const counter = path.join(f.base, 'count-node.cjs');
  fs.writeFileSync(counter, `require('node:fs').appendFileSync(${JSON.stringify(file)}, String(process.argv[1]) + '\\n');\n`);
  return {
    env: { NODE_OPTIONS: `--require ${JSON.stringify(counter)}` },
    read: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []),
  };
}

test('the ZENSU_TDD_GATE escape stays free and records the same bypass ledger entry', t => {
  const shellFixture = fixture(t, 'strict');
  const nativeFixture = fixture(t, 'strict');
  const platformFixture = fixture(t, 'strict');
  const counted = nodeStarts(nativeFixture);
  const off = { env: { ZENSU_TDD_GATE: 'off' } };
  const shell = shellFixture.run(shellGate, shellFixture.edit(path.join(shellFixture.project, 'src/a.js')), off);
  const native = nativeFixture.run(nativeGate, nativeFixture.edit(path.join(nativeFixture.project, 'src/a.js')),
    { env: { ZENSU_TDD_GATE: 'off', ...counted.env } });
  const platform = platformFixture.run(nativeGate, platformFixture.edit(path.join(platformFixture.project, 'src/a.js')),
    { env: { ZENSU_TDD_GATE: 'off', OSTYPE: 'freebsd14.0' } });
  for (const result of [shell, native, platform]) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
  const ledger = f => JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).bypasses;
  assert.deepEqual(ledger(nativeFixture), ['ZENSU_TDD_GATE']);
  assert.deepEqual(ledger(nativeFixture), ledger(shellFixture));
  assert.deepEqual(ledger(platformFixture), ledger(shellFixture));
  assert.ok(counted.read().length > 0);
  assert.equal(counted.read().includes(helperPath), false);
});

test('platforms other than macOS and Linux run the shell implementation through the hook', t => {
  const f = fixture(t, 'strict');
  const counted = nodeStarts(f);
  const source = path.join(f.project, 'src/a.js');
  fs.writeFileSync(source, 'old\n');
  const platform = { env: { OSTYPE: 'freebsd14.0', ...counted.env } };
  expectDeny(f, f.edit(source), /Current phase: UNINITIALIZED, step: \(none\)\./, platform);
  expectDeny(f, f.edit(path.join(f.project, '.zensu/state/x.json')), /direct edits to the session-state files/, platform);
  f.log('--phase', 'RED_WRITE', '--step', 's1');
  expectAllow(f, f.edit(source), platform);
  assert.ok(counted.read().length > 0);
  assert.equal(counted.read().includes(helperPath), false);
  const routed = f.run(nativeGate, f.edit(source), { env: { OSTYPE: 'msys', ...counted.env } });
  assert.equal(routed.error, undefined);
  assert.equal(typeof routed.status, 'number');
  assert.equal(counted.read().includes(helperPath), false);
});

test('a hook locale other than C, POSIX or UTF-8 leaves test-path decisions to the shell reference', t => {
  const installed = (spawnSync('locale', ['-a'], { encoding: 'utf8' }).stdout || '').split('\n');
  const locale = ['zh_CN.GBK', 'zh_TW.Big5', 'ko_KR.eucKR', 'ja_JP.SJIS'].find(name => installed.includes(name));
  if (!locale) {
    t.skip('no non-UTF-8 multibyte locale is installed');
    return;
  }
  const f = fixture(t, 'strict');
  const write = (name, content) => {
    const file = path.join(f.project, name);
    fs.writeFileSync(file, content);
    return file;
  };
  const detect = write('src/detect.js', "describe('a', () => {});\n");
  const named = write('src/\u4e2d_test.py', 'old\n');
  f.log('--phase', 'RED_FAIL', '--step', 's1', '--reason', 'expected failure');
  const options = { env: { LC_ALL: locale } };
  for (const candidate of [detect, named, 'src/\u4e2d_test.py', path.join(f.project, 'src/a.js')]) parity(f, f.edit(candidate), options);
});

function pathWithout(base, omitted) {
  const dir = path.join(base, `path-without-${omitted}`);
  fs.mkdirSync(dir);
  const entries = [...(process.env.PATH || '').split(':'), path.dirname(process.execPath)];
  for (const entry of entries) {
    let names = [];
    try {
      names = fs.readdirSync(entry || '.');
    } catch {
      continue;
    }
    for (const name of names) {
      const target = path.join(dir, name);
      if (name === omitted || fs.lstatSync(target, { throwIfNoEntry: false })) continue;
      fs.symlinkSync(path.join(path.resolve(entry || '.'), name), target);
    }
  }
  return dir;
}

test('a missing zensu-host-path.sh or shell tool leaves the decision to the shell reference', t => {
  const copy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-tdd-plugin-')));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(plugin, copy, { recursive: true });
  fs.rmSync(path.join(copy, 'hooks/lib/zensu-host-path.sh'));
  const partial = fixture(t, null, copy);
  const payload = partial.edit(path.join(partial.project, 'src/a.js'));
  const shell = partial.run(path.join(copy, 'hooks/lib/zensu-tdd-edit-gate.sh'), payload);
  const native = partial.run(path.join(copy, 'hooks/pre-edit-tdd-reminder.sh'), payload);
  assert.equal(native.status, shell.status, `${native.stderr} | ${shell.stderr}`);
  assert.equal(native.stdout, shell.stdout);
  assert.equal(decision(native).permissionDecision, 'deny');

  const f = fixture(t, 'strict');
  const source = path.join(f.project, 'src/a.js');
  fs.writeFileSync(source, 'old\n');
  const withoutUname = parity(f, f.edit(source), { env: { PATH: pathWithout(f.base, 'uname') } });
  assert.equal(decision(withoutUname).permissionDecision, 'deny');
  f.log('--phase', 'RED_FAIL', '--step', 's1', '--reason', 'expected failure');
  parity(f, f.edit('src/X_TEST.py'), { env: { PATH: pathWithout(f.base, 'tr') } });
});

test('one gate invocation starts exactly one node process on macOS and Linux', { skip: !nativeHost }, t => {
  const strict = fixture(t, 'strict');
  const counterFile = path.join(strict.base, 'node-starts');
  const counter = path.join(strict.base, 'count-node.cjs');
  fs.writeFileSync(counter, `require('node:fs').appendFileSync(${JSON.stringify(counterFile)}, String(process.argv[1]) + '\\n');\n`);
  const starts = (f, payload) => {
    fs.rmSync(counterFile, { force: true });
    const result = f.run(nativeGate, payload, { env: { NODE_OPTIONS: `--require ${JSON.stringify(counter)}` } });
    assert.equal(result.status, 0, result.stderr);
    return { result, starts: fs.readFileSync(counterFile, 'utf8').split('\n').filter(Boolean) };
  };
  const cases = [
    [fixture(t, null), 'src/a.js', ''],
    [fixture(t, 'vanilla'), 'src/a.js', ''],
    [strict, 'src/a.js', 'TDD-Phase-Gate: edit on'],
    [strict, '.zensu/state/x.json', 'direct edits to the session-state files'],
  ];
  for (const [f, file, expected] of cases) {
    const observed = starts(f, f.edit(file));
    assert.deepEqual(observed.starts, [helperPath]);
    if (expected) assert.match(observed.result.stdout, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    else assert.equal(observed.result.stdout, '');
  }
  strict.log('--phase', 'RED_WRITE', '--step', 's1');
  const allowed = starts(strict, strict.edit('src/a.js'));
  assert.deepEqual(allowed.starts, [helperPath]);
  assert.equal(allowed.result.stdout, '');
});

test('test-path rules match tdd_is_test_path over names, case, headers and links', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-tdd-test-path-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
    return name;
  };
  const files = [
    write('detect.js', "describe('a', () => {});\n"), write('itcall.js', "it('a');\n"), write('testcall.js', "test('a');\n"),
    write('go.go', 'func TestA(t *testing.T) {}\n'), write('java.java', '@Test\nvoid a() {}\n'),
    write('py.py', 'def test_a():\n    pass\n'), write('rust.rs', '  #[test]\nfn a() {}\n'),
    write('cfg.rs', '\t#[cfg(test)]\nmod t {}\n'), write('bom.js', "\ufeffdescribe('a');\n"),
    write('crlf.js', "describe('a');\r\n"), write('late.js', `${'\n'.repeat(20)}describe('a');\n`),
    write('line20.js', `${'\n'.repeat(19)}describe('a');\n`), write('plain.js', 'const a = 1;\n'),
    write('indented.js', "  describe('a');\n"), write('umlaut.js', "// Grüße\ndescribe('a');\n"),
    write('nul.js', "\u0000describe('a');\n"), write('nbsp.rs', '\u00a0#[test]\n'),
    write('bom2.js', "\ufeff\ufeffdescribe('a');\n"), write('bom2.rs', '\ufeff\ufeff#[test]\n'),
    write('hard-source.js', "describe('a');\n"), write('sub/dir.test.d/keep', ''),
  ];
  fs.writeFileSync(path.join(dir, 'latin1.js'), Buffer.concat([Buffer.from([0xe4, 0x0a]), Buffer.from("describe('a');\n")]));
  fs.linkSync(path.join(dir, 'hard-source.js'), path.join(dir, 'hard.js'));
  fs.symlinkSync(path.join(dir, 'detect.js'), path.join(dir, 'link.test.js'));
  const names = [
    'a.js', 'a.test.js', 'a.TEST.js', 'a_test.go', 'a_TEST.go', 'test_a.py', 'TEST_a.py', 'a.spec.ts', 'a.specs.ts',
    'a_spec.rb', 'a_specs.rb', 'a.tests.js', 'a_tests.js', 'atest.js', 'test.js', 'tests.js', 'spec.js', 'test/a.js',
    'Test/a.js', 'x/tests/a.js', 'x/TESTS/a.js', 'x/__tests__/a.js', 'x/spec/a.js', 'x/specs/a.js', 'x/testing/a.js',
    'x/contest/a.js', 'x/test', 'x/test/', 'tests/', 'a.test.js/', '/abs/tests/a.js', './tests/a.js', 'é/tests/a.js',
    'ÄTESTS/a.js', 'sub/dir.test.d', 'latin1.js', 'hard.js', 'link.test.js', 'missing.js', '-n', '-x.test.js',
    'back\\slash.test.js', ...files,
  ];
  const shell = spawnSync('bash', ['-c', 'set -u; source "$1" >/dev/null 2>&1 || exit 3; shift; for p in "$@"; do printf "%s\\n" "$(tdd_is_test_path "$p")"; done', '_', path.join(lib, 'zensu-tdd-phase.sh'), ...names], {
    cwd: dir, env: { ...cleanEnvironment(), COPILOT_PLUGIN_ROOT: plugin, LC_ALL: 'C' }, encoding: 'utf8', timeout: 120000,
  });
  assert.equal(shell.status, 0, shell.stderr);
  const expected = shell.stdout.split('\n').slice(0, names.length);
  const native = spawnSync(process.execPath, ['-e', `
    const gate = require(${JSON.stringify(helperPath)});
    const names = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify(names.map(name => {
      const verdict = gate.isTestPath(name);
      return verdict === gate.SHELL_UNSURE ? 'shell' : String(verdict);
    })));
  `, JSON.stringify(names)], { cwd: dir, env: { ...cleanEnvironment(), LC_ALL: 'C' }, encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  const actual = JSON.parse(native.stdout);
  const delegated = names.filter((_, index) => actual[index] === 'shell');
  assert.deepEqual(delegated.sort(), ['-n', '-x.test.js', 'back\\slash.test.js', 'bom2.rs', 'latin1.js', 'nbsp.rs', 'nul.js'].sort());
  names.forEach((name, index) => {
    if (actual[index] !== 'shell') assert.equal(actual[index], expected[index], name);
  });
  assert.equal(actual[names.indexOf('detect.js')], 'true');
  assert.equal(actual[names.indexOf('bom2.js')], 'false');
  assert.equal(actual[names.indexOf('late.js')], 'false');
  assert.equal(actual[names.indexOf('hard.js')], 'false');
  assert.equal(actual[names.indexOf('link.test.js')], 'false');
});

test('captured values follow bash command-substitution semantics', () => {
  const values = ['edit\n\n', 'a\u0000b', 'a\nb\n', '\r\n', 'x\ud800y', 'plain'];
  for (const value of values) {
    const shell = spawnSync('bash', ['-c', 'v="$(node -e "process.stdout.write(JSON.parse(process.argv[1]))" "$1")"; printf %s "$v"', '_', JSON.stringify(value)], {
      encoding: 'buffer', env: cleanEnvironment(),
    });
    assert.equal(shell.status, 0);
    assert.deepEqual(Buffer.from(helper.captured(value), 'utf8'), shell.stdout, JSON.stringify(value));
  }
  assert.equal(helper.captured('edit\n'), 'edit');
  assert.equal(helper.captured('x\ud800'), 'x\ufffd');
});
