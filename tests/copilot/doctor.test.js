'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const pluginSource = path.resolve(__dirname, '../../src/plugin');
const nativeDoctor = () => fs.readFileSync(path.join(pluginSource, 'hooks/lib/zensu-doctor-report.js'), 'utf8');
const SKILLS = fs.readdirSync(path.join(pluginSource, 'skills'));
const EXPECTED_EVENTS = Object.keys(JSON.parse(fs.readFileSync(path.join(pluginSource, 'com.github.copilot/hooks/hooks.json'))).hooks);
const EXPECTED_AGENTS = fs.readdirSync(path.join(pluginSource, 'com.github.copilot/agents')).map(name => name.replace(/\.agent\.md$/, ''));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-copilot-doctor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'plugin');
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  for (const dir of [plugin, project, home]) fs.mkdirSync(dir, { recursive: true });
  const write = (file, value) => {
    const location = path.join(plugin, file);
    fs.mkdirSync(path.dirname(location), { recursive: true });
    fs.writeFileSync(location, typeof value === 'string' ? value : JSON.stringify(value));
  };
  write('plugin.json', { name: 'zensu', version: '0.2.0' });
  write('build.json', { schemaVersion: 2, skills: SKILLS });
  for (const skill of SKILLS) write(`skills/${skill}/SKILL.md`, '# fixture');
  const hooks = { version: 1, hooks: Object.fromEntries(EXPECTED_EVENTS.map(event => [event, [{
    type: 'command', bash: `node "\${PLUGIN_ROOT}/hooks/native/dispatcher.js" ${event}`, timeoutSec: 45,
  }]])) };
  write('com.github.copilot/hooks/hooks.json', hooks);
  for (const file of ['protocol.js', 'transcript.js', 'dispatcher.js', 'context.js', 'helper.js', 'approval.js', 'review-gate.js']) write(`hooks/native/${file}`, '// fixture');
  for (const agent of EXPECTED_AGENTS) {
    write(`com.github.copilot/agents/${agent}.agent.md`, fs.readFileSync(path.join(pluginSource, 'com.github.copilot/agents', `${agent}.agent.md`), 'utf8'));
  }
  const env = { HOME: home, COPILOT_PROJECT_DIR: project,
    ZENSU_DOCTOR_PLUGIN_DIR: plugin, ZDOC_NODE: 'v22.0.0', ZDOC_ZENSU: 'authed',
    ZDOC_FORGE_PROVIDER: 'github', ZDOC_FORGE_CLI: 'gh', ZDOC_FORGE_STATE: 'ready',
    ZDOC_PLAYWRIGHT: 'absent', ZDOC_VERIFY: 'consent-no-recipe', ZDOC_BINDING: 'unknown' };
  return { root, plugin, project, home, write, env, hooks };
}

function report(f, overrides = {}) {
  let output = '';
  const reads = [];
  const calls = [];
  const guarded = new Proxy(fs, { get(target, name) {
    const value = target[name];
    if (typeof value !== 'function' || !/(?:read|open|stat|access|realpath)/i.test(name)) return value;
    return (...args) => {
      if (typeof args[0] === 'string') {
        reads.push(args[0]);
        if (/(?:^|\/)\.claude(?:\/|$)/.test(args[0])) throw new Error('Forbidden source-host read');
      }
      return value.apply(target, args);
    };
  } });
  const fakeProcess = { env: { ...f.env, ...(overrides.env || {}) }, cwd: () => f.project,
    stdout: { write: text => { output += text; } }, exit: code => assert.equal(code, 0) };
  const req = name => {
    if (name === 'fs') return guarded;
    if (name === 'path') return path;
    if (name === 'node:child_process') return { spawnSync(command, args, options) {
      calls.push({ command, args, options });
      if (command === 'copilot') return overrides.copilot || { status: 0, stdout: "GitHub Copilot CLI 1.0.98.\nRun 'copilot update' to check for updates.\n" };
      if (command === 'git') return { status: 0, stdout: f.project + '\n' };
      throw new Error(`Unexpected process: ${command}`);
    } };
    if (name === path.join(f.plugin, 'hooks/lib/rule-block-v1.js') && fs.existsSync(name)) return require(name);
    throw Object.assign(new Error('Fixture module unavailable'), { code: 'MODULE_NOT_FOUND' });
  };
  vm.runInNewContext(nativeDoctor(), { require: req, process: fakeProcess, __dirname: path.join(f.plugin, 'hooks/lib'), Buffer, console }, { timeout: 1000 });
  return { output, reads, calls };
}

