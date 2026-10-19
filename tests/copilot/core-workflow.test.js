'use strict';

// Hermetic integration through the packaged native dispatcher and the owned
// workflow core. Tool events are fixtures; shell commands and evidence runs are
// executed locally. This is not a live model or Copilot authentication test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const distribution = path.resolve(__dirname, '../../dist/zensu');
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-copilot-cycle-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // Freeze each integration installation: a development rebuild must not mutate
  // the runtime digest or remove handlers underneath an active test session.
  const plugin = path.join(base, 'plugin');
  fs.cpSync(distribution, plugin, { recursive: true });
  const { dispatch } = require(path.join(plugin, 'hooks/native/dispatcher.js'));
  const core = require(path.join(plugin, 'hooks/lib/session-control-core-v1.js'));
  const evidence = require(path.join(plugin, 'hooks/lib/evidence-run-v1.js'));
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  const config = path.join(base, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ hooks: { pulseSession: false, sessionBanner: false,
    autoTdd: false, tddImplementation: true, autoFixMaxRounds: 5 }, context: { compactionNudge: false },
    evidence: { fullSuiteCommand: `${quote(process.execPath)} src/sum.test.js`, fullSuiteRunner: 'local', fullSuiteGate: 'required' } }));
  const env = { ...process.env, HOME: base, COPILOT_HOME: path.join(base, 'copilot'),
    COPILOT_PLUGIN_DATA: path.join(base, 'data'), PLUGIN_ROOT: plugin, ZENSU_CONFIG: config };
  for (const name of Object.keys(env)) {
    if (name.startsWith('CLAUDE_') || name.startsWith('GIT_') ||
        (/^ZENSU_/.test(name) && name !== 'ZENSU_CONFIG')) delete env[name];
  }
  const git = args => {
    const result = spawnSync('git', args, { cwd: project, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q']);
  fs.writeFileSync(path.join(project, '.gitignore'), '.zensu/\n');
  fs.writeFileSync(path.join(project, 'README.md'), 'Synthetic Copilot workflow fixture.\n');
  git(['add', '.']);
  git(['-c', 'user.name=Workflow Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'Initialize fixture']);

  const sessionId = crypto.randomUUID();
  const transcript = path.join(env.COPILOT_HOME, 'session-state', sessionId, 'events.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true, mode: 0o700 });
  let parentId = null;
  const append = (type, data) => {
    const event = { id: crypto.randomUUID(), parentId, timestamp: new Date().toISOString(), type, data };
    fs.appendFileSync(transcript, JSON.stringify(event) + '\n', { mode: 0o600 });
    parentId = event.id;
  };
  append('session.start', { sessionId, context: { cwd: project } });
  const run = (event, args = {}) => dispatch(event, { sessionId, cwd: project, ...args }, { env, root: plugin });
  const state = () => core.readWorkflowState({ projectRoot: project, sessionId });
  const healthy = result => assert.doesNotMatch(JSON.stringify(result),
    /runtime failed|Zensu [\w-]+\.sh: .*exit [1-9]|session-control runtime:/);
  healthy(run('sessionStart', { source: 'startup' }));

  let shellId = 0;
  function shell(command, expectedStatus = 0) {
    const args = { command };
    const before = run('preToolUse', { toolName: 'bash', toolArgs: args });
    assert.notEqual(before.permissionDecision, 'deny', before.permissionDecisionReason);
    assert.notEqual(before.permissionDecision, 'ask', before.permissionDecisionReason);
    assert.equal(typeof before.modifiedArgs?.command, 'string', 'native hook binds the real shell');
    const toolCallId = crypto.randomUUID();
    append('tool.execution_start', { toolCallId, toolName: 'bash', arguments: args });
    const execution = spawnSync('bash', ['-c', before.modifiedArgs.command], {
      env, cwd: project, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(execution.error, undefined, execution.error?.message);
    assert.equal(execution.status, expectedStatus, `${command}\n${execution.stdout}\n${execution.stderr}`);
    // The native bash transport succeeds even when its child exits nonzero.
    // Its exact footer is the exit-code authority seen by postToolUse.
    const content = `${execution.stdout}${execution.stderr}\n<shellId: ${shellId++} completed with exit code ${execution.status}>`;
    const after = run('postToolUse', { toolName: 'bash', toolArgs: args,
      toolResult: { resultType: 'success', textResultForLlm: content } });
    healthy(after);
    append('tool.execution_complete', { toolCallId, success: true, result: { content } });
    return execution;
  }
  const helper = (args, expectedStatus = 0) => shell(
    `bash "$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-log.sh" ${args.map(quote).join(' ')}`, expectedStatus);
  function edit(file, oldText, newText, expected = 'allow') {
    const args = { path: path.join(project, file), old_str: oldText, new_str: newText };
    const result = run('preToolUse', { toolName: 'edit', toolArgs: args });
    assert.equal(result.permissionDecision === 'deny' ? 'deny' : 'allow', expected,
      `${file}: ${result.permissionDecisionReason || JSON.stringify(result)}`);
    return result;
  }
  let packetReference;
  function prepareReview() {
    const dir = path.join(project, '.zensu/reviews');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify({
      implementation_summary: 'Implement sum(a, b).', requirements_baseline: 'AC-001',
      diff_summary: 'New sum function and assertion.', test_evidence: 'Observed RED exit 1 and GREEN exit 0.',
      build_evidence: 'Direct CommonJS module; no separate build.', coverage_evidence: 'Single expression asserted; no numeric coverage claim.',
    }));
    packetReference = shell('node "$COPILOT_PLUGIN_ROOT/hooks/lib/review-packet-v1.js" create ' +
      '--root "$COPILOT_PROJECT_DIR" --session "$COPILOT_SESSION_ID" ' +
      '--input .zensu/reviews/input.json --out .zensu/reviews/native-cycle.json').stdout.trim();
    assert.match(packetReference, /^REVIEW-PACKET: .+ sha256:[a-f0-9]{64}$/);
    const aspect = { agent_type: 'zensu:review-aspect', mode: 'sync', name: 'policy-retry',
      description: 'A denied pre-tool request must remain retryable', prompt: packetReference + '\nperspective: tests' };
    const denied = dispatch('preToolUse', { sessionId, cwd: project, toolName: 'task', toolArgs: aspect },
      { env, root: plugin, spawnSync: () => ({ status: 0, stdout: JSON.stringify({
        permissionDecision: 'deny', permissionDecisionReason: 'Synthetic downstream policy denial',
      }) }) });
    assert.equal(denied.permissionDecision, 'deny');
    const retried = run('preToolUse', { toolName: 'task', toolArgs: aspect });
    assert.notEqual(retried.permissionDecision, 'deny', retried.permissionDecisionReason);
    healthy(run('postToolUse', { toolName: 'task', toolArgs: retried.modifiedArgs,
      toolResult: { resultType: 'success', textResultForLlm: '## Aspect: tests\n- (no findings)' } }));
    const consume = { agent_type: 'zensu:code-reviewer', mode: 'sync', name: 'premature-consume',
      description: 'Reject consume before the required primary judge',
      prompt: `PRE-MERGED FINDINGS (fan-out)\nREVIEW-TICKET: rt_pending\n${packetReference}` };
    const refused = run('preToolUse', { toolName: 'task', toolArgs: consume });
    assert.equal(refused.permissionDecision, 'deny');
    assert.match(refused.permissionDecisionReason, /primary judge/i);
    const args = { agent_type: 'zensu:review-judge', mode: 'sync', name: 'native-primary',
      description: 'Synthetic completed primary judge', prompt: packetReference + '\nmerged_panel_findings: none' };
    const before = run('preToolUse', { toolName: 'task', toolArgs: args });
    assert.notEqual(before.permissionDecision, 'deny', before.permissionDecisionReason);
    assert.match(before.modifiedArgs.prompt, /edit_landing_evidence/);
    healthy(run('postToolUse', { toolName: 'task', toolArgs: before.modifiedArgs,
      toolResult: { resultType: 'success', textResultForLlm: '## Aspect: judge\n- (no findings)' } }));
  }
  function reviewer(ticket, mode, resultType) {
    const args = { agent_type: 'zensu:code-reviewer', mode, description: 'Review the synthetic change',
      name: `consume-${mode}-${resultType}`,
      prompt: `PRE-MERGED FINDINGS (fan-out)\nREVIEW-TICKET: ${ticket}\n${packetReference}\nNo findings in this fixture.` };
    const before = run('preToolUse', { toolName: 'task', toolArgs: args });
    if (mode === 'background') {
      assert.equal(before.permissionDecision, 'deny');
      assert.match(before.permissionDecisionReason, /mode: sync/);
      return run('postToolUse', { toolName: 'task', toolArgs: args,
        toolResult: { resultType, textResultForLlm: 'Background launch cannot prove completion.' } });
    }
    assert.notEqual(before.permissionDecision, 'deny', before.permissionDecisionReason);
    const toolCallId = crypto.randomUUID();
    append('tool.execution_start', { toolCallId, toolName: 'task', arguments: args });
    const content = resultType === 'success' ? '# Code Review Report\n- Verdict: PASS\nNo findings.' : 'Fixture review failed.';
    const result = run('postToolUse', { toolName: 'task', toolArgs: args,
      toolResult: { resultType, textResultForLlm: content } });
    healthy(result);
    append('tool.execution_complete', { toolCallId, success: resultType === 'success', result: { content } });
    return result;
  }
  return { base, project, env, sessionId, run, state, shell, helper, edit, reviewer, prepareReview, evidence };
}

test('packaged native workflow executes RED/GREEN evidence and closes only after a completed review and self-review', t => {
  const f = fixture(t);
  const evidence = f.evidence;
  const production = 'src/sum.js';
  const tests = 'src/sum.test.js';
  const initial = 'module.exports = (a, b) => 0;\n';
  const implemented = 'module.exports = (a, b) => a + b;\n';
  fs.writeFileSync(path.join(f.project, production), initial);
  fs.writeFileSync(path.join(f.project, tests), "const assert = require('node:assert/strict');\nassert.equal(require('./sum.js')(1, 2), 3);\n");

  const standaloneLog = path.join(f.project, '.zensu/logs/standalone.log');
  fs.mkdirSync(path.dirname(standaloneLog), { recursive: true });
  fs.writeFileSync(standaloneLog, 'S0 IMPL completed — files: src/sum.js\n');
  const standalone = f.shell('bash "$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-edit-landing.sh" ' +
    ['--log', standaloneLog, '--project', f.project].map(quote).join(' '));
  assert.match(standalone.stderr, /STANDALONE AUDIT.*no workflow receipt/);

  f.helper(['--tdd-begin']);
  assert.equal(f.state().active, true);
  f.edit(production, initial, implemented, 'deny');
  f.helper(['--phase', 'RED_WRITE', '--step', 'S1']);
  f.edit(tests, '3', '3');
  f.helper(['--phase', 'RED_RUN', '--step', 'S1']);
  f.edit(production, initial, implemented, 'deny');

  const testCommand = `${quote(process.execPath)} src/sum.test.js`;
  const red = f.helper(['--evidence-run', '--scope', 'scoped', '--cmd', testCommand], 1);
  assert.match(red.stdout, /scope=scoped exit=1/);
  f.helper(['--phase', 'RED_FAIL', '--step', 'S1']);
  f.edit(production, initial, implemented, 'deny');
  f.helper(['--phase', 'IMPL', '--step', 'S1']);
  f.edit(production, initial, implemented);
  fs.writeFileSync(path.join(f.project, production), implemented);
  f.helper(['--phase', 'GREEN_RUN', '--step', 'S1']);
  f.edit(production, implemented, initial, 'deny');
  const green = f.helper(['--evidence-run', '--scope', 'scoped', '--cmd', testCommand]);
  assert.match(green.stdout, /scope=scoped exit=0/);
  f.helper(['--phase', 'GREEN_PASS', '--step', 'S1']);
  f.edit(production, implemented, initial, 'deny');

  const sessionKey = f.helper(['--session-key']).stdout.trim();
  const store = evidence.storeLocations(f.env.COPILOT_PLUGIN_DATA, sessionKey);
  const records = fs.readdirSync(store.records).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(store.records, name), 'utf8')))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.exit_code), [1, 0]);
  for (const record of records) {
    assert.equal(evidence.validateRecord(record, { sessionKey, projectRoot: f.project }), null);
    assert.equal(record.state, 'completed');
    assert.equal(record.tree_start, record.tree_end, 'each evidence run observed one stable Git tree');
    assert.match(record.tree_end, /^[a-f0-9]{40,64}$/);
  }
  assert.notEqual(records[0].tree_end, records[1].tree_end, 'implementation changes invalidate the RED tree');

  const log = path.join(f.project, '.zensu/logs/native-cycle.log');
  const plan = path.join(f.project, '.zensu/plans/native-cycle.md');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  fs.writeFileSync(plan, '# Native workflow fixture\n\n## Requirements\n\n' +
    '| ID | Requirement | Source |\n|---|---|---|\n| AC-001 | Add two numbers correctly. | Fixture specification |\n');
  f.helper(['append', '--log', log, '--message', 'S1 IMPL completed — files: src/sum.js, src/sum.test.js']);
  const unboundAudit = 'bash "$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-edit-landing.sh" ' +
    ['--log', log, '--project', f.project].map(quote).join(' ');
  const receiptPath = path.join(f.project, '.zensu/state/edit-landing-' + sessionKey + '.json');
  for (const extra of ['', ' --receipt -', ' --receipt ' + quote(path.join(f.project, '.zensu/alternate.json'))]) {
    const refused = f.shell(unboundAudit + extra, 2);
    assert.match(refused.stderr, /AUDIT SESSION REQUIRED/);
    assert.ok(refused.stderr.includes(`'--session' ${quote(f.sessionId)}`));
    assert.doesNotMatch(refused.stdout, /EDIT LANDED|EDIT LANDING AUDIT/);
    assert.equal(fs.existsSync(receiptPath), false);
  }
  assert.match(f.shell(unboundAudit + ' --inventory').stdout, /claimed-files=2/);
  assert.equal(fs.existsSync(receiptPath), false);
  const audit = f.shell('bash "$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-edit-landing.sh" ' +
    ['--log', log, '--project', f.project, '--session', f.sessionId].map(quote).join(' '));
  assert.match(audit.stdout, /EDIT LANDED/);
  f.helper(['--tdd-complete', '--plan', plan]);
  assert.equal(f.state().implComplete, true);
  const needsReview = f.run('agentStop');
  assert.equal(needsReview.decision, 'block');
  assert.match(needsReview.reason, /zensu:code-reviewer/);

  f.prepareReview();
  const ticket = f.helper(['--review-ticket']).stdout.trim();
  assert.match(ticket, /^rt_/);
  f.reviewer(ticket, 'background', 'success');
  assert.equal(f.state().reviewRound, 0, 'a background launch is not a completed review');
  f.reviewer(ticket, 'sync', 'failure');
  assert.equal(f.state().reviewRound, 0, 'a failed reviewer cannot consume the ticket');
  const completed = f.reviewer(ticket, 'sync', 'success');
  assert.match(completed.additionalContext, /tdd/);
  assert.equal(f.state().reviewRound, 1);
  assert.equal(f.state().reviewTicketConsumed, true);

  f.helper(['--code-review-done', '--claimed-review-ticket', ticket]);
  assert.equal(f.state().codeReviewDone, true);
  const needsSelfReview = f.run('agentStop');
  assert.equal(needsSelfReview.decision, 'block');
  assert.match(needsSelfReview.reason, /self-review/);
  const missingFullSuite = f.helper(['--chain-done', '--claimed-review-ticket', ticket], 1);
  assert.match(missingFullSuite.stderr, /FULL SUITE/);
  assert.equal(f.state().chainDone, false, 'scoped GREEN alone cannot satisfy the required full suite');
  const fullSuite = f.helper(['--evidence-run', '--scope', 'full']);
  assert.match(fullSuite.stdout, /scope=full exit=0/);
  const missingAcceptance = f.helper(['--chain-done', '--claimed-review-ticket', ticket], 1);
  assert.match(missingAcceptance.stderr, /ACCEPTANCE.*incomplete/);
  assert.equal(f.state().chainDone, false, 'a full suite does not invent acceptance observations');
  const acceptance = f.helper(['--evidence-run', '--scope', 'acceptance', '--cmd', testCommand]);
  const acceptanceRun = acceptance.stdout.match(/er1_[0-9]{13}_[a-f0-9]{12}/)?.[0];
  assert.ok(acceptanceRun, 'the observed acceptance command produced a real evidence record');
  const acceptanceRecord = f.shell('bash "$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-log.sh" ' +
    ['--acceptance-record', '--log', log, '--ac', 'AC-001', '--verdict', 'pass', '--driver', 'library',
      '--evidence-run', acceptanceRun].map(quote).join(' ') +
    " <<'FIXTURE_EVIDENCE'\nThe actual library assertion verifies that sum(1, 2) equals 3 and exited zero.\nFIXTURE_EVIDENCE");
  assert.match(acceptanceRecord.stdout, /AC-001 pass/);

  // A real self-review edit must invalidate the pre-review audit even when its
  // earlier claim was certified. A retry cannot drop the persisted context.
  fs.appendFileSync(path.join(f.project, production), '// Self-review: addition is intentional.\n');
  f.helper(['append', '--log', log, '--message', 'SR1 IMPL completed — files: src/sum.js']);
  const staleAudit = f.helper(['--chain-done', '--claimed-review-ticket', ticket], 1);
  assert.match(staleAudit.stderr, /new edit claims|changed after the receipt/);
  // The terminal receives Session Control's canonical key; it is the same
  // accepted explicit session operand, without inventing a raw native UUID.
  assert.ok(staleAudit.stderr.includes(`'--session' ${quote(sessionKey)}`), staleAudit.stderr);
  assert.ok(staleAudit.stderr.includes(`'--log' ${quote(log)}`), staleAudit.stderr);
  assert.equal(f.state().chainDone, false);
  const auditCommand = 'bash "$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-edit-landing.sh" ' +
    ['--log', log, '--project', f.project, '--session', f.sessionId].map(quote).join(' ');
  const pendingAudit = f.shell(auditCommand, 1);
  assert.match(pendingAudit.stdout, /pending=2/);
  assert.match(f.helper(['--chain-done', '--claimed-review-ticket', ticket], 1).stderr, /receipt is not clean/);
  const predicatePath = path.join(f.project, '.zensu/reviews/self-review-predicates.json');
  fs.writeFileSync(predicatePath, JSON.stringify({ schema: 'edit-landing-predicates-v1', claims: ['S1', 'SR1'].map(step => ({
    step, path: production, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(f.project, production))).digest('hex'),
    present: ['=> a + b', '// Self-review: addition is intentional.'], absent: ['=> 0'],
  })) }));
  f.shell(auditCommand + ' --predicates ' + quote(predicatePath));
  f.helper(['--evidence-run', '--scope', 'full']);
  const finalAcceptance = f.helper(['--evidence-run', '--scope', 'acceptance', '--cmd', testCommand]);
  const finalAcceptanceRun = finalAcceptance.stdout.match(/er1_[0-9]{13}_[a-f0-9]{12}/)?.[0];
  assert.ok(finalAcceptanceRun);
  f.shell('bash "$COPILOT_PLUGIN_ROOT/hooks/lib/zensu-log.sh" ' +
    ['--acceptance-record', '--log', log, '--ac', 'AC-001', '--verdict', 'pass', '--driver', 'library',
      '--evidence-run', finalAcceptanceRun].map(quote).join(' ') +
    " <<'FIXTURE_EVIDENCE'\nThe current self-review tree still passes the actual addition assertion.\nFIXTURE_EVIDENCE");
  f.helper(['--chain-done', '--claimed-review-ticket', ticket]);
  assert.equal(f.state().chainDone, true);
  assert.notEqual(f.run('agentStop').decision, 'block');
  const closedReceipt = fs.readFileSync(receiptPath);
  assert.match(f.shell(unboundAudit).stderr, /STANDALONE AUDIT.*no workflow receipt/);
  assert.deepEqual(fs.readFileSync(receiptPath), closedReceipt);
});
