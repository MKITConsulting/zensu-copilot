'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const packet = require('../../src/plugin/hooks/lib/review-packet-v1.js');
const { sessionKey } = require('../../src/plugin/hooks/lib/session-control-core-v1.js');
const roots = [];
test.after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }).trim();
}
function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-packet-')));
  roots.push(root); git(root, 'init', '-q');
  fs.writeFileSync(path.join(root, 'a.js'), 'old\n');
  git(root, 'add', 'a.js'); git(root, 'commit', '-qm', 'baseline');
  return { root, baseline: git(root, 'rev-parse', 'HEAD') };
}
const receipt = { schema: 'edit-landing-v2', session: 'test-session', log: '.zensu/logs/test.log',
  claims: 1, landed: 1, notLanded: 0, unverified: 0, pending: 0, exemptIgnored: 0, exemptVerified: 0, clean: true };
const input = Object.fromEntries(['implementation_summary', 'requirements_baseline', 'diff_summary',
  'test_evidence', 'build_evidence', 'coverage_evidence'].map(field => [field, field + ' evidence']));

test('canonical change set includes untracked, staged, mid-run committed and nested-root changes', () => {
  const { root, baseline } = repo();
  fs.writeFileSync(path.join(root, 'a.js'), 'committed\n'); git(root, 'commit', '-qam', 'mid-run');
  fs.writeFileSync(path.join(root, 'new [x].js'), 'new\n');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub/staged.js'), 'staged\n'); git(root, 'add', 'sub');
  fs.mkdirSync(path.join(root, '.zensu')); fs.writeFileSync(path.join(root, '.zensu/state.json'), '{}');
  assert.deepEqual(packet.collectChanges({ root: path.join(root, 'sub'), baseline }).changed_files,
    ['a.js', 'new [x].js', 'sub/staged.js']);
});

test('unborn change set includes index and untracked files; invalid baseline fails loudly', () => {
  const { root } = repo();
  git(root, 'checkout', '--orphan', 'unborn');
  fs.writeFileSync(path.join(root, 'new.js'), 'new\n');
  assert.deepEqual(packet.collectChanges({ root }).changed_files, ['a.js', 'new.js']);
  assert.throws(() => packet.collectChanges({ root, baseline: '0'.repeat(40) }), /unborn/);
  const born = repo();
  assert.throws(() => packet.collectChanges({ root: born.root, baseline: '0'.repeat(40) }), /Git command failed/);
});

test('packet writes once, preserves receipt summary and detects tampering before dispatch', () => {
  const { root, baseline } = repo(); fs.writeFileSync(path.join(root, 'a.js'), 'new\n');
  const created = packet.createPacket({ root, baseline, input, editLandingReceipt: receipt });
  assert.equal(created.payload.edit_landing_evidence,
    'EDIT LANDING AUDIT — claims=1 landed=1 not_landed=0 unverified=0 pending=0 exempt_ignored=0 exempt_verified=0');
  const file = path.join(root, 'packet.json');
  assert.match(packet.writePacket(file, created), /^REVIEW-PACKET: .+ sha256:[a-f0-9]{64}$/);
  assert.deepEqual(packet.loadPacket(file, created.sha256), created);
  assert.throws(() => packet.writePacket(file, created), /EEXIST/);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, JSON.stringify({ ...created, payload: { ...created.payload, test_evidence: 'invented' } }));
  assert.throws(() => packet.loadPacket(file, created.sha256), /hash/);
});

test('clean receipts with invalid counts, omitted evidence or unresolved edits fail before dispatch', () => {
  const { root } = repo();
  for (const edit of [{ clean: false }, { notLanded: 1 }, { unverified: 1 }, { pending: 1 }, { landed: -1 }, { session: '' }]) {
    assert.throws(() => packet.createPacket({ root, input, editLandingReceipt: { ...receipt, ...edit } }));
  }
  assert.throws(() => packet.createPacket({ root, input: { ...input, test_evidence: '' }, editLandingReceipt: receipt }), /test_evidence/);
});

