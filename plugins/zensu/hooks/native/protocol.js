'use strict';

// Validate the Copilot hook contract without translating to another host.
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_PATCH_FILES = 1000;
const MAX_SEARCH_ROOTS = 1000;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim() !== '';
const safeIdentity = value => nonempty(value) && value.length <= 4096 && !/[\0\r\n]/.test(value);
const EVENT_NAMES = new Set(['sessionStart', 'sessionEnd', 'preToolUse', 'postToolUse', 'postToolUseFailure',
  'agentStop', 'subagentStart', 'subagentStop', 'userPromptSubmitted', 'userPromptTransformed', 'preCompact']);
const LEGACY_FIELDS = ['hook_event_name', 'session_id', 'transcript_path', 'tool_name', 'tool_input',
  'tool_response', 'tool_result', 'agent_id', 'agent_type', 'agent_name', 'parent_agent_id',
  'last_assistant_message'];
const LEGACY_TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent',
  'Grep', 'Glob', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'TodoWrite', 'ExitPlanMode', 'Skill']);
const AGENT_NAMES = ['code-reviewer', 'review-aspect', 'review-judge',
  'plan-review-worker', 'pr-review-worker', 'zensu-plm'];
const AGENT_ALIASES = new Map();
for (const name of AGENT_NAMES) {
  for (const alias of [name, `zensu:${name}`]) AGENT_ALIASES.set(alias, `zensu:${name}`);
}

function canonicalAgent(value) {
  return typeof value === 'string' ? AGENT_ALIASES.get(value) || value : value;
}

function readArgs(value, errors) {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > MAX_INPUT_BYTES) {
      errors.push('tool-arguments-too-large');
      return {};
    }
    try { value = JSON.parse(value); } catch {
      errors.push('tool-arguments-invalid-json');
      return {};
    }
  }
  if (!object(value)) {
    errors.push('tool-arguments-not-object');
    return {};
  }
  return { ...value };
}

function field(input, names, errors, label, required = false) {
  const present = names.filter(name => own(input, name));
  if (!present.length) {
    if (required) errors.push(`${label}-missing`);
    return undefined;
  }
  const value = input[present[0]];
  if (present.some(name => input[name] !== value)) errors.push(`${label}-conflicting-aliases`);
  if (typeof value !== 'string') {
    errors.push(`${label}-not-string`);
    return undefined;
  }
  return value;
}

function pathField(input, errors) {
  const value = field(input, ['path'], errors, 'file-path', true);
  if (typeof value === 'string' && (!value.trim() || /[\0\r\n]/.test(value))) errors.push('file-path-unsafe');
  return value;
}

// Parse only the explicit apply_patch grammar. A diff we cannot account for is
// rejected before policy evaluation can mistake it for a harmless read.
function patchCalls(patch, errors) {
  if (typeof patch !== 'string' || Buffer.byteLength(patch) > MAX_INPUT_BYTES) {
    errors.push('patch-missing-or-too-large');
    return [];
  }
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  while (lines[lines.length - 1] === '') lines.pop();
  if (lines[0] !== '*** Begin Patch' || lines[lines.length - 1] !== '*** End Patch') {
    errors.push('unsupported-patch-format');
    return [];
  }
  const calls = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    if (!safeIdentity(current.path)) errors.push('patch-path-unsafe');
    // The native parser trims header paths. Reject ambiguous spellings rather
    // than authorize a different relative path from the one Copilot will edit.
    if (current.path.trim() !== current.path) errors.push('patch-path-surrounding-whitespace');
    if (current.operation === 'update' && !current.hasChanges) errors.push('patch-update-content-missing');
    const added = current.added.join('\n');
    const input = { path: current.path, new_str: added, old_str: current.removed.join('\n'),
      patch, operation: current.operation };
    if (current.operation === 'add') input.content = added;
    calls.push({ toolName: current.operation === 'add' ? 'create' : 'edit', toolArgs: input });
    if (current.destination !== undefined) {
      if (!safeIdentity(current.destination)) errors.push('patch-move-path-unsafe');
      if (current.destination.trim() !== current.destination) errors.push('patch-move-path-surrounding-whitespace');
      calls.push({ toolName: 'edit', toolArgs: { ...input, path: current.destination,
        sourcePath: current.path, operation: 'move-destination' } });
    }
  };
  for (const line of lines.slice(1, -1)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      finish();
      current = { path: header[2], operation: header[1].toLowerCase(), added: [], removed: [], hasHunk: false, hasChanges: false };
      if (calls.length >= MAX_PATCH_FILES) { errors.push('patch-too-many-files'); return []; }
      continue;
    }
    if (!current) { errors.push('patch-content-before-file'); continue; }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move) {
      if (current.operation !== 'update' || current.destination !== undefined || current.hasHunk) errors.push('patch-invalid-move');
      current.destination = move[1];
    } else if (current.operation === 'delete') {
      errors.push('patch-delete-has-content');
    } else if (current.operation === 'add') {
      if (!line.startsWith('+')) errors.push('patch-invalid-add-line');
      else current.added.push(line.slice(1));
    } else if (/^@@(?: |$)/.test(line)) {
      current.hasHunk = true;
    } else if (line === '*** End of File') {
      if (!current.hasHunk) errors.push('patch-eof-without-hunk');
    } else if (!/^[ +\-]/.test(line)) {
      errors.push('patch-invalid-update-line');
    } else {
      // The installed native parser accepts a first change chunk without @@.
      // Track content separately so an empty @@ header is still rejected.
      current.hasHunk = true;
      current.hasChanges = true;
      if (line.startsWith('+')) current.added.push(line.slice(1));
      else if (line.startsWith('-')) current.removed.push(line.slice(1));
    }
  }
  finish();
  if (!calls.length) errors.push('patch-empty');
  return calls;
}

