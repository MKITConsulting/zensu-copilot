'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let normalizeEvents, run;
test.before(async () => {
  ({normalizeEvents} = await import('../../src/session-trail/provider.mjs'));
  ({run} = await import('../../src/session-trail/trail.mjs'));
});
const sessionId = '11111111-1111-4111-8111-111111111111';
const event = (id, type, data, owner) => ({id, type, data, timestamp: '2026-10-18T10:00:00Z', ...(owner ? {agentId: owner} : {})});
const start = (id, call, toolName, args, owner) => event(id, 'tool.execution_start', {toolCallId: call, toolName, arguments: args}, owner);
const done = (id, call, success = true, owner) => event(id, 'tool.execution_complete', {toolCallId: call, success, result: {content: 'Completed'}}, owner);
const answer = (id, call, overrides = {}, owner) => event(id, 'human_response.recorded', {toolCallId: call,
  requestId: `request-${id}`, actor: 'human_response', response: {responseKind: 'exit_plan_mode',
    approved: true, selectedAction: 'interactive', planContent: '# Actual plan\n- AC-001: preserve state', ...overrides}}, owner);
const normalize = events => normalizeEvents(events.map(JSON.stringify).join('\n'), sessionId);

test('successful update_todo reconstructs the native Markdown checklist with source IDs', () => {
  const todos = '- [x] RED test failed for the right reason\n- [ ] Implement behavior (in progress)\n- [ ] [verify] BLOCKED: missing fixture';
  const result = normalize([start('s', 'todo', 'update_todo', {todos}), done('d', 'todo')]);
  assert.equal(result.tasks.todos, todos);
  assert.deepEqual(result.tasks.items.map(item => item.checked), [true, false, false]);
  assert.match(result.tasks.items[2].text, /BLOCKED/);
  assert.equal(result.tasks.toolCallId, 'todo');
  assert.equal(result.tasks.callEventId, 's');
  assert.equal(result.tasks.completionEventId, 'd');
  assert.match(result.tasks.meaning, /not test or implementation evidence/);
});

test('pending, failed, malformed and cross-agent checklist calls cannot replace completed progress', () => {
  const rows = [start('s1', 'okay', 'update_todo', {todos: '- [ ] genuine'}), done('d1', 'okay'),
    start('s2', 'pending', 'update_todo', {todos: '- [x] pending'}),
    start('s3', 'failed', 'update_todo', {todos: '- [x] failed'}), done('d3', 'failed', false),
    start('s4', 'child', 'update_todo', {todos: '- [x] child'}, 'agent-child'), done('d4', 'child', true, 'agent-child'),
    start('s5', 'cross', 'update_todo', {todos: '- [x] mismatch'}, 'agent-child'), done('d5', 'cross'),
    start('s6', 'invalid', 'update_todo', {todos: ['invalid shape']}), done('d6', 'invalid'),
    done('orphan', 'no-start')];
  assert.equal(normalize(rows).tasks.todos, '- [ ] genuine');
  assert.equal(normalize([rows[2], rows[4], rows.at(-1)]).tasks, null);
});

test('parallel progress updates follow successful completion order and require actual call IDs', () => {
  const result = normalize([start('s1', 'first', 'update_todo', {todos: '- [ ] first'}),
    start('s2', 'second', 'update_todo', {todos: '- [x] second'}), done('d2', 'second'), done('d1', 'first')]);
  assert.equal(result.tasks.todos, '- [ ] first');
  const missing = normalize([start('s', undefined, 'update_todo', {todos: '- [x] invented'}), done('d', undefined)]);
  assert.equal(missing.tasks, null);
  assert.ok(missing.progressDiagnostics.some(value => value.startsWith('missing-progress-call-identity:')));
});

