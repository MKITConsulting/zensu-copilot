'use strict';

// Native task admission/completion proof. The main thread can supply evidence,
// but only an observed synchronous tool completion can satisfy the judge stage.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const native = require('./context');
const TYPES = new Set(['zensu:review-aspect', 'zensu:review-judge', 'zensu:code-reviewer']);
const PERSONA = /^zensu-review-[A-Za-z0-9_-]+$/;
const START = '\n\n--- ZENSU CANONICAL REVIEW PACKET ---\n';
const END = '\n--- END ZENSU CANONICAL REVIEW PACKET ---';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safePath(base, file, { directory = false, create = false } = {}) {
  const canonical = fs.realpathSync(base);
  const target = path.resolve(file);
  const relative = path.relative(canonical, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Review path escapes its bound directory');
  }
  const parts = relative.split(path.sep);
  let current = canonical;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const isDirectory = index < parts.length - 1 || directory;
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create || !isDirectory) throw error;
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
      throw new Error('Review path contains an unsafe file or symlink');
    }
  }
  return target;
}

function active(context, payload, options = {}) {
  if (payload.toolName !== 'task' || !(TYPES.has(payload.toolArgs?.agent_type) || PERSONA.test(payload.toolArgs?.agent_type))) return null;
  const principals = require(path.join(context.pluginRoot, 'hooks/lib/copilot-principal-v1.js'));
  if (context.nativeSessionId !== context.sessionId
      || principals.classifyPreToolPayload(payload) !== principals.PRINCIPALS.MAIN) return null;
  const core = require(path.join(context.pluginRoot, 'hooks/lib/session-control-core-v1.js'));
  const binding = require(path.join(context.pluginRoot, 'hooks/lib/copilot-hook-session-v1.js'));
  const sessionPayload = { ...payload, sessionId: context.sessionId };
  const environment = native.nativeEnv(context, options.env);
  // Reanchoring changes Session Control's project, not the host lifecycle cwd.
  // Only a genuinely unregistered session may use the fresh-hook fallback;
  // existing invalid records retain the native binder's fail-closed semantics.
  const projectRoot = binding.unregisteredSession(sessionPayload, environment)
    ? binding.resolveFreshHookProject(sessionPayload, environment)
    : binding.bindAndDisclose(sessionPayload, environment, { autoAdopt: true }, 'zensu review gate').projectRoot;
  const stateFile = core.adoptionWorkflowStatePath(projectRoot, context.sessionId);
  try { fs.lstatSync(stateFile); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  safePath(projectRoot, stateFile);
  let state = core.readWorkflowState({ projectRoot, sessionId: context.sessionId });
  if (state.active !== true || state.implComplete !== true || state.chainDone === true) return null;
  // Native sessions from before generation binding retain their current ticket,
  // budget and phase. Bind once under the existing workflow CAS lock; never reset.
  for (let retry = 0; !Object.hasOwn(state, 'reviewGeneration') && retry < 2; retry++) {
    try {
      state = core.mutateWorkflowState({ projectRoot, sessionId: context.sessionId, actor: 'main-v1',
        expectedRevision: state.revision, workflowState: state.workflow_state, event: 'review-generation-bound' }, current => {
        if (!Object.hasOwn(current, 'reviewGeneration')) current.reviewGeneration = crypto.randomUUID();
        return current;
      });
    } catch (error) {
      if (!String(error.message).startsWith('stale workflow revision')) throw error;
      state = core.readWorkflowState({ projectRoot, sessionId: context.sessionId });
    }
  }
  if (state.active !== true || state.implComplete !== true || state.chainDone === true) return null;
  if (typeof state.reviewGeneration !== 'string' || !GENERATION.test(state.reviewGeneration)) {
    throw new Error('Active review generation identity is malformed; preserve the workflow state and diagnose it');
  }
  return { core, state, projectRoot,
    packetLib: require(path.join(context.pluginRoot, 'hooks/lib/review-packet-v1.js')) };
}

function validatePersona(context, type, packet) {
  if (!PERSONA.test(type)) return;
  // Repository personas remain host-profile children. Recognizing their parent
  // dispatch supplies evidence only; it grants neither tools nor judge authority.
  const file = safePath(packet.payload.root, path.join(packet.payload.root, '.github', 'agents', type + '.agent.md'));
  if (fs.lstatSync(file).size > 1024 * 1024) throw new Error('Review persona exceeds the bounded definition size');
  const personas = require(path.join(context.pluginRoot, 'hooks/lib/persona-activation.js'));
  const persona = personas.parsePersona(file);
  if (!persona || persona.name !== type) throw new Error('Review persona definition does not match its native name');
  if (persona.activation !== undefined && !personas.matchActivation(persona.activation, packet.payload.changed_files)) {
    throw new Error('Review persona activation does not match the canonical change set');
  }
}

function packetInput(context, payload, bound) {
  const prompt = payload.toolArgs.prompt;
  if (typeof prompt !== 'string') throw new Error('Review task prompt is missing');
  const matches = [...prompt.matchAll(/^REVIEW-PACKET: (.+) sha256:([a-f0-9]{64})$/gm)];
  if (matches.length !== 1) throw new Error('Active review requires exactly one canonical REVIEW-PACKET reference on its own line: REVIEW-PACKET: <absolute path> sha256:<hash>. Copy the helper output unchanged, without a prose prefix, bullet, quotes, backticks or appended text.');
  const [, suppliedPath, sha256] = matches[0];
  if (!path.isAbsolute(suppliedPath) || /[\r\n\0]/.test(suppliedPath)) throw new Error('Review packet path must be absolute');
  const reviews = path.join(bound.projectRoot, '.zensu', 'reviews');
  safePath(bound.projectRoot, reviews, { directory: true });
  const packetPath = safePath(reviews, suppliedPath);
  const packet = bound.packetLib.loadPacket(packetPath, sha256);
  const changes = bound.packetLib.collectChanges({ root: bound.projectRoot, baseline: packet.payload.baseline || '' });
  const changed = changes.kind === 'git'
    ? JSON.stringify(packet.payload.changed_files) !== JSON.stringify(changes.changed_files)
      || packet.payload.head !== changes.head || packet.payload.tree !== bound.packetLib.fingerprint(changes.root)
    : bound.packetLib.hash(bound.packetLib.explicitSnapshot(changes.root, packet.payload.changed_files)) !== packet.payload.content_snapshot;
  if (packet.payload.root !== changes.root || packet.payload.kind !== changes.kind || changed) {
    throw new Error('Review packet is stale: current tree/change set differs; refresh evidence and create a new packet');
  }
  const receiptFile = path.join(bound.projectRoot, '.zensu', 'state', 'edit-landing-' + bound.core.sessionKey(context.sessionId) + '.json');
  safePath(bound.projectRoot, receiptFile);
  const receipt = native.readPrivate(receiptFile);
  if (receipt?.session !== context.sessionId || packet.payload.edit_landing_receipt?.session !== context.sessionId
      || bound.packetLib.hash(receipt) !== bound.packetLib.hash(packet.payload.edit_landing_receipt)
      || bound.packetLib.landingEvidence(receipt) !== packet.payload.edit_landing_evidence) {
    throw new Error('Review packet receipt does not match this native session and current edit audit');
  }
  const injected = START + 'REVIEW PACKET v1\n' + JSON.stringify(packet.payload, null, 2) + END;
  let original = prompt;
  if (prompt.includes(START)) {
    if (!prompt.endsWith(injected) || prompt.indexOf(START) !== prompt.length - injected.length) {
      throw new Error('Canonical review packet injection was altered or duplicated');
    }
    original = prompt.slice(0, -injected.length);
  }
  const type = payload.toolArgs.agent_type;
  validatePersona(context, type, packet);
  const role = type === 'zensu:review-judge'
    ? (/^judge_run: second\s*$/m.test(original) ? 'secondary' : 'primary')
    : type === 'zensu:code-reviewer' ? 'consume' : 'aspect';
  const directory = path.join(context.pluginData, 'review-gate', 'v1', bound.core.sessionKey(context.sessionId),
    bound.state.reviewGeneration, 'round-' + (bound.state.reviewRound || 0), sha256);
  safePath(context.pluginData, directory, { directory: true, create: true });
  const request = { ...payload.toolArgs, prompt: original };
  const requestHash = bound.packetLib.hash(request);
  return { packet, original, injected, role, directory, requestHash, file: path.join(directory, requestHash + '.json'), request };
}

function configuration(context, projectRoot, env = process.env) {
  const result = spawnSync('bash', ['-c', 'source "$1"; if zensu_hook_enabled reviewJudge; then printf "judge=on\\n"; else printf "judge=off\\n"; fi; printf "panel="; zensu_review_panel; printf "\\n"',
    'zensu-review-gate', path.join(context.pluginRoot, 'hooks/lib/zensu-config.sh')], {
    cwd: projectRoot, env: { ...native.nativeEnv(context, env), COPILOT_PROJECT_DIR: projectRoot },
    encoding: 'utf8', timeout: 10000, maxBuffer: 4096,
  });
  const match = /^judge=(on|off)\npanel=(lean|full)\n$/.exec(result.stdout || '');
  if (result.status !== 0 || !match) throw new Error('Could not resolve native review judge configuration');
  return { judge: match[1] === 'on', panel: match[2] };
}

function records(directory) {
  return fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
    safePath(directory, path.join(directory, name));
    const record = native.readPrivate(path.join(directory, name));
    if (record?.schema !== 'zensu.native-review-dispatch-v1' || !Array.isArray(record.attempts)) {
      throw new Error('Invalid native review completion record');
    }
    return record;
  });
}

