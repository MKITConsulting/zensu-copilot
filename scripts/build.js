#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist/zensu');
const files = new Map();
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function copy(from, relative) {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) throw new Error(`Source symlink refused: ${from}`);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(from).sort()) copy(path.join(from, entry), path.posix.join(relative, entry));
    return;
  }
  if (!stat.isFile()) throw new Error(`Unsupported source: ${from}`);
  const target = path.join(output, relative);
  const data = fs.readFileSync(from);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data, { mode: stat.mode & 0o777 });
  files.set(relative, { source: path.relative(root, from), target: relative, sha256: hash(data) });
}
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
copy(path.join(root, 'src/plugin'), '');
for (const name of ['protocol.js', 'transcript.js', 'dispatcher.js', 'context.js', 'helper.js', 'approval.js', 'review-gate.js', 'ai-work.js']) {
  copy(path.join(root, 'src', name), `hooks/native/${name}`);
}
copy(path.join(root, 'src/session-trail'), 'skills/zensu-session-trail/scripts');
copy(path.join(root, 'src/harness'), 'harness');
for (const name of ['README.md', 'docs/parity.md', 'docs/copilot-runtime.md', 'docs/ai-work-capture.md']) copy(path.join(root, name), name);
const manifest = JSON.parse(fs.readFileSync(path.join(output, 'plugin.json')));
if (manifest.version !== require('../package.json').version) throw new Error('Package/manifest version mismatch');
const skills = fs.readdirSync(path.join(output, 'skills')).sort();
const agents = fs.readdirSync(path.join(output, 'com.github.copilot/agents')).length;
const hooks = JSON.parse(fs.readFileSync(path.join(output, 'com.github.copilot/hooks/hooks.json'))).hooks;
fs.writeFileSync(path.join(output, 'build.json'), JSON.stringify({ schemaVersion: 2,
  host: 'copilot', version: manifest.version, skills, agents,
  files: [...files.values()].sort((a, b) => a.target.localeCompare(b.target)),
}, null, 2) + '\n');
console.log(`Built ${output}: ${skills.length} skills, ${agents} agents, ${Object.keys(hooks).length} native hook events from owned sources.`);
