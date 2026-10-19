'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEvents, readNativeEvents, analyzeNativeEvents, eventOwner, isUserMessage } = require('../../src/transcript.js');
const event = (id, type, data, extra = {}) => ({ id, type, data, timestamp: '2026-10-18T10:00:00Z', ...extra });
const start = (id, call, args = {}, extra = {}) => event(id, 'tool.execution_start', {
  toolCallId: call, toolName: 'task', arguments: { agent_type: 'zensu:code-reviewer', prompt: 'review', mode: 'sync', ...args },
}, extra);
const done = (id, call, success = true, content = 'PASS', extra = {}) => event(id, 'tool.execution_complete', {
  toolCallId: call, success, result: { content }, ...(success ? {} : { error: { message: 'Denied by host' } }),
}, extra);

test('parser retains native event envelopes and identifies malformed or truncated lines', () => {
  const native = start('a', 'c');
  const parsed = parseEvents(`${JSON.stringify(native)}\n{broken\n42\n`);
  assert.deepEqual(parsed.events, [native]);
  assert.deepEqual(parsed.errors, ['invalid-json:2', 'invalid-event:3']);
  assert.deepEqual(parseEvents(null).events, []);
});

test('native event reader is read-only, refuses links and returns no synthetic conversation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-native-events-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'events.jsonl'), native = start('a', 'one');
  const bytes = Buffer.from(JSON.stringify(native) + '\n');
  fs.writeFileSync(file, bytes);
  assert.deepEqual(readNativeEvents(file), {events: [native], errors: []});
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readdirSync(root), ['events.jsonl']);
  fs.symlinkSync(file, path.join(root, 'link'));
  assert.equal(readNativeEvents(path.join(root, 'link')).events.length, 0);
  assert.equal(readNativeEvents(root).events.length, 0);
  assert.equal(readNativeEvents(path.join(root, 'missing')).events.length, 0);
});

test('parallel identical calls retain actual IDs and original start/completion references', () => {
  const events = [start('a', 'first'), start('b', 'second'), done('c', 'second', false), done('d', 'first')];
  const result = analyzeNativeEvents(events);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.calls.map(call => call.toolCallId), ['first', 'second']);
  assert.equal(result.calls[0].start, events[0]);
  assert.equal(result.calls[0].completion, events[3]);
  assert.equal(result.calls[0].toolName, 'task');
  assert.equal(result.calls[0].arguments.agent_type, 'zensu:code-reviewer');
  assert.deepEqual(result.calls.map(call => call.outcome), ['completed', 'error']);
  assert.equal(result.contextUsage, null);
});

test('unmatched and cross-agent completions cannot invent results', () => {
  const result = analyzeNativeEvents([done('orphan', 'missing'), start('a', 'one', {}, { agentId: 'child' }),
    done('b', 'one'), done('c', 'one', true, 'PASS', { agentId: 'child' })]);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].agentId, 'child');
  assert.equal(result.calls[0].completion.id, 'c');
  assert.ok(result.errors.includes('unmatched-tool-completion:missing'));
  assert.ok(result.errors.includes('unmatched-tool-completion:one'));
});

test('duplicate native IDs, starts, completions and reversed order invalidate the entire correlation', () => {
  for (const events of [
    [start('a', 'one'), start('a', 'one'), done('c', 'one')],
    [start('a', 'one'), start('b', 'one'), done('c', 'one')],
    [start('a', 'one'), done('b', 'one'), done('c', 'one')],
    [done('b', 'one'), start('a', 'one')],
  ]) {
    const result = analyzeNativeEvents(events);
    assert.equal(result.calls.length, 0);
    assert.ok(result.errors.length > 0);
  }
});

test('assistant toolRequests are intent and quoted denials do not become failures', () => {
  const result = analyzeNativeEvents([event('message', 'assistant.message', { content: 'Reviewing.',
    toolRequests: [{ toolCallId: 'one', name: 'task' }, {toolCallId: 'never-executed', name: 'task'}] }),
  start('a', 'one'), done('b', 'one', true, 'Denied by host is an example in the documentation.')]);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].outcome, 'completed');
});

test('native user attribution excludes injected, automatic and child prompts', () => {
  const actual = event('human', 'user.message', {content: 'Implement please.'});
  const synthetic = [
    event('s', 'user.message', {content: 'Injected', source: 'skill-pdf'}),
    event('s2', 'user.message', {content: 'Empty source still explicit', source: ''}),
    event('auto', 'user.message', {content: 'Continue', isAutopilotContinuation: true}),
    event('invalid', 'user.message', {content: 'Continue', isAutopilotContinuation: 'false'}),
    event('child', 'user.message', {content: 'Do child work'}, {agentId: 'child'}),
    event('bad-child', 'user.message', {content: 'Unknown identity'}, {agentId: ''}),
    event('parent', 'user.message', {content: 'Unknown owner', parentAgentTaskId: 'parent'}),
    event('owner', 'user.message', {content: 'Child owner', ownerAgentId: 'child'}),
  ];
  assert.equal(isUserMessage(actual), true);
  for (const row of synthetic) assert.equal(isUserMessage(row), false);
  assert.deepEqual(analyzeNativeEvents([actual, ...synthetic]).userMessages, [actual]);
  assert.equal(eventOwner(synthetic[4]), 'child');
  assert.equal(eventOwner(synthetic[5]), undefined);
});

test('invalid native success state and error-bearing success never become successful evidence', () => {
  const bad = event('b', 'tool.execution_complete', {toolCallId: 'one', success: 'true', result: {content: 'PASS'}});
  const result = analyzeNativeEvents([start('a', 'one'), bad]);
  assert.equal(result.calls.length, 0);
  assert.ok(result.errors.includes('invalid-tool-completion:one'));
  bad.data.success = true; bad.data.error = {message: 'Failure'};
  assert.equal(analyzeNativeEvents([start('a', 'one'), bad]).calls[0].outcome, 'error');
});

test('native task completion distinguishes synchronous review from background dispatch', () => {
  for (const mode of ['sync', 'background', undefined]) {
    const result = analyzeNativeEvents([start('a', 'one', {mode}), done('b', 'one')]);
    assert.equal(result.calls[0].outcome, mode === 'sync' ? 'completed' : 'dispatched');
  }
  assert.equal(analyzeNativeEvents([start('a', 'one')]).calls[0].outcome, 'pending');
});

test('native shell completion requires structured exit evidence, not output claiming a pass', () => {
  const bash = event('a', 'tool.execution_start', {toolCallId: 'shell', toolName: 'bash', arguments: {command: 'npm test'}});
  for (const [exitCode, outcome] of [[0, 'completed'], [1, 'error'], [undefined, 'unknown']]) {
    const completion = done('b', 'shell', true, 'pass\n<shellId: 0 completed with exit code 0>');
    if (exitCode !== undefined) completion.data.shellExecution = {exitCode};
    const call = analyzeNativeEvents([bash, completion]).calls[0];
    assert.equal(call.outcome, outcome);
    assert.equal(call.exitCode, exitCode);
  }
});