test('duplicate or reversed event/call correlations are disclosed and never establish progress', () => {
  const first = start('s', 'ambiguous', 'update_todo', {todos: '- [ ] original'});
  const variants = [
    [first, first, done('d', 'ambiguous')],
    [first, start('s2', 'ambiguous', 'update_todo', {todos: '- [x] conflicting'}), done('d', 'ambiguous')],
    [first, done('d1', 'ambiguous'), done('d2', 'ambiguous')],
    [done('d', 'ambiguous'), first],
  ];
  for (const events of variants) {
    const result = normalize(events);
    assert.equal(result.tasks, null);
    assert.ok(result.progressDiagnostics.length > 0);
  }
});

test('plan content comes from an actual correlated human record with source and content hash', () => {
  const result = normalize([start('s', 'plan', 'exit_plan_mode', {summary: 'Presented summary'}),
    answer('human', 'plan', {planFilePath: '/workspace/plan.md'}), done('d', 'plan')]);
  assert.equal(result.plan.summary, 'Presented summary');
  assert.equal(result.plan.content, '# Actual plan\n- AC-001: preserve state');
  assert.equal(result.plan.approval, 'recorded-human-approval');
  assert.equal(result.plan.responseEventId, 'human');
  assert.match(result.plan.contentSha256, /^[a-f0-9]{64}$/);
  assert.match(result.plan.reference.verification, /current file not inspected/);
  assert.match(result.plan.meaning, /never authorization for this continuation/);
  assert.equal(result.unknownEventTypes.includes('human_response.recorded'), false);
});

test('uncorrelated, automated, duplicate and child plan responses cannot impersonate the main plan', () => {
  const begin = start('s', 'plan', 'exit_plan_mode', {summary: 'summary'});
  const automated = answer('auto', 'plan'); automated.data.actor = 'host_automation';
  const variants = [
    [answer('orphan', 'plan')], [begin, automated],
    [begin, answer('a', 'plan'), answer('b', 'plan')],
    [start('s', 'plan', 'exit_plan_mode', {summary: 'child'}, 'child'), answer('a', 'plan', {}, 'child')],
    [begin, done('d', 'plan'), answer('late', 'plan')],
    [answer('early', 'plan'), begin],
    [start('s', 'plan', 'bash', {command: 'echo fake'}), answer('a', 'plan')],
  ];
  for (const events of variants) assert.equal(normalize(events).plan, null);
});

test('rejections and exit-only responses remain historical unapproved plans', () => {
  for (const response of [{approved: false}, {selectedAction: 'exit_only'}]) {
    const result = normalize([start('s', 'p', 'exit_plan_mode', {summary: 'spec'}), answer('a', 'p', response)]);
    assert.equal(result.plan.approval, 'not-approved');
  }
  const result = normalize([start('s', 'p', 'exit_plan_mode', {summary: 'spec'}), answer('a', 'p', {planContent: ''})]);
  assert.equal(result.plan.approval, 'unknown');
});

test('task metadata separates pending, failed, synchronous results and background dispatch', () => {
  const args = mode => ({name: `review-${mode}`, description: 'Review fixture', agent_type: 'zensu:review-aspect', prompt: 'packet', mode});
  const result = normalize([start('s1', 'sync', 'task', args('sync')), done('d1', 'sync'),
    start('s2', 'bg', 'task', args('background')), done('d2', 'bg'),
    start('s3', 'pending', 'task', args('sync')),
    start('s4', 'failed', 'task', args('sync')), done('d4', 'failed', false)]);
  assert.deepEqual(result.taskRuns.map(row => row.state), ['completed', 'dispatched', 'pending', 'failed']);
  assert.equal(result.taskRuns[0].agentType, 'zensu:review-aspect');
  assert.equal(result.taskRuns[0].ownerAgentId, null);
  assert.equal(Object.hasOwn(result.taskRuns[0], 'prompt'), false);
});

