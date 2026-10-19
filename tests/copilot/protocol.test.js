'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEvent, normalizeTool, normalizeOutput } = require('../../src/protocol.js');
const base = { sessionId: 'session-one', cwd: '/workspace/project', timestamp: 1234 };
const call = (toolName, toolArgs) => ({ ...base, toolName, toolArgs });
test('native glob capture preserves native arguments and exposes exact traversal roots', () => {
  const raw = call('glob', { pattern: '**/*', paths: '/private/tmp/zensu-copilot-workflow' });
  const before = JSON.stringify(raw);
  const normalized = normalizeEvent('preToolUse', raw);
  assert.deepEqual(normalized.normalizationErrors, []);
  assert.equal(normalized.toolName, 'glob');
  assert.deepEqual(normalized.toolArgs, { pattern: '**/*', paths: '/private/tmp/zensu-copilot-workflow' });
  assert.deepEqual(normalized.toolCalls, [{ toolName: 'glob', toolArgs: { pattern: '**/*', paths: ['/private/tmp/zensu-copilot-workflow'] } }]);
  assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(normalized.toolArgs, raw.toolArgs);
});

test('native search arrays expose every root separately without splitting literal strings', () => {
  for (const name of ['glob', 'grep', 'rg']) {
    const args = { pattern: 'value', paths: ['/project/src', '/private/state', '/project/src'], glob: '*.js', '-i': true };
    const normalized = normalizeTool(name, JSON.stringify(args));
    assert.deepEqual(normalized.normalizationErrors, []);
    assert.deepEqual(normalized.toolCalls.map(call => call.toolArgs.paths[0]), ['/project/src', '/private/state']);
    for (const call of normalized.toolCalls) {
      assert.equal(call.toolArgs.paths.length, 1);
      assert.equal(call.toolArgs.pattern, 'value');
      assert.equal(call.toolArgs.glob, '*.js');
      assert.equal(call.toolArgs['-i'], true);
    }
    const literal = normalizeTool(name, { pattern: 'x', paths: '/project/a, b' });
    assert.deepEqual(literal.toolCalls.map(call => call.toolArgs.paths[0]), ['/project/a, b']);
  }
});

test('only omitted native search roots use the documented cwd default', () => {
  for (const name of ['glob', 'grep']) {
    assert.deepEqual(normalizeTool(name, { pattern: 'x' }).toolCalls[0].toolArgs, { pattern: 'x', paths: ['.'] });
    assert.deepEqual(normalizeTool(name, { pattern: 'x', paths: '.' }).normalizationErrors, []);
    for (const paths of [null, undefined, '', [], [''], ['src', null], {}, ['/project\nother'], Array(1001).fill('src')]) {
      assert.ok(normalizeTool(name, { pattern: 'x', paths }).normalizationErrors.length, JSON.stringify(paths));
    }
    assert.ok(normalizeTool(name, { pattern: 'x', path: '/allowed' }).normalizationErrors.includes('unsupported-search-root-field'));
    assert.ok(normalizeTool(name, { pattern: 'x', paths: '/actual', path: '/different' }).normalizationErrors.includes('unsupported-search-root-field'));
    assert.ok(normalizeTool(name, { pattern: 'x', directory: '/allowed' }).normalizationErrors.includes('unsupported-search-root-field'));
    assert.ok(normalizeTool(name, { paths: '/actual' }).normalizationErrors.includes('search-pattern-missing'));
  }
});

test('foreign tool names and arguments are rejected rather than translated', () => {
  for (const name of ['Grep', 'Glob', 'Bash', 'Read', 'Write', 'Edit', 'Agent', 'Skill']) {
    assert.ok(normalizeTool(name, { path: 'src' }).normalizationErrors.includes('unsupported-host-tool'));
  }
  for (const args of [{ file_path: 'x', old_str: 'a', new_str: 'b' },
    { path: 'x', old_string: 'a', new_string: 'b' }]) {
    assert.ok(normalizeTool('edit', args).normalizationErrors.includes('unsupported-tool-argument'));
  }
  assert.ok(normalizeTool('task', { subagent_type: 'reviewer', prompt: 'x' }).normalizationErrors.length);
});

