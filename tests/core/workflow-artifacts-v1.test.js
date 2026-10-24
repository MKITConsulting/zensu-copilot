'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const core = require('../../src/plugin/hooks/lib/session-control-core-v1');
const artifacts = require('../../src/plugin/hooks/lib/workflow-artifacts-v1');
const repo = path.resolve(__dirname, '../..');

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-workflow-artifacts-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projectRoot = path.join(dir, 'project');
  for (const bucket of ['logs', 'plans', 'progress']) fs.mkdirSync(path.join(projectRoot, '.zensu', bucket), { recursive: true });
  const sessionId = crypto.randomUUID(), options = { projectRoot, sessionId };
  core.initializeWorkflowState(options);
  const mutate = callback => core.mutateWorkflowState({ ...options, workflowState: 'active', event: 'fixture' }, callback);
  mutate(state => { state.active = true; state.reviewGeneration = crypto.randomUUID(); return state; });
  const log = '.zensu/logs/2026-10-19-0100_tdd-fixture.log';
  fs.writeFileSync(path.join(projectRoot, log), 'TDD STARTED\nEXECUTION STARTED — older generation\n');
  fs.writeFileSync(path.join(projectRoot, '.zensu/plans/2026-10-19-0100_tdd-fixture.md'), '# Fixture plan\n');
  return { dir, projectRoot, sessionId, options, mutate, log, state: () => core.readWorkflowState(options) };
}

test('execution start creates a generation-bound marker exactly once and rejects another log or completed state', t => {
  const f = fixture(t);
  const first = artifacts.start(f.options, f.log);
  const state = f.state(), contents = fs.readFileSync(path.join(f.projectRoot, f.log), 'utf8');
  assert.match(contents, new RegExp(`EXECUTION STARTED — generation=${state.reviewGeneration}`));
  assert.equal(state.workflowArtifacts.generation, state.reviewGeneration);
  assert.equal(artifacts.start(f.options, f.log).generation, first.generation);
  assert.equal(f.state().revision, state.revision, 'repeated start must not mutate state');
  assert.equal(fs.readFileSync(path.join(f.projectRoot, f.log), 'utf8'), contents);
  fs.writeFileSync(path.join(f.projectRoot, '.zensu/logs/other.log'), 'TDD STARTED\n');
  fs.writeFileSync(path.join(f.projectRoot, '.zensu/plans/other.md'), '# Other\n');
  assert.throws(() => artifacts.start(f.options, '.zensu/logs/other.log'), /another run log/);
  f.mutate(s => { s.implComplete = true; return s; });
  assert.throws(() => artifacts.start(f.options, f.log), /active implementation/);
});

test('native progress reconciles stage rows without claiming blocked or arbitrary tasks passed', t => {
  const f = fixture(t), started = artifacts.start(f.options, f.log);
  const file = path.join(f.projectRoot, started.progress);
  fs.writeFileSync(file, '- [ ] Phase 6 audit — pending\n- [ ] Review chain — pending\n- [ ] Chain close and final report — close with the ticket and render the report once.\n- [ ] Deploy — pending\n- [ ] Review chain — BLOCKED: user dependency\n');
  f.mutate(s => { s.implComplete = true; s.codeReviewDone = true; s.chainDone = true; return s; });
  artifacts.syncProgress(f.options);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /- Phase 6 audit — see Native workflow status below\./);
  assert.match(text, /- Review chain — see Native workflow status below\./);
  assert.match(text, /- Chain close and final report — see Native workflow status below\. Stage note: close with the ticket and render the report once\./);
  assert.match(text, /\[ \] Deploy — pending/);
  assert.match(text, /\[ \] Review chain — BLOCKED/);
  assert.match(text, /\[x\] Workflow chain closed/);
  assert.match(text, /This artifact records workflow state only/);
  assert.doesNotMatch(text, /\[[ x]\] Chain close and final report/);
  artifacts.syncProgress(f.options);
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'progress synchronization is idempotent');
});