test('doctor retains core diagnostics and checks native package without reading source-host stores', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.claude', 'settings.json'), '{"secret":"DO_NOT_READ"}');
  const r = report(f);
  assert.match(r.output, /plugin.json: zensu 0\.2\.0/);
  assert.match(r.output, /all 11 dispatcher registrations present/);
  assert.match(r.output, /all 32 entries present/);
  assert.match(r.output, /six named definitions restrict tools/);
  assert.match(r.output, /zensu CLI: installed and authenticated/);
  assert.match(r.output, /GitHub CLI \(gh\): installed and authenticated/);
  assert.match(r.output, /Copilot CLI: 1\.0\.98 on PATH/);
  assert.match(r.output, /config: no config file present/);
  assert.match(r.output, /MCP: connectivity .* not probed/);
  assert.match(r.output, /permissions: effective Copilot tool policy is not inspected/);
  assert.doesNotMatch(r.output, /\.claude|marketplace\.json|DO_NOT_READ|all checks green|auto-mode classifier/);
  assert.equal(r.reads.filter(file => file.includes('/.claude/')).length, 0);
  assert.equal(r.calls.find(call => call.command === 'copilot').options.timeout, 5000);
  assert.deepEqual(Array.from(r.calls.find(call => call.command === 'copilot').args), ['--version']);
});

test('doctor reports absent native events and changed dispatcher commands', t => {
  const f = fixture(t);
  delete f.hooks.hooks.subagentStop;
  f.hooks.hooks.preToolUse[0].bash = 'echo pretend';
  f.write('com.github.copilot/hooks/hooks.json', f.hooks);
  const r = report(f);
  assert.match(r.output, /absent events: subagentStop/);
  assert.match(r.output, /unexpected dispatcher registration: preToolUse/);
  assert.doesNotMatch(r.output, /all 11 dispatcher registrations present/);
});

test('doctor rejects broader custom-agent tools and missing skills', t => {
  const f = fixture(t);
  f.write('com.github.copilot/agents/code-reviewer.agent.md', '---\nname: code-reviewer\ntools: ["view", "grep", "glob", "bash"]\n---\n');
  fs.rmSync(path.join(f.plugin, 'skills/zensu-tdd/SKILL.md'));
  const r = report(f);
  assert.match(r.output, /expected six named, read-only Copilot agents/);
  assert.match(r.output, /skills: missing or invalid entries/);
});

test('doctor distinguishes unavailable host probe and unsupported Node from a pass', t => {
  const f = fixture(t);
  const r = report(f, { env: { ZDOC_NODE: 'v20.19.0' }, copilot: { status: null, error: new Error('ENOENT') } });
  assert.match(r.output, /node: version 22 or newer is required/);
  assert.match(r.output, /Copilot CLI: version probe unavailable/);
  assert.doesNotMatch(r.output, /Copilot CLI: .* on PATH/);
});

test('doctor preserves malformed config and invalid CAS workflow findings', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.project, '.zensu/state'), { recursive: true });
  fs.writeFileSync(path.join(f.project, '.zensu/config.json'), '{ malformed');
  fs.writeFileSync(path.join(f.project, '.zensu/state', `tdd-phase-scv1_${'a'.repeat(64)}.json`), '{ malformed');
  const r = report(f);
  assert.match(r.output, /config:.*(?:unparseable|invalid)/);
  assert.match(r.output, /invalid CAS workflow document/);
});

test('doctor does not equate a valid browser policy with live native browser acceptance', t => {
  const f = fixture(t);
  const r = report(f, { env: { ZDOC_VERIFY: 'policy' } });
  assert.match(r.output, /navigation policy passed the shared contract/);
  assert.match(r.output, /actual native browser\/tool admission remains a separate live check/);
  assert.doesNotMatch(r.output, /dontAsk|every permission mode/);
});


test('doctor validates actual shipped rule carriers without renaming internal close markers', t => {
  const f = fixture(t);
  const sourceRoot = pluginSource;
  f.write('hooks/lib/rule-block-v1.js', fs.readFileSync(path.join(sourceRoot, 'hooks/lib/rule-block-v1.js'), 'utf8'));
  for (const file of ['docs/evidence-discipline.md', 'docs/best-solution-first.md']) {
    f.write(file, fs.readFileSync(path.join(sourceRoot, file), 'utf8'));
  }
  const r = report(f);
  for (const rule of ['evidence-discipline', 'best-solution-first', 'best-solution-first-reminder']) {
    assert.match(r.output, new RegExp(`rule carriers: ${rule} block is intact`));
    assert.ok(nativeDoctor().includes(`<!-- /zensu:${rule} -->`));
  }
  assert.doesNotMatch(r.output, /is NOT injecting|carrier health was NOT checked/);
});