function preReview(context, payload, options = {}) {
  const bound = active(context, payload, options);
  if (!bound) return null;
  if (payload.toolArgs.mode !== 'sync') throw new Error('Active workflow reviewers must use native task mode: sync');
  const input = packetInput(context, payload, bound);
  const previous = records(input.directory);
  if (input.role === 'consume') {
    if (!/^PRE-MERGED FINDINGS \(fan-out\)\r?\nREVIEW-TICKET: [A-Za-z0-9_-]+\r?\n/.test(input.original)) {
      throw new Error('Active consume review requires the exact findings and ticket header');
    }
    const config = configuration(context, bound.projectRoot, options.env);
    const primaryRequired = config.judge && !(config.panel === 'lean' && bound.state.reviewRound > 0);
    if (primaryRequired && !previous.some(record => record.role === 'primary' && record.attempts.some(attempt => attempt.status === 'completed'))) {
      throw new Error('REVIEW INCOMPLETE: primary judge has not completed for this generation, round and packet. Retry the primary once; the additive second judge cannot substitute.');
    }
  }
  const record = native.readPrivate(input.file) || { schema: 'zensu.native-review-dispatch-v1', role: input.role,
    requestHash: input.requestHash, packetHash: input.packet.sha256, generation: bound.state.reviewGeneration,
    round: bound.state.reviewRound || 0, attempts: [] };
  if (record.attempts.some(attempt => attempt.status === 'pending')) throw new Error('Identical native review dispatch is already pending; wait for its completion');
  if (input.role === 'primary' && previous.filter(item => item.role === 'primary')
    .flatMap(item => item.attempts).filter(attempt => attempt.status === 'failed').length >= 2) {
    throw new Error('REVIEW INCOMPLETE: primary judge failed twice; preserve both results and leave this chain pending');
  }
  return { modifiedArgs: { ...payload.toolArgs, prompt: input.original + input.injected }, admit() {
    // The dispatcher invokes this only after every policy has permitted the
    // dispatch. A denial/timeout before native execution creates no pending call.
    const current = active(context, payload, options);
    if (!current || current.state.reviewGeneration !== bound.state.reviewGeneration
        || current.state.reviewRound !== bound.state.reviewRound) throw new Error('Review generation changed before admission');
    const checked = packetInput(context, payload, current);
    const latest = native.readPrivate(checked.file) || record;
    if (latest.attempts.some(attempt => attempt.status === 'pending')) throw new Error('Identical native review dispatch is already pending');
    latest.attempts.push({ status: 'pending', startedAt: new Date().toISOString() });
    native.writePrivate(checked.file, latest);
  } };
}