test('canonical lifecycle checklists remain single and truthful from execution start through closure', () => {
  const original = ['# Progress', '- [ ] Phase 6 audits — run the integrity checks. (in progress)',
    '- [x] Implementation audit accepted', '- [ ] Code review converged', '- [ ] Workflow chain closed',
    '- [ ] Chain close and final report — prepare the final report.',
    '- [ ] Review chain — cancelled by user', '- [ ] Phase 6 audit — SKIPPED: environment',
    '- [ ] Workflow chain closed — blocked: external review', '- [ ] Review chain release — must still deploy',
    '- [ ] Send final report to customer — awaiting authorization'].join('\n');
  const state = { reviewGeneration: crypto.randomUUID(), revision: 3, implComplete: false, codeReviewDone: false, chainDone: false };
  let text = artifacts.progressText(original, state);
  assert.match(text, /- \[ \] Implementation audit accepted/);
  assert.doesNotMatch(text, /- \[x\] Implementation audit accepted/);
  assert.match(text, /- Phase 6 audits — see Native workflow status below\. Stage note: run the integrity checks\./);
  assert.doesNotMatch(text, /\(in progress\)/);
  for (const line of original.split('\n').filter(line => /cancelled|SKIPPED|blocked|release|customer/.test(line))) {
    assert(text.includes(line), `protected task was changed: ${line}`);
  }
  state.implComplete = true; state.codeReviewDone = true; state.chainDone = true; state.revision++;
  text = artifacts.progressText(text, state);
  for (const label of ['Implementation audit accepted', 'Code review converged', 'Workflow chain closed']) {
    assert.equal(text.split('\n').filter(line => line === `- [x] ${label}`).length, 1);
  }
  assert.doesNotMatch(text, /\[x\].*(?:report|customer)/i);
  assert.equal(artifacts.progressText(text, state), text);
});

test('closed reports are read-only, reject stale tickets and never reopen a completed workflow', t => {
  const f = fixture(t);
  f.mutate(s => { s.implComplete = true; s.codeReviewDone = true; s.chainDone = true; s.reviewTicket = 'rt_fixture'; s.reviewTicketConsumed = true; return s; });
  const before = f.state();
  const result = artifacts.report(f.options, 'rt_fixture');
  assert.equal(result.status, 'closed');
  assert.equal(result.nextAction, 'render-report-only');
  assert.deepEqual(f.state(), before);
  assert.throws(() => artifacts.report(f.options, 'rt_old'), /stale self-review ticket/);
  assert.throws(() => artifacts.cli(['report', '--session', crypto.randomUUID()], { COPILOT_PROJECT_DIR: f.projectRoot, COPILOT_SESSION_ID: f.sessionId }), /foreign session/);
});

test('artifact paths reject symlinks, hardlinks, traversal and ambiguous managed sections', t => {
  const f = fixture(t);
  assert.throws(() => artifacts.safeArtifact(f.projectRoot, 'logs', '../outside.log'), /direct file/);
  fs.symlinkSync(path.join(f.projectRoot, f.log), path.join(f.projectRoot, '.zensu/logs/link.log'));
  assert.throws(() => artifacts.start(f.options, '.zensu/logs/link.log'), /unsafe artifact/);
  fs.linkSync(path.join(f.projectRoot, f.log), path.join(f.projectRoot, '.zensu/logs/hard.log'));
  assert.throws(() => artifacts.start(f.options, f.log), /unsafe artifact/);
  assert.throws(() => artifacts.progressText('<!-- zensu:workflow-status -->', f.state()), /ambiguous/);
});

