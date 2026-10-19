#!/usr/bin/env node
'use strict';

// Native Copilot work-order runner with lease renewal and process supervision.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALUE_OPTIONS = new Set(['order', 'session-id', 'project', 'copilot', 'mcp-config', 'plugin-dir', 'log']);
// These are owned by this transport: an override could detach a claim from its session.
const OWNED_FLAGS = new Set(['-p', '--prompt', '-i', '--interactive', '--session-id', '-r', '--resume',
  '--continue', '--connect', '--output-format', '--trust-folder', '-C', '-w', '--worktree', '--plugin-dir',
  '--acp', '--server', '--stdio', '--share-gist', '--remote', '--remote-export', '--config-dir', '--add-dir', '--']);
const EXIT_CODES = Object.freeze({ success: 0, failure: 1, cancelled: 143 });
const USAGE = 'usage: launcher.js --order <order-id> --session-id <client-session-id> [--project <dir>] '
  + '[--copilot <executable>] [--mcp-config <file>] [--plugin-dir <dir>] [--log <file>] [-- <copilot arguments>]';

function boundedNumber(env, name, fallback, min, max) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function parseLauncherArgs(argv) {
  const options = { extra: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      options.extra = argv.slice(index + 1);
      break;
    }
    const match = /^--([a-z-]+)$/.exec(arg);
    if (!match || !VALUE_OPTIONS.has(match[1]) || index + 1 >= argv.length) {
      return { error: `unknown or incomplete argument: ${arg}` };
    }
    if (options[match[1]] !== undefined) return { error: `repeated argument: ${arg}` };
    options[match[1]] = argv[++index];
  }
  if (!UUID_RE.test(String(options.order || ''))) return { error: '--order must name a work order id' };
  if (!UUID_RE.test(String(options['session-id'] || ''))) return { error: '--session-id must be the client session id of the claim' };
  for (const arg of options.extra) {
    const flag = arg.split('=')[0];
    if (OWNED_FLAGS.has(flag) || /^-(?:p|i|r|C|w).+/.test(arg)) {
      return { error: `argument is controlled by the launcher: ${flag}` };
    }
  }
  return { options };
}

function copilotArguments(options, selection = { root: path.resolve(options['plugin-dir'] || PLUGIN_ROOT), external: true }) {
  const args = ['--session-id', options['session-id'], '--output-format', 'json', '--no-auto-update',
    '--no-ask-user', '--no-remote', '--no-remote-export', '--disable-builtin-mcps'];
  if (selection.external) args.push('--plugin-dir', selection.root);
  if (options['mcp-config']) args.push('--additional-mcp-config', `@${path.resolve(options['mcp-config'])}`);
  // Permissions are supplied explicitly by the caller; the launcher never grants broad permissions.
  args.push(...options.extra, '-p', `/zensu-work ${options.order}`);
  return args;
}

// Compare actual package contents, not just a version or an unverified build receipt.
// Copilot installs direct sources in _direct/<name> and marketplace sources in
// <marketplace>/<name>. Unknown inventory sources/layouts are refused below.
function packageIdentity(directory) {
  const root = fs.realpathSync(directory);
  const files = new Map();
  let total = 0;
  function visit(relative) {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('package contains a symbolic link');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
    } else {
      if (!stat.isFile() || files.size >= 10000 || (total += stat.size) > 64 * 1024 * 1024) throw new Error('package cannot be verified');
      files.set(relative.split(path.sep).join('/'), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    }
  }
  visit('');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  const build = JSON.parse(fs.readFileSync(path.join(root, 'build.json'), 'utf8'));
  if (manifest.name !== 'zensu' || typeof manifest.version !== 'string' || build.schemaVersion !== 2
    || build.host !== 'copilot' || build.version !== manifest.version || !Array.isArray(build.files)) {
    throw new Error('expected a built native Zensu package');
  }
  const declared = new Set(['build.json']);
  for (const entry of build.files) {
    if (!entry || typeof entry.target !== 'string' || declared.has(entry.target)
      || files.get(entry.target) !== entry.sha256) throw new Error('package does not match its build receipt');
    declared.add(entry.target);
  }
  if (declared.size !== files.size) throw new Error('package contains untracked files');
  return { root, version: manifest.version,
    digest: crypto.createHash('sha256').update(JSON.stringify([...files].sort())).digest('hex') };
}

