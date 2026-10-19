// Native Copilot session observations. Host records are read-only and untrusted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

export const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MAX_RECORD = 256 * 1024;
const MAX_TRANSCRIPT = 16 * 1024 * 1024;
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const flat = (value, max = 500) => typeof value === 'string'
  ? value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').trim().slice(0, max) : null;
export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function canonical(value) {
  try { return fs.realpathSync.native(value); } catch { return path.resolve(value); }
}
export function safePath(root, candidate) {
  if (!within(root, candidate)) throw new Error('path escapes the configured store');
  let current = root;
  for (const segment of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symlink in session store'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return candidate;
}
export function readRegular(root, file, limit = MAX_RECORD) {
  safePath(root, file);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const fd = fs.openSync(file, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('session record is not a regular file');
    if (stat.size > limit) throw new Error(`session record exceeds ${limit} bytes`);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    return {text: buffer.subarray(0, offset).toString('utf8'), stat};
  } finally { fs.closeSync(fd); }
}
export function readTranscript(root, file) {
  safePath(root, file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('session transcript is not a regular file');
    const chunk = (start, length) => {
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const count = fs.readSync(fd, buffer, offset, length - offset, start + offset);
        if (!count) break;
        offset += count;
      }
      return buffer.subarray(0, offset).toString('utf8');
    };
    if (stat.size <= MAX_TRANSCRIPT) return {text: chunk(0, stat.size), stat, truncated: false};
    const head = chunk(0, 256 * 1024);
    const tail = chunk(stat.size - 1024 * 1024, 1024 * 1024);
    const headEnd = head.lastIndexOf('\n');
    const tailStart = tail.indexOf('\n');
    return {text: `${headEnd < 0 ? '' : head.slice(0, headEnd)}\n${tailStart < 0 ? '' : tail.slice(tailStart + 1)}`, stat, truncated: true};
  } finally { fs.closeSync(fd); }
}
export function atomicJson(root, file, value) {
  safePath(root, file);
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  safePath(root, file);
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx', mode: 0o600});
    safePath(root, file);
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
const validTime = value => {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
};
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
// workspace.yaml is authored by Copilot. Read only its simple top-level scalar
// metadata; do not evaluate YAML tags, aliases or arbitrary nested structures.
export function parseWorkspace(text) {
  const out = {};
  const wanted = new Set(['id', 'cwd', 'git_root', 'repository', 'branch', 'name', 'created_at', 'updated_at']);
  for (const line of text.split('\n')) {
    const match = /^([a-z_]+):(?:\s+(.*))?$/.exec(line);
    if (!match || !wanted.has(match[1])) continue;
    const key = match[1];
    if (Object.hasOwn(out, key)) throw new Error(`duplicate workspace metadata key: ${key}`);
    const raw = (match[2] || '').trim();
    let value;
    if (raw.startsWith('"')) {
      try { value = JSON.parse(raw); } catch { throw new Error(`unsupported quoted workspace scalar: ${key}`); }
    } else if (raw.startsWith("'")) {
      if (!raw.endsWith("'") || raw.length < 2) throw new Error(`unsupported quoted workspace scalar: ${key}`);
      value = raw.slice(1, -1).replaceAll("''", "'");
    } else {
      if (/^[!&*|>\[{]/.test(raw)) throw new Error(`unsupported workspace scalar: ${key}`);
      value = raw.replace(/\s+#.*$/, '');
    }
    out[key] = typeof value === 'string' && value && !['null', '~'].includes(value) ? value : null;
  }
  return out;
}
function content(data) {
  return typeof data.content === 'string' ? data.content : null;
}
const mainEvent = event => !Object.hasOwn(event, 'agentId') && !Object.hasOwn(event.data || {}, 'ownerAgentId')
  && !event.data?.parentToolCallId && !event.data?.parentAgentTaskId;

// These are observations, not authority for the current session. Only an
// executed call and its exact completion can establish a saved checklist.
// Concurrent calls are ordered by completion, never by a guessed launch pair.
export function projectProgress(events) {
  const diagnostics = [];
  const note = message => { if (diagnostics.length < 50) diagnostics.push(message); };
  const idCounts = new Map();
  for (const event of events) if (typeof event.id === 'string') idCounts.set(event.id, (idCounts.get(event.id) || 0) + 1);
  const starts = new Map(), completions = new Map(), responses = new Map();
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\p{Cc}\p{Cf}]/u.test(value);
  const keyOf = event => {
    const callId = event.data?.toolCallId;
    if (!validId(callId) || Object.hasOwn(event, 'agentId') && !validId(event.agentId)
      || !Object.hasOwn(event, 'agentId') && !mainEvent(event)) return null;
    return `${event.agentId || ''}\0${callId}`;
  };
  const add = (map, key, value) => map.set(key, [...(map.get(key) || []), value]);
  for (const [index, event] of events.entries()) {
    if (!['tool.execution_start', 'tool.execution_complete', 'human_response.recorded'].includes(event.type)) continue;
    if (typeof event.id === 'string' && idCounts.get(event.id) !== 1) { note(`duplicate-event:${event.id}`); continue; }
    const key = keyOf(event);
    if (!key) { note(`missing-progress-call-identity:${event.type}`); continue; }
    const row = {event, index};
    add(event.type === 'tool.execution_start' ? starts : event.type === 'tool.execution_complete' ? completions : responses, key, row);
  }
  const checklistCandidates = [], planCandidates = [], taskRuns = [];
  for (const [key, rows] of starts) {
    const relevant = rows.some(row => ['update_todo', 'task', 'exit_plan_mode'].includes(row.event.data?.toolName));
    if (!relevant) continue;
    if (rows.length !== 1) { note(`ambiguous-progress-call:${rows[0].event.data.toolCallId}`); continue; }
    const start = rows[0], data = start.event.data, args = object(data.arguments);
    const finishes = completions.get(key) || [];
    const complete = finishes.length === 1 && finishes[0].index > start.index ? finishes[0] : null;
    if (finishes.length > 1) note(`ambiguous-progress-completion:${data.toolCallId}`);
    if (finishes.length === 1 && !complete) note(`progress-completion-before-start:${data.toolCallId}`);
    const outcome = complete?.event.data;
    const successful = outcome?.success === true && !Object.hasOwn(outcome, 'error');
    const provenance = {toolCallId: data.toolCallId, callEventId: start.event.id || null,
      completionEventId: complete?.event.id || null, at: complete?.event.timestamp || start.event.timestamp || null};
    if (data.toolName === 'task') {
      const state = !complete ? finishes.length ? 'unknown' : 'pending'
        : outcome.success === false || outcome.error ? 'failed'
          : successful ? args.mode === 'sync' ? 'completed' : 'dispatched' : 'unknown';
      taskRuns.push({...provenance, ownerAgentId: start.event.agentId || null,
        name: flat(args.name, 200), description: flat(args.description, 1000),
        agentType: flat(args.agent_type, 200), mode: flat(args.mode, 50), state,
        error: outcome?.error ? flat(typeof outcome.error === 'string' ? outcome.error : outcome.error.message, 1000) : null});
      continue;
    }
    // Child-agent checklists and plan decisions never replace the main session's.
    if (!mainEvent(start.event)) continue;
    if (data.toolName === 'update_todo' && successful && typeof args.todos === 'string') {
      const todos = args.todos.slice(0, 64000);
      const items = [];
      for (const line of todos.split(/\r?\n/)) {
        const item = /^\s*(?:[-*+]\s+|\d+[.)]\s+)\[([ xX])\]\s*(.*)$/.exec(line);
        if (item && items.length < 1000) items.push({text: item[2], checked: item[1].toLowerCase() === 'x'});
      }
      checklistCandidates.push({index: complete.index, value: {...provenance,
        source: 'native-tool-completion', todos, items, truncated: todos.length !== args.todos.length,
        meaning: 'last observed successfully saved checklist; checkbox claims are not test or implementation evidence'}});
    }
    if (data.toolName === 'exit_plan_mode') {
      const answers = responses.get(key) || [];
      if (answers.length !== 1) { if (answers.length > 1) note(`ambiguous-plan-response:${data.toolCallId}`); continue; }
      const answer = answers[0], receipt = object(answer.event.data), response = object(receipt.response);
      if (answer.index <= start.index || complete && answer.index > complete.index) { note(`plan-response-outside-call:${data.toolCallId}`); continue; }
      if (receipt.actor !== 'human_response' || response.responseKind !== 'exit_plan_mode' || !validId(receipt.requestId)) continue;
      const fullContent = typeof response.planContent === 'string' ? response.planContent : null;
      const approved = response.approved === true && fullContent !== null && fullContent.trim() !== ''
        && ['interactive', 'autopilot', 'autopilot_fleet'].includes(response.selectedAction);
      const reference = [response.planFilePath, response.filePath].find(value => typeof value === 'string' && path.isAbsolute(value));
      planCandidates.push({index: answer.index, value: {...provenance, source: 'native-human-response',
        at: answer.event.timestamp || null, responseEventId: answer.event.id || null, requestId: receipt.requestId,
        summary: typeof args.summary === 'string' ? args.summary.slice(0, 16000) : null,
        content: fullContent === null ? null : fullContent.slice(0, 64000),
        contentSha256: fullContent === null ? null : hash(fullContent),
        truncated: (fullContent?.length || 0) > 64000 || (args.summary?.length || 0) > 16000,
        approval: approved ? 'recorded-human-approval' : response.approved === false || response.selectedAction === 'exit_only' ? 'not-approved' : 'unknown',
        selectedAction: flat(response.selectedAction, 100),
        reference: reference ? {path: reference, verification: 'recorded-reference-only; current file not inspected'} : null,
        meaning: 'historical native response; never authorization for this continuation'}});
    }
  }
  for (const [key] of responses) if (!starts.has(key)) note('unmatched-plan-response');
  const latest = candidates => candidates.sort((a, b) => a.index - b.index).at(-1)?.value || null;
  return {tasks: latest(checklistCandidates), plan: latest(planCandidates), taskRuns: taskRuns.slice(-100),
    progressDiagnostics: diagnostics};
}

// The supported shapes correspond to Copilot SDK session events; unknown event
// types stay unknown. In particular, no event.parentId is treated as a session ID:
// it is the preceding EVENT ID in the native append-only event chain.
export function normalizeEvents(text, sessionId) {
  const result = {cwd: null, cwdLast: null, branch: null, title: null, startedAt: null, lastActivity: null,
    lastPrompt: null, prompts: [], assistantTail: [], touched: [], tasks: null, compaction: null,
    mode: null, pr: null, stopCause: null, lastTurn: null, queue: {state: 'unknown', pending: null},
    withdrawnPrompts: {state: 'unavailable', rows: null}, linkedSessionIds: [], forkedFrom: null,
    malformedEvents: 0, unknownEventTypes: [], eventCount: 0, errors: [], lastRateLimit: null,
    lastSuccessfulTurn: null, transcriptSessionId: null, gitRoot: null, sourceMessages: 0, subagents: [],
    plan: null, taskRuns: [], progressDiagnostics: []};
  const unknown = new Set();
  const touched = new Set();
  const progressEvents = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { result.malformedEvents += 1; continue; }
    if (!event || typeof event.type !== 'string') { result.malformedEvents += 1; continue; }
    result.eventCount += 1;
    if (['tool.execution_start', 'tool.execution_complete', 'human_response.recorded'].includes(event.type)) progressEvents.push(event);
    const data = object(event.data);
    const at = validTime(event.timestamp);
    if (at !== null) result.lastActivity = Math.max(result.lastActivity || 0, at);
    if (!mainEvent(event) && ['user.message', 'assistant.message', 'assistant.turn_end', 'session.error'].includes(event.type)) continue;
    switch (event.type) {
      case 'session.start': {
        if (typeof data.sessionId === 'string') result.transcriptSessionId = data.sessionId;
        const context = object(data.context);
        if (typeof context.cwd === 'string' && path.isAbsolute(context.cwd)) result.cwd = context.cwd;
        if (typeof context.gitRoot === 'string' && path.isAbsolute(context.gitRoot)) result.gitRoot = context.gitRoot;
        result.branch = flat(context.branch);
        result.startedAt = at;
        if (ID.test(data.detachedFromSpawningParentSessionId || '')) result.forkedFrom = data.detachedFromSpawningParentSessionId;
        break;
      }
      case 'session.resume': {
        const context = object(data.context);
        if (typeof context.cwd === 'string' && path.isAbsolute(context.cwd)) result.cwdLast = context.cwd;
        break;
      }
      case 'session.context_changed':
        if (typeof data.cwd === 'string' && path.isAbsolute(data.cwd)) result.cwdLast = data.cwd;
        break;
      case 'session.title_changed': result.title = flat(data.title); break;
      case 'user.message': {
        if (Object.hasOwn(data, 'source') || Object.hasOwn(data, 'isAutopilotContinuation') && data.isAutopilotContinuation !== false) { result.sourceMessages += 1; break; }
        const value = content(data);
        if (value !== null) {
          result.lastPrompt = value.slice(0, 16000);
          result.prompts.push({text: value.slice(0, 16000), at: at === null ? null : new Date(at).toISOString()});
          if (result.prompts.length > 200) result.prompts.shift();
        }
        result.lastTurn = {role: 'user', at};
        break;
      }
      case 'assistant.message': {
        const value = content(data);
        if (value !== null) result.assistantTail.push(value.slice(0, 16000));
        if (result.assistantTail.length > 3) result.assistantTail.shift();
        result.lastTurn = {role: 'assistant', at};
        break;
      }
      case 'assistant.turn_end': result.lastSuccessfulTurn = at; result.lastTurn = {role: 'completed', at}; break;
      case 'session.idle': result.lastTurn = {role: 'idle', at}; break;
      case 'session.shutdown': result.stopCause = {kind: 'shutdown', at}; break;
      case 'session.error': {
        const message = flat(data.message, 4000);
        const error = {at, type: flat(data.errorType), code: flat(data.errorCode), message};
        result.errors.push(error);
        if (result.errors.length > 20) result.errors.shift();
        const structuredLimit = ['rate_limit', 'quota'].includes(data.errorType) || data.statusCode === 429;
        const rateLimited = structuredLimit || /rate.?limit|quota|too many requests|429/i.test(`${error.code || ''} ${message || ''}`);
        if (rateLimited) result.lastRateLimit = {...error, classification: structuredLimit ? 'structured' : 'message-derived'};
        result.stopCause = {kind: rateLimited ? 'rate-limit' : 'error', ...error};
        break;
      }
      case 'session.compaction_complete': result.compaction = flat(data.summaryContent, 8000); break;
      case 'subagent.started':
        result.subagents.push({id: flat(event.agentId || data.toolCallId, 128), name: flat(data.agentName), resumable: data.resumable === true});
        if (result.subagents.length > 100) result.subagents.shift();
        break;
      case 'tool.execution_start': {
        // File tools expose their target in arguments; shell commands are never
        // parsed as a reliable file-touch inventory.
        if (['edit', 'create', 'apply_patch'].includes(data.toolName)) {
          const args = object(data.arguments);
          const target = args.path;
          if (typeof target === 'string' && touched.size < 100) touched.add(flat(target, 4096));
        }
        break;
      }
      case 'session.info':
      case 'assistant.turn_start':
      case 'assistant.message_delta':
      case 'assistant.reasoning':
      case 'assistant.reasoning_delta':
      case 'assistant.usage':
      case 'tool.execution_complete':
      case 'human_response.recorded':
      case 'tool.execution_progress':
      case 'session.model_change':
      case 'session.usage_info':
      case 'session.compaction_start':
      case 'session.truncation': break;
      default: if (unknown.size < 50) unknown.add(flat(event.type, 100));
    }
  }
  if (result.transcriptSessionId && result.transcriptSessionId !== sessionId) throw new Error('transcript session identity does not match its directory');
  result.unknownEventTypes = [...unknown];
  result.touched = [...touched];
  Object.assign(result, projectProgress(progressEvents));
  return result;
}

export function git(cwd, args) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const run = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'diff.autoRefreshIndex=false', ...args],
    {cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, env: {...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0'}});
  return run.status === 0 ? run.stdout.trim() : null;
}
export function gitState(cwd) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = git(root, ['status', '--porcelain']);
  const remoteBase = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const base = remoteBase?.replace('refs/remotes/', '') || null;
  const counts = base ? git(root, ['rev-list', '--left-right', '--count', `${base}...HEAD`])?.split(/\s+/).map(Number) : null;
  return {root, branch, head: git(root, ['rev-parse', 'HEAD']), base,
    ahead: counts?.[1] ?? null, behind: counts?.[0] ?? null,
    dirty: status === null ? null : status.split('\n').filter(Boolean).length,
    dirtyFiles: status === null ? null : status.split('\n').filter(Boolean).slice(0, 100).map(value => flat(value, 4096))};
}
export function processObservation(record, now = Date.now()) {
  if (record.status === 'ended') return {state: 'ended', reason: 'registry-ended'};
  if (!Number.isInteger(record.pid) || record.pid <= 0) return {state: 'unknown', reason: 'invalid-pid'};
  try { process.kill(record.pid, 0); }
  catch (error) {
    return error.code === 'ESRCH' ? {state: 'ended', reason: 'process-gone'} : {state: 'unknown', reason: 'process-probe-denied'};
  }
  const updated = validTime(record.updatedAt);
  if (updated === null || updated > now + 60000) return {state: 'unknown', reason: 'invalid-registry-time'};
  if (record.processStart) {
    const start = spawnSync('ps', ['-p', String(record.pid), '-o', 'lstart='], {encoding: 'utf8', timeout: 2000});
    if (start.status !== 0) return {state: 'unknown', reason: 'process-start-unavailable'};
    if (start.stdout.trim() !== String(record.processStart).trim()) return {state: 'ended', reason: 'process-reused'};
    return {state: 'active', reason: 'process-start-matched'};
  }
  return {state: 'unknown', reason: 'pid-alive-without-start-identity'};
}