function postReview(context, payload, options = {}) {
  const bound = active(context, payload, options);
  if (!bound) return null;
  if (payload.toolArgs.mode !== 'sync') return null;
  const completed = payload.toolOutcome === 'completed' && payload.toolResult?.resultType === 'success';
  const input = packetInput(context, payload, bound);
  const record = native.readPrivate(input.file);
  const attempt = record?.attempts?.at(-1);
  if (!record || attempt?.status !== 'pending' || record.requestHash !== input.requestHash) {
    if (!completed) return null;
    throw new Error('Completed review has no matching native pre-dispatch proof; no stage or ticket was advanced');
  }
  const text = payload.toolResult.textResultForLlm;
  let valid = completed && typeof text === 'string' && text.trim() && !text.includes('REVIEW PACKET INVALID');
  if (input.role === 'primary') valid = valid && bound.packetLib.validatePrimaryResult(text);
  if (input.role === 'consume') valid = valid && /^# Code Review Report\s*$/m.test(text) && /^- Verdict: (?:PASS|PASS WITH SUGGESTIONS|NEEDS CHANGES)\s*$/m.test(text);
  attempt.status = valid ? 'completed' : 'failed';
  attempt.completedAt = new Date().toISOString();
  attempt.resultHash = digest(typeof text === 'string' ? text : '');
  if (!valid) attempt.reason = String(text || 'empty native result').slice(0, 2000);
  native.writePrivate(input.file, record);
  if (!valid && input.role === 'consume') throw new Error('REVIEW INCOMPLETE: consume reviewer returned an invalid report; the review ticket remains unconsumed');
  if (!valid && input.role === 'primary') return 'Zensu: the primary judge result was not a substantive completed review. Preserve the failed result and retry once with the same canonical packet; never substitute the additive second judge or report completion.';
  return null;
}

module.exports = { preReview, postReview, safePath, configuration, START, END };
