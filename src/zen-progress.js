'use strict';

const native = require('./context');
const transcript = require('./transcript');

const ANCHOR = /^ZENSU CHAIN ANCHOR: (none|Zensu:(?: [✓▶·✗][a-z][a-z-]*)+)$/m;
const isChild = payload => payload.isChild || ['agentId', 'agentType', 'agentName', 'parentAgentId']
  .some(key => Object.hasOwn(payload, key));

const CLEAR = 'The previous Zen progress anchor is no longer current. Omit the progress line until a new anchor is supplied.\n<!-- zensu:chain-anchor -->\nZENSU CHAIN ANCHOR: none\n<!-- /zensu:chain-anchor -->';

// Prepare a delivery from the dedicated hook, never from tool output. Commit
// only after the dispatcher has constructed the final successful response.
// The cache grants no workflow authority and never changes the workflow document.
function reconcileProgress(context, payload, output) {
  if (isChild(payload)) return { output, commit() {} };
  const match = ANCHOR.exec(output.additionalContext || '');
  const token = match?.[1] || 'none';
  const record = native.readPrivate(context.registryFile);
  const previous = record.zenProgressAnchor || 'none';
  const commit = () => {
    if (token !== previous) native.writePrivate(context.registryFile, {
      ...native.readPrivate(context.registryFile), zenProgressAnchor: token,
    });
  };
  let delivered = output;
  if (!match && output.additionalContext) {
    // Preserve runtime diagnostics even when a presentation failure also clears
    // an old anchor. A progress failure must not conceal another hook's result.
    delivered = { ...output, additionalContext: [output.additionalContext, previous !== 'none' ? CLEAR : ''].filter(Boolean).join('\n\n') };
  } else if (['userPromptTransformed', 'sessionStart'].includes(payload.eventName) && match) {
    // Even an unchanged anchor accompanies the prompt's full/short Zen contract.
    delivered = output;
  } else if (token === previous) {
    delivered = {};
  } else if (token === 'none') {
    delivered = { additionalContext: CLEAR };
  } else if (payload.eventName === 'postToolUse') {
    // A changed position applies before the next tool call, not just at stop.
    delivered = { ...output, additionalContext: `Zen progress update: the supplied anchor replaces the earlier one. Include its exact plain-text value in EVERY user-facing intermediate message as well as the final answer. Render only the value starting with Zensu:, never the ZENSU CHAIN ANCHOR: field label or the HTML markers. For a brief progress message between tools, put the line after the message; do not defer it until the end of the turn. If no message is needed, continue working without inventing one. Keep using this anchor until another update replaces or clears it. This is presentation only; do not repeat work or change workflow state.\n\n${output.additionalContext}` };
  }
  return { output: delivered, commit };
}

// Context delivery is not display evidence. At the native final-response seam,
// request at most one presentation correction per real user turn. Never alter
// workflow state or replace an existing policy block with a presentation request.
function isPresentationUser(events, index, sessionId) {
  const event = events[index];
  if (!Object.hasOwn(event.data, 'parentAgentTaskId')) return transcript.isUserMessage(event);
  const data = event.data;
  // Copilot 1.0.100 attaches parentAgentTaskId to real root prompts too. A
  // matching successful native main-prompt receipt resolves this ambiguity
  // for presentation only; never relax the general workflow owner classifier.
  if (event.type !== 'user.message' || typeof data.content !== 'string'
    || Object.hasOwn(data, 'source') || (Object.hasOwn(data, 'isAutopilotContinuation') && data.isAutopilotContinuation !== false)
    || ['agentId', 'agentType', 'agentName', 'parentAgentId', 'ownerAgentId', 'parentToolCallId']
      .some(key => Object.hasOwn(event, key) || Object.hasOwn(data, key))) return false;
  try { native.identity(data.parentAgentTaskId); } catch { return false; }
  const startIndex = events.slice(0, index).findLastIndex(e => e.type === 'hook.start' && e.data.hookType === 'userPromptSubmitted');
  const start = events[startIndex];
  const input = start?.data.input;
  if (!input || isChild(input) || input.sessionId !== sessionId || input.prompt !== data.content) return false;
  const invocation = start.data.hookInvocationId;
  try { native.identity(invocation); } catch { return false; }
  if (events.filter(e => e.type === 'hook.start' && e.data.hookInvocationId === invocation).length !== 1) return false;
  const ends = events.slice(startIndex + 1, index).filter(e => e.type === 'hook.end' && e.data.hookInvocationId === invocation);
  return ends.length === 1 && ends[0].data.hookType === 'userPromptSubmitted' && ends[0].data.success === true;
}

function verifyProgressResponse(context, payload, output, progress) {
  if (isChild(payload) || payload.stopReason !== 'end_turn' || output.decision === 'block') return output;
  const token = ANCHOR.exec(progress?.additionalContext || '')?.[1];
  if (!token || token === 'none') return output;
  const { events, errors } = transcript.readNativeEvents(context.transcriptPath);
  if (errors.length || !events.some(e => e.type === 'session.start' && e.data.sessionId === context.sessionId)) return output;
  const userIndex = events.findLastIndex((_event, index) => isPresentationUser(events, index, context.sessionId));
  const user = events[userIndex];
  try { native.identity(user?.id, 'user message ID'); } catch { return output; }
  if (events.filter(e => e.id === user.id).length !== 1) return output;
  const response = events.slice(userIndex + 1).findLast(e => e.type === 'assistant.message' && transcript.eventOwner(e) === null);
  if (!response || typeof response.data.content !== 'string' || !response.data.content.trim()
    || response.data.toolRequests?.length) return output;
  let fence = null;
  const visible = response.data.content.split(/\r?\n/).some(line => {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
      return false;
    }
    return !fence && line === token;
  });
  if (visible) return output;
  const record = native.readPrivate(context.registryFile);
  if (record.zenProgressCorrectionTurn === user.id) return output;
  native.writePrivate(context.registryFile, { ...record, zenProgressCorrectionTurn: user.id });
  return { decision: 'block', reason: `Zen presentation correction only: your final answer omitted the current progress line. Reissue the answer, preserving its result, failures and limitations, and include this exact plain-text line outside code blocks: ${token}\nDo not run tools, repeat implementation/review work, change workflow state or invent a next step. This presentation retry is limited to once for this user turn.` };
}

module.exports = { reconcileProgress, verifyProgressResponse };
