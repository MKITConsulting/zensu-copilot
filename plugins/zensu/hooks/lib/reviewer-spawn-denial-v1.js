'use strict';

// Read Copilot events.jsonl directly. A refusal requires a unique native
// permission request and its matching structured denied completion. Free-text
// error messages, assistant toolRequests and reviewer prose are never proof.
// The latest unresolved refusal survives background dispatches, unrelated
// failures and an older parallel review finishing later. Only a later completed
// synchronous reviewer invocation clears it. This remains a diagnostic: an
// unreadable or ambiguous event stream never supplies a successful review.
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const { parseEvents, analyzeNativeEvents, eventOwner } = require('../native/transcript.js');
const REVIEWER_AGENT_TYPE = 'zensu:code-reviewer';
const NATIVE_SCHEMA_SOURCE_BUILD = '1.0.98';
const DENIAL_KINDS = Object.freeze([
  'denied-by-rules', 'denied-interactively-by-user',
  'denied-no-approval-rule-and-could-not-request-from-user',
  'denied-by-content-exclusion-policy', 'denied-by-permission-request-hook',
]);
const MAX_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_LINES = 20000;
const NUL_BYTE = String.fromCharCode(0);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\p{Cc}\p{Cf}]/u.test(value);
const verdict = (status, extra = {}) => ({ status, kind: '', toolName: '', agentType: REVIEWER_AGENT_TYPE, spawns: 0, denials: 0, ...extra });

// Refuse links and non-files before open; O_NONBLOCK prevents FIFO races from
// wedging agentStop. The enclosing hook also applies a process deadline.
function readOnlyFlags() {
  const noFollow = process.platform !== 'win32' && Number.isInteger(fs.constants.O_NOFOLLOW)
    ? fs.constants.O_NOFOLLOW : 0;
  const nonBlock = Number.isInteger(fs.constants.O_NONBLOCK) ? fs.constants.O_NONBLOCK : 0;
  return fs.constants.O_RDONLY | noFollow | nonBlock;
}

function readTail(transcriptPath) {
  if (transcriptPath.indexOf(NUL_BYTE) !== -1) return { error: 'unreadable' };
  let pre;
  try {
    pre = fs.lstatSync(transcriptPath);
  } catch (e) {
    return { error: 'unreadable' };
  }
  if (!pre.isFile()) return { error: 'unreadable' };
  let fd;
  try {
    fd = fs.openSync(transcriptPath, readOnlyFlags());
  } catch (e) {
    return { error: 'unreadable' };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { error: 'unreadable' };
    const size = st.size;
    if (size === 0) return { text: '', truncated: false };
    const start = size > MAX_TAIL_BYTES ? size - MAX_TAIL_BYTES : 0;
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return { text: buf.toString('utf8', 0, read), truncated: start > 0 };
  } catch (e) {
    return { error: 'unreadable' };
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* already closed */ }
  }
}

