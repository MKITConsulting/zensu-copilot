const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
let createProvider, normalizeEvents, parseWorkspace, hash, processObservation, parseArgs, run;
test.before(async () => {
  ({createProvider, normalizeEvents, parseWorkspace, hash, processObservation} = await import('../../src/session-trail/provider.mjs'));
  ({parseArgs, run} = await import('../../src/session-trail/trail.mjs'));
});

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-copilot-trail-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const home = path.join(root, 'home');
  const data = path.join(root, 'plugin');
  const cwd = path.join(root, 'project');
  const now = Date.now();
  fs.mkdirSync(cwd, {recursive: true});
  const env = {COPILOT_HOME: home, COPILOT_PLUGIN_DATA: data, COPILOT_SESSION_ID: B};
  const event = (type, payload, offset = 0, extra = {}) => ({id: `e-${offset}-${type}`, timestamp: new Date(now - 3600000 + offset).toISOString(), parentId: null, type, data: payload, ...extra});
  function session(id, events = [], registry = {status: 'ended'}) {
    const directory = path.join(home, 'session-state', id);
    fs.mkdirSync(directory, {recursive: true});
    const all = [event('session.start', {sessionId: id, version: 1, producer: 'copilot-agent', copilotVersion: '1.0.98', startTime: new Date(now - 3600000).toISOString(), context: {cwd, branch: 'feature/example'}}), ...events];
    const transcript = path.join(directory, 'events.jsonl');
    fs.writeFileSync(transcript, all.map(item => JSON.stringify(item)).join('\n') + '\n');
    if (registry) {
      fs.mkdirSync(path.join(data, 'copilot-sessions'), {recursive: true});
      fs.writeFileSync(path.join(data, 'copilot-sessions', `${hash(id)}.json`), JSON.stringify({schemaVersion: 1, sessionId: id, cwd,
        pid: process.pid, startedAt: new Date(now - 3600000).toISOString(), updatedAt: new Date(now).toISOString(), transcriptPath: transcript, ...registry}));
    }
    return transcript;
  }
  const options = {env, cwd, now};
  return {root, home, data, cwd, env, now, event, session, options};
}

test('normalizes documented events without promoting event parentId to a session link', () => {
  const text = [
    {type: 'session.start', timestamp: '2026-01-01T00:00:00Z', parentId: C, data: {sessionId: A, context: {cwd: '/project', branch: 'main'}}},
    {type: 'user.message', timestamp: '2026-01-01T00:01:00Z', data: {content: 'Build the feature'}},
    {type: 'assistant.message', timestamp: '2026-01-01T00:02:00Z', data: {content: 'Implemented'}},
    {type: 'session.compaction_complete', data: {success: true, summaryContent: 'Keep this state'}},
  ].map(JSON.stringify).join('\n');
  const result = normalizeEvents(text, A);
  assert.equal(result.cwd, '/project');
  assert.equal(result.lastPrompt, 'Build the feature');
  assert.equal(result.compaction, 'Keep this state');
  assert.equal(result.forkedFrom, null);
  assert.deepEqual(result.queue, {state: 'unknown', pending: null});
});

test('rejects a transcript whose native identity differs from its directory', () => {
  assert.throws(() => normalizeEvents(JSON.stringify({type: 'session.start', data: {sessionId: B}}), A), /identity/);
});

test('keeps generated prompts and subagent output out of the user timeline', () => {
  const rows = [
    {type: 'user.message', data: {content: 'real user'}},
    {type: 'user.message', data: {content: 'hidden skill', source: 'skill-example'}},
    {type: 'user.message', data: {content: 'continue', isAutopilotContinuation: true}},
    {type: 'assistant.message', agentId: 'child-1', data: {content: 'child answer'}},
  ];
  const result = normalizeEvents(rows.map(JSON.stringify).join('\n'), A);
  assert.equal(result.lastPrompt, 'real user');
  assert.equal(result.prompts.length, 1);
  assert.deepEqual(result.assistantTail, []);
  assert.equal(result.sourceMessages, 2);
});

test('unknown and malformed events are disclosed', () => {
  const result = normalizeEvents('{bad\n' + JSON.stringify({type: 'future.event', data: {}}), A);
  assert.equal(result.malformedEvents, 1);
  assert.deepEqual(result.unknownEventTypes, ['future.event']);
});

