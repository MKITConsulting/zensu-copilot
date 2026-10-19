'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../src/plugin/skills/zensu-verify-feature');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const entry = read('SKILL.md');
function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const file = path.join(directory, item.name);
    return item.isDirectory() ? markdownFiles(file) : file.endsWith('.md') ? [file] : [];
  });
}

test('verification instructions fit bounded native reads and every phase is reachable from the entrypoint', () => {
  assert(Buffer.byteLength(entry) <= 16 * 1024, 'skill entrypoint exceeds the bounded native read budget');
  for (const file of markdownFiles(root)) {
    assert(fs.statSync(file).size <= 24 * 1024, `${path.relative(root, file)} needs another bounded split`);
  }
  const links = [...entry.matchAll(/\]\(((?:references|rules)\/[^)#]+\.md)\)/g)].map(match => match[1]);
  for (const target of links) assert(fs.existsSync(path.join(root, target)), `missing entrypoint reference: ${target}`);
  const references = fs.readdirSync(path.join(root, 'references')).filter(name => name.endsWith('.md'));
  for (const name of references) assert(links.includes(`references/${name}`), `unreachable workflow section: ${name}`);
  const instructions = references.map(name => read(`references/${name}`)).join('\n');
  for (let phase = 0; phase <= 5; phase++) {
    const headings = instructions.match(new RegExp(`^## Phase ${phase} — `, 'gm')) || [];
    assert.equal(headings.length, 1, `Phase ${phase} must have exactly one authoritative section`);
  }
  assert.match(entry, /File too large/);
  assert.match(entry, /view_range/);
  assert.match(entry, /never treat an unread safety section as optional/);
});

test('splitting verification preserves pre-read remote rejection and browser safety references', () => {
  assert.match(entry, /Before any reference read or other tool call for remote arguments/);
  assert.match(entry, /non-loopback HTTPS with no userinfo, query or fragment/);
  assert.match(entry, /never echo or retain any rejected URL component/);
  assert.match(entry, /never (?:receive, )?read, print, paste, or interpolate a real password/i);
  const policy = read('references/browser-policy.md');
  const browser = read('references/browser-session.md');
  const execution = read('references/execution.md');
  assert.match(policy, /Redirects are not filtered by the browser/);
  assert.match(policy, /take no snapshot or screenshot/);
  assert.match(browser, /Do not invoke\n`auth\.loginScript`, accept `STORAGE_STATE`/);
  assert.match(browser, /exactly one\ncall per bash command/);
  assert.match(execution, /Run cleanup on PASS, FAIL, cancellation, and setup failure/);
  assert.match(execution, /VERIFY-FEATURE-VERDICT: PASS/);
});

test('chain evidence guidance bounds diagnostic output and guards multi-criterion reuse', () => {
  const chain = read('references/chain.md');
  const evidence = read('rules/acceptance-evidence.md');
  assert.match(chain, /rules\/acceptance-evidence\.md/);
  assert.match(evidence, /at most 20 diagnostic lines, each at most 160 characters/);
  assert.match(evidence, /catch unexpected exceptions without printing their message or stack/);
  assert.match(evidence, /do not forward those buffers/);
  assert.match(evidence, /same unchanged tree|unchanged start\/end tree/);
  assert.match(evidence, /immediately record \*\*each covered AC separately\*\*/);
  assert.match(evidence, /do \*\*not\*\* record any criterion as `pass` from its nonzero record/);
  assert.match(evidence, /assertion-to-AC\n   mapping/);
  assert.match(evidence, /Finish with `--acceptance-status`/);
});

test('one real acceptance execution supports separate AC records but stops being reusable after a tree change', async t => {
  const av = require('../../src/plugin/hooks/lib/acceptance-verify-v1');
  const evr = require('../../src/plugin/hooks/lib/evidence-run-v1');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zensu-acceptance-reuse-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projectRoot = path.join(dir, 'project');
  fs.mkdirSync(projectRoot);
  const git = args => execFileSync('git', args, { cwd: projectRoot, stdio: 'pipe' });
  git(['init', '-q']);
  fs.writeFileSync(path.join(projectRoot, '.gitignore'), '.zensu/\n');
  fs.writeFileSync(path.join(projectRoot, 'checks.cjs'), `const assert = require('node:assert/strict');
assert.equal(2 + 2, 4); console.log('AC-001 check=sum result=pass');
assert.equal(2 * 3, 6); console.log('AC-002 check=product result=pass');\n`);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  for (const name of ['logs', 'plans', 'state']) fs.mkdirSync(path.join(projectRoot, '.zensu', name), { recursive: true });
  const stem = '2026-10-19-0100_tdd-reuse';
  const logPath = path.join(projectRoot, '.zensu/logs', `${stem}.log`);
  fs.writeFileSync(logPath, 'TDD STARTED\n');
  fs.writeFileSync(path.join(projectRoot, '.zensu/plans', `${stem}.md`), `# Plan\n\n## Requirements
| ID | Requirement | Source |
|----|-------------|--------|
| AC-001 | Sum is correct | spec |
| AC-002 | Product is correct | spec |\n`);
  const receiptPath = path.join(projectRoot, '.zensu/state/edit-landing.json');
  fs.writeFileSync(receiptPath, JSON.stringify({ schema: 'edit-landing-v2', session: 'fixture', log: `.zensu/logs/${stem}.log`, clean: true }));
  const sessionKey = `scv1_${'e'.repeat(64)}`;
  const pluginData = path.join(dir, 'data');
  fs.mkdirSync(pluginData, { mode: 0o700 });
  const sink = { text: '', write(value) { this.text += value; } };
  const code = await evr.run({ pluginData, sessionKey, projectRoot, cwd: projectRoot, scope: 'acceptance', command: 'node checks.cjs', show: 'tail', bashPath: 'bash', env: process.env, stdout: sink, stderr: sink });
  assert.equal(code, 0, sink.text);
  const recordFiles = fs.readdirSync(path.join(pluginData, 'evidence-run/v1/records', sessionKey));
  assert.equal(recordFiles.length, 1, 'the acceptance suite must execute only once');
  const evidenceRun = recordFiles[0].replace(/\.json$/, '');
  const options = { pluginData, sessionKey, projectRoot, receiptPath, logPath, bashPath: 'bash', driver: 'library', verdict: 'pass', evidenceRun };
  for (const [ac, evidenceText] of [['AC-001', 'The shared consumer asserted that two plus two is four.'], ['AC-002', 'The shared consumer asserted that two times three is six.']]) {
    const result = av.record({ ...options, ac, evidenceText });
    assert.equal(result.code, 0, result.error);
    assert.equal(result.record.evidence_run, evidenceRun);
  }
  assert.equal(av.status(options).code, 0);
  fs.appendFileSync(path.join(projectRoot, 'checks.cjs'), '// changed after observation\n');
  const stale = av.record({ ...options, ac: 'AC-002', evidenceText: 'Attempting to reuse the earlier product observation.' });
  assert.match(stale.error, /another tree/);
  assert.notEqual(av.status(options).code, 0);
});
