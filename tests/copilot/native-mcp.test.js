'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const capability = require('../../src/plugin/hooks/lib/reviewer-capability-v1');
const nativeEvents = require('../../src/transcript');

// Synthetic native envelopes model the installed 1.0.98 session-event schema.
// The advertised tool name is deliberately opaque: no encoded server/tool
// spelling is assumed, reconstructed or translated by the policy.
function fixture(server = 'context7', operation = 'query-docs') {
  const payload = { toolName: 'opaque-catalog-entry', toolArgs: { query: 'documented API' },
    agentId: 'worker-1', isChild: true };
  const start = { id: 'event-1', type: 'tool.execution_start', agentId: 'worker-1', data: {
    toolCallId: 'call-1', toolName: payload.toolName, arguments: payload.toolArgs,
    mcpServerName: server, mcpToolName: operation,
  } };
  return { payload, events: [start] };
}
const allowed = ({ payload, events }) => capability.nativeMcpReadCapability(payload, nativeEvents.analyzeNativeEvents(events));
const complete = (call = 'call-1', id = 'event-2') => ({ id, type: 'tool.execution_complete', agentId: 'worker-1',
  data: { toolCallId: call, success: true, result: { content: 'done' } } });

test('Context7 access uses exact native server provenance and the two read operations', () => {
  for (const operation of ['resolve-library-id', 'query-docs']) {
    const f = fixture('context7', operation);
    assert.equal(allowed(f), true);
    f.events[0].data.mcpConfigServerName = 'context7';
    f.events[0].data.mcpServerName = 'Context7 display title';
    assert.equal(allowed(f), true);
  }
  for (const operation of ['run', 'query-docs-extra', 'query_docs', 'delete', 'query-docs\n']) {
    assert.equal(allowed(fixture('context7', operation)), false, operation);
  }
  for (const server of ['other-context7', 'context7-other', 'Context7', '', 'plugin:unverified:context7']) {
    assert.equal(allowed(fixture(server)), false, server);
  }
});

test('Zensu native MCP retains read and journal capabilities while refusing mutations', () => {
  for (const operation of ['list_products', 'get_feature', 'search_knowledge', 'suggest_workflow',
    'view_feature', 'validate_feature_security', 'analyze_journey_health', 'ghost_get_candidates',
    'pulse_start_session', 'pulse_end_session', 'pulse_session_summary']) {
    assert.equal(allowed(fixture('zensu', operation)), true, operation);
  }
  for (const operation of ['create_feature', 'update_feature', 'delete_roadmap', 'analyze_feature_security',
    'ghost_scan', 'pulse_delete_session', 'get_feature\ncreate_feature']) {
    assert.equal(allowed(fixture('zensu', operation)), false, operation);
  }
  assert.equal(allowed(fixture('zensu-unverified', 'list_products')), false);
});

test('model-supplied MCP labels and familiar tool names cannot grant a capability', () => {
  const f = fixture('untrusted');
  f.payload.mcpServerName = 'context7';
  f.payload.mcpToolName = 'query-docs';
  f.payload.toolArgs = { ...f.payload.toolArgs, mcpConfigServerName: 'context7', mcpToolName: 'query-docs' };
  f.events[0].data.arguments = f.payload.toolArgs;
  assert.equal(allowed(f), false);
  delete f.events[0].data.mcpServerName;
  assert.equal(allowed(f), false);
  f.payload.toolName = 'context7/query-docs';
  f.events[0].data.toolName = f.payload.toolName;
  assert.equal(allowed(f), false);
  f.events[0].data.mcpServerName = 'context7';
  f.events[0].data.mcpConfigServerName = 'foreign-config';
  assert.equal(allowed(f), false);
  f.events[0].data.mcpConfigServerName = null;
  assert.equal(allowed(f), false);
});

test('serial identical calls use the unique pending execution and never a completed grant', () => {
  const f = fixture();
  f.events.push(complete());
  assert.equal(allowed(f), false);
  const next = structuredClone(f.events[0]);
  next.id = 'event-3'; next.data.toolCallId = 'call-2';
  f.events.push(next);
  assert.equal(allowed(f), true);
  next.data.mcpServerName = 'untrusted';
  assert.equal(allowed(f), false);
  next.data.mcpServerName = 'context7';
  f.events.push(complete('call-2', 'event-4'));
  assert.equal(allowed(f), false);
});

test('ambiguous, mismatched, duplicate and foreign-agent executions fail closed', () => {
  for (const change of [
    f => { const extra = structuredClone(f.events[0]); extra.id = 'other'; extra.data.toolCallId = 'other'; f.events.push(extra); },
    f => { f.events.push(structuredClone(f.events[0])); },
    f => { f.events[0].agentId = 'another-worker'; },
    f => { delete f.events[0].agentId; },
    f => { f.events[0].data.arguments = { query: 'different' }; },
    f => { f.events[0].data.toolName = 'different'; },
    f => { delete f.payload.agentId; },
    f => { f.events.unshift(complete()); },
    f => { f.events.push({ ...complete(), agentId: 'another-worker' }); },
  ]) {
    const f = fixture(); change(f); assert.equal(allowed(f), false);
  }
});

test('pending MCP capability reads real native events and refuses missing, malformed or linked logs', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-native-mcp-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = fixture();
  f.payload.transcriptPath = path.join(directory, 'events.jsonl');
  const text = f.events.map(event => JSON.stringify(event)).join('\n') + '\n';
  assert.equal(capability.nativeMcpReadAllowed(f.payload, nativeEvents), false);
  fs.writeFileSync(f.payload.transcriptPath, text);
  assert.equal(capability.nativeMcpReadAllowed(f.payload, nativeEvents), true);
  assert.equal(fs.readFileSync(f.payload.transcriptPath, 'utf8'), text);
  const linked = path.join(directory, 'linked.jsonl');
  fs.symlinkSync(f.payload.transcriptPath, linked);
  assert.equal(capability.nativeMcpReadAllowed({ ...f.payload, transcriptPath: linked }, nativeEvents), false);
  fs.appendFileSync(f.payload.transcriptPath, '{invalid');
  assert.equal(capability.nativeMcpReadAllowed(f.payload, nativeEvents), false);
  assert.equal(capability.nativeMcpReadAllowed({ ...f.payload, transcriptPath: 'events.jsonl' }, nativeEvents), false);
});

test('a neutral child without native MCP provenance receives a closed capability decision', () => {
  const f = fixture();
  const trusted = { contextFile: '/private/context.json', pluginData: '/private/plugin-data',
    pluginRoot: '/installed/plugin', projectRoot: '/workspace/project', toolCwd: '/workspace/project' };
  const reason = capability.neutralViolation(f.payload, trusted);
  assert.match(reason, /cannot invoke opaque-catalog-entry/);
  assert.match(reason, /unique pending native execution/);
  assert.doesNotMatch(reason, /mcp__/);
});