test('workspace metadata supplies native titles without evaluating YAML objects or aliases', t => {
  const f = fixture(t); f.session(A);
  const file = path.join(f.home, 'session-state', A, 'workspace.yaml');
  fs.writeFileSync(file, `id: ${A}\nname: 'User''s session'\ncwd: ${JSON.stringify(f.cwd)}\nbranch: feat/native\n`);
  const row = createProvider(f.options).list()[0];
  assert.equal(row.title, "User's session"); assert.equal(row.branch, 'feat/native');
  assert.throws(() => parseWorkspace('name: *secret'), /unsupported/);
  assert.throws(() => parseWorkspace('name: one\nname: two'), /duplicate/);
});
test('internal custom-agent aliases are never advertised as standalone resumable sessions', t => {
  const f = fixture(t);
  f.session(A);
  f.session(B, [], { status: 'active', rootSessionId: A, parentAgentId: A });
  assert.deepEqual(createProvider(f.options).list().map(row => row.sessionId), [A]);
});

test('workspace identity mismatch is disclosed and cannot redirect cwd', t => {
  const f = fixture(t); f.session(A);
  fs.writeFileSync(path.join(f.home, 'session-state', A, 'workspace.yaml'), `id: ${B}\ncwd: /outside\n`);
  const provider = createProvider(f.options);
  assert.equal(provider.list()[0].cwd, f.cwd);
  assert.ok(provider.diagnostics.some(item => item.source === 'workspace'));
});

test('list omits the deep prompt and assistant transcript fields', t => {
  const f = fixture(t); f.session(A, [f.event('user.message', {content: 'one'}, 1)]);
  const row = run(['list', '--json'], f.options).value.rows[0];
  assert.equal(Object.hasOwn(row, 'prompts'), false);
  assert.equal(Object.hasOwn(row, 'assistantTail'), false);
});

test('the full ten-command surface is registered and foreign flags are refused', () => {
  for (const command of ['list', 'instances', 'limited', 'lineage']) assert.equal(parseArgs([command]).command, command);
  for (const command of ['show', 'handoff', 'takeover', 'adopt', 'release']) assert.equal(parseArgs([command, A]).command, command);
  assert.equal(parseArgs(['label', A, 'My session']).command, 'label');
  assert.throws(() => parseArgs(['takeover', A, '--forget', B, '--apply']), /not supported/);
  assert.throws(() => parseArgs(['lineage', '--where', A, '--backfill']), /mutually exclusive/);
  assert.throws(() => parseArgs(['lineage', '--apply']), /requires/);
  assert.throws(() => parseArgs(['show', A, '--prompts', '--json']), /operand/);
  assert.throws(() => parseArgs(['show', A, '--prompts', 'NaN']), /integer/);
});

test('enumerates a native session store and keeps all host files read-only', t => {
  const f = fixture(t);
  const transcript = f.session(A, [f.event('user.message', {content: 'Hello'}, 100)]);
  const before = fs.readFileSync(transcript);
  const result = run(['show', A, '--json', '--no-git'], f.options).value;
  assert.equal(result.session.lastPrompt, 'Hello');
  assert.equal(result.session.liveness.state, 'ended');
  assert.equal(result.continuation.resume, `copilot --resume '${A}'`);
  assert.deepEqual(fs.readFileSync(transcript), before);
  assert.equal(result.session.metadata.account, 'unavailable');
});

test('missing registry is unknown rather than ended', t => {
  const f = fixture(t); f.session(A, [], null);
  const row = createProvider(f.options).list()[0];
  assert.equal(row.liveness.state, 'unknown');
  assert.equal(row.liveness.reason, 'registry-unavailable');
  assert.equal(row.live, null);
});

test('PID reuse cannot be inferred away when the registry has no process start identity', () => {
  assert.deepEqual(processObservation({status: 'active', pid: process.pid, updatedAt: new Date().toISOString()}),
    {state: 'unknown', reason: 'pid-alive-without-start-identity'});
});

test('instances includes uncertain registry candidates with their uncertainty', t => {
  const f = fixture(t); f.session(A, [], {status: 'active'});
  const value = run(['instances', '--json'], f.options).value;
  assert.equal(value.rows.length, 1);
  assert.equal(value.rows[0].liveness.state, 'unknown');
});

test('malformed registry records are reported, not used as identity', t => {
  const f = fixture(t); f.session(A);
  fs.writeFileSync(path.join(f.data, 'copilot-sessions', `${hash(A)}.json`), JSON.stringify({schemaVersion: 1, sessionId: B, status: 'active'}));
  const provider = createProvider(f.options);
  assert.equal(provider.list()[0].registry, null);
  assert.ok(provider.diagnostics.some(item => item.source === 'registry' && /identity/.test(item.error)));
});

test('rejects symlinked session directories without reading their contents', t => {
  const f = fixture(t); f.session(A);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'events.jsonl'), JSON.stringify({type: 'user.message', data: {content: 'private outside'}}));
  fs.symlinkSync(outside, path.join(f.home, 'session-state', C));
  const row = createProvider(f.options).list().find(item => item.sessionId === C);
  assert.match(row.transcriptError, /symlink/);
  assert.equal(row.lastPrompt, null);
});