function scanEvents(events, options = {}) {
  const agentType = options.agentType || REVIEWER_AGENT_TYPE;
  const analysis = analyzeNativeEvents(events);
  const counts = new Map();
  for (const event of events) if (identity(event.id)) counts.set(event.id, (counts.get(event.id) || 0) + 1);
  const unique = event => identity(event?.id) && counts.get(event.id) === 1;
  const relevant = analysis.calls.filter(call => call.agentId === null && call.toolName === 'task' && call.arguments?.agent_type === agentType);
  const attempts = new Map(relevant.map(call => [call.toolCallId, {
    index: call.startIndex, call, denial: null,
  }]));
  // Include failed permission admissions which never reached execution_start;
  // a runtime-owned permission request establishes the attempted call itself.
  for (const [index, event] of events.entries()) {
    if (event.type !== 'permission.requested' || !unique(event) || eventOwner(event) !== null) continue;
    const data = event.data, request = data.permissionRequest;
    if (!identity(data.requestId) || !request || !['hook', 'custom-tool'].includes(request.kind)
      || request.toolName !== 'task' || !identity(request.toolCallId)) continue;
    const args = request.kind === 'hook' ? request.toolArgs : request.args;
    if (!args || args.agent_type !== agentType) continue;
    if (events.filter(row => row.type === 'permission.requested' && row.data?.requestId === data.requestId).length !== 1) continue;
    const starts = events.filter(row => row.type === 'tool.execution_start' && eventOwner(row) === null && row.data?.toolCallId === request.toolCallId);
    const executions = events.filter(row => row.type === 'tool.execution_complete' && eventOwner(row) === null && row.data?.toolCallId === request.toolCallId);
    if (executions.length > 1 || executions.some(row => !unique(row))) continue;
    const existing = attempts.get(request.toolCallId);
    if (starts.length && (!existing || starts.length !== 1 || !isDeepStrictEqual(existing.call.arguments, args))) continue;
    const finishes = events.filter(row => row.type === 'permission.completed' && row.data?.requestId === data.requestId);
    if (finishes.length !== 1) continue;
    const finish = finishes[0], finishIndex = events.indexOf(finish);
    if (!unique(finish) || eventOwner(finish) !== null || finishIndex <= index
      || finish.data.toolCallId !== undefined && finish.data.toolCallId !== request.toolCallId
      || !DENIAL_KINDS.includes(finish.data.result?.kind)) continue;
    // A claimed successful execution or a permission response arriving after
    // completion contradicts refusal evidence. Keep the observation unknown.
    if (existing?.call.completion && (existing.call.completionIndex < finishIndex || existing.call.completion.data.success !== false)) continue;
    const attempt = existing || { index, call: null, denial: null };
    attempt.index = Math.min(attempt.index, index);
    // More than one denial admission for the same invocation is ambiguous,
    // not multiple failed retries; it cannot spend the user's retry budget.
    if (attempt.denial) { attempt.ambiguous = true; continue; }
    attempt.denial = { nativeKind: finish.data.result.kind, decisionSource: finish.data.decisionSource || null,
      requestId: data.requestId, eventId: finish.id };
    attempts.set(request.toolCallId, attempt);
  }
  let blocked = null, cleared = false, errored = analysis.errors.length > 0, denials = 0;
  for (const [toolCallId, attempt] of [...attempts].sort((a, b) => a[1].index - b[1].index)) {
    if (attempt.ambiguous) { errored = true; continue; }
    if (attempt.denial) { denials += 1; blocked = { toolCallId, ...attempt.denial }; cleared = false; }
    else if (attempt.call?.outcome === 'completed') { blocked = null; cleared = true; }
    else if (attempt.call?.outcome === 'error' || attempt.call?.outcome === 'unknown') errored = true;
  }
  const status = blocked ? 'blocked' : cleared && !analysis.errors.length ? 'clear' : errored ? 'errored' : 'none';
  return verdict(status, { agentType, spawns: attempts.size, denials,
    ...(blocked ? { ...blocked, kind: 'permission-denied', toolName: 'task' } : cleared ? { toolName: 'task' } : {}) });
}

function scanTranscript(transcriptPath, options = {}) {
  const agentType = options.agentType || REVIEWER_AGENT_TYPE;
  if (typeof transcriptPath !== 'string' || !transcriptPath) return verdict('none', { agentType });
  const tail = readTail(transcriptPath);
  if (tail.error) return verdict('unreadable', { agentType });
  let lines = tail.text.split('\n');
  if (tail.truncated && lines.length) lines = lines.slice(1);
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  const parsed = parseEvents(lines.join('\n'));
  if (parsed.errors.length) return verdict('unreadable', { agentType });
  return scanEvents(parsed.events, options);
}

function main(argv) {
  let transcriptPath = '', agentType = REVIEWER_AGENT_TYPE;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--transcript' && i + 1 < argv.length) transcriptPath = argv[++i];
    else if (argv[i] === '--agent-type' && i + 1 < argv.length) agentType = argv[++i];
  }
  let report;
  try { report = scanTranscript(transcriptPath, { agentType }); }
  catch { report = verdict('unreadable', { agentType }); }
  process.stdout.write(`status=${report.status} kind=${report.kind} tool=${report.toolName} spawns=${report.spawns} denials=${report.denials}\n`);
  return 0;
}

module.exports = { DENIAL_KINDS, NATIVE_SCHEMA_SOURCE_BUILD, REVIEWER_AGENT_TYPE, MAX_TAIL_BYTES, MAX_LINES, readOnlyFlags, scanEvents, scanTranscript, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
