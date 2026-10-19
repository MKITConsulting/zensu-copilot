'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const gate = require('../../src/review-gate');
const core = require('../../src/plugin/hooks/lib/session-control-core-v1.js');
const packets = require('../../src/plugin/hooks/lib/review-packet-v1.js');
const pluginRoot = path.resolve(__dirname, '../../src/plugin');

function fixture(t, hooks = {}, prepare = () => {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-review-gate-')));
  t.after(() => fs.rmSync(base, { force: true, recursive: true }));
  const project = path.join(base, 'project'); fs.mkdirSync(project);
  const pluginData = path.join(base, 'data'); fs.mkdirSync(pluginData);
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', env: {
    ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  } }).trim();
  git('init', '-q'); fs.writeFileSync(path.join(project, 'source.js'), 'old\n');
  git('add', 'source.js'); git('commit', '-qm', 'baseline');
  const baseline = git('rev-parse', 'HEAD'); fs.writeFileSync(path.join(project, 'source.js'), 'new\n');
  prepare(project);
  const sessionId = crypto.randomUUID();
  const context = { sessionId, nativeSessionId: sessionId, pluginRoot, pluginData, cwd: project,
    copilotHome: path.join(base, 'copilot'), record: { cwd: project } };
  core.initializeWorkflowState({ projectRoot: project, sessionId });
  const update = patch => core.mutateWorkflowState({ projectRoot: project, sessionId, actor: 'main-v1',
    event: 'test-update', workflowState: 'implementation_complete' }, state => Object.assign(state, patch));
  update({ active: true, implComplete: true, reviewGeneration: crypto.randomUUID() });
  const receipt = { schema: 'edit-landing-v2', session: sessionId, log: '.zensu/logs/test.log',
    claims: 1, landed: 1, notLanded: 0, unverified: 0, pending: 0, exemptIgnored: 0, exemptVerified: 0, clean: true };
  const receiptPath = path.join(project, '.zensu', 'state', 'edit-landing-' + core.sessionKey(sessionId) + '.json');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  const reviews = path.join(project, '.zensu', 'reviews'); fs.mkdirSync(reviews);
  const input = Object.fromEntries(['implementation_summary', 'requirements_baseline', 'diff_summary',
    'test_evidence', 'build_evidence', 'coverage_evidence'].map(field => [field, field + ' observed']));
  const packet = packets.createPacket({ root: project, baseline, input, editLandingReceipt: receipt });
  const file = path.join(reviews, 'packet.json'); const marker = packets.writePacket(file, packet);
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ hooks }));
  const env = { ...process.env, HOME: base, ZENSU_CONFIG: path.join(base, 'config.json') };
  const options = { env };
  const task = (role, name = role, extra = '') => ({ toolName: 'task', isChild: false,
    toolArgs: { agent_type: 'zensu:' + role, mode: 'sync', name, description: name,
      prompt: (role === 'code-reviewer' ? 'PRE-MERGED FINDINGS (fan-out)\nREVIEW-TICKET: rt_test\n' : '') + marker + '\n' + extra } });
  const finish = (payload, text, overrides = {}) => gate.postReview(context, { ...payload, toolOutcome: 'completed',
    toolResult: { resultType: 'success', textResultForLlm: text }, ...overrides }, options);
  const start = payload => {
    const prepared = gate.preReview(context, payload, options);
    prepared.admit();
    return { ...payload, toolArgs: prepared.modifiedArgs };
  };
  return { base, project, pluginData, context, options, task, start, finish, update, receipt, receiptPath, file, marker, packet };
}

