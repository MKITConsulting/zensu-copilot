'use strict';
// Disposable audit-only fixture; pass an explicitly permitted copied helper path.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const helper = path.resolve(process.argv[2]);
const base = fs.mkdtempSync('/private/tmp/zensu-audit-scope-recheck-');
for (const directory of ['home', 'config', 'tmp']) fs.mkdirSync(path.join(base, directory));
const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: path.join(base, 'home'), XDG_CONFIG_HOME: path.join(base, 'config'), TMPDIR: path.join(base, 'tmp'),
  LC_ALL: 'C', LANG: 'C', TZ: 'UTC', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
function fixture(label) {
  const project = path.join(base, label); fs.mkdirSync(project);
  const git = (...args) => cp.execFileSync('/usr/bin/git', ['-C', project, ...args], { env, encoding: 'utf8' }).trim();
  git('init', '-q'); fs.writeFileSync(path.join(project, 'source.js'), 'old\n');
  git('add', 'source.js'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline');
  const baseline = git('rev-parse', 'HEAD'); fs.writeFileSync(path.join(project, 'source.js'), 'new\n');
  fs.mkdirSync(path.join(project, '.zensu/logs'), { recursive: true });
  const log = path.join(project, '.zensu/logs/test.log'); fs.writeFileSync(log, 'SR1 IMPL completed — files: source.js\n');
  const dirty = path.join(base, label + '.dirty'); fs.writeFileSync(dirty, 'source.js\n');
  const receipt = path.join(project, '.zensu/state/audit.json');
  const args = ['--log', log, '--project', project, '--receipt', receipt];
  const run = (extra = [], environment = env) => {
    const r = cp.spawnSync('/bin/bash', [helper, ...args, ...extra], { env: environment, cwd: project, encoding: 'utf8', timeout: 20000 });
    return { exit: r.status, error: r.error?.message, output: (r.stdout + r.stderr).trim(),
      receiptExists: fs.existsSync(receipt), receipt: fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt)) : null };
  };
  return { project, baseline, dirty, run };
}
const omissionFixture = fixture('omission');
const first = omissionFixture.run(['--baseline', omissionFixture.baseline, '--dirty-before', omissionFixture.dirty]);
const omittedRetry = omissionFixture.run();
const firstFixture = fixture('git-fault');
const faultFirst = firstFixture.run(['--baseline', firstFixture.baseline, '--dirty-before', firstFixture.dirty]);
const bin = path.join(base, 'bin'); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho "fatal: synthetic git failure" >&2\nexit 128\n', { mode: 0o755 });
const fault = firstFixture.run([], { ...env, PATH: bin + path.delimiter + env.PATH });
const retry = firstFixture.run();
const secondFixture = fixture('invalid-proof');
const proof = path.join(base, 'bad-proof.json');
fs.writeFileSync(proof, JSON.stringify({ schema: 'edit-landing-predicates-v1', claims: [{
  step: 'SR1', path: 'source.js', sha256: '0'.repeat(64), present: ['new'] }] }));
const invalid = secondFixture.run(['--baseline', secondFixture.baseline, '--dirty-before', secondFixture.dirty, '--predicates', proof]);
const proofRetry = secondFixture.run();
const results = { first, omittedRetry, faultFirst, fault, retry, invalid, proofRetry };
fs.writeFileSync(path.join(base, 'proof.json'), JSON.stringify({ helper,
  containment: { environment: env, explicitReceipt: true, sessionOperand: false, hostOrModelLaunched: false },
  fixtureProjects: [omissionFixture.project, firstFixture.project, secondFixture.project],
  ...results }, null, 2) + '\n');
console.log(JSON.stringify({ base, results: Object.fromEntries(Object.entries(results).map(([name, value]) => [name, {
  exit: value.exit, receipt: value.receiptExists, clean: value.receipt?.clean,
  dirty: value.receipt?.auditScope?.dirty, pending: value.receipt?.pending }])) }, null, 2));
