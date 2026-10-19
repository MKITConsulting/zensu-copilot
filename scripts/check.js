#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'upstream/zensu-claude-code');
const plugin = path.join(root, 'dist/zensu');
const tree = require('../upstream-tree.json');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Unexpected symlink: ${file}`);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
for (const entry of tree) {
  assert.equal(entry.type, 'blob');
  const file = path.join(source, entry.path);
  const data = fs.readFileSync(file);
  const oid = crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  assert.equal(oid, entry.oid, `Pinned upstream changed: ${entry.path}`);
}
assert.equal(walk(source).length, tree.length, 'Untracked files in pinned source snapshot');
const build = JSON.parse(fs.readFileSync(path.join(plugin, 'build.json')));
const actual = walk(plugin).map(file => path.relative(plugin, file)).filter(file => file !== 'build.json').sort();
assert.deepEqual(build.files.map(file => file.target).sort(), actual, 'Build inventory mismatch');
for (const file of build.files) assert.equal(sha256(fs.readFileSync(path.join(plugin, file.target))), file.sha256, `Package changed: ${file.target}`);
assert.equal(build.skills.length, 32);
assert.equal(new Set(build.skills).size, 32);
for (const skill of build.skills) {
  const text = fs.readFileSync(path.join(plugin, 'skills', skill, 'SKILL.md'), 'utf8');
  assert(text.startsWith('---\n'), `Missing skill metadata: ${skill}`);
  assert(text.includes(`name: ${skill}\n`), `Skill name mismatch: ${skill}`);
}
const agents = fs.readdirSync(path.join(plugin, 'com.github.copilot/agents'));
assert.equal(agents.length, 6);
for (const agent of agents) assert(agent.endsWith('.agent.md'));
const hooks = JSON.parse(fs.readFileSync(path.join(plugin, 'com.github.copilot/hooks/hooks.json')));
assert.equal(hooks.version, 1);
assert.equal(Object.keys(hooks.hooks).length, 11);
for (const [event, entries] of Object.entries(hooks.hooks)) {
  assert.equal(entries.length, 1, `Expected one sequenced dispatcher: ${event}`);
  assert(entries[0].bash.endsWith(`dispatcher.js" ${event}`));
}
let checked = 0;
for (const file of walk(plugin)) {
  if (!/\.(?:js|mjs|sh)$/.test(file)) continue;
  const isShell = file.endsWith('.sh');
  const result = spawnSync(isShell ? 'bash' : process.execPath, [isShell ? '-n' : '--check', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${path.relative(plugin, file)}: ${result.stderr}`);
  checked++;
}
assert.equal(build.host, 'copilot');
assert.equal(build.schemaVersion, 2);
assert(!fs.existsSync(path.join(plugin, 'hooks/hooks.json')), 'Foreign hook registry leaked into native package');
assert(fs.existsSync(path.join(plugin, 'hooks/registry.json')), 'Native policy registry missing');
for (const file of build.files) {
  assert(file.source.startsWith('src/') || ['README.md', 'docs/parity.md', 'docs/copilot-runtime.md'].includes(file.source), `Non-owned build source: ${file.source}`);
  assert.equal(sha256(fs.readFileSync(path.join(root, file.source))), file.sha256, `Build transformed owned source: ${file.target}`);
  if (!/\.(?:js|mjs|sh)$/.test(file.target)) continue;
  const text = fs.readFileSync(path.join(plugin, file.target), 'utf8');
  assert(!/process\.env\.CLAUDE_|\$\{?CLAUDE_|hookSpecificOutput\s*:|\.hookSpecificOutput|hookEventName/.test(text), `Foreign runtime contract in ${file.target}`);
  assert(!/compatibilityEnv|projectTranscript\(|projectEvents\(|upstream\//.test(text), `Compatibility runtime in ${file.target}`);
}
assert(!fs.existsSync(path.join(plugin, '.claude-plugin')), 'Foreign manifest leaked into native package');
console.log(`Verified ${tree.length} immutable source files, ${build.files.length} package hashes, 32 skills, 6 agents, 11 events and ${checked} runtime syntax checks.`);