test('canonical bytes are injected identically; only a completed primary unlocks consume', t => {
  const f = fixture(t, { reviewPanel: 'full' });
  assert.throws(() => f.start(f.task('code-reviewer')), /primary judge has not completed/);
  const aspect = f.start(f.task('review-aspect', 'tests', 'perspective: tests'));
  const secondary = f.start(f.task('review-judge', 'secondary', 'merged_panel_findings: none\njudge_run: second'));
  assert.equal(aspect.toolArgs.prompt.slice(aspect.toolArgs.prompt.indexOf(gate.START)),
    secondary.toolArgs.prompt.slice(secondary.toolArgs.prompt.indexOf(gate.START)));
  f.finish(secondary, '## Aspect: judge (second run)\n- (no findings)');
  assert.throws(() => f.start(f.task('code-reviewer')), /primary judge has not completed/);
  const failed = f.start(f.task('review-judge', 'primary', 'merged_panel_findings: none'));
  assert.match(f.finish(failed, 'REVIEW PACKET INVALID: invented close marker'), /retry once/);
  assert.throws(() => f.start(f.task('code-reviewer')), /primary judge has not completed/);
  const retry = f.start(f.task('review-judge', 'primary-retry', 'merged_panel_findings: none'));
  f.finish(retry, '## Aspect: judge\n- (no findings)');
  const consume = f.start(f.task('code-reviewer'));
  f.finish(consume, '# Code Review Report\n## Summary\n- Verdict: PASS');
  assert.equal(core.readWorkflowState({ projectRoot: f.project, sessionId: f.context.sessionId }).reviewRound, 0);
});

test('reanchored native sessions review the authoritative project while host cwd stays unchanged', t => {
  const f = fixture(t, { reviewPanel: 'full' });
  const oldRoot = path.join(f.base, 'host-start'); fs.mkdirSync(oldRoot);
  core.initializeWorkflowState({ projectRoot: oldRoot, sessionId: f.context.sessionId });
  const oldState = core.readWorkflowState({ projectRoot: oldRoot, sessionId: f.context.sessionId });
  f.context.cwd = oldRoot;
  f.context.record.cwd = oldRoot;
  // Reanchor deliberately preserves the host lifecycle cwd and changes this
  // authoritative record. The next workflow begins under the new anchor.
  const recordsDir = path.join(f.pluginData, 'session-control', 'v1', 'records');
  fs.mkdirSync(recordsDir, { recursive: true, mode: 0o700 });
  core.registerContext({ recordsDir, sessionId: f.context.sessionId, host: 'copilot',
    projectRoot: f.project, pluginRoot, pluginData: f.pluginData });
  const noPacket = f.task('code-reviewer');
  noPacket.toolArgs.prompt = 'PRE-MERGED FINDINGS (fan-out)\nREVIEW-TICKET: rt_test\n';
  assert.throws(() => gate.preReview(f.context, noPacket, f.options), /canonical REVIEW-PACKET/);
  assert.throws(() => f.start(f.task('code-reviewer')), /primary judge has not completed/);
  const judge = f.start(f.task('review-judge'));
  assert.match(judge.toolArgs.prompt, /ZENSU CANONICAL REVIEW PACKET/);
  f.finish(judge, '## Aspect: judge\n- (no findings)');
  f.finish(f.start(f.task('code-reviewer')), '# Code Review Report\n- Verdict: PASS');
  assert.deepEqual(core.readWorkflowState({ projectRoot: oldRoot, sessionId: f.context.sessionId }), oldState);
  assert.equal(f.context.record.cwd, oldRoot);
  assert.equal(core.readContext({ recordsDir, sessionId: f.context.sessionId, expectedHost: 'copilot' }).project_root, f.project);
  // A present but damaged binding must never become a fallback to the idle host cwd.
  fs.writeFileSync(path.join(recordsDir, core.sessionKey(f.context.sessionId) + '.json'), '{}\n');
  assert.throws(() => gate.preReview(f.context, noPacket, f.options), /context|schema|record/i);
});

