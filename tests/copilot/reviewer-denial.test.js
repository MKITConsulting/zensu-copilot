'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
// Exercise the package's real relative module layout without rebuilding shared
// dist while parallel implementation is still in progress.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-native-denial-'));
fs.mkdirSync(path.join(root, 'hooks/lib'), {recursive: true});
fs.mkdirSync(path.join(root, 'hooks/native'));
const scannerFile = path.join(root, 'hooks/lib/reviewer-spawn-denial-v1.js');
fs.copyFileSync(path.join(__dirname, '../../src/plugin/hooks/lib/reviewer-spawn-denial-v1.js'), scannerFile);
fs.copyFileSync(path.join(__dirname, '../../src/transcript.js'), path.join(root, 'hooks/native/transcript.js'));
const {scanEvents, scanTranscript, DENIAL_KINDS} = require(scannerFile);
test.after(() => fs.rmSync(root, {recursive: true, force: true}));
const event = (id, type, data, extra = {}) => ({id, type, data, timestamp: '2026-10-18T10:00:00Z', ...extra});
const args = (mode = 'sync') => ({agent_type: 'zensu:code-reviewer', name: 'review', description: 'Review', prompt: 'packet', mode});
const start = (id, call, mode) => event(id, 'tool.execution_start', {toolCallId: call, toolName: 'task', arguments: args(mode)});
const done = (id, call, success = true, text = 'PASS') => event(id, 'tool.execution_complete', {
  toolCallId: call, success, ...(success ? {result: {content: text}} : {error: {message: text}}),
});
const request = (id, call, kind = 'hook', mode) => event(id, 'permission.requested', {
  requestId: `request-${id}`, permissionRequest: {kind, toolName: 'task', toolCallId: call,
    [kind === 'hook' ? 'toolArgs' : 'args']: args(mode)},
});
const denied = (id, req, kind = 'denied-by-rules') => event(id, 'permission.completed', {
  requestId: req.data.requestId, toolCallId: req.data.permissionRequest.toolCallId,
  decisionSource: 'host_policy', result: {kind},
});
const refusal = (call, prefix = call) => {
  const req = request(`${prefix}-request`, call);
  return [start(`${prefix}-start`, call), req, denied(`${prefix}-deny`, req), done(`${prefix}-end`, call, false, 'Permission refused')];
};

test('structured native permission denials correlate by request and tool IDs, not result prose', () => {
  for (const kind of DENIAL_KINDS) {
    const rows = refusal('one'); rows[2].data.result.kind = kind;
    const result = scanEvents(rows);
    assert.equal(result.status, 'blocked');
    assert.equal(result.nativeKind, kind);
    assert.equal(result.kind, 'permission-denied');
    assert.equal(result.toolName, 'task');
    assert.equal(result.toolCallId, 'one');
    assert.equal(result.denials, 1);
  }
});

test('native denied admission is visible when no tool execution began', () => {
  for (const kind of ['hook', 'custom-tool']) {
    const req = request('request', 'not-started', kind);
    assert.equal(scanEvents([req, denied('denied', req)]).status, 'blocked');
  }
});

test('permission admission can precede execution_start without losing exact refusal correlation', () => {
  const rows = refusal('one'); [rows[0], rows[1]] = [rows[1], rows[0]];
  assert.equal(scanEvents(rows).status, 'blocked');
});

test('successful reviewer quoting a permission denial and model-request intent stay clean', () => {
  const intent = event('m', 'assistant.message', {content: 'Permission refused', toolRequests: [
    {toolCallId: 'one', name: 'task', arguments: args()}, {toolCallId: 'never-executed', name: 'task', arguments: args()},
  ]});
  const result = scanEvents([intent, start('s', 'one'), done('d', 'one', true, 'denied-by-rules is an example')]);
  assert.equal(result.status, 'clear');
  assert.equal(result.spawns, 1);
  assert.equal(result.denials, 0);
  assert.equal(scanEvents([intent]).status, 'none');
});

test('unknown errors cannot be classified as permission refusals or successful reviews', () => {
  const result = scanEvents([start('s', 'one'), done('d', 'one', false, 'denied-by-rules')]);
  assert.equal(result.status, 'errored');
  assert.equal(result.denials, 0);
});

