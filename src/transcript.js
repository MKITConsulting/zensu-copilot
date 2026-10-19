'use strict';

// Native Copilot event observations. This module never writes a transcript or
// invents a conversation message to represent a tool invocation or result.
const fs = require('node:fs');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\p{Cc}\p{Cf}]/u.test(value);
const MAX_TEXT_BYTES = 32 * 1024 * 1024;

function parseEvents(text) {
  const events = [], errors = [];
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT_BYTES) {
    return { events, errors: ['transcript-invalid-or-too-large'] };
  }
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (!object(event) || typeof event.type !== 'string' || !object(event.data)) errors.push(`invalid-event:${index + 1}`);
      else events.push(event);
    } catch { errors.push(`invalid-json:${index + 1}`); }
  });
  return { events, errors };
}

function readOnlyFlags() {
  return fs.constants.O_RDONLY | (process.platform !== 'win32' ? fs.constants.O_NOFOLLOW || 0 : 0) | (fs.constants.O_NONBLOCK || 0);
}

function readNativeEvents(file) {
  let fd;
  try {
    if (!identity(file)) return { events: [], errors: ['invalid-transcript-path'] };
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_TEXT_BYTES) return { events: [], errors: ['unsafe-or-oversized-transcript'] };
    fd = fs.openSync(file, readOnlyFlags());
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > MAX_TEXT_BYTES) {
      return { events: [], errors: ['transcript-changed-or-unsafe'] };
    }
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) return { events: [], errors: ['transcript-short-read'] };
      offset += count;
    }
    return parseEvents(buffer.toString('utf8'));
  } catch { return { events: [], errors: ['transcript-unreadable'] }; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// null denotes the main agent; undefined means ownership is malformed or only
// a parent-call hint is available. Such events cannot establish main activity.
function eventOwner(event) {
  if (!object(event) || !object(event.data)) return undefined;
  if (Object.hasOwn(event, 'agentId')) return identity(event.agentId) ? event.agentId : undefined;
  if (Object.hasOwn(event.data, 'ownerAgentId')) return identity(event.data.ownerAgentId) ? event.data.ownerAgentId : undefined;
  if (event.data.parentToolCallId || event.data.parentAgentTaskId) return undefined;
  return null;
}

function isUserMessage(event) {
  return event?.type === 'user.message' && eventOwner(event) === null
    && !Object.hasOwn(event.data, 'source')
    && (!Object.hasOwn(event.data, 'isAutopilotContinuation') || event.data.isAutopilotContinuation === false)
    && typeof event.data.content === 'string';
}

function completionOutcome(start, completion) {
  if (!completion) return { outcome: 'pending' };
  const data = completion.data;
  if (data.success === false || data.error !== undefined) return { outcome: 'error' };
  if (data.success !== true) return { outcome: 'unknown' };
  if (start.data.toolName === 'task') return { outcome: start.data.arguments?.mode === 'sync' ? 'completed' : 'dispatched' };
  if (start.data.toolName === 'bash' || start.data.toolName === 'powershell') {
    const exitCode = data.shellExecution?.exitCode;
    if (!Number.isInteger(exitCode)) return { outcome: 'unknown' };
    return { outcome: exitCode === 0 ? 'completed' : 'error', exitCode };
  }
  return { outcome: 'completed' };
}

// Correlation keeps the original envelopes. Tool requests in assistant prose
// describe intent, not execution. Duplicate IDs/calls invalidate their entire
// correlation instead of arbitrarily choosing a favorable completion.
function analyzeNativeEvents(events) {
  const errors = [], calls = [], userMessages = [];
  if (!Array.isArray(events)) return { calls, userMessages, errors: ['events-not-array'], contextUsage: null };
  const counts = new Map(), starts = new Map(), completions = new Map();
  for (const event of events) if (identity(event?.id)) counts.set(event.id, (counts.get(event.id) || 0) + 1);
  const add = (map, key, row) => map.set(key, [...(map.get(key) || []), row]);
  for (const [index, event] of events.entries()) {
    if (!object(event) || !object(event.data) || !identity(event.id)) { errors.push('invalid-event-envelope'); continue; }
    if (counts.get(event.id) !== 1) { errors.push(`duplicate-event:${event.id}`); continue; }
    if (isUserMessage(event)) userMessages.push(event);
    if (!['tool.execution_start', 'tool.execution_complete'].includes(event.type)) continue;
    const owner = eventOwner(event), callId = event.data.toolCallId;
    if (owner === undefined || !identity(callId)) { errors.push('invalid-tool-identity'); continue; }
    const key = JSON.stringify([owner, callId]);
    add(event.type === 'tool.execution_start' ? starts : completions, key, { event, index });
  }
  for (const [key, rows] of starts) {
    const start = rows[0], id = start.event.data.toolCallId;
    if (rows.length !== 1) { errors.push(`duplicate-tool-start:${id}`); continue; }
    if (!identity(start.event.data.toolName)) { errors.push(`invalid-tool-start:${id}`); continue; }
    const ends = completions.get(key) || [];
    if (ends.length > 1) { errors.push(`duplicate-tool-completion:${id}`); continue; }
    const completion = ends[0];
    if (completion && completion.index <= start.index) { errors.push(`completion-before-start:${id}`); continue; }
    if (completion && typeof completion.event.data.success !== 'boolean') { errors.push(`invalid-tool-completion:${id}`); continue; }
    calls.push({ toolCallId: id, agentId: eventOwner(start.event), toolName: start.event.data.toolName,
      arguments: start.event.data.arguments, start: start.event, completion: completion?.event || null,
      startIndex: start.index, completionIndex: completion?.index ?? null,
      ...completionOutcome(start.event, completion?.event) });
  }
  for (const [key, rows] of completions) if (!starts.has(key)) errors.push(`unmatched-tool-completion:${rows[0].event.data.toolCallId}`);
  return { calls, userMessages, errors: [...new Set(errors)], contextUsage: null };
}

module.exports = { parseEvents, readNativeEvents, analyzeNativeEvents, eventOwner, isUserMessage, completionOutcome, readOnlyFlags, MAX_TEXT_BYTES };