function selectPlugin(options, env, projectRoot) {
  if (env.COPILOT_PLUGIN_DIR_ONLY) return { error: 'unset COPILOT_PLUGIN_DIR_ONLY so the installed plugin inventory can be verified' };
  let desired;
  try { desired = packageIdentity(path.resolve(options['plugin-dir'] || PLUGIN_ROOT)); } catch (_) {
    return { error: 'the requested plugin is not an intact native Zensu build; rebuild it before launching' };
  }
  // This native command is read-only and includes enabled state and live sources.
  // Do not forward stderr: a broken CLI may print credentials or private context.
  const listed = spawnSync(options.copilot || 'copilot', ['--no-auto-update', 'plugin', 'list', '--json'],
    { cwd: projectRoot, env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (listed.error && listed.error.code === 'ENOENT') return { unavailable: true };
  if (listed.error || listed.status !== 0 || String(listed.stderr || '').trim()) {
    return { error: 'Copilot plugin inventory could not be verified; run `copilot plugin list --json` with the same COPILOT_HOME and resolve its errors' };
  }
  let inventory;
  try { inventory = JSON.parse(listed.stdout); } catch (_) { /* Invalid inventory is never treated as an empty installation. */ }
  if (!Array.isArray(inventory) || inventory.some((entry) => !entry || typeof entry.name !== 'string'
    || typeof entry.enabled !== 'boolean' || typeof entry.source !== 'string')) {
    return { error: 'Copilot returned an unknown plugin inventory format; update Copilot or inspect `copilot plugin list --json`' };
  }
  const entries = inventory.filter((entry) => entry.name.toLowerCase() === 'zensu');
  if (entries.length === 0) return { root: desired.root, external: true };
  if (entries.length !== 1) return { error: 'multiple Zensu registrations exist; keep one matching installation before launching' };
  const installed = entries[0];
  if (!installed.enabled) return { error: 'the installed Zensu plugin is disabled; explicitly enable the matching package with `copilot plugin enable zensu` before launching' };
  if (installed.source !== 'installed' || typeof installed.marketplace !== 'string'
    || !/^(?:[A-Za-z0-9][A-Za-z0-9_-]*)?$/.test(installed.marketplace)) {
    return { error: 'the active Zensu source or installation location cannot be verified; use one installed native package before launching' };
  }
  const home = path.resolve(env.COPILOT_HOME || path.join(os.homedir(), '.copilot'));
  const installedRoot = path.join(home, 'installed-plugins', installed.marketplace || '_direct', 'zensu');
  let actual;
  try {
    // Do not mistake a redirected cache entry for the runtime selected by Copilot.
    for (const directory of [path.join(home, 'installed-plugins'), path.dirname(installedRoot), installedRoot]) {
      if (!fs.lstatSync(directory).isDirectory()) throw new Error('unexpected cache layout');
    }
    actual = packageIdentity(installedRoot);
  } catch (_) {
    return { error: 'the installed Zensu package cannot be verified; reinstall the requested native build with `copilot plugin install <plugin-dir>` before launching' };
  }
  if (installed.version !== actual.version || desired.digest !== actual.digest) {
    return { error: 'the installed Zensu runtime differs from the requested build; reinstall the requested directory with `copilot plugin install <plugin-dir>` before launching (a second --plugin-dir would load both)' };
  }
  return { root: actual.root, external: false };
}

function translate(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.agentId) return null;
  const data = message.data && typeof message.data === 'object' ? message.data : {};
  // session.resume lacks a session ID and cannot establish a claim's identity.
  if (message.type === 'session.start') {
    return { kind: 'init', sessionId: data.sessionId };
  }
  if (message.type === 'session.error' || message.type === 'error') {
    return { kind: 'error', rateLimited: data.errorType === 'rate_limit' || data.statusCode === 429, resetAt: null };
  }
  // The CLI adds this record to its SDK event stream after saving/exporting the session.
  if (message.type === 'result') {
    return { kind: 'result', sessionId: message.sessionId,
      isError: message.exitCode !== 0 || message.outcome === 'blocked' };
  }
  return null;
}

function emit(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function currentContext(runtime, env, projectRoot, sessionKey, orderId) {
  let context;
  try { context = runtime.loadContext({ env, projectRoot, sessionKey }); } catch (_) { return null; }
  if (!context || context.fault || !context.marker) return null;
  return String(context.marker.orderId).toLowerCase() === orderId.toLowerCase() ? context : null;
}

function watchdog(runtime, env, projectRoot, sessionKey, orderId) {
  const context = currentContext(runtime, env, projectRoot, sessionKey, orderId);
  if (!context) return null;
  let lease;
  try { lease = runtime.readState(context.files.lease); } catch (_) { lease = null; }
  const seconds = lease && Number.isFinite(lease.leaseSeconds) && lease.leaseSeconds > 0 ? lease.leaseSeconds : null;
  return runtime.renew(context, { env, thresholdMs: seconds ? Math.floor(seconds * 1000 / 3) : null }).verdict;
}

function releaseRuns(runtime, env, projectRoot, sessionKey, orderId) {
  const context = currentContext(runtime, env, projectRoot, sessionKey, orderId);
  if (!context) return;
  const below = context.marker.attempt + 1;
  const stateLibrary = path.join(env.COPILOT_PLUGIN_ROOT, 'hooks', 'lib', 'zensu-autopilot-state.sh');
  for (const runId of runtime.releasePlan(projectRoot, context.marker.orderId, below)) {
    spawnSync('bash', ['-c', 'source "$1" && autopilot_release_work_order_run "$2" "$3" "$4" "$5"',
      'zensu-launcher-release', stateLibrary, runId, context.marker.orderId, String(below), projectRoot],
    { env, stdio: 'ignore', timeout: 60000 });
  }
}

function childEnvironment(env, options, projectRoot, selection) {
  const root = selection.root;
  const home = path.resolve(env.COPILOT_HOME || path.join(os.homedir(), '.copilot'));
  const data = path.resolve(env.COPILOT_PLUGIN_DATA || env.PLUGIN_DATA || path.join(home, 'zensu', 'plugin-data'));
  const child = { ...env };
  // Match the native dispatcher boundary; never inherit another host's identity or data.
  for (const name of Object.keys(child)) {
    if (name.startsWith('CLAUDE_') || /^ZENSU_(BOUND_SESSION_ID|CONTEXT|SESSION_KEY|RUNTIME_DIGEST|SOURCE_REVISION|PRINCIPAL|PROJECT_ROOT|CONTROL_RECORD)/.test(name)) delete child[name];
  }
  return { ...child, COPILOT_SESSION_ID: options['session-id'], COPILOT_PLUGIN_ROOT: root,
    COPILOT_PROJECT_DIR: projectRoot, COPILOT_PLUGIN_DATA: data, PLUGIN_ROOT: root,
    ZENSU_RUNTIME_HOST: 'copilot', ZENSU_BOUND_SESSION_ID: options['session-id'], COPILOT_HOME: home };
}

async function launch(argv, env = process.env) {
  const parsed = parseLauncherArgs(argv);
  if (parsed.error) {
    process.stderr.write(`zensu launcher: ${parsed.error}\n${USAGE}\n`);
    return 2;
  }
  const { options } = parsed;
  // Runtime paths resolve from the built plugin. Importing this module for argument tests is side-effect free.
  let runtime = require(path.join(PLUGIN_ROOT, 'hooks', 'lib', 'work-order-v1.js'));
  if (!runtime.tokenPresent(env)) {
    process.stderr.write('zensu launcher: ZENSU_SESSION_TOKEN is not set\n');
    return 2;
  }
  let projectRoot;
  try {
    projectRoot = fs.realpathSync(options.project || process.cwd());
    if (!fs.statSync(projectRoot).isDirectory()) throw new Error('not a directory');
  } catch (_) {
    process.stderr.write('zensu launcher: the project directory cannot be read\n');
    return 2;
  }
  const selection = selectPlugin(options, env, projectRoot);
  if (selection.unavailable) {
    emit({ event: 'exited', status: 'failure', exit_code: null, reason: 'harness_unavailable' });
    return EXIT_CODES.failure;
  }
  if (selection.error) {
    process.stderr.write(`zensu launcher: ${selection.error}\n`);
    return 2;
  }
  runtime = require(path.join(selection.root, 'hooks', 'lib', 'work-order-v1.js'));
  const supervisor = require(path.join(selection.root, 'scripts', 'process-supervisor.js'));
  let logFd = null;
  if (options.log) {
    try {
      logFd = fs.openSync(options.log, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT
        | (fs.constants.O_NOFOLLOW || 0), 0o600);
      if (!fs.fstatSync(logFd).isFile()) throw new Error('not a regular file');
      fs.fchmodSync(logFd, 0o600);
    } catch (_) {
      if (logFd !== null) fs.closeSync(logFd);
      process.stderr.write('zensu launcher: the log file cannot be opened\n');
      return 2;
    }
  }
  const secrets = ['ZENSU_SESSION_TOKEN', 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']
    .map((key) => env[key]).filter((value) => typeof value === 'string' && value.length > 0);
  const log = (line) => {
    if (logFd === null) return;
    let redacted = line;
    for (const secret of secrets) redacted = redacted.split(secret).join('[REDACTED]');
    try { fs.writeSync(logFd, `${redacted}\n`); } catch (_) { /* Logging must not leak into the protocol. */ }
  };
  const childEnv = childEnvironment(env, options, projectRoot, selection);
  const sessionKey = runtime.sessionKeyOf(options['session-id']);
  const tickMs = boundedNumber(env, 'ZENSU_LAUNCHER_TICK_MS', 5000, 50, 60000);
  const graceMs = boundedNumber(env, 'ZENSU_LAUNCHER_STOP_GRACE_MS', 10000, 0, 60000);
  const state = { started: false, cancelled: false, leaseLost: false, result: null, error: false,
    identityMismatch: false, stopping: null, pid: null };
  const stop = () => {
    if (state.stopping) return state.stopping;
    if (state.pid === null) return Promise.resolve();
    state.stopping = (async () => {
      supervisor.signalGroup(state.pid, 'SIGTERM');
      const remaining = await supervisor.waitForGroupExit(state.pid, graceMs);
      if (remaining !== 'gone') {
        supervisor.signalGroup(state.pid, 'SIGKILL');
        await supervisor.waitForGroupExit(state.pid, 3000);
      }
    })();
    return state.stopping;
  };
  const cancel = () => { state.cancelled = true; void stop(); };
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  for (const signal of signals) process.on(signal, cancel);
  const child = spawn(options.copilot || 'copilot', copilotArguments(options, selection), {
    cwd: projectRoot, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const spawned = await new Promise((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  const cleanup = () => {
    for (const signal of signals) process.removeListener(signal, cancel);
    if (logFd !== null) { fs.closeSync(logFd); logFd = null; }
  };
  if (!spawned) {
    cleanup();
    emit({ event: 'exited', status: state.cancelled ? 'cancelled' : 'failure', exit_code: null, reason: 'harness_unavailable' });
    return state.cancelled ? EXIT_CODES.cancelled : EXIT_CODES.failure;
  }
  state.pid = child.pid;
  if (state.cancelled) void stop();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const errors = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
  errors.on('line', log);
  lines.on('line', (line) => {
    log(line);
    let message;
    try { message = JSON.parse(line); } catch (_) { return; }
    const translated = translate(message);
    if (!translated) return;
    if ((translated.kind === 'init' || translated.kind === 'result')
      && translated.sessionId !== options['session-id']) {
      state.identityMismatch = true;
      void stop();
      return;
    }
    // Copilot can attach its JSON listener after session.start. Its terminal
    // result carries the authoritative session ID even when init was not streamed.
    if ((translated.kind === 'init' || translated.kind === 'result') && !state.started) {
      state.started = true;
      emit({ event: 'session_started', client_session_id: options['session-id'] });
    }
    if (translated.kind === 'error') {
      state.error = true;
      if (translated.rateLimited) emit({ event: 'rate_limited', reset_at: translated.resetAt });
    } else if (translated.kind === 'result') {
      state.error ||= translated.isError;
      state.result = translated;
    }
  });
  const timer = setInterval(() => {
    if (state.stopping || state.leaseLost) return;
    try {
      if (watchdog(runtime, childEnv, projectRoot, sessionKey, options.order) === runtime.VERDICTS.LOST) {
        state.leaseLost = true;
        void stop();
      }
    } catch (_) {
      state.error = true;
      void stop();
    }
  }, tickMs);
  const exit = await exited;
  clearInterval(timer);
  await stop();
  // A descendant may retain stdio after the main child exits. Bound the drain.
  let drainTimer;
  await Promise.race([closed, new Promise((resolve) => { drainTimer = setTimeout(resolve, 2000); })]);
  clearTimeout(drainTimer);
  lines.close();
  errors.close();
  child.stdout.destroy();
  child.stderr.destroy();
  cleanup();
  try { releaseRuns(runtime, childEnv, projectRoot, sessionKey, options.order); } catch (_) { state.error = true; }
  let status = 'failure';
  let reason = null;
  if (state.cancelled) status = 'cancelled';
  else if (state.identityMismatch) reason = 'session_mismatch';
  else if (state.leaseLost) reason = 'lease_lost';
  else if (state.error) reason = 'harness_error';
  else if (exit.code !== 0) reason = 'harness_failed';
  else if (!state.started || !state.result) reason = 'incomplete_stream';
  else status = 'success';
  emit({ event: 'exited', status, exit_code: exit.code, ...(reason ? { reason } : {}) });
  return EXIT_CODES[status];
}

module.exports = { EXIT_CODES, copilotArguments, launch, parseLauncherArgs, selectPlugin, translate };

if (require.main === module) {
  launch(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => {
    process.stderr.write('zensu launcher: internal fault\n');
    process.exitCode = 2;
  });
}