// Copilot 1.0.98 uses `paths`: one directory string or an array. Each policy
// check receives one native search root; the original arguments remain intact.
function searchCalls(name, input, errors) {
  field(input, ['pattern'], errors, 'search-pattern', true);
  for (const alias of ['path', 'file_path', 'filePath', 'files', 'directory', 'root', 'cwd', 'workdir']) {
    if (own(input, alias)) errors.push('unsupported-search-root-field');
  }
  const supplied = own(input, 'paths') ? input.paths : '.';
  const roots = typeof supplied === 'string' ? [supplied] : Array.isArray(supplied) ? supplied : [];
  if (!roots.length || roots.length > MAX_SEARCH_ROOTS) errors.push('search-roots-empty-invalid-or-too-many');
  if (roots.some(value => !safeIdentity(value))) errors.push('search-root-unsafe');
  return [...new Set(roots.filter(safeIdentity))].map(root => ({ toolName: name, toolArgs: { ...input, paths: [root] } }));
}

function normalizeTool(name, rawArgs) {
  const errors = [];
  const input = name === 'apply_patch' && typeof rawArgs === 'string' && rawArgs.startsWith('*** Begin Patch')
    ? { patch: rawArgs } : readArgs(rawArgs, errors);
  let calls = [];
  if (!nonempty(name)) errors.push('tool-name-missing');
  if (LEGACY_TOOLS.has(name)) errors.push('unsupported-host-tool');
  for (const key of ['file_path', 'new_string', 'old_string', 'subagent_type']) {
    if (own(input, key)) errors.push('unsupported-tool-argument');
  }
  if (name === 'lsp') {
    const readOnly = ['goToDefinition', 'findReferences', 'hover', 'documentSymbol', 'workspaceSymbol', 'goToImplementation', 'incomingCalls', 'outgoingCalls'];
    if (!readOnly.includes(input.operation)) errors.push('lsp-mutating-or-unknown-operation');
  } else if (['run_dynamic_workflow', 'dynamic_workflows_manage'].includes(name)) {
    errors.push('unaccounted-workflow-execution');
  } else if (name === 'powershell') {
    errors.push('powershell-policy-parser-unavailable');
  } else if (name === 'bash') {
    field(input, ['command'], errors, 'command', true);
  } else if (['grep', 'glob', 'rg'].includes(name)) {
    calls = searchCalls(name, input, errors);
  } else if (name === 'apply_patch') {
    const patch = field(input, ['patch', 'input'], errors, 'patch', true);
    calls = patchCalls(patch, errors);
  } else if (['view', 'create', 'edit'].includes(name)) {
    pathField(input, errors);
    if (name === 'create') field(input, ['content'], errors, 'write-content', true);
    if (name === 'edit') {
      field(input, ['new_str'], errors, 'edit-content', true);
      field(input, ['old_str'], errors, 'edit-old-content', true);
    }
  } else if (name === 'task') {
    const type = field(input, ['agent_type'], errors, 'task-agent-type', true);
    if (type !== undefined) input.agent_type = canonicalAgent(type);
    field(input, ['prompt'], errors, 'task-prompt', true);
  } else if (/(?:write|edit|patch|create|delete|remove|move|rename|replace|insert|execute|shell)/i.test(String(name))) {
    errors.push('unsupported-mutating-tool');
  }
  if (!calls.length) calls.push({ toolName: name, toolArgs: input });
  return { toolName: name, toolArgs: input, toolCalls: calls,
    toolChanges: calls.filter(call => ['edit', 'create'].includes(call.toolName))
      .map(call => ({ operation: call.toolArgs.operation || call.toolName, ...call.toolArgs })),
    normalizationErrors: [...new Set(errors)] };
}