test('activated repository personas receive identical canonical evidence without gaining judge or main authority', t => {
  const type = 'zensu-review-domain';
  const f = fixture(t, { reviewPanel: 'full' }, project => {
    const agents = path.join(project, '.github', 'agents'); fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, type + '.agent.md'), '---\nname: ' + type
      + '\nactivation: "*.js"\ntools:\n  - view\n  - grep\n  - glob\n---\nReview domain rules.\n');
  });
  const request = f.task('review-aspect', 'custom-domain'); request.toolArgs.agent_type = type;
  const persona = f.start(request);
  const builtin = f.start(f.task('review-aspect', 'builtin-correctness'));
  assert.equal(persona.toolArgs.prompt.slice(persona.toolArgs.prompt.indexOf(gate.START)),
    builtin.toolArgs.prompt.slice(builtin.toolArgs.prompt.indexOf(gate.START)));
  // Even a persona that claims to be the primary judge cannot satisfy that stage.
  f.finish(persona, '## Aspect: judge\n- (no findings)');
  assert.throws(() => f.start(f.task('code-reviewer')), /primary judge has not completed/);
  const principals = require('../../src/plugin/hooks/lib/copilot-principal-v1.js');
  assert.equal(principals.classifySubagent(type), principals.PRINCIPALS.HOST);
  for (const identity of [{ agentType: 'copilot:unclassified' }, { agentName: 'unknown' },
    { parentAgentId: 'parent' }, { agentId: '' }, { isChild: true }]) {
    assert.equal(gate.preReview(f.context, { ...request, ...identity }, f.options), null);
    assert.equal(f.finish({ ...persona, ...identity }, '## Aspect: judge\n- (no findings)'), null);
  }
  assert.equal(gate.preReview({ ...f.context, nativeSessionId: 'unknown-child' }, request, f.options), null);
  assert.throws(() => f.start(f.task('code-reviewer')), /primary judge has not completed/);
  f.finish(f.start(f.task('review-judge')), '## Aspect: judge\n- (no findings)');
  assert.ok(f.start(f.task('code-reviewer')));
});

test('repository persona recognition rejects absent, mismatched, inactive and symlinked definitions', t => {
  const type = 'zensu-review-domain';
  for (const kind of ['absent', 'mismatched', 'inactive', 'symlink']) {
    const f = fixture(t, {}, project => {
      const agents = path.join(project, '.github', 'agents'); fs.mkdirSync(agents, { recursive: true });
      const file = path.join(agents, type + '.agent.md');
      if (kind === 'absent') return;
      if (kind === 'symlink') { fs.symlinkSync(path.join(project, 'source.js'), file); return; }
      fs.writeFileSync(file, '---\nname: ' + (kind === 'mismatched' ? 'zensu-review-other' : type)
        + (kind === 'inactive' ? '\nactivation: "*.py"' : '') + '\ntools: ["view", "grep", "glob"]\n---\nReview.\n');
    });
    const request = f.task('review-aspect', kind); request.toolArgs.agent_type = type;
    assert.throws(() => f.start(request), /ENOENT|does not match|symlink/, kind);
  }
});

test('two failed primary attempts leave the chain pending and refuse a third', t => {
  const f = fixture(t);
  for (let index = 0; index < 2; index++) {
    const attempt = f.start(f.task('review-judge', 'attempt-' + index));
    f.finish(attempt, '', { toolOutcome: 'error', toolResult: { resultType: 'failure', textResultForLlm: 'native task failed' } });
  }
  assert.throws(() => f.start(f.task('review-judge', 'third')), /failed twice/);
  assert.throws(() => f.start(f.task('code-reviewer')), /primary judge has not completed/);
});

test('inline packet references explain the standalone-line correction without relaxing the parser', t => {
  const f = fixture(t);
  const request = f.task('review-aspect');
  for (const malformed of ['Exact evidence reference: ' + f.marker, '- ' + f.marker,
    '`' + f.marker + '`', f.marker + ' extra text']) {
    assert.throws(() => gate.preReview(f.context, { ...request, toolArgs: { ...request.toolArgs, prompt: malformed } }, f.options),
      /on its own line.*without a prose prefix/);
  }
  assert.ok(f.start(request).toolArgs.prompt.includes(gate.START));
});

test('generation and round changes invalidate old completion even when packet bytes match', t => {
  const f = fixture(t, { reviewPanel: 'full' });
  f.finish(f.start(f.task('review-judge')), '## Aspect: judge\n- (no findings)');
  f.update({ reviewRound: 1 });
  assert.throws(() => f.start(f.task('code-reviewer')), /primary judge has not completed/);
  f.update({ reviewRound: 0, reviewGeneration: crypto.randomUUID() });
  assert.throws(() => f.start(f.task('code-reviewer')), /primary judge has not completed/);
});

test('native config disables primary or exempts only lean re-review; standalone calls retain host behavior', t => {
  const disabled = fixture(t, { reviewJudge: false });
  assert.ok(disabled.start(disabled.task('code-reviewer')));
  const lean = fixture(t, { reviewPanel: 'lean' }); lean.update({ reviewRound: 1 });
  assert.ok(lean.start(lean.task('code-reviewer')));
  const full = fixture(t, { reviewPanel: 'full' }); full.update({ reviewRound: 1 });
  assert.throws(() => full.start(full.task('code-reviewer')), /primary judge has not completed/);
  full.update({ active: false });
  assert.equal(gate.preReview(full.context, full.task('review-judge'), full.options), null);
});