test('native shell lifecycle wires markers, progress closure and generation reset without changing the old log', t => {
  const f = fixture(t), plugin = path.join(f.dir, 'plugin'), data = path.join(f.dir, 'data');
  fs.cpSync(path.join(repo, 'src/plugin'), plugin, { recursive: true });
  fs.mkdirSync(path.join(plugin, 'hooks/native'), { recursive: true });
  for (const name of ['dispatcher', 'protocol', 'context', 'approval', 'helper', 'transcript', 'review-gate', 'ai-work']) fs.copyFileSync(path.join(repo, `src/${name}.js`), path.join(plugin, `hooks/native/${name}.js`));
  const inventory = [];
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).forEach(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name !== 'build.json') inventory.push({ target: path.relative(plugin, file), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
  });
  walk(plugin);
  fs.writeFileSync(path.join(plugin, 'build.json'), JSON.stringify({ schemaVersion: 2, host: 'copilot', version: '0.2.0', files: inventory }));
  fs.mkdirSync(data, { mode: 0o700 });
  const recordsDir = path.join(data, 'session-control/v1/records');
  fs.mkdirSync(recordsDir, { recursive: true, mode: 0o700 });
  for (const name of ['session-control', 'session-control/v1']) fs.chmodSync(path.join(data, name), 0o700);
  core.registerContext({ recordsDir, sessionId: f.sessionId, host: 'copilot', pluginData: data, executingPluginRoot: plugin, projectRoot: f.projectRoot, pluginRoot: plugin });
  const env = { ...process.env, HOME: f.dir, COPILOT_PLUGIN_ROOT: plugin, COPILOT_PROJECT_DIR: f.projectRoot,
    COPILOT_PLUGIN_DATA: data, COPILOT_SESSION_ID: f.sessionId, ZENSU_BOUND_SESSION_ID: f.sessionId };
  for (const name of Object.keys(env)) if (name.startsWith('CLAUDE_') || name.startsWith('GIT_') || (name.startsWith('ZENSU_') && name !== 'ZENSU_BOUND_SESSION_ID')) delete env[name];
  const git = args => {
    const result = spawnSync('git', args, { cwd: f.projectRoot, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q']); fs.writeFileSync(path.join(f.projectRoot, '.gitignore'), '.zensu/\n'); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  const run = (...args) => {
    const result = spawnSync('bash', [path.join(plugin, 'hooks/lib/zensu-log.sh'), ...args], { cwd: f.projectRoot, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  run('--tdd-begin');
  run('--execution-start', '--log', f.log);
  const first = f.state(), progress = path.join(f.projectRoot, first.workflowArtifacts.progress);
  const missingReceipt = spawnSync('bash', [path.join(plugin, 'hooks/lib/zensu-log.sh'), '--chain-done'],
    { cwd: f.projectRoot, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(missingReceipt.status, 1);
  assert.match(missingReceipt.stderr, /edit-landing audit/);
  // This fixture changes workflow metadata only, so the zero-source-change
  // exception applies. Its claimed write still needs an actual current audit.
  fs.writeFileSync(path.join(f.projectRoot, '.zensu/lifecycle-settings.json'), '{"enabled":true}\n');
  run('append', '--log', f.log, '--message', 'S1 IMPL completed — files: .zensu/lifecycle-settings.json');
  const audit = spawnSync('bash', [path.join(plugin, 'hooks/lib/zensu-edit-landing.sh'), '--log', f.log,
    '--project', f.projectRoot, '--session', f.sessionId], { cwd: f.projectRoot, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(audit.status, 0, audit.stdout + audit.stderr);
  run('--tdd-complete');
  assert.match(fs.readFileSync(progress, 'utf8'), /\[x\] Implementation audit accepted/);
  assert.match(run('--chain-done').stdout, /CHAIN CLOSED — render-report-only/);
  assert.match(fs.readFileSync(progress, 'utf8'), /\[x\] Workflow chain closed/);
  const before = f.state(), text = fs.readFileSync(path.join(f.projectRoot, f.log), 'utf8');
  assert.equal(JSON.parse(run('--chain-report').stdout).status, 'closed');
  assert.deepEqual(f.state(), before);
  f.mutate(s => { s.reviewPacketGate = { fixture: true }; return s; });
  run('--tdd-begin');
  assert.notEqual(f.state().reviewGeneration, first.reviewGeneration);
  assert.equal(f.state().workflowArtifacts, undefined);
  assert.equal(f.state().reviewPacketGate, undefined);
  assert.equal(fs.readFileSync(path.join(f.projectRoot, f.log), 'utf8'), text);
  run('--execution-start', '--log', f.log);
  assert.match(fs.readFileSync(progress, 'utf8'), /\[ \] Workflow chain closed/);
});