test('latest unresolved refusal is not cleared by older parallel completion or background dispatch', () => {
  const rows = [start('old-start', 'old'), ...refusal('new'), done('old-end', 'old'),
    start('bg-start', 'bg', 'background'), done('bg-end', 'bg')];
  assert.equal(scanEvents(rows).status, 'blocked');
  assert.equal(scanEvents(rows).toolCallId, 'new');
  rows.push(start('retry-start', 'retry'), done('retry-end', 'retry'));
  assert.equal(scanEvents(rows).status, 'clear');
});

test('a later synchronous refusal supersedes an earlier completed review and counts real attempts', () => {
  const result = scanEvents([start('s', 'old'), done('d', 'old'), ...refusal('first'), ...refusal('second')]);
  assert.equal(result.status, 'blocked');
  assert.equal(result.toolCallId, 'second');
  assert.equal(result.denials, 2);
});

test('child and unrelated permission events cannot impersonate the main reviewer', () => {
  for (const mutation of [
    rows => rows.forEach(row => { row.agentId = 'child'; }),
    rows => { rows[2].agentId = 'child'; },
    rows => { rows[1].data.permissionRequest.toolName = 'bash'; },
    rows => { rows[1].data.permissionRequest.toolArgs.agent_type = 'zensu:review-aspect'; },
    rows => { rows[2].data.toolCallId = 'other'; },
    rows => { rows[2].data.requestId = 'other'; },
    rows => { rows[1].data.permissionRequest.toolArgs.prompt = 'different invocation'; },
  ]) {
    const rows = refusal('one'); mutation(rows);
    assert.notEqual(scanEvents(rows).status, 'blocked');
  }
});

test('duplicate event, request and completion identities never establish denial or clear a refusal', () => {
  for (const duplicateIndex of [0, 1, 2, 3]) {
    const rows = refusal('one'); rows.splice(duplicateIndex, 0, rows[duplicateIndex]);
    assert.notEqual(scanEvents(rows).status, 'blocked');
  }
  const rows = [...refusal('denied'), start('retry-start', 'retry'), done('retry-end', 'retry')];
  rows.push(done('other-end', 'retry'));
  assert.equal(scanEvents(rows).status, 'blocked');
  const requestDuplicate = refusal('one');
  requestDuplicate.splice(2, 0, {...requestDuplicate[1], id: 'other-request-event'});
  assert.notEqual(scanEvents(requestDuplicate).status, 'blocked');
});

test('permission success, cancellation and out-of-order denial do not prove a refusal', () => {
  for (const kind of ['approved', 'cancelled', 'new-unknown-kind']) {
    const rows = refusal('one'); rows[2].data.result.kind = kind;
    assert.equal(scanEvents(rows).status, 'errored');
  }
  const rows = refusal('one'); [rows[1], rows[2]] = [rows[2], rows[1]];
  assert.notEqual(scanEvents(rows).status, 'blocked');
});

test('contradictory successful tool completion cannot validate a denial receipt', () => {
  const rows = refusal('one'); rows[3] = done('end', 'one', true);
  assert.notEqual(scanEvents(rows).status, 'blocked');
});

test('scanner reads original events.jsonl without modification and refuses malformed or linked files', () => {
  const file = path.join(root, 'events.jsonl');
  const bytes = Buffer.from(refusal('native').map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(file, bytes);
  assert.equal(scanTranscript(file).status, 'blocked');
  assert.deepEqual(fs.readFileSync(file), bytes);
  const result = spawnSync(process.execPath, [scannerFile, '--transcript', file], {encoding: 'utf8'});
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^status=blocked kind=permission-denied tool=task spawns=1 denials=1\n$/);
  fs.writeFileSync(file, bytes.toString() + '{truncated');
  assert.equal(scanTranscript(file).status, 'unreadable');
  fs.symlinkSync(file, path.join(root, 'linked'));
  assert.equal(scanTranscript(path.join(root, 'linked')).status, 'unreadable');
  assert.equal(scanTranscript(root).status, 'unreadable');
});