test('primary result requires substantive primary completion, not second-judge or invalid output', () => {
  assert.equal(packet.validatePrimaryResult('## Aspect: judge\n- (no findings)'), true);
  assert.equal(packet.validatePrimaryResult('## Aspect: judge\n- [IMPORTANT] JUDGE-1 a.js:1 — issue. Evidence: guard missing. Fix: add guard.'), true);
  for (const text of ['## Aspect: judge', 'REVIEW PACKET INVALID: close marker', '## Aspect: judge (second run)\n- (no findings)', '## Aspect: judge\n- (no findings)\nREVIEW PACKET INVALID']) {
    assert.equal(packet.validatePrimaryResult(text), false);
  }
});

test('CLI derives the canonical receipt key from the session ID and refuses a foreign session', () => {
  const { root, baseline } = repo();
  const stateDir = path.join(root, '.zensu', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const receiptFile = path.join(stateDir, 'edit-landing-' + sessionKey(receipt.session) + '.json');
  const inputFile = path.join(root, '.zensu', 'input.json');
  const out = path.join(root, '.zensu', 'packet.json');
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const args = ['create', '--root', root, '--baseline', baseline, '--input', inputFile,
    '--session', receipt.session, '--out', out];
  assert.match(packet.cli(args), /^REVIEW-PACKET: .+ sha256:[a-f0-9]{64}$/);
  assert.deepEqual(packet.loadPacket(out).payload.changed_files, []);
  fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, session: 'foreign' }));
  assert.throws(() => packet.cli(args), /session mismatch/);
});

test('packet reader refuses symlinks and hash changes even when the replacement is valid JSON', () => {
  const { root } = repo();
  const created = packet.createPacket({ root, input, editLandingReceipt: receipt });
  const file = path.join(root, 'packet.json');
  packet.writePacket(file, created);
  const link = path.join(root, 'linked.json');
  fs.symlinkSync(file, link);
  assert.throws(() => packet.loadPacket(link), /regular/);
  assert.throws(() => packet.loadPacket(file, '0'.repeat(64)), /hash/);
});

test('near-limit canonical packet round-trips at the exact on-disk byte cap', () => {
  const { root } = repo();
  const initial = packet.createPacket({ root, input, editLandingReceipt: receipt });
  const size = Buffer.byteLength(JSON.stringify(initial) + '\n');
  const boundedInput = { ...input, implementation_summary: 'x'.repeat(packet.MAX_BYTES - size + input.implementation_summary.length) };
  const created = packet.createPacket({ root, input: boundedInput, editLandingReceipt: receipt });
  const file = path.join(root, 'bounded.json');
  packet.writePacket(file, created);
  assert.equal(fs.statSync(file).size, packet.MAX_BYTES);
  assert.equal(packet.loadPacket(file, created.sha256).sha256, created.sha256);
  assert.throws(() => packet.createPacket({ root, input: { ...boundedInput, implementation_summary: boundedInput.implementation_summary + 'x' }, editLandingReceipt: receipt }), /size limit/);
});

test('non-Git packets bind explicit file snapshots and disclose that the change inventory is limited', () => {
  const { root } = repo(); fs.rmSync(path.join(root, '.git'), { recursive: true });
  assert.deepEqual(packet.collectChanges({ root }), { root, kind: 'explicit-no-git', baseline: null, head: null, changed_files: null });
  assert.throws(() => packet.createPacket({ root, input, editLandingReceipt: receipt }), /explicit changed_files/);
  const created = packet.createPacket({ root, input: { ...input, changed_files: ['deleted.js', 'a.js'] }, editLandingReceipt: receipt });
  assert.equal(created.payload.tree, null);
  assert.match(created.payload.scope_limitations, /no repository-wide diff/);
  assert.deepEqual(created.payload.changed_files, ['a.js', 'deleted.js']);
  assert.deepEqual(created.payload.non_git_snapshot[1], { path: 'deleted.js', exists: false });
  const file = path.join(root, 'packet.json'); packet.writePacket(file, created);
  assert.equal(packet.loadPacket(file).sha256, created.sha256);
  fs.writeFileSync(path.join(root, 'a.js'), 'different\n');
  assert.notEqual(packet.hash(packet.explicitSnapshot(root, created.payload.changed_files)), created.payload.content_snapshot);
  assert.throws(() => packet.explicitSnapshot(root, ['../outside']), /in-root/);
  fs.symlinkSync(root, path.join(root, 'link'));
  assert.throws(() => packet.explicitSnapshot(root, ['link/a.js']), /symlink/);
});