test('model claims, child events, async dispatches and mismatched task names never prove primary completion', t => {
  const f = fixture(t);
  const task = f.task('review-judge');
  assert.throws(() => f.finish(task, '## Aspect: judge\n- (no findings)'), /no matching native pre-dispatch/);
  assert.throws(() => f.start({ ...task, toolArgs: { ...task.toolArgs, mode: 'background' } }), /mode: sync/);
  assert.equal(f.finish({ ...task, toolArgs: { ...task.toolArgs, mode: 'background' } }, '## Aspect: judge\n- (no findings)'), null);
  const dispatched = f.start(task);
  assert.equal(f.finish({ ...dispatched, isChild: true, agentId: 'child' }, '## Aspect: judge\n- (no findings)'), null);
  assert.throws(() => f.finish({ ...dispatched, toolArgs: { ...dispatched.toolArgs, name: 'different' } }, '## Aspect: judge\n- (no findings)'), /no matching native pre-dispatch/);
  assert.throws(() => f.start(f.task('code-reviewer')), /primary judge has not completed/);
});

test('source edits, foreign receipt, packet edits and symlink ancestry fail before dispatch', t => {
  const changed = fixture(t); fs.writeFileSync(path.join(changed.project, 'source.js'), 'changed again\n');
  assert.throws(() => changed.start(changed.task('review-judge')), /stale/);
  const foreign = fixture(t); fs.writeFileSync(foreign.receiptPath, JSON.stringify({ ...foreign.receipt, session: 'someone-else' }));
  assert.throws(() => foreign.start(foreign.task('review-judge')), /receipt does not match/);
  const altered = fixture(t); fs.chmodSync(altered.file, 0o600);
  fs.writeFileSync(altered.file, JSON.stringify({ ...altered.packet, payload: { ...altered.packet.payload, test_evidence: 'invented' } }));
  assert.throws(() => altered.start(altered.task('review-judge')), /hash/);
  const linked = fixture(t); const real = path.join(linked.base, 'external-reviews');
  fs.renameSync(path.dirname(linked.file), real); fs.symlinkSync(real, path.dirname(linked.file));
  assert.throws(() => linked.start(linked.task('review-judge')), /symlink/);
});

test('invalid consume reports stop downstream ticket advancement', t => {
  const f = fixture(t, { reviewJudge: false });
  const consume = f.start(f.task('code-reviewer'));
  assert.throws(() => f.finish(consume, 'REVIEW PACKET INVALID: missing fields'), /ticket remains unconsumed/);
  assert.equal(core.readWorkflowState({ projectRoot: f.project, sessionId: f.context.sessionId }).reviewRound, 0);
});

test('judge policy follows the existing global/project merge and explicit override semantics', t => {
  const f = fixture(t);
  const env = { ...f.options.env }; delete env.ZENSU_CONFIG;
  fs.mkdirSync(path.join(f.base, '.zensu'));
  fs.writeFileSync(path.join(f.base, '.zensu', 'config.json'), JSON.stringify({ hooks: { reviewJudge: false, reviewPanel: 'full' } }));
  fs.writeFileSync(path.join(f.project, '.zensu', 'config.json'), JSON.stringify({ hooks: { reviewJudge: true } }));
  assert.deepEqual(gate.configuration(f.context, f.project, env), { judge: true, panel: 'full' });
  fs.writeFileSync(path.join(f.project, '.zensu', 'config.json'), JSON.stringify({ hooks: { reviewJudge: 'false', reviewPanel: 'lean' } }));
  assert.deepEqual(gate.configuration(f.context, f.project, env), { judge: true, panel: 'lean' });
  assert.deepEqual(gate.configuration(f.context, f.project, f.options.env), { judge: true, panel: 'lean' });
});

test('denied prepared dispatch creates no pending attempt; admission happens once after all policies', t => {
  const f = fixture(t);
  const request = f.task('review-judge');
  const denied = gate.preReview(f.context, request, f.options);
  const retry = gate.preReview(f.context, request, f.options);
  assert.equal(denied.modifiedArgs.prompt, retry.modifiedArgs.prompt);
  retry.admit();
  assert.throws(() => denied.admit(), /already pending/);
  f.finish({ ...request, toolArgs: retry.modifiedArgs }, '## Aspect: judge\n- (no findings)');
  assert.ok(f.start(f.task('code-reviewer')));
});

