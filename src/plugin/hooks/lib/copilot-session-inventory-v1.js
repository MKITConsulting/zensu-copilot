'use strict';

// Read-only native workspace observations used by reanchor. Unregistered does
// not mean inactive: an ordinary Copilot session can own a worktree without
// loading this plugin. Absence of a shutdown is deliberately conservative.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {parseEvents, eventOwner, readOnlyFlags} = require('../native/transcript.js');
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SESSIONS = 2048;
const MAX_WORKSPACE_BYTES = 64 * 1024;
const EVENT_HEAD_BYTES = 256 * 1024;
const EVENT_TAIL_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function directory(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('native session directory is not plain');
  return {file, stat};
}
function unchangedDirectory(before) {
  const after = directory(before.file);
  if (after.stat.dev !== before.stat.dev || after.stat.ino !== before.stat.ino) throw new Error('native session directory changed during inspection');
}
function readFile(file, limit, budget, tail = false) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.nlink !== 1) throw new Error('native session file is not a plain private file');
    if (!tail && before.size > limit) throw new Error('native workspace metadata exceeds the inspection limit');
    fd = fs.openSync(file, readOnlyFlags());
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error('native session file changed before inspection');
    }
    const chunk = (offset, length) => {
      if (budget.remaining < length) throw new Error('native session inventory exceeds the total inspection limit');
      budget.remaining -= length;
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const count = fs.readSync(fd, bytes, read, length - read, offset + read);
        if (!count) throw new Error('native session file ended during inspection');
        read += count;
      }
      return bytes.toString('utf8');
    };
    let text, truncated = false;
    if (!tail || opened.size <= EVENT_HEAD_BYTES + EVENT_TAIL_BYTES) text = chunk(0, opened.size);
    else {
      truncated = true;
      const head = chunk(0, EVENT_HEAD_BYTES), end = chunk(opened.size - EVENT_TAIL_BYTES, EVENT_TAIL_BYTES);
      const headBoundary = head.lastIndexOf('\n'), tailBoundary = end.indexOf('\n');
      if (headBoundary < 0 || tailBoundary < 0) throw new Error('native session event exceeds the inspection window');
      text = head.slice(0, headBoundary) + '\n' + end.slice(tailBoundary + 1);
    }
    const after = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || named.dev !== opened.dev || named.ino !== opened.ino || !named.isFile() || named.nlink !== 1) {
      throw new Error('native session file changed during inspection');
    }
    return {text, truncated};
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Only the documented top-level identity and cwd scalars are needed. Never
// evaluate arbitrary YAML tags, aliases, object constructors or nested values.
function workspaceMetadata(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^(id|cwd):(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const key = match[1], raw = (match[2] || '').trim();
    if (Object.hasOwn(out, key)) throw new Error('native workspace has duplicate identity or cwd');
    let value;
    if (raw.startsWith('"')) value = JSON.parse(raw);
    else if (raw.startsWith("'")) {
      if (!raw.endsWith("'") || raw.length < 2) throw new Error('invalid quoted native workspace scalar');
      value = raw.slice(1, -1).replaceAll("''", "'");
    } else {
      if (/^[!&*|>\[{]/.test(raw)) throw new Error('unsupported native workspace scalar');
      value = raw.replace(/\s+#.*$/, '');
    }
    if (typeof value !== 'string' || !value || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error('unsafe native workspace scalar');
    out[key] = value;
  }
  return out;
}

function sessionClaims(sessionDirectory, sessionId, budget) {
  const openedDirectory = directory(sessionDirectory);
  let workspace = {}, loaded = null;
  try { workspace = workspaceMetadata(readFile(path.join(sessionDirectory, 'workspace.yaml'), MAX_WORKSPACE_BYTES, budget).text); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { loaded = readFile(path.join(sessionDirectory, 'events.jsonl'), EVENT_HEAD_BYTES + EVENT_TAIL_BYTES, budget, true); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (workspace.id && workspace.id !== sessionId) throw new Error('native workspace identity does not match its directory');
  const parsed = loaded ? parseEvents(loaded.text) : {events: [], errors: []};
  if (parsed.errors.length) throw new Error('native session event stream is malformed or incomplete');
  const paths = new Set();
  const add = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error('native session working directory is unavailable or unsafe');
    paths.add(path.normalize(value));
  };
  if (workspace.cwd) add(workspace.cwd);
  const ids = new Set();
  let nativeIdentity = null, closed = false;
  for (const event of parsed.events) {
    if (typeof event.id !== 'string' || !event.id || ids.has(event.id)) throw new Error('native session event identity is missing or duplicated');
    ids.add(event.id);
    const owner = eventOwner(event);
    if (owner === undefined) throw new Error('native session event ownership is unknown');
    if (owner !== null) continue;
    const data = event.data;
    if (event.type === 'session.start') {
      if (data.sessionId !== sessionId) throw new Error('native event identity does not match its directory');
      nativeIdentity = data.sessionId;
      if (data.context?.cwd !== undefined) add(data.context.cwd);
      closed = false;
    } else if (event.type === 'session.resume') {
      if (data.context?.cwd !== undefined) add(data.context.cwd);
      closed = false;
    } else if (event.type === 'session.context_changed') {
      if (data.cwd !== undefined) add(data.cwd);
      closed = false;
    } else if (event.type === 'session.shutdown') closed = true;
    else if (closed && !['session.usage_info', 'session.info', 'session.metrics', 'session.title_changed'].includes(event.type)) {
      // Later activity, including an unknown future event, invalidates a prior
      // shutdown as proof of an inactive current session.
      closed = false;
    }
  }
  unchangedDirectory(openedDirectory);
  if (!nativeIdentity && !workspace.id) throw new Error('native session identity cannot be established');
  if (closed) return [];
  if (!paths.size) throw new Error('an unclosed native session has no observed working directory');
  return [...paths].map(value => ({session: sessionId, source: 'unclosed native Copilot session', path: value}));
}

function inventoryClaims(options = {}) {
  const claims = [], unverifiable = [], environment = options.environment || process.env;
  let home, store;
  try {
    const configured = environment.COPILOT_HOME || path.join(os.homedir(), '.copilot');
    if (typeof configured !== 'string' || !path.isAbsolute(configured)) throw new Error('Copilot home is not an absolute path');
    // A configured ancestor may be a platform alias such as /tmp; resolve that
    // boundary once, then reject all aliases within the native session store.
    directory(configured);
    home = fs.realpathSync.native(configured);
    store = directory(path.join(home, 'session-state'));
    const entries = fs.readdirSync(store.file, {withFileTypes: true});
    if (entries.length > MAX_SESSIONS) throw new Error('native session inventory exceeds the session limit');
    const budget = {remaining: MAX_TOTAL_BYTES};
    for (const entry of entries) {
      if (entry.name === options.sessionId) continue;
      if (!entry.isDirectory()) {
        if (entry.isSymbolicLink()) unverifiable.push(`native session entry ${entry.name} is a symbolic link`);
        continue;
      }
      if (!SESSION_ID.test(entry.name)) { unverifiable.push('native session directory has an unsupported identity'); continue; }
      try { claims.push(...sessionClaims(path.join(store.file, entry.name), entry.name, budget)); }
      catch (error) { unverifiable.push(`native session ${entry.name}: ${error.message}`); }
    }
    unchangedDirectory(store);
    const afterNames = fs.readdirSync(store.file).sort();
    if (JSON.stringify(entries.map(entry => entry.name).sort()) !== JSON.stringify(afterNames)) throw new Error('native session inventory changed during inspection');
  } catch (error) { unverifiable.push(`native session inventory unavailable: ${error.message}`); }
  return {claims, unverifiable};
}

module.exports = {inventoryClaims, workspaceMetadata, MAX_SESSIONS, EVENT_HEAD_BYTES, EVENT_TAIL_BYTES, MAX_TOTAL_BYTES};