test('does not trust a registry-provided transcript path outside native storage', t => {
  const f = fixture(t); f.session(A, [], {status: 'ended', transcriptPath: '/secret/outside'});
  const row = createProvider(f.options).list()[0];
  assert.equal(row.transcript, path.join(f.home, 'session-state', A, 'events.jsonl'));
});

test('large transcripts retain their identity and recent tail while explicitly marking omission', t => {
  const f = fixture(t);
  const file = f.session(A);
  const middle = JSON.stringify(f.event('session.info', {infoType: 'test', message: 'x'.repeat(4096)}, 1)) + '\n';
  const fd = fs.openSync(file, 'a');
  for (let index = 0; index < 4200; index += 1) fs.writeSync(fd, middle);
  fs.writeSync(fd, JSON.stringify(f.event('user.message', {content: 'latest instruction'}, 2)) + '\n');
  fs.closeSync(fd);
  const row = createProvider(f.options).list()[0];
  assert.equal(row.cwd, f.cwd); assert.equal(row.lastPrompt, 'latest instruction');
  assert.equal(row.truncated, true); assert.equal(row.transcriptError, null);
});

test('explicit config roots isolate lookup from the ambient Copilot home', t => {
  const f = fixture(t); f.session(A);
  const provider = createProvider({...f.options, configDir: path.join(f.root, 'other'), env: {}});
  assert.deepEqual(provider.list(), []);
});

test('scope filters unrelated repositories and --all explicitly widens the view', t => {
  const f = fixture(t); f.session(A);
  const different = path.join(f.root, 'different'); fs.mkdirSync(different);
  assert.equal(run(['list', '--no-git', '--json'], {...f.options, cwd: different}).value.rows.length, 0);
  assert.equal(run(['list', '--all', '--no-git', '--json'], {...f.options, cwd: different}).value.rows.length, 1);
});