function normalizeResult(toolName, input, supplied, failed = false) {
  const result = object(supplied) ? supplied : {};
  const resultType = result.resultType;
  const text = result.textResultForLlm;
  const failure = failed || ['failure', 'denied', 'rejected', 'cancelled'].includes(resultType);
  let status = failure ? 'error' : result.status === 'async_launched' ? 'async_launched'
    : result.status === 'completed' ? 'completed' : 'unknown';
  const response = { ...result, resultType };
  if (toolName === 'task') {
    // Native success means task dispatch succeeded. Only explicit synchronous
    // execution establishes that the returned report is a completed review.
    if (!failure && status !== 'async_launched') status = input.mode === 'sync' && resultType === 'success' ? 'completed' : 'unknown';
  } else if (toolName === 'bash') {
    // Copilot 1.0.98 appends this host footer to the combined shell output. A
    // quoted marker, stderr-only field, or absent footer cannot prove exit 0.
    const footer = typeof text === 'string' ? /(?:^|\r?\n)<shellId: ([0-9]+) completed with exit code ([0-9]{1,3})>(?:\r?\n)?$/.exec(text) : null;
    delete response.exit_code;
    delete response.exitCode;
    delete response.stdout;
    if (footer && resultType === 'success' && !failed) {
      response.exitCode = Number(footer[2]);
      response.stdout = text.slice(0, footer.index);
      response.shellId = footer[1];
      response.outputStreams = 'combined';
      status = response.exitCode === 0 ? 'completed' : 'error';
    } else if (!failure) status = 'unknown';
  }
  return { ...response, status };
}

function normalizeEvent(eventName, raw) {
  const errors = [];
  if (!object(raw)) { errors.push('event-not-object'); raw = {}; }
  if (!EVENT_NAMES.has(eventName)) errors.push('unsupported-event');
  for (const key of LEGACY_FIELDS) if (own(raw, key)) errors.push('unsupported-event-field');
  // Copilot's shell-hook wire contract uses this exact snake-case field. The
  // SDK's deserializeHookInput renames it to stopHookActive for SDK handlers;
  // shell hooks must retain the wire field, including false on the first stop.
  if (own(raw, 'stop_hook_active')) {
    if (!['agentStop', 'subagentStop'].includes(eventName)) errors.push('stop-recursion-field-on-non-stop-event');
    if (typeof raw.stop_hook_active !== 'boolean') errors.push('stop-hook-active-not-boolean');
  }
  if (!safeIdentity(raw.sessionId)) errors.push('session-id-missing-or-unsafe');
  if (!safeIdentity(raw.cwd)) errors.push('cwd-missing-or-unsafe');
  const payload = { ...raw, eventName, normalizationErrors: errors };
  if (own(payload, 'agentType')) payload.agentType = canonicalAgent(payload.agentType);
  else if (own(payload, 'agentName')) payload.agentType = canonicalAgent(payload.agentName);
  // Partial child identity stays a child. A missing classifier cannot promote a
  // native child to the main agent, even on a tool event with sparse metadata.
  const child = eventName.startsWith('subagent') || ['agentId', 'agentName', 'parentAgentId', 'agentType'].some(key => own(payload, key));
  payload.isChild = child;
  if (child && !own(payload, 'agentType')) payload.agentType = 'copilot:unclassified';
  if (own(payload, 'agentId') && !safeIdentity(payload.agentId)) errors.push('agent-id-invalid');
  if (own(payload, 'agentType') && !safeIdentity(payload.agentType)) errors.push('agent-type-invalid');
  if (child && !safeIdentity(payload.agentId)) errors.push('subagent-correlation-id-missing');
  if (['preToolUse', 'postToolUse', 'postToolUseFailure'].includes(eventName)) {
    const tool = normalizeTool(raw.toolName, raw.toolArgs);
    for (const key of ['toolName', 'toolArgs', 'toolCalls', 'toolChanges']) payload[key] = tool[key];
    errors.push(...tool.normalizationErrors);
    if (eventName !== 'preToolUse') {
      payload.toolResult = normalizeResult(payload.toolName, payload.toolArgs, raw.toolResult, eventName === 'postToolUseFailure');
      if (own(raw, 'error')) payload.toolResult.error = raw.error;
      payload.toolOutcome = payload.toolResult.status;
      // Only the dispatcher's exact native human-response receipt may approve
      // a plan. Even structured transport success is not human authorization.
      if (payload.toolName === 'exit_plan_mode') payload.planApproved = false;
    }
  }
  payload.normalizationErrors = [...new Set(errors)];
  return payload;
}

