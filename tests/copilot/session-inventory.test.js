'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-native-inventory-module-'));
fs.mkdirSync(path.join(root, 'hooks/lib'), {recursive: true});
fs.mkdirSync(path.join(root, 'hooks/native'));
fs.copyFileSync(path.join(__dirname, '../../src/plugin/hooks/lib/copilot-session-inventory-v1.js'), path.join(root, 'hooks/lib/copilot-session-inventory-v1.js'));
fs.copyFileSync(path.join(__dirname, '../../src/transcript.js'), path.join(root, 'hooks/native/transcript.js'));
const {inventoryClaims, EVENT_HEAD_BYTES, EVENT_TAIL_BYTES} = require(path.join(root, 'hooks/lib/copilot-session-inventory-v1.js'));
test.after(() => fs.rmSync(root, {recursive: true, force: true}));
const event = (id, type, data, extra = {}) => ({id, type, data, timestamp: '2026-10-18T10:00:00Z', ...extra});
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-native-inventory-'));
  fs.mkdirSync(path.join(home, 'session-state'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const session = (id, cwd = '/work/target', events = [], metadata = true) => {
    const dir = path.join(home, 'session-state', id); fs.mkdirSync(dir);
    if (metadata) fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${cwd}\n`);
    const rows = [event(`start-${id}`, 'session.start', {sessionId: id, context: {cwd}}), ...events];
    fs.writeFileSync(path.join(dir, 'events.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
    return dir;
  };
  return {home, session, scan: () => inventoryClaims({environment: {COPILOT_HOME: home}, sessionId: 'current'})};
}

test('native sessions without a plugin registry still claim their observed worktrees', t => {
  const f = fixture(t); f.session('foreign');
  assert.deepEqual(f.scan(), {claims: [{session: 'foreign', source: 'unclosed native Copilot session', path: '/work/target'}], unverifiable: []});
});

test('only a root native shutdown releases ownership; idle, age and child shutdown do not', t => {
  const f = fixture(t);
  f.session('closed', '/work/closed', [event('end', 'session.shutdown', {})]);
  f.session('idle', '/work/idle', [event('idle', 'session.idle', {})]);
  f.session('child', '/work/child', [event('end-child', 'session.shutdown', {}, {agentId: 'child'})]);
  const result = f.scan();
  assert.deepEqual(result.unverifiable, []);
  assert.deepEqual(result.claims.map(row => row.session).sort(), ['child', 'idle']);
});

test('resume and later activity invalidate an older shutdown and preserve all observed paths', t => {
  const f = fixture(t);
  f.session('resumed', '/work/start', [event('end', 'session.shutdown', {}),
    event('resume', 'session.resume', {context: {cwd: '/work/resumed'}}),
    event('change', 'session.context_changed', {cwd: '/work/current'})]);
  f.session('unknown-new-event', '/work/unknown', [event('end2', 'session.shutdown', {}), event('future', 'session.future_activity', {})]);
  const result = f.scan();
  assert.deepEqual(result.unverifiable, []);
  assert.deepEqual(result.claims.filter(row => row.session === 'resumed').map(row => row.path), ['/work/start', '/work/resumed', '/work/current']);
  assert.ok(result.claims.some(row => row.session === 'unknown-new-event'));
});

test('own session is excluded and a native workspace-only foreign session stays conservatively owned', t => {
  const f = fixture(t); f.session('current');
  const dir = f.session('metadata-only'); fs.unlinkSync(path.join(dir, 'events.jsonl'));
  const result = f.scan();
  assert.deepEqual(result.unverifiable, []);
  assert.deepEqual(result.claims.map(row => row.session), ['metadata-only']);
});

test('identity mismatch, unknown paths and malformed events make ownership unverifiable', t => {
  const f = fixture(t);
  const mismatch = f.session('wrong-id');
  fs.writeFileSync(path.join(mismatch, 'workspace.yaml'), 'id: someone-else\ncwd: /work/target\n');
  const malformed = f.session('malformed'); fs.appendFileSync(path.join(malformed, 'events.jsonl'), '{broken');
  const missing = path.join(f.home, 'session-state', 'missing'); fs.mkdirSync(missing);
  const result = f.scan();
  assert.equal(result.claims.length, 0);
  assert.equal(result.unverifiable.length, 3);
});

test('a changed native identity and duplicate event IDs cannot manufacture a closed session', t => {
  const f = fixture(t);
  f.session('changed', '/work/target', [event('wrong', 'session.start', {sessionId: 'other'}), event('end', 'session.shutdown', {})]);
  f.session('duplicate', '/work/target', [event('end2', 'session.shutdown', {}), event('end2', 'session.shutdown', {})]);
  assert.equal(f.scan().unverifiable.length, 2);
});

test('native inventory refuses symlinked stores, sessions and files without reading their targets', t => {
  const f = fixture(t), real = f.session('real');
  fs.symlinkSync(real, path.join(f.home, 'session-state', 'linked-session'));
  fs.unlinkSync(path.join(real, 'workspace.yaml'));
  fs.symlinkSync(path.join(real, 'events.jsonl'), path.join(real, 'workspace.yaml'));
  assert.equal(f.scan().unverifiable.length, 2);
  const aliasHome = path.join(f.home, 'alias-home'); fs.mkdirSync(aliasHome);
  fs.symlinkSync(path.join(f.home, 'session-state'), path.join(aliasHome, 'session-state'));
  const result = inventoryClaims({environment: {COPILOT_HOME: aliasHome}, sessionId: 'current'});
  assert.equal(result.claims.length, 0);
  assert.equal(result.unverifiable.length, 1);
});

test('large native logs retain head identity and latest lifecycle without reading unbounded bytes', t => {
  const f = fixture(t), dir = f.session('large');
  const file = path.join(dir, 'events.jsonl');
  const body = 'x'.repeat(4096);
  let padding = '';
  for (let index = 0; padding.length < EVENT_HEAD_BYTES + EVENT_TAIL_BYTES + 200000; index += 1) {
    padding += JSON.stringify(event(`info-${index}`, 'session.info', {message: body})) + '\n';
  }
  fs.appendFileSync(file, padding + JSON.stringify(event('end', 'session.shutdown', {})) + '\n');
  assert.deepEqual(f.scan(), {claims: [], unverifiable: []});
  fs.appendFileSync(file, JSON.stringify(event('resume', 'session.resume', {context: {cwd: '/work/resumed'}})) + '\n');
  assert.deepEqual(f.scan().claims.map(row => row.path), ['/work/target', '/work/resumed']);
});

test('inspection is read-only and missing native inventory is uncertainty, never proof of no owners', t => {
  const f = fixture(t), dir = f.session('foreign');
  const before = fs.readdirSync(dir).map(name => [name, fs.readFileSync(path.join(dir, name))]);
  f.scan();
  for (const [name, data] of before) assert.deepEqual(fs.readFileSync(path.join(dir, name)), data);
  assert.deepEqual(fs.readdirSync(dir), before.map(row => row[0]));
  const result = inventoryClaims({environment: {COPILOT_HOME: path.join(f.home, 'missing')}, sessionId: 'current'});
  assert.equal(result.claims.length, 0);
  assert.equal(result.unverifiable.length, 1);
});