test('dispatcher gates every native search root and raw patch file and retains a denial', t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { dispatch } = require('../../src/dispatcher');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-search-roots-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'plugin');
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hooks/registry.json'), JSON.stringify({ preToolUse: [{
    matcher: 'grep|glob|edit|create', script: 'hooks/search-gate.sh',
  }] }));
  const paths = [path.join(base, 'src'), path.join(base, 'private-state')];
  const patchPaths = [paths[0] + '/new.js', paths[0] + '/old.js', paths[1] + '/moved.js', paths[0] + '/deleted.js'];
  const patch = ['*** Begin Patch', `*** Add File: ${patchPaths[0]}`, '+new',
    `*** Update File: ${patchPaths[1]}`, `*** Move to: ${patchPaths[2]}`, '-old', '+new',
    `*** Delete File: ${patchPaths[3]}`, '*** End Patch'].join('\n');
  for (const [toolName, toolArgs, expected] of [
    ['glob', { pattern: 'value', paths }, paths], ['grep', { pattern: 'value', paths }, paths], ['apply_patch', patch, patchPaths],
  ]) {
    const checked = [];
    const output = dispatch('preToolUse', { sessionId: 'search-fixture', cwd: base, toolName,
      toolArgs }, {
      root, env: { COPILOT_HOME: path.join(base, 'home'), COPILOT_PLUGIN_DATA: path.join(base, 'data') },
      spawnSync: (_command, _args, options) => {
        const input = JSON.parse(options.input);
        const target = input.toolArgs.path ?? input.toolArgs.paths?.[0];
        checked.push(target);
        const denied = target === paths[1] || target.startsWith(paths[1] + '/');
        return { status: 0, stdout: JSON.stringify({
          permissionDecision: denied ? 'deny' : 'allow', permissionDecisionReason: denied ? 'Protected root' : 'Allowed root',
        }) };
      },
    });
    assert.deepEqual(checked, expected);
    assert.equal(output.permissionDecision, 'deny');
    assert.match(output.permissionDecisionReason, /Protected root/);
  }
  const ambiguous = dispatch('preToolUse', {
    sessionId: 'search-fixture', cwd: base, toolName: 'apply_patch',
    toolArgs: `*** Begin Patch\n*** Add File:  ${paths[1]}/state.json\n+tamper\n*** End Patch`,
  }, {
    root, env: { COPILOT_HOME: path.join(base, 'home'), COPILOT_PLUGIN_DATA: path.join(base, 'data') },
    spawnSync: () => assert.fail('Ambiguous native path must be denied before policy evaluation'),
  });
  assert.equal(ambiguous.permissionDecision, 'deny');
  assert.match(ambiguous.permissionDecisionReason, /patch-path-surrounding-whitespace/);
});

test('native semantic rename and unaccounted workflow execution cannot bypass source-write gates', () => {
  assert.deepEqual(normalizeTool('lsp', { operation: 'rename', file: 'src/a.ts', newName: 'x' }).normalizationErrors, ['lsp-mutating-or-unknown-operation']);
  for (const operation of ['goToDefinition', 'findReferences', 'hover', 'documentSymbol', 'workspaceSymbol', 'goToImplementation', 'incomingCalls', 'outgoingCalls']) {
    assert.deepEqual(normalizeTool('lsp', { operation, file: 'src/a.ts' }).normalizationErrors, []);
  }
  assert.notEqual(normalizeTool('lsp', { operation: 'new-operation' }).normalizationErrors.length, 0);
  for (const name of ['run_dynamic_workflow', 'dynamic_workflows_manage']) assert(normalizeTool(name, {}).normalizationErrors.includes('unaccounted-workflow-execution'));
});

test('native edit arguments and input provenance survive without mutation', () => {
  const raw = call('edit', { path: 'src/app.js', old_str: 'old', new_str: 'new' });
  const before = JSON.stringify(raw);
  const result = normalizeEvent('preToolUse', raw);
  assert.equal(result.eventName, 'preToolUse');
  assert.equal(result.sessionId, base.sessionId);
  assert.equal(result.toolName, 'edit');
  assert.equal(result.toolArgs.path, 'src/app.js');
  assert.equal(result.toolArgs.new_str, 'new');
  assert.deepEqual(result.normalizationErrors, []);
  assert.equal(JSON.stringify(raw), before);
});

