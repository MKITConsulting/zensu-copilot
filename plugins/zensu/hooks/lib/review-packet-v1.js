#!/usr/bin/env node
'use strict';

// Canonical read-only review input. No model-generated evidence is promoted to a
// receipt: the landing summary is derived from the existing audit receipt.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { sessionKey } = require('./session-control-core-v1.js');
const evidence = require('./evidence-run-v1.js');
const SCHEMA = 'zensu-review-packet-v1';
const MAX_BYTES = 1024 * 1024;
const FIELDS = ['implementation_summary', 'requirements_baseline', 'diff_summary',
  'test_evidence', 'build_evidence', 'coverage_evidence'];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function encode(value) { return JSON.stringify(stable(value)); }
function hash(value) { return crypto.createHash('sha256').update(encode(value)).digest('hex'); }
function readJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('input must be a regular bounded JSON file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function git(root, args, optional = false, absentRepository = false) {
  // A model or parent process must not redirect the audited repository via Git
  // environment overrides, shell expansion or user-configured external tools.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.LC_ALL = 'C';
  const result = spawnSync('git', ['-C', root, '--no-optional-locks', ...args],
    { env, encoding: 'utf8', maxBuffer: 8 * MAX_BYTES, timeout: 10000 });
  if (absentRepository && result.status === 128 && /^fatal: not a git repository(?: |\()/m.test(result.stderr || '')) return null;
  if (result.status !== 0 && !(optional && result.status === 1)) {
    throw new Error('change-set Git command failed: ' + args[0]);
  }
  return result.status === 0 ? result.stdout : null;
}
function collectChanges({ root, baseline = '' }) {
  const requested = fs.realpathSync(root);
  const discovered = git(requested, ['rev-parse', '--show-toplevel'], false, true);
  if (discovered === null) {
    if (baseline) throw new Error('a non-Git review cannot claim a commit baseline');
    return { root: requested, kind: 'explicit-no-git', baseline: null, head: null, changed_files: null };
  }
  const top = fs.realpathSync(discovered.trim());
  const head = git(top, ['rev-parse', '--verify', '--quiet', 'HEAD'], true);
  const paths = new Set();
  const add = output => output.split('\0').filter(Boolean).forEach(file => {
    if (/[\r\n\0]/.test(file)) throw new Error('change-set path contains an unsupported control character');
    if (!file.split('/').some(part => part === '.zensu' || part === '.git')) paths.add(file);
  });
  if (head !== null) {
    add(git(top, ['diff', '--no-ext-diff', '--name-only', '-z', 'HEAD', '--']));
    if (baseline) {
      if (!/^[0-9a-f]{40,64}$/i.test(baseline)) throw new Error('baseline must be an exact commit SHA');
      git(top, ['rev-parse', '--verify', baseline + '^{commit}']);
      add(git(top, ['diff', '--no-ext-diff', '--name-only', '-z', baseline + '..HEAD', '--']));
    }
  } else {
    if (baseline) throw new Error('baseline cannot be applied to an unborn repository');
    add(git(top, ['ls-files', '--cached', '-z', '--']));
  }
  add(git(top, ['ls-files', '--others', '--exclude-standard', '-z', '--']));
  return { root: top, kind: 'git', baseline: baseline || null, head: head === null ? null : head.trim(), changed_files: [...paths].sort() };
}
function explicitSnapshot(root, supplied) {
  if (!Array.isArray(supplied) || supplied.length > 20000) throw new Error('non-Git review requires a bounded explicit changed_files list');
  const files = [...new Set(supplied)];
  const result = [];
  let totalBytes = 0;
  for (const file of files.sort()) {
    if (typeof file !== 'string' || !file || /[\x00-\x1f\x7f\\]/.test(file) || path.isAbsolute(file)
        || path.posix.normalize(file) !== file || file.split('/').some(part => ['..', '.git', '.zensu'].includes(part))) {
      throw new Error('non-Git changed_files must be normalized in-root source paths');
    }
    const parts = file.split('/');
    let current = root, stat, missing = false;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      try { stat = fs.lstatSync(current); }
      catch (error) { if (error.code !== 'ENOENT') throw error; missing = true; break; }
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
        throw new Error('non-Git changed path contains a symlink or unsupported file');
      }
    }
    if (missing) { result.push({ path: file, exists: false }); continue; }
    totalBytes += stat.size;
    if (stat.size > 8 * MAX_BYTES || totalBytes > 64 * MAX_BYTES) throw new Error('non-Git review snapshot exceeds size limit');
    const content = fs.readFileSync(current);
    result.push({ path: file, exists: true, bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') });
  }
  return result;
}
function landingEvidence(receipt) {
  if (!receipt || !['edit-landing-v1', 'edit-landing-v2'].includes(receipt.schema)) throw new Error('unsupported edit-landing receipt');
  const counters = ['claims', 'landed', 'notLanded', 'unverified', 'pending', 'exemptIgnored', 'exemptVerified'];
  if (!counters.every(key => Number.isSafeInteger(receipt[key]) && receipt[key] >= 0)) throw new Error('invalid edit-landing counters');
  if (receipt.clean !== true || receipt.notLanded !== 0 || receipt.unverified !== 0 || receipt.pending !== 0) throw new Error('edit-landing receipt is not clean');
  if (typeof receipt.session !== 'string' || !receipt.session || typeof receipt.log !== 'string' || !receipt.log) throw new Error('unbound edit-landing receipt');
  return 'EDIT LANDING AUDIT — claims=' + receipt.claims + ' landed=' + receipt.landed
    + ' not_landed=' + receipt.notLanded + ' unverified=' + receipt.unverified
    + ' pending=' + receipt.pending + ' exempt_ignored=' + receipt.exemptIgnored
    + ' exempt_verified=' + receipt.exemptVerified;
}
function fingerprint(root) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-review-tree-'));
  try {
    const result = evidence.computeTree(root, scratch, { ...evidence.LIMITS, gitTimeoutMs: 10000 });
    if (!result.tree) throw new Error('review tree unavailable: ' + result.reason);
    return result.tree;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
function createPacket({ root, baseline, input, editLandingReceipt }) {
  const changes = collectChanges({ root, baseline });
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('packet input must be an object');
  for (const field of FIELDS) {
    if (typeof input[field] !== 'string' || !input[field].trim()) throw new Error('missing review field: ' + field);
  }
  const payload = { policy: 'reviewer-readonly-v1', ...changes, tree: null };
  if (changes.kind === 'git') payload.tree = fingerprint(changes.root);
  else {
    payload.non_git_snapshot = explicitSnapshot(changes.root, input.changed_files);
    payload.changed_files = payload.non_git_snapshot.map(file => file.path);
    payload.content_snapshot = hash(payload.non_git_snapshot);
    payload.scope_limitations = 'Only explicitly listed session paths are covered; no repository-wide diff, commit baseline or Git tree proof is available.';
  }
  for (const field of FIELDS) payload[field] = input[field];
  payload.edit_landing_evidence = landingEvidence(editLandingReceipt);
  payload.edit_landing_receipt = editLandingReceipt;
  const packet = { schema: SCHEMA, sha256: hash(payload), payload };
  if (Buffer.byteLength(encode(packet) + '\n') > MAX_BYTES) throw new Error('review packet exceeds size limit');
  return packet;
}
function loadPacket(file, expectedHash) {
  const packet = readJson(file);
  if (!packet || packet.schema !== SCHEMA || !/^[0-9a-f]{64}$/.test(packet.sha256)
      || hash(packet.payload) !== packet.sha256 || (expectedHash && packet.sha256 !== expectedHash)) {
    throw new Error('review packet hash/schema mismatch');
  }
  const scopeValid = packet.payload.kind === 'git' ? /^[0-9a-f]{40,64}$/.test(packet.payload.tree)
    : packet.payload.kind === 'explicit-no-git' && packet.payload.tree === null
      && Array.isArray(packet.payload.non_git_snapshot) && hash(packet.payload.non_git_snapshot) === packet.payload.content_snapshot
      && typeof packet.payload.scope_limitations === 'string' && packet.payload.scope_limitations.length > 0;
  if (packet.payload.policy !== 'reviewer-readonly-v1' || !scopeValid
      || !Array.isArray(packet.payload.changed_files)
      || !packet.payload.changed_files.every(file => typeof file === 'string' && file.length > 0)
      || !FIELDS.every(field => typeof packet.payload[field] === 'string' && packet.payload[field].trim())
      || landingEvidence(packet.payload.edit_landing_receipt) !== packet.payload.edit_landing_evidence) {
    throw new Error('invalid review packet payload');
  }
  return packet;
}
function writePacket(file, packet) {
  const text = encode(packet) + '\n';
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('review packet exceeds size limit');
  fs.writeFileSync(file, text, { flag: 'wx', mode: 0o444 });
  return 'REVIEW-PACKET: ' + fs.realpathSync(file) + ' sha256:' + packet.sha256;
}
function validatePrimaryResult(text) {
  if (typeof text !== 'string' || /REVIEW PACKET INVALID/.test(text)
      || !/^## Aspect: judge\s*$/m.test(text)) return false;
  return /^- \(no findings\)\s*$/m.test(text)
    || /^- \[(?:CRITICAL|IMPORTANT|SUGGESTION)\] JUDGE-\d+ .+Evidence: .+Fix: .+/m.test(text);
}
function cli(argv) {
  const [verb, ...args] = argv;
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!/^--[a-z-]+$/.test(args[i]) || !args[i + 1] || flags[args[i]]) throw new Error('invalid arguments');
    flags[args[i]] = args[i + 1];
  }
  if (verb === 'changes') return JSON.stringify(collectChanges({ root: flags['--root'], baseline: flags['--baseline'] }), null, 2);
  if (verb === 'create') {
    const receiptPath = flags['--receipt'] || (flags['--session'] && path.join(flags['--root'], '.zensu', 'state',
      'edit-landing-' + sessionKey(flags['--session']) + '.json'));
    if (!receiptPath) throw new Error('create requires --session or --receipt');
    const receipt = readJson(receiptPath);
    if (flags['--session'] && receipt.session !== flags['--session']) throw new Error('edit-landing session mismatch');
    return writePacket(flags['--out'], createPacket({ root: flags['--root'], baseline: flags['--baseline'],
      input: readJson(flags['--input']), editLandingReceipt: receipt }));
  }
  if (verb === 'validate') return JSON.stringify(loadPacket(flags['--input'], flags['--sha256']));
  throw new Error('expected changes, create or validate');
}
if (require.main === module) {
  try { process.stdout.write(cli(process.argv.slice(2)) + '\n'); }
  catch (error) { process.stderr.write('review-packet: ' + error.message + '\n'); process.exitCode = 2; }
}
module.exports = { SCHEMA, MAX_BYTES, collectChanges, explicitSnapshot, landingEvidence, fingerprint, createPacket, loadPacket, writePacket, validatePrimaryResult, hash, cli };
