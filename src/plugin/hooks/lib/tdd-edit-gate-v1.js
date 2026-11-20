#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = __dirname;
const EXIT = Object.freeze({ DECIDED: 0, BIND_FAILED: 10, SESSION_DENY: 11, SHELL_REFERENCE: 13 });
const BINDER_EXCLUDED = Object.freeze([
  'ZENSU_COPILOT_PLUGIN_ROOT',
  'ZENSU_SESSION_KEY',
  'ZENSU_SESSION_CONTEXT',
  'ZENSU_RUNTIME_DIGEST',
  'ZENSU_PROJECT_ROOT',
  'ZENSU_SESSION_ADOPTED',
  '_ZENSU_PROJECT_DIR_MEMO',
  'ZENSU_TDD_GATE_LOG_COMMAND',
]);
const CANONICAL_KEY_RE = /^scv1_[0-9a-f]{64}$/;
const STATE_NAME_RE = /^tdd-phase-(scv1_[a-f0-9]{64})\.json$/;
const STATE_GLOB_RE = /^tdd-phase-scv1_[\s\S]*\.json$/;
const TEST_DIRECTORIES = Object.freeze(['test', 'tests', '__tests__', 'spec', 'specs']);
const TEST_NAME_PARTS = Object.freeze(['_test.', '_tests.', '.test.', '.tests.', '.spec.', '.specs.', '_spec.', '_specs.']);
const TEST_LOWER_NAME_PARTS = Object.freeze(['_test.', '_tests.', '_spec.', '_specs.']);
const HEADER_LINES = 20;
const SHELL_TOOLS = Object.freeze(['uname', 'basename', 'tr', 'stat', 'head', 'sed', 'grep']);
const SHELL_UNSURE = Symbol('shell-unsure');

function libPath(name) {
  return path.join(LIB, name);
}