test('native JSON arguments and empty file contents remain valid', () => {
  const created = normalizeTool('create', JSON.stringify({ path: '/tmp/empty', content: '' }));
  assert.equal(created.toolArgs.content, '');
  assert.deepEqual(created.normalizationErrors, []);
  const edited = normalizeTool('edit', { path: 'a.js', old_str: '', new_str: '' });
  assert.deepEqual(edited.normalizationErrors, []);
  assert.equal(normalizeTool('view', { path: 'a.js' }).toolName, 'view');
});

test('unsupported mutation schemas cannot silently become harmless calls', () => {
  for (const [name, args] of [['edit', { path: 'x', replacement: 'a' }], ['apply_patch', { patch: 'diff --git a/x b/x' }],
    ['str_replace_editor', { path: 'x', command: 'undo_edit' }], ['rename_file', { from: 'x', to: 'y' }],
    ['powershell', { command: 'Set-Content x y' }], ['create', '{broken']]) {
    assert.ok(normalizeTool(name, args).normalizationErrors.length, name);
  }
  assert.ok(normalizeTool('edit', { path: 'x', file_path: 'y', old_str: '', new_str: '' })
    .normalizationErrors.includes('unsupported-tool-argument'));
});

test('multi-file patches expose every add, edit, deletion and move destination to gates', () => {
  const patch = ['*** Begin Patch', '*** Add File: src/new.js', '+const value = 1;',
    '*** Update File: src/old.js', '*** Move to: .zensu/state/state.json', '@@', '-old', '+new',
    '*** Delete File: src/deleted.js', '*** End Patch', ''].join('\n');
  const normalized = normalizeTool('apply_patch', { patch });
  assert.deepEqual(normalized.normalizationErrors, []);
  assert.equal(normalized.toolName, 'apply_patch');
  assert.deepEqual(normalized.toolCalls.map(value => value.toolArgs.path),
    ['src/new.js', 'src/old.js', '.zensu/state/state.json', 'src/deleted.js']);
  assert.equal(normalized.toolCalls[0].toolArgs.content, 'const value = 1;');
  assert.equal(normalized.toolCalls[2].toolArgs.operation, 'move-destination');
  assert.equal(normalized.toolCalls[2].toolArgs.new_str, 'new');
  assert.equal(normalized.toolCalls[3].toolArgs.operation, 'delete');
});

test('native freeform and JSON patch transports expose the same file changes', () => {
  const patch = ['*** Begin Patch', '*** Add File: src/new.js', '+const value = 1;',
    '*** Update File: src/old.js', '*** Move to: .zensu/state/state.json', '@@', '-old', '+new',
    '*** Delete File: src/deleted.js', '*** End Patch', ''].join('\n');
  const raw = normalizeEvent('preToolUse', call('apply_patch', patch));
  assert.deepEqual(raw.normalizationErrors, []);
  assert.deepEqual(raw.toolCalls, normalizeTool('apply_patch', { patch }).toolCalls);
  assert.deepEqual(raw.toolCalls, normalizeTool('apply_patch', { input: patch }).toolCalls);
  assert.deepEqual(raw.toolCalls, normalizeTool('apply_patch', JSON.stringify({ patch })).toolCalls);
  assert.equal(raw.toolArgs.patch, patch);
  assert.equal(normalizeEvent('postToolUse', { ...call('apply_patch', patch),
    toolResult: { resultType: 'success', textResultForLlm: 'Files updated.' } }).toolCalls.length, 4);
});

test('freeform patches retain grammar, path and byte limits before any gate runs', () => {
  const { MAX_INPUT_BYTES } = require('../../src/protocol');
  for (const patch of ['*** Begin Patch\n*** Add File: x\n+x',
    '*** Begin Patch\n*** Add File: a\0b\n+x\n*** End Patch',
    `*** Begin Patch\n*** Add File: x\n+${'x'.repeat(MAX_INPUT_BYTES)}\n*** End Patch`]) {
    const result = normalizeTool('apply_patch', patch);
    assert.ok(result.normalizationErrors.length);
    assert.equal(result.toolName, 'apply_patch');
  }
  assert.ok(normalizeTool('edit', '*** Begin Patch\n*** End Patch').normalizationErrors.includes('tool-arguments-invalid-json'));
  for (const args of ['{"patch": "*** Begin Patch', '{*** Begin Patch\n*** End Patch}', JSON.stringify('*** Begin Patch\n*** End Patch')]) {
    assert.ok(normalizeTool('apply_patch', args).normalizationErrors.length);
  }
});

