'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const helper = require('../../src/plugin/hooks/lib/edit-landing-receipt-v1.js');
const { sessionKey } = require('../../src/plugin/hooks/lib/session-control-core-v1.js');
const auditScript = path.resolve(__dirname, '../../src/plugin/hooks/lib/zensu-edit-landing.sh');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('standalone audit announces no workflow receipt and inventory ignores ambient native selectors', t => {
  const f = fixture(t);
  const args = [auditScript, '--log', f.log, '--project', f.root];
  const env = { ...process.env, COPILOT_SESSION_ID: '' };
  const standalone = spawnSync('bash', args, { env, encoding: 'utf8' });
  assert.equal(standalone.status, 0, standalone.stderr);
  assert.match(standalone.stderr, /STANDALONE AUDIT.*no workflow receipt/);
  assert.equal(fs.existsSync(f.receipt), false);
  const inventory = spawnSync('bash', [...args, '--inventory'], { encoding: 'utf8',
    env: { ...env, COPILOT_SESSION_ID: 'unregistered', COPILOT_PLUGIN_ROOT: '/not-a-plugin' } });
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.match(inventory.stdout, /claimed-files=1/);
  assert.doesNotMatch(inventory.stderr, /STANDALONE|SESSION REQUIRED/);
  assert.equal(fs.existsSync(f.receipt), false);
});