test('large checklist/plan displays are explicitly truncated while preserving full plan hash', () => {
  const content = 'x'.repeat(65000);
  const result = normalize([start('s1', 'todo', 'update_todo', {todos: content}), done('d1', 'todo'),
    start('s2', 'plan', 'exit_plan_mode', {summary: 'summary'}), answer('a', 'plan', {planContent: content})]);
  assert.equal(result.tasks.truncated, true);
  assert.equal(result.tasks.todos.length, 64000);
  assert.equal(result.plan.truncated, true);
  assert.equal(result.plan.content.length, 64000);
  assert.equal(result.plan.contentSha256, require('node:crypto').createHash('sha256').update(content).digest('hex'));
});

test('show/handoff expose observed progress but list omits deep plan and task content', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-copilot-progress-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const home = path.join(root, 'copilot'), cwd = path.join(root, 'project');
  const dir = path.join(home, 'session-state', sessionId);
  fs.mkdirSync(dir, {recursive: true}); fs.mkdirSync(cwd);
  const records = [event('init', 'session.start', {sessionId, context: {cwd}}),
    start('s1', 'todo', 'update_todo', {todos: '- [ ] Continue exact work'}), done('d1', 'todo'),
    start('s2', 'plan', 'exit_plan_mode', {summary: 'Summary from the call'}), answer('a', 'plan'),
    start('s3', 'worker', 'task', {name: 'review', description: 'Inspect', agent_type: 'zensu:review-aspect', mode: 'background', prompt: 'secret worker prompt'}), done('d3', 'worker')];
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, records.map(JSON.stringify).join('\n'));
  const before = fs.readFileSync(file);
  const options = {cwd, env: {COPILOT_HOME: home, COPILOT_PLUGIN_DATA: path.join(root, 'data')}, now: Date.parse('2026-10-18T10:05:00Z')};
  for (const command of ['show', 'handoff']) {
    const result = run([command, sessionId, '--no-git'], options);
    assert.match(result.output, /Last observed saved checklist/);
    assert.match(result.output, /> - \[ \] Continue exact work/);
    assert.match(result.output, /Historical evidence only/);
    assert.match(result.output, /review: dispatched/);
    assert.doesNotMatch(result.output, /secret worker prompt/);
  }
  const list = run(['list', '--json', '--no-git'], options).value.rows[0];
  for (const key of ['tasks', 'plan', 'taskRuns']) assert.equal(Object.hasOwn(list, key), false);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('session trail attributes only native unsourced main user messages to the human', () => {
  const root = event('u', 'user.message', {content: 'Actual request'});
  const rows = [root,
    event('s', 'user.message', {content: 'Skill injection', source: 'skill-zensu'}),
    event('s2', 'user.message', {content: 'Explicit source', source: ''}),
    event('a', 'user.message', {content: 'Automated continuation', isAutopilotContinuation: true}),
    event('c', 'user.message', {content: 'Child prompt'}, 'child'),
    {...event('bad', 'user.message', {content: 'Unknown child'}), agentId: ''},
    event('parent', 'user.message', {content: 'Unknown parent', parentAgentTaskId: 'task'}),
    event('array', 'user.message', {content: [{type: 'text', text: 'Foreign format'}]})];
  const result = normalize(rows);
  assert.equal(result.lastPrompt, 'Actual request');
  assert.deepEqual(result.prompts.map(row => row.text), ['Actual request']);
  assert.equal(result.sourceMessages, 3);
});

test('unknown child identities and parent-only hints never establish root progress', () => {
  for (const overrides of [{agentId: ''}, {agentId: null}, {data: {parentToolCallId: 'parent'}}]) {
    const begin = start('s', 'todo', 'update_todo', {todos: '- [x] forged'});
    const finish = done('d', 'todo');
    if (overrides.data) { Object.assign(begin.data, overrides.data); Object.assign(finish.data, overrides.data); }
    else { Object.assign(begin, overrides); Object.assign(finish, overrides); }
    assert.equal(normalize([begin, finish]).tasks, null);
  }
});