test('legacy pending native workflow receives one generation without resetting ticket, budget or phase', t => {
  const f = fixture(t, { reviewPanel: 'full' });
  f.update({ reviewGeneration: undefined, reviewRound: 3, reviewTicket: 'rt_legacy', reviewTicketConsumed: false });
  const before = core.readWorkflowState({ projectRoot: f.project, sessionId: f.context.sessionId });
  assert.equal(Object.hasOwn(before, 'reviewGeneration'), false);
  gate.preReview(f.context, f.task('review-judge', 'first'), f.options);
  const migrated = core.readWorkflowState({ projectRoot: f.project, sessionId: f.context.sessionId });
  assert.match(migrated.reviewGeneration, /^[a-f0-9-]{36}$/);
  assert.equal(migrated.reviewRound, 3);
  assert.equal(migrated.reviewTicket, 'rt_legacy');
  assert.equal(migrated.reviewTicketConsumed, false);
  assert.equal(migrated.workflow_state, before.workflow_state);
  assert.equal(migrated.revision, before.revision + 1);
  gate.preReview(f.context, f.task('review-judge', 'second'), f.options);
  assert.equal(core.readWorkflowState({ projectRoot: f.project, sessionId: f.context.sessionId }).reviewGeneration, migrated.reviewGeneration);
});

test('malformed generation and dangling workflow symlink fail closed', t => {
  const malformed = fixture(t); malformed.update({ reviewGeneration: null });
  assert.throws(() => malformed.start(malformed.task('review-judge')), /malformed/);
  const linked = fixture(t);
  const file = core.adoptionWorkflowStatePath(linked.project, linked.context.sessionId);
  fs.rmSync(file); fs.symlinkSync(path.join(linked.base, 'missing'), file);
  assert.throws(() => linked.start(linked.task('review-judge')), /symlink/);
});

test('parallel native fan-out can create shared private directories without EEXIST failures', async t => {
  const f = fixture(t);
  const script = `const {safePath}=require(process.argv[1]); const path=require('node:path');
    process.stdin.once('data', () => { for(let i=0;i<20;i++) safePath(process.argv[2],
      path.join(process.argv[2], 'parallel', String(i), 'shared'), {directory:true,create:true}); process.exit(0); });
    process.stdout.write('ready');`;
  const runs = Array.from({ length: 6 }, () => {
    const child = spawn(process.execPath, ['-e', script, require.resolve('../../src/review-gate'), f.pluginData]);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const ready = new Promise((resolve, reject) => {
      child.stdout.once('data', resolve); child.once('error', reject);
    });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || 'child exited ' + code)));
    });
    return { child, ready, done };
  });
  await Promise.all(runs.map(run => run.ready));
  runs.forEach(run => run.child.stdin.end('start'));
  await Promise.all(runs.map(run => run.done));
});

test('non-Git workflows retain required native review and invalidate edits inside the declared file scope', t => {
  const f = fixture(t, { reviewPanel: 'full' });
  fs.rmSync(path.join(f.project, '.git'), { recursive: true });
  const input = { ...f.packet.payload, changed_files: ['source.js'] };
  const packet = packets.createPacket({ root: f.project, input, editLandingReceipt: f.receipt });
  const marker = packets.writePacket(path.join(path.dirname(f.file), 'non-git.json'), packet);
  const task = role => {
    const value = f.task(role);
    value.toolArgs.prompt = value.toolArgs.prompt.replace(f.marker, marker);
    return value;
  };
  assert.throws(() => f.start(task('code-reviewer')), /primary judge has not completed/);
  const judge = f.start(task('review-judge'));
  assert.match(judge.toolArgs.prompt, /Only explicitly listed session paths/);
  f.finish(judge, '## Aspect: judge\n- (no findings)');
  assert.ok(f.start(task('code-reviewer')));
  fs.writeFileSync(path.join(f.project, 'source.js'), 'changed after review\n');
  assert.throws(() => f.start(task('review-aspect')), /stale/);
});