function normalizeOutput(eventName, results, raw = {}) {
  const contexts = [];
  const reasons = [];
  const decisions = [];
  const blocks = [];
  let modifiedResult;
  let modifiedResponse;
  let modifiedArgs;
  let invalidOutput = false;
  const append = value => { if (typeof value === 'string' && value.trim()) contexts.push(value); };
  for (let value of Array.isArray(results) ? results : [results]) {
    if (value == null || value === '') continue;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { invalidOutput = true; continue; }
    }
    if (!object(value) || own(value, 'hookSpecificOutput') || own(value, 'systemMessage')) {
      invalidOutput = true;
      continue;
    }
    append(value.additionalContext);
    if (['allow', 'ask', 'deny'].includes(value.permissionDecision)) {
      decisions.push(value.permissionDecision);
      if (nonempty(value.permissionDecisionReason)) reasons.push(value.permissionDecisionReason);
    } else if (own(value, 'permissionDecision')) invalidOutput = true;
    if (value.decision === 'block' && nonempty(value.reason)) blocks.push(value.reason);
    if (object(value.modifiedResult)) modifiedResult = value.modifiedResult;
    if (object(value.modifiedArgs)) modifiedArgs = value.modifiedArgs;
    if (typeof value.modifiedResponse === 'string') modifiedResponse = value.modifiedResponse;
  }
  if (invalidOutput) {
    const reason = 'A Zensu policy handler returned invalid native output; the operation was not approved.';
    if (eventName === 'preToolUse') return { permissionDecision: 'deny', permissionDecisionReason: reason };
    if (['agentStop', 'subagentStop'].includes(eventName)) return { decision: 'block', reason };
    append(reason);
  }
  const context = contexts.join('\n\n');
  if (eventName === 'userPromptTransformed') {
    const transformed = typeof raw.transformedPrompt === 'string' ? raw.transformedPrompt : '';
    return context && transformed ? { modifiedTransformedPrompt: `${transformed}\n\n${context}` } : {};
  }
  if (['userPromptSubmitted', 'preCompact', 'sessionEnd'].includes(eventName)) return {};
  if (eventName === 'preToolUse') {
    const decision = decisions.includes('deny') ? 'deny' : decisions.includes('ask') ? 'ask'
      : decisions.includes('allow') ? 'allow' : undefined;
    const output = {};
    if (decision) {
      output.permissionDecision = decision;
      if (reasons.length) output.permissionDecisionReason = [...new Set(reasons)].join('\n\n');
      else if (decision === 'deny') output.permissionDecisionReason = 'Zensu policy denied this operation.';
    }
    if (modifiedArgs && decision !== 'deny') output.modifiedArgs = modifiedArgs;
    return output;
  }
  if (eventName === 'agentStop' || eventName === 'subagentStop') {
    if (blocks.length) return { decision: 'block', reason: [...new Set(blocks)].join('\n\n') };
    return eventName === 'subagentStop' && modifiedResponse !== undefined ? { modifiedResponse } : {};
  }
  const output = context ? { additionalContext: context } : {};
  if (eventName === 'postToolUse' && modifiedResult) output.modifiedResult = modifiedResult;
  return output;
}

module.exports = { normalizeEvent, normalizeTool, normalizeResult, normalizeOutput, canonicalAgent, EVENT_NAMES, MAX_INPUT_BYTES };