test('selectors require an unambiguous exact ID or a prefix of at least six characters', t => {
  const f = fixture(t); f.session(A); f.session('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const provider = createProvider(f.options);
  assert.throws(() => provider.resolve('111111'), /ambiguous/);
  assert.throws(() => provider.resolve('111'), /not found/);
  assert.equal(provider.resolve(A).sessionId, A);
});

test('zero prompt limit shows no prompts rather than all history', t => {
  const f = fixture(t); f.session(A, [f.event('user.message', {content: 'one'}, 1)]);
  assert.deepEqual(run(['show', A, '--prompts', '0', '--no-git', '--json'], f.options).value.session.prompts, []);
});

test('handoff renders a brief without writing it or creating lineage', t => {
  const f = fixture(t); f.session(A, [f.event('user.message', {content: 'continue from here'}, 1)]);
  const result = run(['handoff', A, '--no-git'], f.options);
  assert.match(result.output, /untrusted session data/);
  assert.match(result.output, /continue from here/);
  assert.equal(fs.existsSync(result.value.handoffPath), false);
  assert.equal(fs.existsSync(path.join(f.home, 'zensu-copilot')), false);
});

test('takeover --no-record works without current identity and does not run Copilot', t => {
  const f = fixture(t); f.session(A, [], null);
  const result = run(['takeover', A, '--no-record', '--no-git', '--json'], {...f.options, env: {...f.env, COPILOT_SESSION_ID: ''}}).value;
  assert.equal(result.recorded, null);
  assert.equal(result.session.liveness.state, 'unknown');
});

test('takeover refuses uncertain activity unless --force or --no-record is explicit', t => {
  const f = fixture(t); f.session(A, [], {status: 'active'}); f.session(B);
  assert.throws(() => run(['takeover', A, '--no-git'], f.options), /busy or unknown/);
});

test('takeover records a provisional edge and lineage resolves its destination', t => {
  const f = fixture(t); f.session(A); f.session(B);
  const value = run(['takeover', A, '--no-git', '--json'], f.options).value;
  assert.equal(value.recorded.edge.confidence, 'provisional');
  assert.equal(value.recorded.edge.from.sessionId, A);
  assert.equal(value.recorded.edge.to.sessionId, B);
  const lineage = run(['lineage', '--where', A, '--json'], f.options).value;
  assert.equal(lineage.current, B);
  assert.equal(lineage.links.length, 1);
});

test('adopt refuses a self-loop and honors the lineage opt-out', t => {
  const f = fixture(t); f.session(A); f.session(B);
  assert.throws(() => run(['adopt', B], f.options), /itself/);
  assert.throws(() => run(['adopt', A], {...f.options, env: {...f.env, ZENSU_SESSION_LINEAGE: 'off'}}), /disabled/);
});

test('lineage deletion is previewed and requires --apply', t => {
  const f = fixture(t); f.session(A); f.session(B);
  run(['adopt', A], f.options);
  const preview = run(['lineage', '--forget', A, '--json'], f.options).value;
  assert.equal(preview.dryRun, true); assert.equal(preview.files.length, 1);
  assert.equal(run(['lineage', '--where', A, '--json'], f.options).value.found, true);
  const applied = run(['lineage', '--forget', A, '--apply', '--json'], f.options).value;
  assert.equal(applied.removed.length, 1);
  assert.equal(run(['lineage', '--where', A, '--json'], f.options).value.found, false);
});

test('forget removes every duplicate edge file rather than only the display winner', t => {
  const f = fixture(t); f.session(A); f.session(B);
  run(['adopt', A], f.options); run(['adopt', A], f.options);
  const value = run(['lineage', '--forget', A, '--apply', '--json'], f.options).value;
  assert.equal(value.removed.length, 2);
});

test('label and remove affect only per-session plugin labels', t => {
  const f = fixture(t); f.session(A);
  run(['label', A, 'Migration session'], f.options);
  assert.equal(run(['list', '--json', '--no-git'], f.options).value.rows[0].label, 'Migration session');
  run(['label', '--remove', A], f.options);
  assert.equal(run(['list', '--json', '--no-git'], f.options).value.rows[0].label, null);
});

test('release previews then records handover completion without changing the registry', t => {
  const f = fixture(t); f.session(A); f.session(B);
  const file = path.join(f.data, 'copilot-sessions', `${hash(A)}.json`);
  const before = fs.readFileSync(file);
  assert.equal(run(['release', A, '--no-git', '--json'], f.options).value.file, null);
  const value = run(['release', A, '--apply', '--no-git', '--json'], f.options).value;
  assert.equal(JSON.parse(fs.readFileSync(value.file)).kind, 'handover-complete');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.match(value.note, /no session, process, transcript or worktree was modified/);
});

test('rate-limit recovery requires a later completed main-agent turn', t => {
  const f = fixture(t);
  f.session(A, [f.event('session.error', {errorType: 'rate_limit', errorCode: 'user_weekly_rate_limited', message: 'Too many requests'}, 1)]);
  f.session(B, [f.event('session.error', {errorType: 'quota', message: 'Quota'}, 1), f.event('assistant.turn_end', {turnId: '1'}, 2)]);
  const value = run(['limited', '--no-git', '--json'], f.options).value;
  assert.equal(value.stalled[0].sessionId, A);
  assert.equal(value.recovered[0].sessionId, B);
  assert.equal(value.stalled[0].lastRateLimit.classification, 'structured');
});

test('linked continuation and backfill use explicit native parent metadata', t => {
  const f = fixture(t); f.session(A); f.session(B);
  f.session(C, [f.event('session.start', {sessionId: C, detachedFromSpawningParentSessionId: A, context: {cwd: f.cwd}}, 1)]);
  const value = run(['show', A, '--no-git', '--json'], f.options).value;
  assert.equal(value.continuation.linkedSessions[0].sessionId, C);
  const preview = run(['lineage', '--backfill', '--all', '--json'], f.options).value;
  assert.equal(preview.edges.length, 1); assert.equal(preview.edges[0].confidence, 'inferred');
  run(['lineage', '--backfill', '--all', '--apply'], f.options);
  assert.equal(run(['lineage', '--where', A, '--json'], f.options).value.current, C);
});

test('symlinked lineage storage refuses a write rather than escaping the host namespace', t => {
  const f = fixture(t); f.session(A); f.session(B);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.home, 'zensu-copilot'));
  assert.throws(() => run(['adopt', A], f.options), /symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('CLI produces parseable JSON and diagnostics on stderr with a nonzero exit', t => {
  const f = fixture(t); f.session(A);
  const script = path.resolve(__dirname, '../../src/session-trail/trail.mjs');
  const okay = spawnSync(process.execPath, [script, 'list', '--all', '--json'], {env: {...process.env, ...f.env}, cwd: f.cwd, encoding: 'utf8'});
  assert.equal(okay.status, 0); assert.equal(JSON.parse(okay.stdout).rows[0].sessionId, A);
  const bad = spawnSync(process.execPath, [script, 'takeover', A, '--forget', B], {env: {...process.env, ...f.env}, cwd: f.cwd, encoding: 'utf8'});
  assert.equal(bad.status, 1); assert.equal(bad.stdout, ''); assert.match(bad.stderr, /not supported/);
});
