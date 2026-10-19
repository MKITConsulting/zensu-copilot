'use strict';
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { readNativeEvents: readTranscript, eventOwner } = require('./transcript');
const { unbindShell } = require('./context');
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const mainEvent = event => eventOwner(event) === null;
const uniqueEvent = (events, event) => validId(event?.id) && events.filter(item => item?.id === event.id).length === 1;

// Hook toolResult is only prose in Copilot 1.0.98. The durable human-response
// event, correlated to the active native call, is the approval authority.
function planApproval(events, toolArgs, agentId) {
  if (agentId !== undefined || !Array.isArray(events)) return null;
  const completed = new Set(events.filter(e => mainEvent(e) && e.type === 'tool.execution_complete').map(e => e.data?.toolCallId));
  const active = events.filter(e => mainEvent(e) && e.type === 'tool.execution_start'
    && e.data?.toolName === 'exit_plan_mode' && !completed.has(e.data.toolCallId)
    && isDeepStrictEqual(e.data.arguments, toolArgs));
  if (active.length !== 1 || !validId(active[0].data.toolCallId) || !uniqueEvent(events, active[0])) return null;
  const callId = active[0].data.toolCallId;
  const responses = events.filter(e => e?.type === 'human_response.recorded' && e.data?.toolCallId === callId);
  if (responses.length !== 1) return null;
  const event = responses[0];
  if (!mainEvent(event) || !uniqueEvent(events, event) || events.indexOf(event) <= events.indexOf(active[0])) return null;
  const { response, actor, requestId } = event.data;
  if (actor !== 'human_response' || !validId(requestId) || events.filter(e => e?.type === 'human_response.recorded' && e.data?.requestId === requestId).length !== 1 || response?.responseKind !== 'exit_plan_mode'
    || response.approved !== true || !['interactive', 'autopilot', 'autopilot_fleet'].includes(response.selectedAction)
    || typeof response.planContent !== 'string' || !response.planContent.trim()
    || Buffer.byteLength(response.planContent) > 1024 * 1024) return null;
  return { plan: response.planContent, approved: true, isAgent: false,
    approval: { source: 'copilot-human-response', requestId, toolCallId: callId, eventId: event.id,
      sha256: crypto.createHash('sha256').update(response.planContent).digest('hex') } };
}
function readPlanApproval(file, toolArgs, agentId) {
  const events = readNativeEvents(file);
  return events ? planApproval(events, toolArgs, agentId) : null;
}
function readNativeEvents(file) {
  const parsed = readTranscript(file);
  if (parsed.errors.length) return null;
  return parsed.events;
}
function shellArgs(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || typeof value.command !== 'string') return null;
  return { ...value, command: unbindShell(value.command) };
}
function navigationApproval(events, args, agentId) {
  if (agentId !== undefined || !Array.isArray(events) || !shellArgs(args)) return null;
  const completed = new Set(events.filter(e => mainEvent(e) && e.type === 'tool.execution_complete').map(e => e.data?.toolCallId));
  const active = events.filter(e => mainEvent(e) && e.type === 'tool.execution_start' && e.data?.toolName === 'bash'
    && !completed.has(e.data.toolCallId) && isDeepStrictEqual(shellArgs(e.data.arguments), shellArgs(args)));
  if (active.length !== 1 || !validId(active[0].data.toolCallId) || !uniqueEvent(events, active[0])) return null;
  const callId = active[0].data.toolCallId;
  const requests = events.filter(e => mainEvent(e) && e.type === 'permission.requested' && !e.data?.resolvedByHook
    && validId(e.data?.requestId) && uniqueEvent(events, e) && events.indexOf(e) > events.indexOf(active[0])
    && events.filter(other => other?.type === 'permission.requested' && other.data?.requestId === e.data.requestId).length === 1
    && e.data?.permissionRequest?.kind === 'hook' && e.data.permissionRequest.toolName === 'bash'
    && e.data.permissionRequest.toolCallId === callId
    && isDeepStrictEqual(shellArgs(e.data.permissionRequest.toolArgs), shellArgs(args)));
  const receipts = requests.flatMap(request => {
    const matches = events.filter(e => e?.type === 'permission.completed' && e.data?.requestId === request.data.requestId);
    if (matches.length !== 1) return [];
    return matches.filter(e => mainEvent(e) && uniqueEvent(events, e) && events.indexOf(e) > events.indexOf(request)
      && (!e.data.toolCallId || e.data.toolCallId === callId)
      && e.data.decisionSource === 'human_response'
      && ['approved', 'approved-for-session', 'approved-for-location'].includes(e.data.result?.kind));
  });
  return receipts.length === 1 ? { requestId: receipts[0].data.requestId, toolCallId: callId, eventId: receipts[0].id } : null;
}
function readNavigationApproval(file, args, agentId) {
  return navigationApproval(readNativeEvents(file), args, agentId);
}
module.exports = { planApproval, readPlanApproval, navigationApproval, readNavigationApproval };
