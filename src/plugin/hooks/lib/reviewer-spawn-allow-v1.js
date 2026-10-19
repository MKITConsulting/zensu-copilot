#!/usr/bin/env node
// reviewer-spawn-allow-v1.js — decides whether a native preToolUse task spawn is
// one of Zensu's own capability-confined reviewers, and therefore may be granted
// by this plugin; Copilot still owns the final tool permission decision.
//
// Native task grants are limited to this plugin's confined reviewers. The
// capability policy independently checks every tool they invoke; this grant
// does not permit a general child, a write or an unclassified agent.
const fs = require('node:fs');
const path = require('node:path');
var principal = require('./copilot-principal-v1.js');


var PLUGIN_SCOPE = 'zensu:';

function pluginScoped(sets) {
  var out = [];
  sets.forEach(function (set) {
    Array.from(set).forEach(function (name) {
      if (typeof name !== 'string') return;
      if (name.indexOf(PLUGIN_SCOPE) !== 0) return;
      if (out.indexOf(name) === -1) out.push(name);
    });
  });
  return out.sort();
}

var READ_TRIO = Object.freeze(['glob', 'grep', 'view']);

function declaredTools(agentsDir, name) {
  var stem = name.indexOf(PLUGIN_SCOPE) === 0 ? name.slice(PLUGIN_SCOPE.length) : name;
  if (stem === '' || stem.indexOf('/') !== -1 || stem.indexOf('\\') !== -1
      || stem === '.' || stem === '..') return null;
  var text;
  try {
    text = fs.readFileSync(path.join(agentsDir, stem + '.agent.md'), 'utf8');
  } catch (e) {
    return null;
  }
  var parts = text.split('---');
  if (parts.length < 2) return null;
  var found = /^tools:[ \t]*(.+)$/m.exec(parts[1]);
  if (!found) return null;
  try {
    const tools = JSON.parse(found[1]);
    return Array.isArray(tools) && tools.every(tool => typeof tool === 'string') ? tools.sort() : null;
  } catch { return null; }
}

function confinedByFrontmatter(agentsDir, names) {
  return names.filter(function (name) {
    var tools = declaredTools(agentsDir, name);
    if (!tools || tools.length !== READ_TRIO.length) return false;
    return tools.every(function (tool, i) { return tool === READ_TRIO[i]; });
  });
}

var AGENTS_DIR = path.join(__dirname, '..', '..', 'com.github.copilot', 'agents');

var CONFINED_REVIEWER_AGENTS = Object.freeze(confinedByFrontmatter(AGENTS_DIR, pluginScoped([
  principal.REVIEWER_TYPES,
  principal.EVIDENCE_WORKER_TYPES,
])));

var SPAWN_TOOL_NAMES = Object.freeze(['task']);

var MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

var REFUSALS = Object.freeze({
  UNREADABLE: 'unreadable-payload',
  NOT_A_SPAWN: 'not-a-spawn-tool',
  NOT_CONFINED: 'not-a-confined-reviewer',
});

function isConfinedReviewer(subagentType) {
  return typeof subagentType === 'string'
    && CONFINED_REVIEWER_AGENTS.indexOf(subagentType) !== -1;
}

function allowVerdict(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { allow: false, reason: REFUSALS.UNREADABLE, subagentType: '' };
  }
  if (SPAWN_TOOL_NAMES.indexOf(payload.toolName) === -1) {
    return { allow: false, reason: REFUSALS.NOT_A_SPAWN, subagentType: '' };
  }
  var input = payload.toolArgs;
  var subagentType = input && typeof input === 'object' && !Array.isArray(input)
    ? input.agent_type
    : undefined;
  if (!isConfinedReviewer(subagentType)) {
    return {
      allow: false,
      reason: REFUSALS.NOT_CONFINED,
      subagentType: typeof subagentType === 'string' ? subagentType : '',
    };
  }
  return { allow: true, reason: '', subagentType: subagentType };
}

function decisionReason(subagentType) {
  return 'Zensu grants its own read-only reviewer spawn ' + subagentType
    + ' (view/grep/glob only). Disable with hooks.reviewerSpawnAutoAllow=false'
    + ' in ~/.zensu/config.json.';
}

function renderDecision(verdict) {
  if (!verdict || verdict.allow !== true) return '';
  return JSON.stringify({
    
      permissionDecision: 'allow',
      permissionDecisionReason: decisionReason(verdict.subagentType),
  }) + '\n';
}

function parsePayload(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (Buffer.byteLength(raw, 'utf8') > MAX_PAYLOAD_BYTES) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function decide(raw) {
  return renderDecision(allowVerdict(parsePayload(raw)));
}

function main() {
  var chunks = [];
  var size = 0;
  process.stdin.on('data', function (c) {
    size += c.length;
    if (size <= MAX_PAYLOAD_BYTES) chunks.push(c);
  });
  process.stdin.on('end', function () {
    if (size > MAX_PAYLOAD_BYTES) return;
    process.stdout.write(decide(Buffer.concat(chunks).toString('utf8')));
  });
  process.stdin.on('error', function () {});
}

module.exports = {
  PLUGIN_SCOPE: PLUGIN_SCOPE,
  CONFINED_REVIEWER_AGENTS: CONFINED_REVIEWER_AGENTS,
  READ_TRIO: READ_TRIO,
  confinedByFrontmatter: confinedByFrontmatter,
  SPAWN_TOOL_NAMES: SPAWN_TOOL_NAMES,
  MAX_PAYLOAD_BYTES: MAX_PAYLOAD_BYTES,
  REFUSALS: REFUSALS,
  isConfinedReviewer: isConfinedReviewer,
  allowVerdict: allowVerdict,
  renderDecision: renderDecision,
  decide: decide,
  main: main,
};

if (require.main === module) {
  main();
}