function captured(value) {
  return Buffer.from(String(value), 'utf8').toString('utf8').replace(/\0/g, '').replace(/\n+$/, '');
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function isSymlink(file) {
  const link = lstatOrNull(file);
  return Boolean(link) && link.isSymbolicLink();
}

function regularFile(file) {
  const stat = statOrNull(file);
  return Boolean(stat) && stat.isFile();
}

function regularUnlinkedFile(file) {
  return regularFile(file) && !isSymlink(file);
}

function readable(file) {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function sourceable(file) {
  return regularFile(file) && readable(file);
}

function onPath(name) {
  for (const entry of (process.env.PATH || '').split(':')) {
    const candidate = path.join(entry || '.', name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function shellDependenciesPresent() {
  return sourceable(libPath('zensu-host-path.sh')) && SHELL_TOOLS.every((tool) => onPath(tool));
}

function directory(file) {
  const stat = statOrNull(file);
  return Boolean(stat) && stat.isDirectory();
}

function physicalDirectory(dir) {
  if (typeof dir !== 'string' || dir === '' || !directory(dir)) return null;
  try {
    fs.accessSync(dir, fs.constants.X_OK);
    return fs.realpathSync.native(dir);
  } catch {
    return null;
  }
}

function hostPath(value) {
  if (typeof value !== 'string' || value === '' || /[\r\n]/.test(value)) return null;
  if (!directory(value) || isSymlink(value)) return null;
  if (!value.startsWith('/') && process.env.CDPATH) {
    const shell = spawnSync('bash', [libPath('zensu-host-path.sh'), value], { encoding: 'utf8' });
    return shell.status === 0 ? captured(shell.stdout) : null;
  }
  return physicalDirectory(value);
}

function msysExclusions(names) {
  const existing = process.env.MSYS2_ENV_CONV_EXCL || '';
  if (/[\r\n]/.test(existing)) return null;
  if (!regularUnlinkedFile(libPath('zensu-msys-env.sh')) || !readable(libPath('zensu-msys-env.sh'))) return null;
  if (existing === '*') return existing;
  let result = existing;
  for (const name of names) {
    const selector = `${name}=`;
    if (!`;${result};`.includes(`;${selector};`)) result = `${result}${result ? ';' : ''}${selector}`;
  }
  return result;
}

function posixBasename(value) {
  const trimmed = value.replace(/\/+$/, '');
  if (trimmed === '') return value === '' ? '' : '/';
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

function posixDirname(value) {
  const trimmed = value.replace(/\/+$/, '');
  if (trimmed === '') return value.startsWith('/') ? '/' : '.';
  const slash = trimmed.lastIndexOf('/');
  if (slash < 0) return '.';
  const parent = trimmed.slice(0, slash).replace(/\/+$/, '');
  return parent === '' ? '/' : parent;
}

function asciiLower(value) {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function field(payload, keys) {
  let value = payload;
  for (const key of keys) {
    if (value && typeof value === 'object') value = value[key];
    else {
      value = '';
      break;
    }
  }
  return typeof value === 'string' ? value : '';
}

function principalIsMain(text) {
  try {
    if (!sourceable(libPath('zensu-agent-context.sh'))) return false;
    if (!regularUnlinkedFile(libPath('copilot-principal-v1.js'))) return false;
    const payload = JSON.parse(text || '{}');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (payload.eventName !== 'preToolUse') return false;
    return require('./copilot-principal-v1.js').classifyPreToolPayload(payload) === 'main-v1';
  } catch {
    return false;
  }
}

function bind(raw) {
  try {
    if (raw.length === 0) return null;
    if (!regularUnlinkedFile(libPath('copilot-hook-session-v1.js'))) return null;
    const nativePluginRoot = hostPath(physicalDirectory(path.join(LIB, '..', '..')));
    if (!nativePluginRoot) return null;
    const nativePluginData = hostPath(process.env.COPILOT_PLUGIN_DATA || '');
    if (!nativePluginData) return null;
    const exclusions = msysExclusions(['COPILOT_PLUGIN_ROOT', 'COPILOT_PLUGIN_DATA']);
    if (exclusions === null) return null;
    const hookSession = require('./copilot-hook-session-v1.js');
    const environment = { ...process.env };
    for (const name of BINDER_EXCLUDED) delete environment[name];
    Object.assign(environment, {
      MSYS2_ENV_CONV_EXCL: exclusions,
      COPILOT_PLUGIN_ROOT: nativePluginRoot,
      COPILOT_PLUGIN_DATA: nativePluginData,
    });
    const payload = hookSession.parseHookPayload(raw);
    const binding = hookSession.bindAndDisclose(payload, environment, { autoAdopt: true }, 'zensu tdd edit gate');
    hookSession.assertExportableBinding(binding);
    return binding;
  } catch {
    return null;
  }
}

function resolveSessionId(raw, injected) {
  const value = raw === '' ? injected : raw;
  if (value === '') return null;
  if (!regularFile(libPath('session-control-core-v1.js'))) return null;
  const core = require('./session-control-core-v1.js');
  let resolved;
  if (CANONICAL_KEY_RE.test(value)) resolved = value;
  else {
    try {
      resolved = captured(core.sessionKey(value));
    } catch {
      return null;
    }
  }
  if (injected !== '') {
    if (!CANONICAL_KEY_RE.test(injected)) {
      try {
        if (core.sessionKey(injected) !== injected) return null;
      } catch {
        return null;
      }
    }
    if (resolved !== injected) return null;
  }
  return resolved;
}

function boundProjectRoot(binding) {
  const candidate = binding.projectRoot;
  const contextFile = binding.contextFile;
  const sessionKey = binding.sessionKey;
  if (!candidate) return null;
  const before = physicalDirectory(candidate);
  if (!before || !contextFile || !sessionKey) return null;
  if (isSymlink(candidate) || !directory(candidate)) return null;
  if (isSymlink(contextFile) || !regularFile(contextFile)) return null;
  if (!regularFile(libPath('session-control-core-v1.js'))) return null;
  if (msysExclusions(['PROJECT_CANDIDATE', 'CONTEXT_FILE']) === null) return null;
  try {
    require('./copilot-hook-session-v1.js').validateBoundProject({ projectRoot: candidate, contextFile, sessionKey });
  } catch {
    return null;
  }
  const rendered = physicalDirectory(candidate);
  return rendered && rendered === before ? rendered : null;
}

function tddLibraryLoads(declaredRoot) {
  if (!sourceable(libPath('zensu-tdd-phase.sh'))) return false;
  const executed = physicalDirectory(path.join(LIB, '..', '..'));
  if (!executed) return false;
  let root = declaredRoot;
  if (root) {
    if (physicalDirectory(root) !== executed) return false;
  }
  root = executed;
  const nativeRoot = hostPath(root);
  if (!nativeRoot) return false;
  return regularUnlinkedFile(path.join(nativeRoot, 'hooks', 'lib', 'session-control-core-v1.js'));
}

function stateFileFor(projectRoot, key) {
  return `${projectRoot}/.zensu/state/tdd-phase-${key}.json`;
}

function nativeProjectPath(shellPath, shellRoot, nativeRoot) {
  if (!shellPath || /[\r\n]/.test(shellPath)) return null;
  const framed = `/${shellPath}/`;
  if (framed.includes('/../') || framed.includes('/./')) return null;
  if (!shellRoot || !nativeRoot) return null;
  if (shellPath === shellRoot) return nativeRoot;
  if (!shellPath.startsWith(`${shellRoot}/`)) return null;
  const suffix = shellPath.slice(shellRoot.length);
  if (!suffix) return null;
  return `${nativeRoot.replace(/\/$/, '')}${suffix}`;
}

function readState(stateFile, projectRoot, binding) {
  if (stateFile === '') return { status: 'missing' };
  const base = posixBasename(stateFile);
  if (!STATE_GLOB_RE.test(base)) return { status: 'invalid' };
  const key = resolveSessionId(base.slice('tdd-phase-'.length, -'.json'.length), binding.sessionKey);
  if (key === null || stateFileFor(projectRoot, key) !== stateFile) return { status: 'invalid' };
  const nativeRoot = nativeProjectPath(projectRoot, projectRoot, binding.projectRoot);
  const nativeFile = nativeProjectPath(stateFile, projectRoot, binding.projectRoot);
  if (nativeRoot === null || nativeFile === null) return { status: 'invalid' };
  if (!regularUnlinkedFile(libPath('session-control-core-v1.js'))) return { status: 'invalid' };
  const match = STATE_NAME_RE.exec(path.basename(nativeFile));
  if (!match) return { status: 'invalid' };
  let stat;
  try {
    stat = fs.lstatSync(nativeFile);
  } catch (error) {
    return { status: error && error.code === 'ENOENT' ? 'missing' : 'invalid' };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { status: 'invalid' };
  try {
    const core = require('./session-control-core-v1.js');
    return { status: 'valid', state: core.readWorkflowState({ projectRoot: nativeRoot, sessionId: match[1] }) };
  } catch {
    return { status: 'invalid' };
  }
}

function activationStatus(sessionId, binding, projectRoot) {
  const key = resolveSessionId(sessionId, binding.sessionKey);
  if (key === null) return 'invalid';
  const bound = resolveSessionId(key, binding.sessionKey);
  if (bound === null || !binding.contextFile || posixBasename(binding.contextFile) !== `${bound}.json`) return 'inactive';
  const snapshot = readState(stateFileFor(projectRoot, key), projectRoot, binding);
  if (snapshot.status !== 'valid') return 'invalid';
  return snapshot.state.active === true ? 'active' : 'inactive';
}

function shellAbsolute(filePath) {
  if (filePath.startsWith('/') || filePath.startsWith('\\\\')) return true;
  if (/^[A-Za-z]:[\\/]/.test(filePath)) return true;
  const characters = Array.from(filePath);
  if (characters.length >= 3 && characters[1] === ':' && (characters[2] === '/' || characters[2] === '\\')) {
    return SHELL_UNSURE;
  }
  return false;
}

function pathClass(fp, sd) {
  const lownorm = p => path.posix.normalize(String(p).replace(/\\/g, '/')).toLowerCase();
  const realdir = p => {
    try {
      return fs.realpathSync(p);
    } catch (_) {
      return path.resolve(p);
    }
  };
  const realfile = p => {
    try {
      return fs.realpathSync(p);
    } catch (_) {
      return path.join(realdir(path.dirname(p)), path.basename(p));
    }
  };
  const fAbs = lownorm(realfile(path.resolve(fp || '')));
  const sAbs = lownorm(realdir(path.resolve(sd || ''))) + '/';
  if (fAbs.indexOf(sAbs) === 0) return 'state';
  if (fAbs.indexOf('/.zensu/') >= 0 || fAbs.endsWith('/.zensu')) return 'zensu';
  return 'other';
}

function readHeader(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const chunks = [];
    const buffer = Buffer.alloc(65536);
    let lines = 0;
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      let end = count;
      for (let index = 0; index < count; index += 1) {
        if (buffer[index] === 0x0a) {
          lines += 1;
          if (lines === HEADER_LINES) {
            end = index + 1;
            break;
          }
        }
      }
      chunks.push(Buffer.from(buffer.subarray(0, end)));
      if (lines >= HEADER_LINES) break;
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  } finally {
    fs.closeSync(descriptor);
  }
}

function headerNamesTest(file) {
  const header = readHeader(file);
  if (header === null) return false;
  let bytes = header;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  if (bytes.includes(0)) return SHELL_UNSURE;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return SHELL_UNSURE;
  }
  const lines = text.split('\n');
  const localeSpaced = /^[\t\n\v\f\r \u0080-\u{10FFFF}]*[\u0080-\u{10FFFF}][\t\n\v\f\r \u0080-\u{10FFFF}]*#\[(?:test|cfg\(test\))\]/u;
  if (lines.some((line) => localeSpaced.test(line))) return SHELL_UNSURE;
  if (lines.some((line) => /^(?:func Test|describe\(|it\(|test\(|@Test|def test_)/.test(line))) return true;
  if (lines.some((line) => /^[\t\n\v\f\r ]*#\[test\]/.test(line))) return true;
  return lines.some((line) => /^[\t\n\v\f\r ]*#\[cfg\(test\)\]/.test(line));
}

function shellLocaleNeutral() {
  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '';
  return locale === '' || locale === 'C' || locale === 'POSIX' || /(?:^|\.)utf-?8(?:@|$)/i.test(locale);
}

function isTestPath(filePath) {
  if (filePath === '') return false;
  if (!shellLocaleNeutral()) return SHELL_UNSURE;
  if (filePath.startsWith('-') || filePath.includes('\\')) return SHELL_UNSURE;
  if (isSymlink(filePath)) return false;
  const lower = asciiLower(filePath);
  if (TEST_DIRECTORIES.some((name) => lower.includes(`/${name}/`) || lower.startsWith(`${name}/`))) return true;
  const base = posixBasename(filePath);
  if (base.startsWith('test_') || TEST_NAME_PARTS.some((part) => base.includes(part))) return true;
  const lowerBase = asciiLower(base);
  if (TEST_LOWER_NAME_PARTS.some((part) => lowerBase.includes(part))) return true;
  const stat = statOrNull(filePath);
  if (!stat || !stat.isFile()) return false;
  if (stat.nlink > 1) return false;
  return headerNamesTest(filePath);
}

function echoRewrites(value) {
  return typeof value === 'string' && (value.startsWith('-') || value.includes('\\'));
}

function hasRedFail(state, step) {
  return Array.isArray(state.history)
    && state.history.some((entry) => entry.step === step && entry.phase === 'RED_FAIL');
}

function denial(reason) {
  return JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason });
}

function invalidStateDenial(stateFile) {
  const file = stateFile || '(unknown)';
  return denial('TDD-Phase-Gate: edit blocked because the existing session-state file is invalid or unreadable (' + file + '). It cannot be trusted as inactive or UNINITIALIZED. Start a fresh Copilot CLI session so Session Control v1 creates new state; use ZENSU_TDD_GATE=off only as an explicit, reviewed recovery escape.');
}

function stateFileDenial(logCommand) {
  return denial('TDD-Phase-Gate: direct edits to the session-state files (.zensu/state/) are blocked while a session is active — state flags change only through ' + logCommand + ' (e.g. --tdd-begin, --tdd-reset, --phase).');
}

function phaseDenial(toolName, filePath, phaseValue, stepValue, logCommand) {
  const phase = phaseValue || 'UNINITIALIZED';
  const step = stepValue || '(none)';
  const file = filePath || '(unknown)';
  const tool = toolName || 'edit';
  const header =
    'TDD-Phase-Gate: ' + tool + ' on ' + file + ' blocked.\n' +
    'Current phase: ' + phase + ', step: ' + step + '.\n' +
    'Expected: RED_WRITE | REFACTOR | (IMPL after RED_FAIL for step ' + step + ') | (GREEN_PASS only on test paths).\n';
  const reason = header +
    'Action:\n' +
    '  1. New test file: ' + logCommand + ' --phase RED_WRITE --step <id>\n' +
    '  2. IMPL: first run the test, set RED_FAIL:\n' +
    '     ' + logCommand + ' --phase RED_RUN --step <id>\n' +
    '     (run the test command)\n' +
    '     ' + logCommand + ' --phase RED_FAIL --step <id> --reason "..."\n' +
    '     ' + logCommand + ' --phase IMPL --step <id>\n' +
    '  3. Refactor: ' + logCommand + ' --phase REFACTOR --step <id>\n' +
    '  4. Legitimate non-TDD edit: ZENSU_TDD_GATE is read from the environment Copilot CLI was started in, so no edit, create or bash prefix can set it for this edit. Ask the user to choose: leave this chain with ' + logCommand + ' --tdd-reset, or restart Copilot CLI with ZENSU_TDD_GATE=off, which the bypass ledger records.';
  return denial(reason);
}

function appendHookLog(toolName, filePath, phase, step) {
  const log = process.env.ZENSU_HOOK_LOG;
  if (!log) return;
  try {
    fs.appendFileSync(log,
      `[hook: preToolUse] TDD-Phase-Gate: ${toolName} on ${filePath} blocked.\n`
      + `[hook: preToolUse] Current phase: ${phase}, step: ${step}.\n`
      + `[hook: preToolUse] Expected: RED_WRITE | REFACTOR | (IMPL after RED_FAIL for step ${step}) | (GREEN_PASS only on test paths).\n`
      + '[hook: preToolUse] permissionDecision=deny\n');
  } catch {
    return;
  }
}

function decided(output) {
  return { code: EXIT.DECIDED, output };
}

function exitWith(code) {
  return { code, output: '' };
}

function decide(raw) {
  const environment = process.env;
  if (!environment.ZENSU_TDD_GATE_LOG_COMMAND || !shellDependenciesPresent()) return exitWith(EXIT.SHELL_REFERENCE);
  const text = raw.toString('utf8');
  if (!principalIsMain(text)) return decided('');
  if (!sourceable(libPath('zensu-session.sh'))) return decided('');
  const binding = bind(raw);
  if (!binding) return exitWith(EXIT.BIND_FAILED);
  const payload = JSON.parse(text);
  const toolName = captured(field(payload, ['toolName']));
  if (toolName !== 'create' && toolName !== 'edit') return decided('');
  const sessionId = resolveSessionId(captured(field(payload, ['sessionId'])), binding.sessionKey);
  if (sessionId === null) return decided('');
  const filePath = captured(field(payload, ['toolArgs', 'path']));
  const projectRoot = boundProjectRoot(binding);
  if (projectRoot === null) return exitWith(EXIT.SESSION_DENY);
  if (!tddLibraryLoads(environment.COPILOT_PLUGIN_ROOT || '')) return decided('');
  const stateFile = stateFileFor(projectRoot, sessionId);
  if (environment.ZENSU_TDD_GATE === 'off') return exitWith(EXIT.SHELL_REFERENCE);

  const snapshot = readState(stateFile, projectRoot, binding);
  if (snapshot.status === 'missing') {
    const activation = activationStatus(sessionId, binding, projectRoot);
    return decided(activation === 'active' || activation === 'invalid' ? invalidStateDenial(stateFile) : '');
  }
  if (snapshot.status !== 'valid') return decided(invalidStateDenial(stateFile));
  const state = snapshot.state;
  if (state.active !== true) return decided('');

  const absolute = shellAbsolute(filePath);
  if (absolute === SHELL_UNSURE) return exitWith(EXIT.SHELL_REFERENCE);
  const filePathShell = absolute ? filePath : `${projectRoot}/${filePath}`;
  if (filePathShell === '' || /[\r\n]/.test(filePathShell)) return decided(invalidStateDenial(stateFile));
  const stateDirectory = nativeProjectPath(posixDirname(stateFile), projectRoot, binding.projectRoot);
  if (stateDirectory === null) return decided(invalidStateDenial(stateFile));
  let classification;
  try {
    classification = pathClass(filePathShell, stateDirectory);
  } catch {
    return decided(invalidStateDenial(stateFile));
  }
  const logCommand = environment.ZENSU_TDD_GATE_LOG_COMMAND;
  if (classification === 'state') return decided(stateFileDenial(logCommand));
  if (state.vanilla === true) return decided('');
  if (classification === 'zensu') return decided('');

  if (echoRewrites(state.phase) || echoRewrites(state.step_id)) return exitWith(EXIT.SHELL_REFERENCE);
  const phase = state.phase === undefined ? 'UNINITIALIZED' : captured(state.phase) || 'UNINITIALIZED';
  const step = state.step_id === undefined ? '' : captured(state.step_id);
  let allowed;
  if (phase === 'RED_WRITE' || phase === 'REFACTOR') allowed = true;
  else if (phase === 'RED_FAIL' || phase === 'GREEN_PASS') {
    const testPath = isTestPath(filePath);
    if (testPath === SHELL_UNSURE) return exitWith(EXIT.SHELL_REFERENCE);
    allowed = testPath === true;
  } else if (phase === 'IMPL') allowed = hasRedFail(state, step);
  else allowed = false;
  if (allowed) return decided('');
  const output = phaseDenial(toolName, filePath, phase, step, logCommand);
  appendHookLog(toolName, filePath, phase, step);
  return decided(output);
}

function main() {
  let result;
  try {
    result = decide(fs.readFileSync(0));
  } catch {
    result = exitWith(EXIT.SHELL_REFERENCE);
  }
  if (result.output) process.stdout.write(result.output);
  process.exitCode = result.code;
}

if (require.main === module) main();

module.exports = {
  captured,
  isTestPath,
  SHELL_UNSURE,
};
