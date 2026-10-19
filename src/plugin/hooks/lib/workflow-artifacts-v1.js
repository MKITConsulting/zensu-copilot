#!/usr/bin/env node
'use strict';

// Bind model-visible progress to one native workflow generation. These files
// report observed state; they never grant a review, test or acceptance verdict.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const core = require('./session-control-core-v1.js');
const START = '<!-- zensu:workflow-status -->';
const END = '<!-- /zensu:workflow-status -->';
const MAX_BYTES = 1024 * 1024;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeArtifact(root, bucket, file, createDirectory = false) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('artifact path is required');
  const base = fs.realpathSync(root);
  const resolved = path.resolve(base, file);
  const directory = path.join(base, '.zensu', bucket);
  if (path.dirname(resolved) !== directory || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(path.basename(resolved))) {
    throw new Error(`artifact must be a direct file in .zensu/${bucket}`);
  }
  for (const part of [path.join(base, '.zensu'), directory]) {
    if (!fs.existsSync(part) && createDirectory) fs.mkdirSync(part, { mode: 0o700 });
    const stat = fs.lstatSync(part);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(part) !== part) throw new Error('unsafe artifact directory');
  }
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('unsafe artifact file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return resolved;
}
function read(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
function progressText(text, state) {
  if (text.includes(START) !== text.includes(END) || text.split(START).length > 2 || text.split(END).length > 2) {
    throw new Error('ambiguous managed progress section');
  }
  const first = text.indexOf(START), last = text.indexOf(END);
  if (first >= 0 && last < first) throw new Error('invalid managed progress section');
  // The managed block is the sole lifecycle checklist. Known duplicate stage
  // rows become pointers, not claims that arbitrary work or report delivery ran.
  // Preserve blocked/cancelled/skipped rows and all unrelated tasks verbatim.
  const labels = new Set(['Phase 6 audit', 'Phase 6 audits', 'Review chain', 'Chain close and final report',
    'Implementation audit accepted', 'Code review converged', 'Workflow chain closed']);
  const reconcile = value => value.replace(/^- \[[ xX]\] ([^\r\n]+)$/gm, (line, body) => {
    const separator = body.indexOf(' — ');
    const label = separator < 0 ? body : body.slice(0, separator);
    const detail = separator < 0 ? '' : body.slice(separator + 3);
    if (!labels.has(label) || /\b(?:blocked|cancelled|canceled|skipped)\b/i.test(detail)) return line;
    const note = /^(?:pending|completed)(?:; see native workflow status below\.?)?$/i.test(detail) ? ''
      : detail.replace(/\s*\(in progress\)\s*$/i, '').trim();
    return `- ${label} — see Native workflow status below.${note ? ' Stage note: ' + note : ''}`;
  });
  const before = reconcile(first < 0 ? text : text.slice(0, first));
  const after = first < 0 ? '' : reconcile(text.slice(last + END.length));
  const row = (done, label) => `- [${done ? 'x' : ' '}] ${label}`;
  const block = [START, '## Native workflow status', '',
    row(state.implComplete === true, 'Implementation audit accepted'),
    row(state.codeReviewDone === true, 'Code review converged'),
    row(state.chainDone === true, 'Workflow chain closed'),
    '', `Workflow generation: ${state.reviewGeneration}. Observed revision: ${state.revision}. Completion records remain the evidence authority.`,
    'The assistant presents the final report in its response after chain closure. This artifact records workflow state only.', END].join('\n');
  if (first >= 0) return before + block + after;
  return before.trimEnd() + '\n\n' + block + '\n';
}
function syncProgress(options, state = core.readWorkflowState(options)) {
  if (!state?.workflowArtifacts) return null;
  const artifacts = state.workflowArtifacts;
  if (artifacts.schema !== 'zensu-workflow-artifacts-v1' || !GENERATION.test(state.reviewGeneration || '') || artifacts.generation !== state.reviewGeneration) throw new Error('unknown or stale workflow artifact binding');
  const file = safeArtifact(options.projectRoot, 'progress', artifacts.progress, true);
  const previous = read(file), next = progressText(previous, state);
  if (Buffer.byteLength(next) > MAX_BYTES) throw new Error('progress artifact exceeds size limit');
  if (previous !== next) {
    const temporary = file + `.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, next, { flag: 'wx', mode: 0o600 });
      safeArtifact(options.projectRoot, 'progress', artifacts.progress);
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  return file;
}
function start(options, log) {
  const state = core.readWorkflowState(options);
  if (!state?.active || state.implComplete || state.chainDone) throw new Error('execution start requires an active implementation');
  if (!GENERATION.test(state.reviewGeneration || '')) throw new Error('workflow generation is missing or invalid');
  const file = safeArtifact(options.projectRoot, 'logs', log);
  if (!file.endsWith('.log') || !read(file).trim()) throw new Error('initialize the matching plan and run log first');
  const stem = path.basename(file, '.log');
  const plan = safeArtifact(options.projectRoot, 'plans', path.join('.zensu/plans', stem + '.md'));
  if (!read(plan).trim()) throw new Error('matching plan is missing');
  const relative = path.relative(options.projectRoot, file);
  const artifacts = { schema: 'zensu-workflow-artifacts-v1', generation: state.reviewGeneration, log: relative, progress: `.zensu/progress/${stem}.md` };
  if (state.workflowArtifacts && (state.workflowArtifacts.log !== relative || state.workflowArtifacts.generation !== state.reviewGeneration)) throw new Error('this generation already owns another run log');
  const marker = `EXECUTION STARTED — generation=${state.reviewGeneration}`;
  if (!read(file).split('\n').some(line => /^(?:\[[^\]\r\n]*\] )?EXECUTION STARTED — generation=/.test(line) && line.endsWith(marker))) {
    const result = spawnSync('bash', [path.join(__dirname, 'zensu-log.sh'), 'append', '--log', file,
      '--message', marker], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, COPILOT_PLUGIN_ROOT: path.resolve(__dirname, '../..'), COPILOT_PROJECT_DIR: options.projectRoot } });
    if (result.status !== 0) throw new Error('execution-start log append failed');
  }
  if (!state.workflowArtifacts) {
    core.mutateWorkflowState({ ...options, workflowState: 'active', event: 'execution-started' }, current => {
      if (current.revision !== state.revision || current.reviewGeneration !== state.reviewGeneration || !current.active || current.implComplete || current.chainDone) throw new Error('workflow changed during execution start');
      current.workflowArtifacts = artifacts;
      return current;
    });
  }
  const progress = syncProgress(options);
  return { status: 'execution-started', generation: state.reviewGeneration, log: relative, progress: path.relative(options.projectRoot, progress) };
}
function report(options, ticket) {
  const state = core.readWorkflowState(options);
  if (!state) throw new Error('workflow state missing');
  if (ticket !== undefined && (ticket !== state.reviewTicket || !state.reviewTicketConsumed)) throw new Error('stale self-review ticket');
  return { status: state.chainDone ? 'closed' : 'pending', nextAction: state.chainDone ? 'render-report-only' : 'continue-current-generation',
    generation: state.reviewGeneration || null, revision: state.revision, implComplete: state.implComplete === true, codeReviewDone: state.codeReviewDone === true,
    selfReviewFixed: state.selfReviewFixed === true, chainDone: state.chainDone === true,
    reviewRound: state.reviewRound, progress: state.workflowArtifacts?.progress || null };
}
function cli(argv, env = process.env) {
  const [verb, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--log', '--claimed-review-ticket', '--session'].includes(rest[i]) || !rest[i + 1] || flags[rest[i]]) throw new Error('invalid artifact-helper arguments');
    flags[rest[i]] = rest[i + 1];
  }
  const options = { projectRoot: env.COPILOT_PROJECT_DIR, sessionId: flags['--session'] || env.COPILOT_SESSION_ID };
  if (!options.projectRoot || !options.sessionId) throw new Error('native project/session binding missing');
  if (!env.COPILOT_SESSION_ID || core.sessionKey(options.sessionId) !== core.sessionKey(env.COPILOT_SESSION_ID)) throw new Error('foreign session selector');
  if (verb === 'start' && !flags['--claimed-review-ticket']) return start(options, flags['--log']);
  if (verb === 'sync' && !flags['--log'] && !flags['--claimed-review-ticket']) return { progress: syncProgress(options) };
  if (verb === 'report' && !flags['--log']) return report(options, flags['--claimed-review-ticket']);
  throw new Error('unknown artifact-helper verb');
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(cli(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write('workflow-artifacts: ' + error.message + '\n'); process.exitCode = 1; }
}
module.exports = { safeArtifact, progressText, start, syncProgress, report, cli };
