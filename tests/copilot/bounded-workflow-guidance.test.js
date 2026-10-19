'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const skills = path.resolve(__dirname, '../../src/plugin/skills');
const read = name => fs.readFileSync(path.join(skills, name), 'utf8');
const audit = 'zensu-tdd/references/';
const self = 'zensu-self-review/';

function boundedReferences(entryName, expected) {
  const entry = read(entryName);
  assert(Buffer.byteLength(entry) < 18 * 1024, `${entryName} exceeds the native view budget`);
  const links = [...entry.matchAll(/\]\(([^)#]+\.md)\)/g)].map(match => match[1]);
  for (const target of expected) {
    assert(links.includes(target), `unreachable required stage: ${target}`);
    const name = path.join(path.dirname(entryName), target);
    assert(Buffer.byteLength(read(name)) < 18 * 1024, `${name} exceeds the native view budget`);
  }
  assert.match(entry, /File too large/);
  assert.match(entry, /view_range/);
}

test('the audit index routes every original phase to one bounded authoritative reference', () => {
  boundedReferences(`${audit}audit.md`, ['audit-evidence.md', 'audit-integrity.md', 'audit-acceptance.md']);
  const references = ['audit-evidence.md', 'audit-integrity.md', 'audit-acceptance.md'].map(name => read(audit + name));
  const joined = references.join('\n');
  for (const step of ['1.', '2.', '3.', '4.', '5.', '5b.', '6.', '6b.', '6c.', '6d.', '7.', '8.', '9.']) {
    assert.equal(joined.split('\n').filter(line => line.startsWith(step + ' ')).length, 1, `missing/duplicated audit step ${step}`);
  }
  assert.match(references[0], /mandatory full-suite run/);
  assert.match(references[0], /never pipe the runner/i);
  assert.match(references[1], /runs in BOTH strict and vanilla mode/);
  assert.match(references[1], /Withdrawal is not an exit; it is a record/);
  assert.match(references[1], /NO claim was graded/);
  assert.match(references[2], /skills\/zensu-verify-feature\/SKILL\.md/);
  assert.match(references[2], /every later edit makes the records stale/);
});

test('self-review stays view-loadable and the generation guard precedes all deferred stages', () => {
  const entry = read(`${self}SKILL.md`);
  boundedReferences(`${self}SKILL.md`, ['references/reflection.md', 'references/fix-round.md', 'references/report.md']);
  assert(entry.indexOf('## Generation guard') < entry.indexOf('## Execution references'));
  assert.match(entry, /status: closed.*nextAction: render-report-only/);
  assert.match(entry, /A rejected ticket or failed command stops this handoff without mutation/);
  assert.match(entry, /partial, duplicate, malformed, or conflicting envelope/);
  assert.match(entry, /Never touch another session's chain-state/);
  assert.match(entry, /do not reload the skill through the native `skill` tool/);
  assert.match(entry, /Never restart Phases 1–3 to recover an instruction/);
  assert.match(entry, /progress file records workflow state only/);
  const reflection = read(`${self}references/reflection.md`);
  const fix = read(`${self}references/fix-round.md`);
  const report = read(`${self}references/report.md`);
  for (const phase of [1, 2, 3, 4]) {
    assert.equal((reflection + fix + report).match(new RegExp(`^## Phase ${phase}:`, 'gm'))?.length, 1);
  }
  assert.match(reflection, /Set `TOP="\$PROJECT_ROOT"`/);
  assert.match(reflection, /view_range:/);
  assert.doesNotMatch(reflection, /`offset`|`limit`/);
  assert.match(fix, /references\/audit-integrity\.md/);
  assert.match(fix, /Do not invoke `\/zensu-self-review` again/);
  assert.match(fix, /--chain-report --claimed-review-ticket/);
  assert.match(report, /terminal summary line/);
  assert.match(report, /Never substitute `none` for a value you did not read/);
});

test('progress instructions reserve lifecycle stages for observed flags and do not preclaim report delivery', () => {
  const planning = read('zensu-tdd/references/planning.md');
  const execution = read('zensu-tdd/references/execution.md');
  for (const label of ['Implementation audit accepted', 'Code review converged', 'Workflow chain closed']) assert(planning.includes(label));
  assert.match(planning, /Do not create duplicate lifecycle checkboxes/);
  assert.match(planning, /preserve blocked or cancelled work/);
  assert.match(planning, /not report delivery/);
  assert.match(execution, /Read the current progress file before editing other tasks/);
});

test('audit recovery carries exact machine-checked predicates and cannot downgrade round scope', () => {
  const integrity = read(audit + 'audit-integrity.md');
  const fix = read(self + 'references/fix-round.md');
  assert.match(integrity, /--predicates <JSON file>/);
  assert.match(integrity, /schema: 'edit-landing-predicates-v1'/);
  assert.match(integrity, /createHash\('sha256'\)\.update\(fs\.readFileSync/);
  assert.match(integrity, /every historical and new claim label/);
  assert.match(integrity, /"missing":true/);
  assert.match(integrity, /omitting `--dirty-before` cannot clear its cumulative dirty paths/);
  assert.match(integrity, /never edit, delete or replace them to remove a pending claim/);
  assert.match(fix, /Only after the audit is clean continue to the latch/);
  assert.match(fix, /clean, fresh edit-landing receipt/);
  assert.match(fix, /do not reload\n  either workflow skill/);
});

test('moved workflow instructions resolve all local Markdown references', () => {
  const names = ['audit.md', 'audit-evidence.md', 'audit-integrity.md', 'audit-acceptance.md'].map(name => audit + name)
    .concat(['SKILL.md', 'references/reflection.md', 'references/fix-round.md', 'references/report.md'].map(name => self + name));
  for (const name of names) {
    for (const [, target] of read(name).matchAll(/\]\(([^)#]+\.md)\)/g)) {
      assert(fs.existsSync(path.resolve(skills, path.dirname(name), target)), `${name} has a broken reference: ${target}`);
    }
  }
});
