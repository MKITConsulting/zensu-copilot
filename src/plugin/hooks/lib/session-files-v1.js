'use strict';
const fs = require('node:fs');

// File descriptors bind safety checks to the bytes actually read. Session
// records are private regular files; links and streaming devices are refused.
function openPlainFile(file, maxBytes) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) return { status: 'unsafe' };
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return { status: 'unsafe' };
    const content = fs.readFileSync(fd, 'utf8');
    if (Buffer.byteLength(content) > maxBytes) return { status: 'unsafe' };
    return { status: 'ok', content };
  } catch (error) { return { status: error.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function gitEnvironment(base) {
  const env = { ...(base || process.env) };
  for (const name of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CONFIG|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)/.test(name)) delete env[name];
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}
module.exports = { openPlainFile, gitEnvironment };