test('native first patch chunk can omit @@ while empty updates stay rejected', () => {
  // These grammar outcomes were checked with Copilot 1.0.98 runtime.patchParse.
  const patch = ['*** Begin Patch', '*** Update File: src/a.js', '-old', '+new',
    '*** Update File: src/b.js', '*** Move to: private/b.js', '-before', '+after', '*** End Patch'].join('\n');
  const normalized = normalizeTool('apply_patch', patch);
  assert.deepEqual(normalized.normalizationErrors, []);
  assert.deepEqual(normalized.toolCalls.map(call => call.toolArgs.path), ['src/a.js', 'src/b.js', 'private/b.js']);
  assert.equal(normalized.toolCalls[0].toolArgs.old_str, 'old');
  assert.equal(normalized.toolCalls[0].toolArgs.new_str, 'new');
  for (const body of ['', '@@\n', '*** Move to: y\n']) {
    assert.ok(normalizeTool('apply_patch', `*** Begin Patch\n*** Update File: x\n${body}*** End Patch`).normalizationErrors.includes('patch-update-content-missing'));
  }
});

test('patch malformed headers, paths, and non-add content are rejected', () => {
  for (const patch of ['*** Begin Patch\n*** End Patch',
    '*** Begin Patch\n*** Add File: a\nnot-added\n*** End Patch',
    '*** Begin Patch\n*** Update File: a\n@@\n*** End Patch',
    '*** Begin Patch\n*** Delete File: a\n+new\n*** End Patch',
    '*** Begin Patch\n*** Add File: a\0b\n+x\n*** End Patch']) {
    assert.ok(normalizeTool('apply_patch', { patch }).normalizationErrors.length, patch);
  }
});

test('patch header whitespace cannot disguise the native parser target', () => {
  // The native parser trims these fields; the adapter must reject the ambiguous
  // spelling before a gate can treat an absolute private path as a relative one.
  for (const file of [' /private/state.json', '/private/state.json ', '\t/private/state.json', '/private/state.json\u00a0']) {
    for (const [kind, body] of [['Add', '+new\n'], ['Update', '-old\n+new\n'], ['Delete', '']]) {
      const patch = `*** Begin Patch\n*** ${kind} File: ${file}\n${body}*** End Patch`;
      assert.ok(normalizeTool('apply_patch', patch).normalizationErrors.includes('patch-path-surrounding-whitespace'), `${kind}: ${JSON.stringify(file)}`);
    }
    const move = `*** Begin Patch\n*** Update File: src/a.js\n*** Move to: ${file}\n-old\n+new\n*** End Patch`;
    assert.ok(normalizeTool('apply_patch', move).normalizationErrors.includes('patch-move-path-surrounding-whitespace'));
  }
  assert.deepEqual(normalizeTool('apply_patch', '*** Begin Patch\n*** Add File: src/with spaces.js\n+new\n*** End Patch').normalizationErrors, []);
});

test('task target identity is independent from firing subagent identity', () => {
  const raw = { ...call('task', { agent_type: 'zensu:code-reviewer', prompt: 'Review.' }),
    agentId: 'outer-child', agentType: 'foreign-reviewer' };
  const normalized = normalizeEvent('preToolUse', raw);
  assert.equal(normalized.agentType, 'foreign-reviewer');
  assert.equal(normalized.toolArgs.agent_type, 'zensu:code-reviewer');
  assert.equal(normalizeTool('task', { agent_type: 'code-reviewer-extra', prompt: 'x' })
    .toolArgs.agent_type, 'code-reviewer-extra');
  const partial = normalizeEvent('preToolUse', { ...call('bash', { command: 'pwd' }), parentAgentId: 'parent' });
  assert.equal(partial.agentType, 'copilot:unclassified');
  const missing = normalizeEvent('subagentStart', { ...base, agentName: 'plan-review-worker' });
  assert.equal(missing.agentType, 'zensu:plan-review-worker');
  assert.ok(missing.normalizationErrors.includes('subagent-correlation-id-missing'));
});

