#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const protocol = require('./protocol');
const nativeContext = require('./context');
const reviewGate = require('./review-gate');
const { readPlanApproval, readNavigationApproval } = require('./approval');

function matchingHooks(root, event, tool) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'hooks/registry.json'), 'utf8'));
  const entries = config[event] || [];
  if (!Array.isArray(entries)) throw new Error('Invalid native policy registry');
  return entries.filter(hook => !hook.matcher || new RegExp(`^(?:${hook.matcher})$`).test(tool || '')).map(hook => {
    if (typeof hook.script !== 'string' || !/^hooks\/[a-z0-9/-]+\.sh$/.test(hook.script)
      || hook.script.split('/').includes('..')) throw new Error('Unsafe native policy script');
    return { ...hook, script: path.join(root, hook.script), name: path.basename(hook.script) };
  });
}
function parseOutput(result, hook, event) {
  const stdout = String(result.stdout || '').trim();
  if (result.error || result.signal || result.status !== 0) {
    const reason = `Zensu ${hook.name}: ${String(result.stderr || result.error?.message || `exit ${result.status}`).trim().slice(0, 2000)}`;
    if (event === 'preToolUse') return { permissionDecision: 'deny', permissionDecisionReason: reason };
    if (event === 'agentStop' || event === 'subagentStop') return { decision: 'block', reason: `${reason}. The workflow is still pending; repair it before claiming completion.` };
    return { additionalContext: reason };
  }
  if (!stdout) return {};
  try { return JSON.parse(stdout); } catch {
    if (event === 'preToolUse') return { permissionDecision: 'deny', permissionDecisionReason: `Zensu ${hook.name} emitted invalid decision JSON` };
    throw new Error(`${hook.name} emitted invalid JSON`);
  }
}
function additional(output, text) {
  if (text) output.additionalContext = [output.additionalContext, text].filter(Boolean).join('\n\n');
  return output;
}
function dispatch(event, raw, options = {}) {
  const env = options.env || process.env;
  const root = options.root || path.resolve(__dirname, '../..');
  const context = nativeContext.resolveContext(raw, env, root);
  if (env.ZENSU_COPILOT_CAPTURE_DIR) {
    const capture = nativeContext.directory(env.ZENSU_COPILOT_CAPTURE_DIR, true);
    nativeContext.writePrivate(path.join(capture, `${Date.now()}-${process.pid}-${event}.json`), { event, payload: raw,
      environment: { pluginRoot: context.pluginRoot, pluginData: context.pluginData } });
  }
  const payload = protocol.normalizeEvent(event, raw);
  payload.nativeSessionId = payload.sessionId;
  payload.sessionId = context.sessionId;
  payload.transcriptPath = context.transcriptPath;
  if (context.nativeSessionId !== context.sessionId) {
    payload.isChild = true;
    if (!payload.agentId && context.agentRecord) {
      payload.agentId = context.nativeSessionId;
      payload.agentType = protocol.canonicalAgent(context.agentRecord.agentType) || 'copilot:unclassified';
      payload.parentAgentId = context.agentRecord.parentAgentId;
      payload.normalizationErrors = payload.normalizationErrors.filter(error => error !== 'subagent-correlation-id-missing');
    } else if (!payload.agentId) payload.normalizationErrors.push('unregistered-child-identity');
  }
  // This describes an output capability, not a guessed permission mode or an
  // approval. Copilot owns the ask decision and may refuse it non-interactively.
  payload.nativePermissionPrompt = true;
  if (payload.toolName === 'bash' && payload.toolArgs?.command) payload.toolArgs.command = nativeContext.unbindShell(payload.toolArgs.command);
  if (payload.normalizationErrors?.length) {
    const reason = `Zensu could not safely interpret ${event}: ${payload.normalizationErrors.join('; ')}`;
    if (event === 'preToolUse') return { permissionDecision: 'deny', permissionDecisionReason: reason };
    if (['agentStop', 'subagentStop'].includes(event)) return { decision: 'block', reason };
    return { additionalContext: reason };
  }
  nativeContext.observe(context, event, { agentId: payload.agentId, agentType: payload.agentType, isChild: payload.isChild });
  // Copilot emits prompt/stop events inside custom agents as well. They are not
  // new human instructions or completion of the main workflow.
  if (payload.isChild && ['userPromptSubmitted', 'userPromptTransformed', 'agentStop', 'sessionEnd'].includes(event)) return {};
  if (event === 'userPromptSubmitted') {
    const record = nativeContext.readPrivate(context.registryFile);
    nativeContext.writePrivate(context.registryFile, { ...record, lastUserPrompt: String(raw.prompt || '').slice(0, 64000) });
    return {};
  }
  if (event === 'preCompact') {
    const result = (options.spawnSync || spawnSync)('bash', [path.join(root, 'hooks/session-start-prompt-ledger.sh')], {
      input: JSON.stringify({ ...payload, eventName: 'sessionStart', source: 'compact' }), encoding: 'utf8',
      env: nativeContext.nativeEnv(context, env), cwd: context.cwd, timeout: 10000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error('Could not reset prompt ledger before compaction');
    return {};
  }
  if (event === 'postToolUseFailure') {
    const output = { additionalContext: 'Zensu: this tool failed. Do not record it as a successful test, completed reviewer, approved plan or acceptance observation.' };
    try { additional(output, reviewGate.postReview(context, payload, { env })); }
    catch (error) { additional(output, `Zensu review remains pending: ${error.message}`); }
    return output;
  }
  if (event === 'postToolUse' && payload.toolName === 'bash' && /playwright/i.test(payload.toolArgs.command)) {
    payload.nativePermissionApproved = Boolean(readNavigationApproval(context.transcriptPath, raw.toolArgs, payload.agentId));
  }
  if (event === 'postToolUse' && payload.toolName === 'exit_plan_mode') {
    const receipt = readPlanApproval(context.transcriptPath,
      typeof raw.toolArgs === 'string' ? JSON.parse(raw.toolArgs) : raw.toolArgs, payload.agentId);
    // Do not trust model text, tool payload flags, or automation to
    // stand in for the native human approval record.
    payload.planApproved = Boolean(receipt);
    if (receipt) payload.toolResult = { ...payload.toolResult, ...receipt };
  }
  let reviewDispatch = null;
  let reviewCompletion = null;
  if (event === 'preToolUse') {
    try {
      reviewDispatch = reviewGate.preReview(context, payload, { env });
      if (reviewDispatch?.modifiedArgs) {
        payload.toolArgs = reviewDispatch.modifiedArgs;
        payload.toolCalls = payload.toolCalls.map(call => ({ ...call, toolArgs: reviewDispatch.modifiedArgs }));
      }
    } catch (error) {
      return { permissionDecision: 'deny', permissionDecisionReason: `Zensu review gate: ${error.message}` };
    }
  }
  if (event === 'postToolUse') {
    try { reviewCompletion = reviewGate.postReview(context, payload, { env }); }
    catch (error) { return { additionalContext: `Zensu review remains pending: ${error.message}` }; }
  }
  const start = Date.now();
  const budget = event === 'preToolUse' ? 50000 : 35000;
  const results = [];
  let calls = [payload];
  if (payload.toolCalls?.length) calls = payload.toolCalls.map((call) => ({ ...payload, ...call }));
  for (const call of calls) {
    for (const hook of matchingHooks(root, event, call.toolName)) {
      if (hook.name === 'plan-approved-delegate.sh' && payload.planApproved !== true) continue;
      if (hook.name === 'post-review-tdd-delegate.sh' && payload.toolOutcome !== 'completed') continue;
      const remaining = budget - (Date.now() - start);
      if (remaining < 100) {
        if (event === 'preToolUse') return { permissionDecision: 'deny', permissionDecisionReason: 'Zensu internal hook deadline exceeded; retry after resolving the slow hook.' };
        throw new Error('Internal hook deadline exceeded; workflow remains pending');
      }
      const result = (options.spawnSync || spawnSync)('bash', [hook.script], {
        input: JSON.stringify(call), encoding: 'utf8',
        env: nativeContext.nativeEnv(context, env), cwd: context.cwd,
        timeout: Math.min(remaining, (hook.timeout || 20) * 1000), maxBuffer: 4 * 1024 * 1024,
      });
      results.push(parseOutput(result, hook, event));
    }
  }
  let output = protocol.normalizeOutput(event, results, raw);
  if (reviewDispatch?.modifiedArgs && output.permissionDecision !== 'deny') {
    try { reviewDispatch.admit(); }
    catch (error) {
      return { permissionDecision: 'deny', permissionDecisionReason: `Zensu review gate: ${error.message}` };
    }
    output.modifiedArgs = reviewDispatch.modifiedArgs;
  }
  if (reviewCompletion) additional(output, reviewCompletion);
  if (event === 'postToolUse' && payload.toolName === 'exit_plan_mode' && !payload.planApproved) {
    additional(output, 'Zensu: no human implementation approval was recorded for this plan. Rejection, exit-only and automated responses do not approve a durable run. Keep its planning gate pending; use the native plan approval interaction and select an implementation action when the user is ready.');
  }
  if (event === 'sessionStart') {
    additional(output, `Zensu Copilot CLI plugin is active. Session: ${context.sessionId}. Use /zensu-help, /zensu-setup, /zensu-doctor. Shell helpers are bound to this session by the native tool hook. Context occupancy is only reported when the host supplies measured utilization; no occupancy is inferred from transcript length.`);
    additional(output, nativeContext.SHELL_BINDING_NOTICE);
    additional(output, nativeContext.NATIVE_READ_NOTICE);
  }
  if (event === 'preToolUse' && output.permissionDecision !== 'deny' && payload.toolName === 'bash') {
    if (raw.toolName === 'powershell') return { permissionDecision: 'deny', permissionDecisionReason: 'Zensu shell policy requires Bash; use the bash tool (native PowerShell is not supported).' };
    output.modifiedArgs = { ...(typeof raw.toolArgs === 'string' ? JSON.parse(raw.toolArgs) : raw.toolArgs), command: nativeContext.shellBinding(context, payload.toolArgs.command) };
  }
  return output;
}
function main() {
  const raw = fs.readFileSync(0);
  if (!raw.length || raw.length > 2 * 1024 * 1024) throw new Error('Hook payload empty or exceeds 2 MiB');
  const result = dispatch(process.argv[2], JSON.parse(raw.toString('utf8')));
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (require.main === module) {
  try { main(); } catch (error) {
    const event = process.argv[2];
    const reason = `Zensu Copilot runtime failed: ${error.message}`;
    const result = event === 'preToolUse' ? { permissionDecision: 'deny', permissionDecisionReason: reason }
      : ['agentStop', 'subagentStop'].includes(event) ? { decision: 'block', reason }
      : { additionalContext: reason };
    process.stdout.write(JSON.stringify(result) + '\n');
    process.stderr.write(reason + '\n');
    process.exitCode = event === 'preToolUse' ? 2 : 0;
  }
}
module.exports = { dispatch, matchingHooks, parseOutput };
