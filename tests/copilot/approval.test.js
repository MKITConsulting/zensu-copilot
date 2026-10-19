'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planApproval, navigationApproval } = require('../../src/approval');
const args = { summary: 'Implement fixture', actions: ['interactive', 'exit_only'] };
function fixture() {
  return [{ type: 'tool.execution_start', id: 'start-1', data: { toolCallId: 'call-1', toolName: 'exit_plan_mode', arguments: args } },
    { type: 'human_response.recorded', id: 'human-1', data: { requestId: 'request-1', toolCallId: 'call-1', actor: 'human_response',
      response: { responseKind: 'exit_plan_mode', approved: true, selectedAction: 'interactive', planContent: '# Approved plan\nImplement fixture.' } } }];
}
test('native human approval supplies the exact reviewed plan bytes and correlated receipt', () => {
  const events = fixture();
  const approval = planApproval(events, args);
  assert.equal(approval.plan, events[1].data.response.planContent);
  assert.equal(approval.approval.toolCallId, 'call-1');
  assert.match(approval.approval.sha256, /^[a-f0-9]{64}$/);
});
test('exit-only, rejection, automation and unclassified actors never approve implementation', () => {
  for (const mutation of [e => { e[1].data.response.selectedAction = 'exit_only'; }, e => { e[1].data.response.approved = false; },
    e => { e[1].data.actor = 'host_automation'; }, e => { e[1].data.actor = 'unknown'; }, e => { delete e[1].data.response.planContent; }]) {
    const e = fixture(); mutation(e); assert.equal(planApproval(e, args), null);
  }
});
test('stale, ambiguous, mismatched and child receipts cannot approve a new call', () => {
  const stale = fixture(); stale.push({ type: 'tool.execution_complete', data: { toolCallId: 'call-1' } });
  assert.equal(planApproval(stale, args), null);
  assert.equal(planApproval(fixture(), { summary: 'Other plan' }), null);
  assert.equal(planApproval(fixture(), args, 'child-1'), null);
  const repeated = fixture(); repeated.push(structuredClone(repeated[1]));
  assert.equal(planApproval(repeated, args), null);
  const mismatch = fixture(); mismatch[1].data.toolCallId = 'other';
  assert.equal(planApproval(mismatch, args), null);
});
test('browser consent requires the exact hook request and a human permission decision', () => {
  const toolArgs = { command: 'playwright-cli -s=zensu-verify-x goto https://example.com/' };
  const events = [{ type: 'tool.execution_start', id: 'start-bash', data: { toolName: 'bash', toolCallId: 'bash-1', arguments: toolArgs } },
    { type: 'permission.requested', id: 'request-hook', data: { requestId: 'permission-1', permissionRequest: { kind: 'hook', toolName: 'bash', toolCallId: 'bash-1', toolArgs } } },
    { type: 'permission.completed', id: 'approved-1', data: { requestId: 'permission-1', toolCallId: 'bash-1', decisionSource: 'human_response', result: { kind: 'approved' } } }];
  assert.equal(navigationApproval(events, toolArgs).requestId, 'permission-1');
  for (const mutation of [e => { delete e[1].data.requestId; delete e[2].data.requestId; },
    e => { delete e[2].id; }, e => { e[2].agentId = 'child'; }, e => { e.reverse(); },
    e => { e[1].data.ownerAgentId = 'child'; }]) {
    const malformed = structuredClone(events); mutation(malformed);
    assert.equal(navigationApproval(malformed, toolArgs), null);
  }
  for (const source of ['assisted_approval', 'host_policy', 'unattended_fallback', 'authorization_carry_forward', undefined]) {
    const copy = structuredClone(events); copy[2].data.decisionSource = source;
    assert.equal(navigationApproval(copy, toolArgs), null);
  }
  const cancelled = structuredClone(events); cancelled[2].data.result.kind = 'cancelled';
  assert.equal(navigationApproval(cancelled, toolArgs), null);
  const wrong = structuredClone(events); wrong[1].data.permissionRequest.toolCallId = 'other';
  assert.equal(navigationApproval(wrong, toolArgs), null);
  const conflicting = structuredClone(events); conflicting.push({ type: 'permission.completed', data: { requestId: 'permission-1', decisionSource: 'human_response', result: { kind: 'cancelled' } } });
  assert.equal(navigationApproval(conflicting, toolArgs), null);
  assert.equal(navigationApproval(events, toolArgs, 'reviewer'), null);
  events.push({ type: 'tool.execution_complete', data: { toolCallId: 'bash-1' } });
  assert.equal(navigationApproval(events, toolArgs), null);
});
test('plan receipt integrity rejects missing IDs, child owners and out-of-order history', () => {
  for (const mutation of [e => { e.reverse(); }, e => { e[1].agentId = 'child'; },
    e => { delete e[1].id; }, e => { delete e[0].id; }, e => { e[1].data.requestId = ''; }]) {
    const malformed = fixture(); mutation(malformed); assert.equal(planApproval(malformed, args), null);
  }
});

test('ambiguous native ownership never establishes plan or browser approval', () => {
  const toolArgs = { command: 'playwright-cli -s=zensu-verify-x goto https://example.com/' };
  const browser = [
    { type: 'tool.execution_start', id: 'start', data: { toolName: 'bash', toolCallId: 'call', arguments: toolArgs } },
    { type: 'permission.requested', id: 'request', data: { requestId: 'permission', permissionRequest: { kind: 'hook', toolName: 'bash', toolCallId: 'call', toolArgs } } },
    { type: 'permission.completed', id: 'receipt', data: { requestId: 'permission', toolCallId: 'call', decisionSource: 'human_response', result: { kind: 'approved' } } },
  ];
  for (const mutate of [
    e => { e.agentId = ''; }, e => { e.agentId = null; },
    e => { e.data.ownerAgentId = ''; }, e => { e.data.ownerAgentId = null; },
    e => { e.data.parentToolCallId = 'unclassified-parent'; },
    e => { e.data.parentAgentTaskId = 'unclassified-task'; },
  ]) {
    for (let i = 0; i < 2; i++) {
      const events = fixture(); mutate(events[i]);
      assert.equal(planApproval(events, args), null);
    }
    for (let i = 0; i < browser.length; i++) {
      const events = structuredClone(browser); mutate(events[i]);
      assert.equal(navigationApproval(events, toolArgs), null);
    }
  }
  for (const actor of ['', null, false]) {
    assert.equal(planApproval(fixture(), args, actor), null);
    assert.equal(navigationApproval(browser, toolArgs, actor), null);
  }
});
