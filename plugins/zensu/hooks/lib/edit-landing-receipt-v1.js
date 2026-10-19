'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const RECEIPT_SCHEMAS = Object.freeze({ 'edit-landing-v1': 1, 'edit-landing-v2': 2 });
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const EXIT = Object.freeze({ ok: 0, usage: 2, none: 3 });

function readBoundedJson(filePath, maxBytes) {
  let descriptor;
  let before;
  try {
    before = fs.lstatSync(filePath);
    if (before.isSymbolicLink()) return { invalid: 'unreadable (symlink)' };
    const noFollow = process.platform !== 'win32' && Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
    const flags = fs.constants.O_RDONLY | noFollow | (fs.constants.O_NONBLOCK || 0);
    descriptor = fs.openSync(filePath, flags);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { absent: true };
    return { invalid: `unreadable (${(error && error.code) || 'error'})` };
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return { invalid: 'not a regular file' };
    if (stat.dev !== before.dev || stat.ino !== before.ino) return { invalid: 'unreadable (replaced)' };
    if (stat.size > maxBytes) return { invalid: 'oversized' };
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = fs.readSync(descriptor, buffer, offset, stat.size - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    if (offset !== stat.size) return { invalid: 'short read' };
    return { value: JSON.parse(buffer.toString('utf8')) };
  } catch (error) {
    return { invalid: error && error.code ? `unreadable (${error.code})` : 'unparseable' };
  } finally {
    try { fs.closeSync(descriptor); } catch { }
  }
}

function canonical(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function isOutside(relative) {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function resolveRunLog(projectRoot, logValue) {
  if (typeof projectRoot !== 'string' || projectRoot === '') return { reason: 'no project root is bound' };
  if (typeof logValue !== 'string' || logValue === '') return { reason: 'no run log was named' };
  const root = canonical(path.resolve(projectRoot));
  const logsDirRaw = path.join(root, '.zensu', 'logs');
  try {
    if (fs.lstatSync(logsDirRaw).isSymbolicLink()) return { reason: 'the project .zensu/logs directory is a symlink' };
  } catch { }
  const logsDir = canonical(logsDirRaw);
  if (isOutside(path.relative(root, logsDir))) return { reason: 'the project .zensu/logs directory resolves outside the project root' };
  const raw = path.resolve(root, logValue);
  const resolved = path.join(canonical(path.dirname(raw)), path.basename(raw));
  const relative = path.relative(logsDir, resolved);
  if (relative === '' || isOutside(relative)) return { reason: 'the run log is not inside the project .zensu/logs directory' };
  if (!resolved.endsWith('.log')) return { reason: 'the run log does not end in .log' };
  return {
    root,
    logRel: path.relative(root, resolved).split(path.sep).join('/'),
    stem: path.basename(resolved, '.log'),
  };
}

function receiptRunLog(options) {
  const loaded = readBoundedJson(options.receiptPath, options.maxBytes || MAX_RECEIPT_BYTES);
  if (loaded.absent) return { status: 'absent' };
  if (loaded.invalid) return { status: 'invalid', reason: `the edit-landing receipt is ${loaded.invalid}` };
  const receipt = loaded.value;
  const version = receipt && typeof receipt === 'object' && Object.prototype.hasOwnProperty.call(RECEIPT_SCHEMAS, receipt.schema)
    ? RECEIPT_SCHEMAS[receipt.schema]
    : 0;
  if (!version || typeof receipt.log !== 'string' || receipt.log === '') {
    return { status: 'invalid', reason: 'the edit-landing receipt names no run log under a known schema' };
  }
  const resolved = resolveRunLog(options.projectRoot, receipt.log);
  if (resolved.reason) return { status: 'invalid', reason: resolved.reason };
  return { status: 'ok', root: resolved.root, logRel: resolved.logRel, stem: resolved.stem };
}

// The shell owns claim parsing and Git membership. This module binds that
// grading to an append-only audit scope and verifies literal predicate evidence.
// A retry cannot turn PENDING into LANDED by dropping its original arguments.
const SCOPE_SCHEMA = 'edit-landing-scope-v1';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function auditFail(message) { throw new Error('edit-landing audit: ' + message); }
function bytes(file, limit = MAX_FILE_BYTES) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) auditFail('expected a bounded regular file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) auditFail('file changed while opening it');
    const value = fs.readFileSync(fd);
    if (value.length > limit) auditFail('file exceeds audit size limit');
    return value;
  } finally { fs.closeSync(fd); }
}
function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value)
      || path.isAbsolute(value) || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
      || value.split('/').some(part => part === '..' || part === '.git')) auditFail('expected a normalized source path inside the project');
  return value;
}
function snapshot(root, file) {
  relativeFile(file);
  const parts = file.split('/');
  let target = root;
  for (let i = 0; i < parts.length; i++) {
    target = path.join(target, parts[i]);
    let stat;
    try { stat = fs.lstatSync(target); }
    catch (error) { if (error.code === 'ENOENT') return { path: file, exists: false }; throw error; }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) auditFail('claimed path contains a symlink or unsupported file');
  }
  const value = bytes(target);
  return { path: file, exists: true, bytes: value.length, sha256: digest(value) };
}
function generation(root, session) {
  if (!session) return null;
  const core = require('./session-control-core-v1.js');
  const target = path.join(root, '.zensu', 'state', 'tdd-phase-' + core.sessionKey(session) + '.json');
  const loaded = readBoundedJson(target, MAX_RECEIPT_BYTES);
  if (loaded.absent) return null;
  if (loaded.invalid) auditFail('workflow state is unreadable');
  const value = loaded.value.reviewGeneration;
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) auditFail('workflow generation is invalid');
  return value;
}
function logPrefix(log, previous) {
  const value = bytes(log);
  if (previous && (!Number.isSafeInteger(previous.bytes) || previous.bytes < 0
      || value.length < previous.bytes || digest(value.subarray(0, previous.bytes)) !== previous.sha256)) {
    auditFail('the audited run log was rewritten; preserve its append-only history');
  }
  return { bytes: value.length, sha256: digest(value) };
}
function prepareScope(options) {
  const root = fs.realpathSync(options.root), log = fs.realpathSync(options.log);
  const claimRoot = fs.realpathSync(options.claimRoot || root);
  const sessionKey = options.session ? require('./session-control-core-v1.js').sessionKey(options.session) : null;
  const currentGeneration = generation(root, options.session);
  let previous = null, legacyUnresolved = false;
  if (options.receipt && options.receipt !== '-') {
    const loaded = readBoundedJson(options.receipt, MAX_RECEIPT_BYTES);
    if (loaded.invalid) auditFail('the previous receipt is unreadable; it cannot be silently replaced');
    if (loaded.value && !loaded.value.auditScope) legacyUnresolved = loaded.value.clean !== true
      || ['pending', 'notLanded', 'unverified'].some(field => loaded.value[field] > 0);
    if (loaded.value && loaded.value.auditScope) {
      const scope = loaded.value.auditScope;
      if (scope.schema !== SCOPE_SCHEMA) auditFail('unknown persisted audit scope');
      if (scope.sessionKey !== sessionKey || scope.root !== root) auditFail('receipt belongs to another session or project');
      if (scope.generation === currentGeneration) {
        if ((scope.claimRoot || scope.root) !== claimRoot) auditFail('the audited repository root changed');
        if (scope.log !== log) auditFail('this generation is already bound to a different run log');
        previous = scope;
        legacyUnresolved = scope.legacyUnresolved === true;
      }
    }
  }
  const prefix = logPrefix(log, previous && previous.logPrefix);
  const inherited = (name, supplied) => {
    const old = previous && previous[name];
    if (old && supplied !== undefined && supplied !== old) auditFail(name + ' cannot be weakened or changed within this generation');
    return supplied === undefined ? old || '' : supplied;
  };
  const dirty = new Set(previous ? previous.dirty : []);
  if (options.dirty !== undefined) {
    if (!options.dirty) auditFail('--dirty-before requires an existing file');
    for (const file of bytes(options.dirty, MAX_RECEIPT_BYTES).toString('utf8').split(/\r?\n/).filter(Boolean)) dirty.add(relativeFile(file));
  }
  return { schema: SCOPE_SCHEMA, root, claimRoot, log, sessionKey, generation: currentGeneration,
    baseline: inherited('baseline', options.baseline), epoch: inherited('epoch', options.epoch),
    dirty: [...dirty].sort(), logPrefix: prefix, previous, legacyUnresolved };
}
function checkpointScope(scope, receiptPath, session) {
  if (!receiptPath || receiptPath === '-') return;
  if (!path.isAbsolute(receiptPath) || /edit-landing-\.json$/.test(receiptPath)) auditFail('receipt checkpoint requires an absolute valid destination');
  const directory = path.dirname(receiptPath), parsed = path.parse(directory);
  let current = parsed.root;
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch (created) { if (created.code !== 'EEXIST') throw created; }
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) auditFail('receipt checkpoint ancestor is not a safe directory');
  }
  try {
    const stat = fs.lstatSync(receiptPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) auditFail('receipt checkpoint destination is not a regular file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const previous = scope.previous || {};
  const auditScope = { ...scope, claims: previous.claims || [], snapshots: previous.snapshots || {}, observedFiles: previous.observedFiles || [], tree: previous.tree || null };
  delete auditScope.previous;
  const value = { schema: 'edit-landing-v2', session, log: path.relative(scope.root, scope.log).split(path.sep).join('/'),
    claims: auditScope.claims.length, landed: 0, notLanded: 0, unverified: auditScope.claims.length,
    pending: 0, exemptIgnored: 0, exemptVerified: 0, clean: false,
    auditFailure: 'The current audit has not completed. Rerun it; its cumulative context is preserved.', auditScope };
  const encoded = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(encoded) > MAX_RECEIPT_BYTES) auditFail('receipt scope exceeds size limit');
  const temporary = receiptPath + '.checkpoint-' + crypto.randomUUID();
  try {
    fs.writeFileSync(temporary, encoded, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, receiptPath);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function parseManifest(file) {
  const records = bytes(file, MAX_RECEIPT_BYTES).toString('utf8').split('\n').filter(Boolean).map(line => {
    const [step, raw, resolved, ...extra] = line.split('\t');
    if (extra.length || !step || raw === undefined || resolved === undefined) auditFail('invalid claim manifest');
    return { step, raw, path: resolved || null };
  });
  if (records.length > 2000) auditFail('claim budget exceeded');
  return records;
}
function verifyPredicates(root, file, claims, snapshots, observedFiles, baseline) {
  if (!file) return new Set();
  const loaded = JSON.parse(bytes(file, MAX_RECEIPT_BYTES).toString('utf8'));
  if (!loaded || loaded.schema !== 'edit-landing-predicates-v1' || !Array.isArray(loaded.claims) || loaded.claims.length > 2000) auditFail('invalid predicate proof document');
  const proved = new Set();
  for (const proof of loaded.claims) {
    if (!proof || typeof proof.step !== 'string' || !proof.step || proof.step.length > 512) auditFail('predicate proof requires an exact claim step');
    const filePath = relativeFile(proof.path);
    const matches = claims.map((claim, index) => claim.step === proof.step && claim.path === filePath ? index : -1).filter(index => index >= 0);
    if (!matches.length) auditFail('predicate proof names no current claim');
    const current = snapshots[filePath];
    if (proof.missing === true) {
      if (current.exists || Object.keys(proof).some(key => !['step', 'path', 'missing'].includes(key))) auditFail('deletion predicate is not satisfied');
      // Absence alone must not clear a claim for a file that never existed.
      if (!observedFiles.has(filePath)) {
        const changes = require('./review-packet-v1.js').collectChanges({ root, baseline });
        if (changes.kind !== 'git' || !changes.changed_files.includes(filePath)) auditFail('deletion proof requires a previously observed file or a Git deletion');
      }
    } else {
      if (Object.keys(proof).some(key => !['step', 'path', 'sha256', 'present', 'absent'].includes(key))) auditFail('unknown predicate proof field');
      if (!current.exists || !/^[a-f0-9]{64}$/.test(proof.sha256 || '') || proof.sha256 !== current.sha256) auditFail('predicate proof hash is stale or invalid');
      const present = proof.present === undefined ? [] : proof.present, absent = proof.absent === undefined ? [] : proof.absent;
      if (![present, absent].every(list => Array.isArray(list) && list.length <= 100
          && list.every(value => typeof value === 'string' && value.trim() && Buffer.byteLength(value) <= 4096))
          || !present.length && !absent.length) auditFail('predicate proof requires nonempty bounded literal predicates');
      const content = bytes(path.join(root, filePath)).toString('utf8');
      if (present.some(literal => !content.includes(literal)) || absent.some(literal => content.includes(literal))) auditFail('literal predicate is not satisfied');
    }
    matches.forEach(index => proved.add(index + 1));
  }
  return proved;
}
function prepareClaims(scope, manifest, predicates) {
  const claims = parseManifest(manifest), old = scope.previous;
  if (old && (!Array.isArray(old.claims) || old.claims.length > claims.length
      || old.claims.some((claim, index) => claim.step !== claims[index].step || claim.raw !== claims[index].raw
        || claim.path !== null && claim.path !== claims[index].path))) auditFail('audited claim identities were rewritten');
  const snapshots = Object.create(null);
  let totalBytes = 0;
  for (const claim of claims) if (claim.path && !Object.hasOwn(snapshots, claim.path)) {
    snapshots[claim.path] = snapshot(scope.claimRoot || scope.root, claim.path);
    totalBytes += snapshots[claim.path].bytes || 0;
    if (totalBytes > 64 * 1024 * 1024) auditFail('claimed file snapshot exceeds the 64 MiB limit');
  }
  const dirty = new Set(scope.dirty), certified = [];
  const observedFiles = new Set(old?.observedFiles || Object.entries(old?.snapshots || {}).filter(([, value]) => value.exists).map(([file]) => file));
  for (const [file, value] of Object.entries(snapshots)) if (value.exists) observedFiles.add(file);
  if (scope.legacyUnresolved) for (const claim of claims) if (claim.path) dirty.add(claim.path);
  if (old) {
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i], prior = old.claims[i];
      if (!claim.path) continue;
      if (prior && prior.path === null) dirty.add(claim.path);
      if (prior && prior.certified && same(old.snapshots[claim.path], snapshots[claim.path])) certified.push(i + 1);
      // Membership in a prior audit means this path was already changed before
      // the new claim. A missing --dirty-before flag cannot recertify it.
      if (Object.hasOwn(old.snapshots, claim.path)) dirty.add(claim.path);
    }
  }
  const proved = [...verifyPredicates(scope.claimRoot || scope.root, predicates, claims, snapshots, observedFiles, scope.baseline)];
  const result = { ...scope, dirty: [...dirty].sort(), claims, snapshots, observedFiles: [...observedFiles].sort(), certified, proved };
  delete result.previous; delete result.legacyUnresolved;
  return result;
}
function measuredTree(root) {
  if (require('./review-packet-v1.js').collectChanges({ root }).kind === 'explicit-no-git') return { kind: 'explicit-no-git' };
  const evidence = require('./evidence-run-v1.js');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-landing-tree-'));
  try {
    const result = evidence.computeTree(root, scratch, { ...evidence.LIMITS, gitTimeoutMs: 10000 });
    if (result.tree) return { kind: 'git', tree: result.tree };
    auditFail('current tree is unavailable: ' + result.reason);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
function finishScope(scope, landedFile) {
  const landed = new Set(bytes(landedFile, MAX_RECEIPT_BYTES).toString('utf8').trim().split('\n').filter(Boolean).map(Number));
  for (const [file, old] of Object.entries(scope.snapshots)) if (!same(old, snapshot(scope.claimRoot || scope.root, file))) auditFail('a claimed file changed during the audit');
  if (!same(scope.logPrefix, logPrefix(scope.log))) auditFail('run log changed during the audit');
  const result = { ...scope, claims: scope.claims.map((claim, i) => ({ ...claim, certified: landed.has(i + 1) })), tree: measuredTree(scope.claimRoot || scope.root) };
  delete result.certified; delete result.proved;
  return result;
}
function receiptFresh(options) {
  const loaded = readBoundedJson(options.receiptPath, MAX_RECEIPT_BYTES);
  if (loaded.absent || loaded.invalid) auditFail('a current receipt is required; run the edit-landing audit');
  const receipt = loaded.value, scope = receipt && receipt.auditScope;
  if (!receipt || !RECEIPT_SCHEMAS[receipt.schema] || receipt.clean !== true || receipt.auditFailure
      || !Number.isSafeInteger(receipt.claims) || receipt.claims < 1 || receipt.landed !== receipt.claims
      || ['pending', 'notLanded', 'unverified'].some(field => receipt[field] !== 0)) auditFail('the current receipt is not clean; resolve its pending or unlanded claims');
  if (!scope || scope.schema !== SCOPE_SCHEMA) auditFail('receipt has no persisted audit scope; rerun the audit with its original context');
  const root = fs.realpathSync(options.projectRoot), key = require('./session-control-core-v1.js').sessionKey(options.session);
  if (scope.root !== root || scope.sessionKey !== key || scope.generation !== generation(root, options.session)) auditFail('receipt is bound to another project, session or review generation');
  const resolved = resolveRunLog(root, receipt.log);
  if (resolved.reason || path.resolve(root, resolved.logRel) !== scope.log) auditFail('receipt run log binding is invalid');
  const prefix = logPrefix(scope.log, scope.logPrefix);
  if (prefix.bytes > scope.logPrefix.bytes) {
    const tail = bytes(scope.log).subarray(scope.logPrefix.bytes).toString('utf8');
    if (tail.split('\n').some(line => {
      const entry = line.trimStart().replace(/^\[[^\]]*\]\s*/, '');
      return !/^(EDIT LANDED |EDIT NOT LANDED |EDIT LANDING AUDIT |PENDING PREDICATE |UNVERIFIED |RECEIPT REFUSED )/.test(entry)
        && /IMPL completed [—–-] files:|\bWIRED\b/.test(entry);
    })) auditFail('new edit claims were logged after the receipt; rerun the audit');
  }
  const claimRoot = require('./review-packet-v1.js').collectChanges({ root }).root;
  if ((scope.claimRoot || scope.root) !== claimRoot) auditFail('the audited repository root changed');
  for (const [file, old] of Object.entries(scope.snapshots || {})) if (!same(old, snapshot(claimRoot, file))) auditFail('claimed files changed after the receipt; rerun the audit with current predicates');
  if (!scope.tree || !same(scope.tree, measuredTree(claimRoot))) auditFail('the current tree differs from the receipt; rerun the audit');
  return receipt;
}
function failedReceipt(file) {
  const loaded = readBoundedJson(file, MAX_RECEIPT_BYTES);
  if (loaded.absent || loaded.invalid || !loaded.value || typeof loaded.value !== 'object') auditFail('the prior audit scope could not be preserved');
  return { ...loaded.value, clean: false, auditFailure: 'The latest audit did not complete because Git failed. Rerun the audit after resolving that failure.' };
}

const shellQuote = value => `'${String(value).replace(/'/g, "'\\''")}'`;

function auditRecoveryCommand({ projectRoot, sessionId, state, log }) {
  const selected = resolveRunLog(projectRoot, state?.workflowArtifacts?.log || log || '');
  const runLog = selected.reason ? '<bound-run-log>' : path.resolve(projectRoot, selected.logRel);
  return ['bash', path.join(__dirname, 'zensu-edit-landing.sh'), '--log', runLog,
    '--project', projectRoot, '--session', sessionId].map(shellQuote).join(' ');
}

function requireNativeAuditSession(options, env = process.env) {
  if (!env.COPILOT_SESSION_ID) return;
  // Resolve the existing immutable native record, without adoption or mutation.
  // Ambient selectors alone never establish authority, and no child is promoted
  // to its parent. This check only refuses an ambiguous write-mode invocation.
  const binding = require('./copilot-hook-session-v1.js').resolveHookSession(
    { sessionId: env.COPILOT_SESSION_ID }, env);
  const core = require('./session-control-core-v1.js');
  let state;
  try { state = core.readWorkflowState({ projectRoot: binding.projectRoot, sessionId: env.COPILOT_SESSION_ID }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!state.active || state.chainDone) return;
  const command = auditRecoveryCommand({ projectRoot: binding.projectRoot,
    sessionId: env.COPILOT_SESSION_ID, state, log: options.log });
  throw new Error('AUDIT SESSION REQUIRED — an active native workflow requires explicit --session; no claims were graded and no receipt was written.\n' +
    `Run: ${command}\nPreserve the original dirty scope and add --predicates with current literal/hash proofs when required. Use --inventory for read-only inspection.`);
}

function main(argv, env = process.env, stdout = process.stdout, stderr = process.stderr) {
  if (argv[0] === 'require-native-session') {
    try { requireNativeAuditSession({ log: env.ZENSU_ELR_LOG }, env); return EXIT.ok; }
    catch (error) { stderr.write('zensu-edit-landing.sh: ' + error.message + '\n'); return EXIT.usage; }
  }
  if (argv[0] === 'recovery') {
    try {
      const core = require('./session-control-core-v1.js');
      const projectRoot = env.ZENSU_ELR_PROJECT_ROOT, sessionId = env.ZENSU_ELR_SESSION;
      const state = core.readWorkflowState({ projectRoot, sessionId });
      const receipt = receiptRunLog({ receiptPath: env.ZENSU_ELR_RECEIPT, projectRoot });
      stdout.write('Run: ' + auditRecoveryCommand({ projectRoot, sessionId, state, log: receipt.logRel }) + '\n');
      stdout.write('Retain the persisted dirty scope; add --predicates with current literal/hash proofs where needed. Refresh stale acceptance records before retrying closure.\n');
      return EXIT.ok;
    } catch (error) { stderr.write('Audit recovery command unavailable: ' + error.message + '\n'); return EXIT.usage; }
  }
  if (argv[0] === 'failed') {
    try { stdout.write(JSON.stringify(failedReceipt(env.ZENSU_ELR_RECEIPT)) + '\n'); return EXIT.ok; }
    catch (error) { stderr.write(error.message + '\n'); return EXIT.usage; }
  }
  if (argv[0] === 'fresh') {
    try { receiptFresh({ receiptPath: env.ZENSU_ELR_RECEIPT, projectRoot: env.ZENSU_ELR_PROJECT_ROOT, session: env.ZENSU_ELR_SESSION }); return EXIT.ok; }
    catch (error) { stderr.write(error.message + '\n'); return 1; }
  }
  if (argv[0] === 'scope-prepare' || argv[0] === 'scope-claims') {
    try {
      const dir = env.ZEL_SCOPE_DIR;
      const output = path.join(dir, 'scope.json');
      let scope;
      if (argv[0] === 'scope-prepare') {
        scope = prepareScope({ root: env.ZEL_ROOT, claimRoot: env.ZEL_CLAIM_ROOT, log: env.ZEL_LOG, session: env.ZEL_SESSION,
          receipt: env.ZEL_RECEIPT, baseline: env.ZEL_BASELINE_SEEN === '1' ? env.ZEL_BASELINE : undefined,
          epoch: env.ZEL_EPOCH_SEEN === '1' ? env.ZEL_EPOCH : undefined,
          dirty: env.ZEL_DIRTY_SEEN === '1' ? env.ZEL_DIRTY : undefined });
        if (env.ZEL_CHECKPOINT === '0' && scope.generation) auditFail('an active workflow requires a canonical receipt-producing audit; omit --receipt - (use --inventory for read-only inspection)');
        if (env.ZEL_CHECKPOINT !== '0') checkpointScope(scope, env.ZEL_RECEIPT, env.ZEL_SESSION);
      } else scope = prepareClaims(JSON.parse(bytes(output).toString('utf8')), env.ZEL_MANIFEST, env.ZEL_PREDICATES);
      const encoded = JSON.stringify(scope);
      if (Buffer.byteLength(encoded) > MAX_RECEIPT_BYTES) auditFail('audit scope exceeds size limit');
      fs.writeFileSync(output, encoded);
      for (const field of ['baseline', 'epoch']) fs.writeFileSync(path.join(dir, field), scope[field]);
      for (const field of ['dirty', 'certified', 'proved']) fs.writeFileSync(path.join(dir, field), (scope[field] || []).join('\n') + '\n');
      return EXIT.ok;
    } catch (error) { stderr.write(error.message + '\n'); return EXIT.usage; }
  }
  if (argv[0] !== 'receipt-log') {
    stderr.write('usage: edit-landing-receipt-v1.js receipt-log\n');
    return EXIT.usage;
  }
  const receipt = receiptRunLog({ receiptPath: env.ZENSU_ELR_RECEIPT || '', projectRoot: env.ZENSU_ELR_PROJECT_ROOT || '' });
  if (receipt.status !== 'ok') return EXIT.none;
  stdout.write(receipt.logRel);
  return EXIT.ok;
}

module.exports = {
  RECEIPT_SCHEMAS,
  MAX_RECEIPT_BYTES,
  EXIT,
  readBoundedJson,
  canonical,
  isOutside,
  resolveRunLog,
  receiptRunLog,
  prepareScope, prepareClaims, finishScope, receiptFresh, snapshot,
  auditRecoveryCommand, requireNativeAuditSession,
  main,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
