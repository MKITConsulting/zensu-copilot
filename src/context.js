'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

function identity(value, label = 'session ID') {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f/\\]/.test(value)) {
    throw new Error(`Invalid Copilot ${label}`);
  }
  return value;
}
const key = (value) => crypto.createHash('sha256').update(identity(value)).digest('hex');
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
function directory(value, create = false) {
  const resolved = path.resolve(value);
  if (create) fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe directory: ${resolved}`);
  return fs.realpathSync.native(resolved);
}
function readPrivate(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('Unsafe private record');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writePrivate(file, value) {
  directory(path.dirname(file), true);
  if (fs.existsSync(file)) readPrivate(file);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function writePrivateText(file, text) {
  directory(path.dirname(file), true);
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe private text record');
  }
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function resolveContext(raw, env = process.env, root = path.resolve(__dirname, '../..')) {
  const nativeSessionId = identity(raw.sessionId);
  const pluginRoot = directory(root);
  for (const name of ['PLUGIN_ROOT', 'COPILOT_PLUGIN_ROOT']) {
    if (env[name] && directory(env[name]) !== pluginRoot) throw new Error(`${name} does not identify this installation`);
  }
  const copilotHome = path.resolve(env.COPILOT_HOME || path.join(os.homedir(), '.copilot'));
  const pluginData = directory(env.COPILOT_PLUGIN_DATA || env.PLUGIN_DATA || path.join(copilotHome, 'zensu', 'plugin-data'), true);
  if (pluginData === pluginRoot || pluginData.startsWith(pluginRoot + path.sep)) throw new Error('Plugin data must be outside installation');
  const cwd = directory(raw.cwd || process.cwd());
  const registryDirectory = directory(path.join(pluginData, 'copilot-sessions'), true);
  const parentId = raw.parentAgentId;
  const ownRecord = readPrivate(path.join(registryDirectory, `${key(nativeSessionId)}.json`));
  const parentRecord = parentId ? readPrivate(path.join(registryDirectory, `${key(parentId)}.json`)) : null;
  // Native child tools use the child's sessionId; lifecycle hooks use the
  // parent's. The host-supplied parent chain is the only source of authority.
  const sessionId = identity(parentRecord?.rootSessionId || parentId || ownRecord?.rootSessionId || nativeSessionId);
  const registryFile = path.join(registryDirectory, `${key(sessionId)}.json`);
  const record = readPrivate(registryFile);
  if (record && record.sessionId !== sessionId) throw new Error('Session record identity mismatch');
  return { sessionId, nativeSessionId, parentId, agentRecord: ownRecord?.rootSessionId ? ownRecord : null, pluginRoot, pluginData, copilotHome, cwd, registryFile, record,
    transcriptPath: raw.transcriptPath || path.join(copilotHome, 'session-state', sessionId, 'events.jsonl') };
}
function nativeEnv(context, base = process.env) {
  const env = { ...base };
  for (const name of Object.keys(env)) {
    // Never inherit another session's private authority or a foreign host's
    // identity. All host values below come from this native hook invocation.
    if (name.startsWith('CLAUDE_') || /^ZENSU_(CONTEXT|SESSION_KEY|RUNTIME_DIGEST|SOURCE_REVISION|PRINCIPAL|PROJECT_ROOT|CONTROL_RECORD|BOUND_SESSION_ID)/.test(name)) delete env[name];
  }
  Object.assign(env, {
    COPILOT_PLUGIN_ROOT: context.pluginRoot, COPILOT_PLUGIN_DATA: context.pluginData,
    COPILOT_SESSION_ID: context.sessionId, COPILOT_PROJECT_DIR: context.cwd,
    COPILOT_HOME: context.copilotHome, ZENSU_BOUND_SESSION_ID: context.sessionId,
    ZENSU_RUNTIME_HOST: 'copilot', PLUGIN_ROOT: context.pluginRoot,
  });
  return env;
}
function shellBinding(context, command) {
  if (typeof command !== 'string') throw new Error('Shell command must be a string');
  const env = nativeEnv(context, {});
  // Marker makes post-tool command recovery exact; the original command remains
  // available verbatim after one newline, without eval or string interpolation.
  const assignment = Object.entries(env).map(([name, value]) => `${name}=${quote(value)}`).join(' ');
  return `# zensu-copilot-context-v1\nexport ${assignment}\n${command}`;
}
function unbindShell(command) {
  if (typeof command !== 'string' || !command.startsWith('# zensu-copilot-context-v1\n')) return command;
  const lines = command.split('\n');
  if (!lines[1].startsWith('export ')) throw new Error('Malformed session binding');
  return lines.slice(2).join('\n');
}
function observe(context, event, extra = {}) {
  const now = new Date().toISOString();
  const previous = readPrivate(context.registryFile);
  const rootEvent = !extra.isChild && !extra.agentId && context.nativeSessionId === context.sessionId;
  const record = { ...(previous || {}), schemaVersion: 1, sessionId: context.sessionId,
    cwd: previous?.cwd || context.cwd, startedAt: previous?.startedAt || now, updatedAt: now,
    transcriptPath: context.transcriptPath, status: event === 'sessionEnd' && rootEvent ? 'ended' : (previous?.status || 'active') };
  // The dispatcher parent is the Copilot hook process or a shell, not necessarily
  // the CLI. Do not manufacture a live CLI PID from process.ppid.
  if (!previous) record.pid = null;
  if (event === 'sessionStart') record.status = 'active';
  writePrivate(context.registryFile, record);
  if (event === 'subagentStart' && extra.agentId && extra.agentId !== context.sessionId) {
    writePrivate(path.join(context.pluginData, 'copilot-sessions', `${key(extra.agentId)}.json`), {
      schemaVersion: 1, sessionId: extra.agentId, rootSessionId: context.sessionId,
      parentAgentId: context.parentId || context.nativeSessionId, agentType: extra.agentType,
      cwd: context.cwd, startedAt: now, updatedAt: now, status: 'active', pid: null,
      transcriptPath: context.transcriptPath,
    });
  }
  if (event === 'subagentStop' && extra.agentId && extra.agentId !== context.sessionId) {
    const childFile = path.join(context.pluginData, 'copilot-sessions', `${key(extra.agentId)}.json`);
    const child = readPrivate(childFile);
    if (child?.rootSessionId === context.sessionId) writePrivate(childFile, { ...child, status: 'ended', updatedAt: now });
  }
  return record;
}
module.exports = { identity, key, quote, directory, readPrivate, writePrivate, writePrivateText, resolveContext, nativeEnv, shellBinding, unbindShell, observe };