test('an unverified native identity cannot silently become a clean standalone audit', t => {
  const f = fixture(t);
  const result = spawnSync('bash', [auditScript, '--log', f.log, '--project', f.root], {
    env: { ...process.env, COPILOT_SESSION_ID: 'unregistered', COPILOT_PLUGIN_ROOT: f.root }, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not match the executing plugin/);
  assert.doesNotMatch(result.stdout, /EDIT LANDED|EDIT LANDING AUDIT/);
  assert.equal(fs.existsSync(f.receipt), false);
});

test('audit recovery command selects the bound log and quotes every shell operand', () => {
  const root = "/tmp/audit's project $(printf unsafe)";
  const command = helper.auditRecoveryCommand({ projectRoot: root, sessionId: "session'$(printf unsafe)",
    state: { workflowArtifacts: { log: '.zensu/logs/bound.log' } }, log: '.zensu/logs/ignored.log' });
  const parsed = spawnSync('bash', ['-c', `set -- ${command}; printf '%s\\0' "$@"`], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.deepEqual(parsed.stdout.split('\0').slice(0, -1), ['bash', auditScript, '--log',
    root + '/.zensu/logs/bound.log', '--project', root, '--session', "session'$(printf unsafe)"]);
});

function fixture(t, git = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'landing-scope-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = crypto.randomUUID(), reviewGeneration = crypto.randomUUID();
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Audit Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Audit Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (/^GIT_/.test(key) && !/^GIT_(AUTHOR|COMMITTER)_/.test(key)) delete env[key];
  const runGit = args => {
    const result = spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  fs.mkdirSync(path.join(root, '.zensu/logs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.zensu/state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.zensu/\n');
  fs.writeFileSync(path.join(root, 'a.js'), 'before\n');
  if (git) { runGit(['init', '-q']); runGit(['add', '.']); runGit(['commit', '-qm', 'baseline']); }
  const baseline = git ? runGit(['rev-parse', 'HEAD']) : '';
  const state = path.join(root, '.zensu/state/tdd-phase-' + sessionKey(session) + '.json');
  fs.writeFileSync(state, JSON.stringify({ reviewGeneration }));
  const log = path.join(root, '.zensu/logs/run.log');
  fs.writeFileSync(log, 'T01 IMPL completed — files: a.js\n');
  const receipt = path.join(root, '.zensu/state/edit-landing-' + sessionKey(session) + '.json');
  const dirty = path.join(root, '.zensu/dirty.txt'); fs.writeFileSync(dirty, 'a.js\n');
  const proof = path.join(root, '.zensu/proof.json');
  const putProof = (steps = ['T01'], overrides = {}) => {
    const content = fs.readFileSync(path.join(root, 'a.js'));
    fs.writeFileSync(proof, JSON.stringify({ schema: 'edit-landing-predicates-v1', claims: steps.map(step =>
      ({ step, path: 'a.js', sha256: hash(content), present: ['after'], absent: ['before'], ...overrides })) }));
    return proof;
  };
  const audit = (args = [], status = 0, extraEnv = {}) => {
    const result = spawnSync('bash', [auditScript, '--log', log, '--project', root, '--session', session, ...args],
      { env: { ...env, ...extraEnv }, cwd: root, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, status, result.stdout + result.stderr);
    return result;
  };
  const load = () => JSON.parse(fs.readFileSync(receipt, 'utf8'));
  const fresh = () => helper.receiptFresh({ receiptPath: receipt, projectRoot: root, session });
  fs.writeFileSync(path.join(root, 'a.js'), 'after\n');
  return { root, log, session, state, reviewGeneration, receipt, dirty, proof, baseline, runGit, audit, load, fresh, putProof };
}

test('omitting dirty-before cannot launder a pending receipt; literal/hash proof clears it', t => {
  const f = fixture(t);
  f.audit(['--dirty-before', f.dirty], 1);
  assert.equal(f.load().pending, 1);
  f.audit([], 1);
  assert.equal(f.load().pending, 1);
  assert.throws(f.fresh, /not clean/);
  f.audit(['--predicates', f.putProof()]);
  assert.equal(f.fresh().clean, true);
  f.audit();
  assert.equal(f.load().pending, 0, 'certified unchanged claims stay certified on retries');
});

test('new round preserves historical unchanged claims but requires proof for its new claim', t => {
  const f = fixture(t); f.audit();
  fs.appendFileSync(f.log, 'SR1 IMPL completed — files: a.js\n');
  f.audit(['--dirty-before', f.dirty], 1);
  assert.equal(f.load().landed, 1);
  assert.equal(f.load().pending, 1);
  f.audit(['--predicates', f.putProof(['SR1'])]);
  assert.equal(f.fresh().claims, 2);
});

test('changed certified content requires current proof even when dirty-before is omitted', t => {
  const f = fixture(t); f.audit();
  fs.writeFileSync(path.join(f.root, 'a.js'), 'after second\n');
  assert.throws(f.fresh, /changed after/);
  f.audit([], 1);
  assert.equal(f.load().pending, 1);
  f.audit(['--predicates', f.putProof()]);
  assert.equal(f.fresh().clean, true);
});

test('audit keeps the original baseline across mid-run commit and refuses a weakened baseline', t => {
  const f = fixture(t); f.audit(['--baseline', f.baseline]);
  f.runGit(['add', 'a.js']); f.runGit(['commit', '-qm', 'implementation']);
  f.audit();
  assert.equal(f.load().auditScope.baseline, f.baseline);
  assert.match(f.audit(['--baseline', ''], 2).stderr, /cannot be weakened/);
});

test('append-only log and claim identities cannot be rewritten to drop pending work', t => {
  const f = fixture(t); f.audit(['--dirty-before', f.dirty], 1);
  fs.writeFileSync(f.log, 'T02 IMPL completed — files: a.js\n');
  assert.match(f.audit([], 2).stderr, /rewritten/);
  assert.throws(f.fresh, /not clean/);
});

test('terminal accepts ordinary log appends, rejects new claims, new tree edits and generation changes', t => {
  const f = fixture(t); f.audit();
  fs.appendFileSync(f.log, 'ACCEPTANCE — 1/1 passed\nEDIT LANDING AUDIT — claims=1\n');
  assert.equal(f.fresh().clean, true);
  fs.writeFileSync(path.join(f.root, 'new.js'), 'unclaimed\n');
  assert.throws(f.fresh, /tree differs/);
  fs.unlinkSync(path.join(f.root, 'new.js'));
  fs.appendFileSync(f.log, 'SR1 WIRED — files: a.js\n');
  assert.throws(f.fresh, /new edit claims/);
  f.audit(['--predicates', f.putProof(['SR1'])]);
  fs.writeFileSync(f.state, JSON.stringify({ reviewGeneration: crypto.randomUUID() }));
  assert.throws(f.fresh, /generation/);
});

test('alternate receipt output inherits the canonical pending scope and cannot clear it', t => {
  const f = fixture(t); f.audit(['--dirty-before', f.dirty], 1);
  const alternate = path.join(f.root, '.zensu/alternative.json');
  f.audit(['--receipt', alternate], 1);
  assert.equal(JSON.parse(fs.readFileSync(alternate)).pending, 1);
  assert.equal(f.load().clean, false);
  assert.deepEqual(f.load().auditScope.dirty, ['a.js']);
  f.audit([], 1);
  assert.equal(f.load().pending, 1);
});

test('predicate proofs fail closed for wrong hash, empty predicates, false literals and unknown executable fields', t => {
  const f = fixture(t); f.audit(['--dirty-before', f.dirty], 1);
  for (const overrides of [{ sha256: '0'.repeat(64) }, { present: [], absent: [] },
    { present: ['not in this file'] }, { command: 'touch forbidden' }, { present: [''] }]) {
    f.audit(['--predicates', f.putProof(['T01'], overrides)], 2);
    assert.equal(f.load().clean, false);
  }
  assert.equal(fs.existsSync(path.join(f.root, 'forbidden')), false);
});

test('missing dirty input, symlinked source and predicate path traversal cannot yield a clean receipt', t => {
  const f = fixture(t);
  f.audit(['--dirty-before', path.join(f.root, 'missing')], 2);
  f.putProof(['T01'], { path: '../a.js' });
  f.audit(['--predicates', f.proof], 2);
  fs.renameSync(path.join(f.root, 'a.js'), path.join(f.root, 'target.js'));
  fs.symlinkSync('target.js', path.join(f.root, 'a.js'));
  f.audit([], 2);
  assert.equal(f.load().clean, false, 'post-binding errors retain a nonclean checkpoint');
});

test('non-Git claims can be verified by explicit predicates and remain scoped to their files', t => {
  const f = fixture(t, false);
  f.audit([], 1);
  f.audit(['--predicates', f.putProof()]);
  assert.equal(f.fresh().auditScope.tree.kind, 'explicit-no-git');
  fs.writeFileSync(path.join(f.root, 'a.js'), 'later\n');
  assert.throws(f.fresh, /changed after/);
});

test('a legacy pending receipt cannot be laundered on its first scoped audit', t => {
  const f = fixture(t);
  fs.writeFileSync(f.receipt, JSON.stringify({ schema: 'edit-landing-v2', session: f.session,
    log: '.zensu/logs/run.log', claims: 1, landed: 0, notLanded: 0, unverified: 0, pending: 1, clean: false }));
  f.audit([], 1);
  assert.equal(f.load().pending, 1);
  f.audit(['--predicates', f.putProof()]);
  assert.equal(f.fresh().clean, true);
});

test('an unresolved bare claim can acquire its real path after landing, with explicit proof', t => {
  const f = fixture(t);
  fs.writeFileSync(f.log, 'T01 IMPL completed — files: README.md\n');
  f.audit([], 1);
  assert.equal(f.load().auditScope.claims[0].path, null);
  fs.writeFileSync(path.join(f.root, 'README.md'), 'actual new content\n');
  fs.writeFileSync(f.proof, JSON.stringify({ schema: 'edit-landing-predicates-v1', claims: [{ step: 'T01',
    path: 'README.md', sha256: hash('actual new content\n'), present: ['actual new content'] }] }));
  f.audit(['--predicates', f.proof]);
  assert.equal(f.fresh().clean, true);
});

test('legitimate .zensu configuration claims retain snapshot and predicate support', t => {
  const f = fixture(t);
  fs.writeFileSync(f.log, 'T01 IMPL completed — files: .zensu/config.json\n');
  fs.writeFileSync(path.join(f.root, '.zensu/config.json'), '{"enabled":true}\n');
  f.audit();
  assert.equal(f.fresh().auditScope.snapshots['.zensu/config.json'].exists, true);
});

test('first-attempt invalid predicate input persists dirty scope before validation fails', t => {
  const f = fixture(t);
  f.audit(['--dirty-before', f.dirty, '--predicates', f.putProof(['T01'], { sha256: '0'.repeat(64) })], 2);
  assert.equal(f.load().clean, false);
  f.audit([], 1);
  assert.equal(f.load().pending, 1);
  f.audit(['--predicates', f.putProof()]);
  assert.equal(f.fresh().clean, true);
});

test('Git faults retain dirty scope and invalidate prior clean receipts until a real retry', t => {
  const f = fixture(t);
  const bin = path.join(f.root, '.zensu/failing-bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho "fatal: synthetic Git failure" >&2\nexit 128\n', { mode: 0o700 });
  const failing = { PATH: bin + path.delimiter + process.env.PATH };
  f.audit(['--dirty-before', f.dirty], 2, failing);
  assert.equal(f.load().clean, false);
  f.audit([], 1);
  assert.equal(f.load().pending, 1);
  f.audit(['--predicates', f.putProof()]);
  f.audit([], 2, failing);
  assert.throws(f.fresh, /not clean/);
  f.audit();
  assert.equal(f.fresh().clean, true);
});

test('active workflow rejects no-receipt audits while read-only inventory remains supported', t => {
  const f = fixture(t);
  assert.match(f.audit(['--receipt', '-', '--dirty-before', f.dirty], 2).stderr, /receipt-producing audit/);
  assert.equal(fs.existsSync(f.receipt), false);
  const inventory = spawnSync('bash', [auditScript, '--inventory', '--log', f.log, '--project', f.root], { encoding: 'utf8' });
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.match(inventory.stdout, /claimed-files=1/);
});

test('a nested project anchor binds its own session state while auditing repository-relative claims', t => {
  const f = fixture(t);
  const projectRoot = path.join(f.root, 'nested');
  fs.mkdirSync(path.join(projectRoot, '.zensu/logs'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.zensu/state'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.zensu/state', path.basename(f.state)), JSON.stringify({ reviewGeneration: f.reviewGeneration }));
  const log = path.join(projectRoot, '.zensu/logs/nested.log');
  fs.writeFileSync(log, 'T01 IMPL completed — files: nested/new.js\n');
  fs.writeFileSync(path.join(projectRoot, 'new.js'), 'new content\n');
  const result = spawnSync('bash', [auditScript, '--log', log, '--project', projectRoot, '--session', f.session], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const receiptPath = path.join(projectRoot, '.zensu/state', path.basename(f.receipt));
  const receipt = helper.receiptFresh({ receiptPath, projectRoot, session: f.session });
  assert.equal(receipt.auditScope.root, projectRoot);
  assert.equal(receipt.auditScope.claimRoot, f.root);
  assert.equal(receipt.auditScope.generation, f.reviewGeneration);
});

test('deletion proofs require a real prior file, and survive a pending audit before clearance', t => {
  const f = fixture(t, false);
  fs.mkdirSync(path.join(f.root, 'src'));
  fs.writeFileSync(f.log, 'T01 IMPL completed — files: src/missing.js\n');
  f.audit([], 1);
  fs.writeFileSync(f.proof, JSON.stringify({ schema: 'edit-landing-predicates-v1', claims: [
    { step: 'T01', path: 'src/missing.js', missing: true },
  ] }));
  assert.match(f.audit(['--predicates', f.proof], 2).stderr, /previously observed file or a Git deletion/);
  fs.writeFileSync(path.join(f.root, 'src/missing.js'), 'exists now\n');
  f.audit([], 1);
  fs.unlinkSync(path.join(f.root, 'src/missing.js'));
  f.audit([], 1);
  f.audit(['--predicates', f.proof]);
  assert.equal(f.fresh().clean, true);
});

test('a later ignore rule cannot clear a persisted pending dirty claim', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'src'));
  fs.writeFileSync(path.join(f.root, 'src/new.js'), 'after\n');
  fs.writeFileSync(f.log, 'T01 IMPL completed — files: src/new.js\n');
  fs.writeFileSync(f.dirty, 'src/new.js\n');
  f.audit(['--dirty-before', f.dirty], 1);
  fs.appendFileSync(path.join(f.root, '.gitignore'), 'src/new.js\n');
  f.audit([], 1);
  assert.equal(f.load().pending, 1);
});