export function createProvider({env = process.env, configDir, now = Date.now(), observeProcess = processObservation} = {}) {
  const home = canonical(configDir || env.COPILOT_HOME || path.join(os.homedir(), '.copilot'));
  const data = canonical(env.COPILOT_PLUGIN_DATA || path.join(home, 'zensu', 'plugin-data'));
  const sessions = path.join(home, 'session-state');
  const registry = path.join(data, 'copilot-sessions');
  const selfId = env.COPILOT_SESSION_ID || env.ZENSU_COPILOT_SESSION_ID || null;
  const diagnostics = [];
  let snapshot;
  function list() {
    if (snapshot) return snapshot;
    const records = new Map();
    const childIds = new Set();
    let registryAvailable = false;
    try {
      safePath(data, registry);
      const inventory = fs.readdirSync(registry);
      if (inventory.length > 20000) diagnostics.push({source: 'registry', error: 'inventory-truncated-at-20000'});
      const files = inventory.sort().slice(0, 20000);
      registryAvailable = true;
      for (const file of files) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
        try {
          const record = JSON.parse(readRegular(data, path.join(registry, file)).text);
          if (record.schemaVersion !== 1 || !ID.test(record.sessionId || '') || hash(record.sessionId) + '.json' !== file
              || !['active', 'ended'].includes(record.status)) throw new Error('invalid registry identity or schema');
          if (record.rootSessionId && record.rootSessionId !== record.sessionId) {
            if (!ID.test(record.rootSessionId)) throw new Error('invalid root session identity');
            childIds.add(record.sessionId);
            continue;
          }
          records.set(record.sessionId, record);
        } catch (error) { diagnostics.push({source: 'registry', file, error: flat(error.message)}); }
      }
    } catch (error) { diagnostics.push({source: 'registry', error: error.code === 'ENOENT' ? 'unavailable' : flat(error.message)}); }
    const ids = new Set(records.keys());
    try {
      safePath(home, sessions);
      const inventory = fs.readdirSync(sessions);
      if (inventory.length > 20000) diagnostics.push({source: 'sessions', error: 'inventory-truncated-at-20000'});
      for (const name of inventory.sort().slice(0, 20000)) if (ID.test(name)) ids.add(name);
    } catch (error) { diagnostics.push({source: 'sessions', error: error.code === 'ENOENT' ? 'unavailable' : flat(error.message)}); }
    const rows = [];
    for (const sessionId of ids) {
      if (childIds.has(sessionId)) continue;
      const record = records.get(sessionId);
      const transcript = path.join(sessions, sessionId, 'events.jsonl');
      let summary = normalizeEvents('', sessionId);
      let stat = null;
      let transcriptError = null;
      let transcriptTruncated = false;
      let workspace = {};
      try {
        workspace = parseWorkspace(readRegular(home, path.join(sessions, sessionId, 'workspace.yaml')).text);
        if (workspace.id && workspace.id !== sessionId) throw new Error('workspace identity does not match its directory');
      } catch (error) {
        workspace = {};
        if (error.code !== 'ENOENT') diagnostics.push({source: 'workspace', sessionId, error: flat(error.message)});
      }
      try {
        const read = readTranscript(home, transcript);
        summary = normalizeEvents(read.text, sessionId);
        stat = read.stat;
        transcriptTruncated = read.truncated;
      } catch (error) {
        transcriptError = error.code === 'ENOENT' ? 'unavailable' : flat(error.message);
        diagnostics.push({source: 'transcript', sessionId, error: transcriptError});
      }
      const workspaceCwd = typeof workspace.cwd === 'string' && path.isAbsolute(workspace.cwd) ? workspace.cwd : null;
      const cwd = summary.cwdLast || workspaceCwd || summary.cwd || (typeof record?.cwd === 'string' && path.isAbsolute(record.cwd) ? record.cwd : null);
      const liveness = record ? observeProcess(record, now) : {state: 'unknown', reason: registryAvailable ? 'not-registered' : 'registry-unavailable'};
      const activity = summary.lastActivity || validTime(record?.updatedAt) || stat?.mtimeMs || null;
      rows.push({...summary, title: flat(workspace.name) || summary.title, branch: flat(workspace.branch) || summary.branch,
        sessionId, provider: 'copilot', transcript, transcriptError,
        truncated: transcriptTruncated || transcriptError !== null || summary.malformedEvents > 0, size: stat?.size ?? null,
        mtime: stat?.mtimeMs ?? null, cwd, wt: cwd, cwdExists: !!cwd && fs.existsSync(cwd),
        lastActivity: activity === null ? null : new Date(activity).toISOString(),
        registry: record ? {pid: record.pid, status: record.status, startedAt: record.startedAt, updatedAt: record.updatedAt} : null,
        live: liveness.state === 'active' ? {pid: record.pid, sessionId, cwd} : null, liveness,
        metadata: {account: 'unavailable', window: 'not-applicable', taskChips: 'not-applicable', linkedSessions: 'unavailable'}});
    }
    snapshot = rows.sort((a, b) => (Date.parse(b.lastActivity) || 0) - (Date.parse(a.lastActivity) || 0));
    return snapshot;
  }
  function resolve(selector, rows = list()) {
    if (typeof selector !== 'string' || !selector.trim()) throw new Error('a session selector is required');
    const exact = rows.filter(row => row.sessionId === selector);
    const matches = exact.length ? exact : rows.filter(row => selector.length >= 6 && row.sessionId.startsWith(selector));
    if (matches.length !== 1) throw new Error(matches.length ? 'session selector is ambiguous' : 'session not found; use list --all');
    return matches[0];
  }
  function self() {
    if (!selfId || !ID.test(selfId)) throw new Error('current Copilot session identity is unavailable; use takeover --no-record for a read-only brief');
    const row = list().find(item => item.sessionId === selfId);
    return {sessionId: selfId, accountUuid: null, appPid: null, pid: row?.registry?.pid ?? null,
      worktree: row?.cwd || null, branch: row?.branch || null};
  }
  return {home, data, sessions, registry, diagnostics, list, resolve, self,
    resume: row => `copilot --resume ${quote(row.sessionId)}`};
}