test('only native events and identities are accepted', () => {
  assert.ok(normalizeEvent('preToolUse', { ...call('bash', { command: 'pwd' }), session_id: 'another' })
    .normalizationErrors.includes('unsupported-event-field'));
  assert.ok(normalizeEvent('preToolUse', null).normalizationErrors.includes('event-not-object'));
  const foreign = normalizeEvent('PreToolUse', { session_id: 's', cwd: '/x', tool_name: 'Write',
    tool_input: { file_path: 'a', content: '' } });
  assert.ok(foreign.normalizationErrors.includes('unsupported-event'));
  assert.ok(foreign.normalizationErrors.includes('session-id-missing-or-unsafe'));
  assert.equal(foreign.toolName, undefined);
});

test('native wire stop payloads retain first-stop and repeated-stop flags without SDK renaming', () => {
  // Copilot 1.0.98 shell-hook shape, corroborated by native captures and the
  // installed SDK index.js deserializeHookInput; this is a synthetic fixture.
  for (const eventName of ['agentStop', 'subagentStop']) {
    for (const recursion of [{}, { stop_hook_active: false }, { stop_hook_active: true }]) {
      const raw = { ...base, transcriptPath: '/workspace/session/events.jsonl',
        stopReason: 'end_turn', ...recursion,
        ...(eventName === 'subagentStop' ? { agentId: 'reviewer-one',
          agentType: 'zensu:review-aspect', agentName: 'zensu:review-aspect',
          parentAgentId: base.sessionId, response: '## Aspect: correctness\nNo findings.' } : {}) };
      const before = structuredClone(raw);
      const result = normalizeEvent(eventName, raw);
      assert.deepEqual(result.normalizationErrors, []);
      assert.equal(Object.hasOwn(result, 'stop_hook_active'), Object.hasOwn(raw, 'stop_hook_active'));
      assert.equal(result.stop_hook_active, raw.stop_hook_active);
      assert.equal(Object.hasOwn(result, 'stopHookActive'), false);
      assert.equal(result.isChild, eventName === 'subagentStop');
      assert.equal(result.response, raw.response);
      assert.equal(result.agentId, raw.agentId);
      assert.equal(result.parentAgentId, raw.parentAgentId);
      assert.deepEqual(raw, before);
    }
  }
});

test('native stop recursion flags reject non-booleans and do not apply to tool events', () => {
  for (const eventName of ['agentStop', 'subagentStop']) {
    for (const value of ['true', 'false', 0, 1, null, undefined, {}, []]) {
      const raw = { ...base, stop_hook_active: value,
        ...(eventName === 'subagentStop' ? { agentId: 'child', agentType: 'zensu:review-aspect' } : {}) };
      assert.ok(normalizeEvent(eventName, raw).normalizationErrors.includes('stop-hook-active-not-boolean'));
    }
  }
  assert.ok(normalizeEvent('preToolUse', { ...call('bash', { command: 'pwd' }), stop_hook_active: true })
    .normalizationErrors.includes('stop-recursion-field-on-non-stop-event'));
});

test('dispatcher delivers native stop wire flags to policies and preserves their actual decision', t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { dispatch } = require('../../src/dispatcher');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-native-stop-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'plugin');
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hooks/registry.json'), JSON.stringify({
    agentStop: [{ script: 'hooks/stop-policy.sh' }], subagentStop: [{ script: 'hooks/child-stop-policy.sh' }],
  }));
  const env = { COPILOT_HOME: path.join(directory, 'home'), COPILOT_PLUGIN_DATA: path.join(directory, 'data') };
  for (const eventName of ['agentStop', 'subagentStop']) {
    for (const recursion of [{}, { stop_hook_active: false }, { stop_hook_active: true }]) {
      const raw = { sessionId: 'root-session', cwd: directory, stopReason: 'end_turn',
        transcriptPath: path.join(directory, 'events.jsonl'), ...recursion,
        ...(eventName === 'subagentStop' ? { agentId: 'child-reviewer',
          agentType: 'zensu:review-aspect', agentName: 'zensu:review-aspect',
          parentAgentId: 'root-session', response: '## Aspect: correctness\nNo findings.' } : {}) };
      for (const decision of [{}, { decision: 'block', reason: 'Required review remains pending.' }]) {
        let invoked = 0;
        const output = dispatch(eventName, raw, { root, env, spawnSync: (_command, _args, options) => {
          invoked++;
          const payload = JSON.parse(options.input);
          assert.equal(payload.eventName, eventName);
          assert.equal(payload.stop_hook_active, raw.stop_hook_active);
          assert.equal(Object.hasOwn(payload, 'stop_hook_active'), Object.hasOwn(raw, 'stop_hook_active'));
          assert.equal(Object.hasOwn(payload, 'stopHookActive'), false);
          return { status: 0, stdout: JSON.stringify(decision) };
        } });
        assert.equal(invoked, 1);
        assert.deepEqual(output, decision);
      }
    }
  }
  const rejected = dispatch('agentStop', { sessionId: 'root-session', cwd: directory, stop_hook_active: 'true' }, {
    root, env, spawnSync: () => assert.fail('Invalid recursion data must not reach policies'),
  });
  assert.equal(rejected.decision, 'block');
  assert.match(rejected.reason, /stop-hook-active-not-boolean/);
});

test('post-tool outcome never invents reviewer completion from generic success', () => {
  const raw = { ...call('task', { agent_type: 'code-reviewer', prompt: 'review' }),
    toolResult: { resultType: 'success', textResultForLlm: 'Agent launched in background.' } };
  assert.equal(normalizeEvent('postToolUse', raw).toolOutcome, 'unknown');
  assert.equal(normalizeEvent('postToolUse', { ...raw, toolResult: { ...raw.toolResult, status: 'async_launched' } })
    .toolResult.status, 'async_launched');
  assert.equal(normalizeEvent('postToolUseFailure', { ...raw, error: 'cancelled' }).toolOutcome, 'error');
});

test('native synchronous task success is a completed review; background and omitted mode remain unknown', () => {
  const raw={...call('task',{agent_type:'code-reviewer',prompt:'review',mode:'sync'}),
    toolResult:{resultType:'success',textResultForLlm:'PROBE_REVIEW_DONE'}};
  const completed=normalizeEvent('postToolUse',raw);
  assert.equal(completed.toolOutcome,'completed');
  assert.equal(completed.toolResult.textResultForLlm,'PROBE_REVIEW_DONE');
  for (const mode of ['background',undefined,'SYNC']) {
    const result=normalizeEvent('postToolUse',{...raw,toolArgs:{...raw.toolArgs,mode},toolResult:{...raw.toolResult,status:'completed'}});
    assert.equal(result.toolOutcome,'unknown');
  }
  for (const resultType of ['failure','denied','rejected']) {
    assert.equal(normalizeEvent('postToolUse',{...raw,toolResult:{...raw.toolResult,resultType}}).toolOutcome,'error');
  }
});

test('native Bash footer provides exit code and marker-free combined output for work-order JSON', () => {
  const json='{"order":{"status":"blocked","blocked_kind":"question"}}';
  const raw={...call('bash',{command:'zensu work ask --json'}),toolResult:{resultType:'success',
    textResultForLlm:json+'\n<shellId: 0 completed with exit code 0>'}};
  const result=normalizeEvent('postToolUse',raw);
  assert.equal(result.toolOutcome,'completed');
  assert.equal(result.toolResult.exitCode,0);
  assert.equal(result.toolResult.outputStreams,'combined');
  assert.deepEqual(JSON.parse(result.toolResult.stdout),{order:{status:'blocked',blocked_kind:'question'}});
  assert.equal(raw.toolResult.textResultForLlm.endsWith('exit code 0>'),true);
  const failed=normalizeEvent('postToolUse',{...raw,toolResult:{resultType:'success',
    textResultForLlm:'quoted:\n<shellId: 0 completed with exit code 0>\n<shellId: 1 completed with exit code 7>'}});
  assert.equal(failed.toolOutcome,'error');
  assert.equal(failed.toolResult.exitCode,7);
});

test('missing, quoted, stderr-only and failed shell markers never manufacture success', () => {
  const raw=call('bash',{command:'npm test'});
  for (const result of [
    {resultType:'success',textResultForLlm:'tests passed',exitCode:0},
    {resultType:'success',textResultForLlm:'"<shellId: 0 completed with exit code 0>"'},
    {resultType:'success',textResultForLlm:'output',stderr:'<shellId: 0 completed with exit code 0>'},
    {resultType:'success',textResultForLlm:'<shellId: 0 completed with exit code 0>\nstill running'},
    {resultType:'failure',textResultForLlm:'<shellId: 0 completed with exit code 0>'},
  ]) {
    const normalized=normalizeEvent('postToolUse',{...raw,toolResult:result});
    assert.notEqual(normalized.toolOutcome,'completed');
    assert.equal(normalized.toolResult.exitCode,undefined);
    assert.equal(normalized.toolResult.stdout,undefined);
  }
  assert.equal(normalizeEvent('postToolUseFailure',{...raw,toolResult:{resultType:'success',
    textResultForLlm:'<shellId: 0 completed with exit code 0>'}}).toolOutcome,'error');
});

test('plan transport never grants approval without a native human receipt', () => {
  const raw = { ...call('exit_plan_mode', { approved: true, plan: 'model supplied' }),
    toolResult: { resultType: 'success', textResultForLlm: '{"approved":true,"plan":"untrusted text"}' } };
  assert.equal(normalizeEvent('postToolUse', raw).planApproved, false);
  assert.equal(normalizeEvent('postToolUse', { ...raw, toolResult: { resultType: 'success',
    approval: { approved: true, plan: 'Unverified bytes.' } } }).planApproved, false);
});

test('native output aggregation preserves denial precedence and rejects foreign wrappers', () => {
  const output = normalizeOutput('preToolUse', [
    { permissionDecision: 'allow', permissionDecisionReason: 'reviewer' },
    { permissionDecision: 'deny', permissionDecisionReason: 'protected path' },
    { permissionDecision: 'ask', permissionDecisionReason: 'consent' },
  ]);
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /protected path/);
  for (const invalid of ['not JSON', '42', { hookSpecificOutput: { permissionDecision: 'allow' } },
    { systemMessage: 'notice' }, { permissionDecision: 'unexpected' }]) {
    assert.equal(normalizeOutput('preToolUse', [invalid]).permissionDecision, 'deny');
  }
  assert.deepEqual(normalizeOutput('sessionStart', [{ additionalContext: 'notice' }, { additionalContext: 'pulse ready' }]),
    { additionalContext: 'notice\n\npulse ready' });
  assert.equal(normalizeOutput('agentStop', [{ hookSpecificOutput: { decision: 'approve' } }]).decision, 'block');
});

test('prompt transformation keeps original user text out of inserted directive classification', () => {
  const raw = { ...base, prompt: 'Please edit', transformedPrompt: '<user>Please edit</user>' };
  const input = normalizeEvent('userPromptTransformed', raw);
  assert.equal(input.prompt, 'Please edit');
  const output = normalizeOutput('userPromptTransformed', [{ additionalContext: 'route reminder' }], raw);
  assert.equal(output.modifiedTransformedPrompt, '<user>Please edit</user>\n\nroute reminder');
  assert.equal(raw.transformedPrompt, '<user>Please edit</user>');
  assert.deepEqual(normalizeOutput('userPromptSubmitted', [{ additionalContext: 'ignored' }]), {});
});

test('Stop block wins over response rewrite; successful subagent rewrite survives', () => {
  assert.deepEqual(normalizeOutput('subagentStop', [{ modifiedResponse: 'redacted' }, { decision: 'block', reason: 'retry JSON' }]),
    { decision: 'block', reason: 'retry JSON' });
  assert.deepEqual(normalizeOutput('subagentStop', [{ modifiedResponse: '' }]), { modifiedResponse: '' });
  assert.deepEqual(normalizeOutput('agentStop', [{ modifiedResponse: 'not applicable' }]), {});
});

test('dispatcher refuses foreign hook fields before invoking any native policy', t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { dispatch } = require('../../src/dispatcher');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-native-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'plugin');
  fs.mkdirSync(plugin);
  const env = { COPILOT_HOME: path.join(root, 'home'), COPILOT_PLUGIN_DATA: path.join(root, 'data') };
  // The policy registry does not exist: rejection must happen before lookup.
  for (const foreign of [{ tool_name: 'Write' }, { tool_input: { file_path: 'secret' } },
    { hook_event_name: 'PreToolUse' }, { session_id: 'other-session' }]) {
    const result = dispatch('preToolUse', { sessionId: 'native-id', cwd: root,
      toolName: 'create', toolArgs: { path: 'file', content: 'x' }, ...foreign }, {
      root: plugin, env, spawnSync: () => assert.fail('A foreign envelope reached policy evaluation'),
    });
    assert.equal(result.permissionDecision, 'deny');
    assert.match(result.permissionDecisionReason, /unsupported-event-field/);
  }
});
