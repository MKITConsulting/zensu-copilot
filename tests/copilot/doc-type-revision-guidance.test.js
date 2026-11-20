'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const plugin = path.resolve(__dirname, '../../src/plugin');
const read = file => fs.readFileSync(path.join(plugin, file), 'utf8');
const normalize = text => text.replace(/\s+/g, ' ');
const GUIDE = 'docs/documentation-guide.md';
const SCOPE_TITLE = 'Required doc types (the release gate)';
const REFUSAL = 'previous revision must be released or superseded before creating a new one';
const GET = 'zensu features get <feature-uuid>';
const REVISION = 'zensu features revision <feature-id>';
const SCOPE_ROW = /^\| *(?:unset[^|]*|`(?:default|api|internal_only|public_facing)`) *\| *`(?:user_facing|api_reference|adr|tutorial)`/;

function section(text, start, stop) {
  const lines = text.split('\n');
  const from = lines.findIndex(line => line.startsWith(start));
  assert.notEqual(from, -1, `missing section ${start}`);
  const length = lines.slice(from + 1).findIndex(line => line.startsWith(stop));
  assert.notEqual(length, -1, `missing end of section ${start}`);
  return normalize(lines.slice(from, from + 1 + length).join('\n'));
}

function readsBefore(text, first, then) {
  const i = text.indexOf(first);
  const j = text.indexOf(then);
  return i !== -1 && j > i;
}

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(file) : entry.name.endsWith('.md') ? [file] : [];
  });
}

const scopeRows = text => text.split('\n').filter(line => SCOPE_ROW.test(line));

function scopeRowsUnder(directory) {
  return markdownFiles(directory).flatMap(file => {
    const relative = path.relative(directory, file).split(path.sep).join('/');
    return scopeRows(fs.readFileSync(file, 'utf8')).map(row => `${relative}: ${row}`);
  });
}

test('the documentation guide owns the release-gate doc type table and picks no type by classification', () => {
  const guide = read(GUIDE);
  const flat = normalize(guide);
  assert.ok(guide.split('\n').includes(`## ${SCOPE_TITLE}`), 'missing the required doc types heading');
  for (const row of [
    '| unset (`null`, the default) | `user_facing` | `end_user` |',
    '| `api` | `api_reference` | `developer` |',
    '| `internal_only` | `adr` | `internal` |',
    '| `public_facing` | `user_facing` — **plus** `tutorial` when `estimated_effort` ∈ {L, XL} | `user_facing`→`end_user`; `tutorial`→`developer` |',
  ]) assert.ok(guide.split('\n').includes(row), `missing row ${row}`);
  for (const rule of [
    'So the scope picks the type, not the security classification, the kind of code or the reader who seems likely.',
    'a gate that requires docs reports `documentation must be complete before release`',
    'Read `feature_scope` and `estimated_effort` from `zensu features get <feature-id>`',
    'A response without a `feature_scope` field counts as unset: author `user_facing` and say so.',
    'note that the `tutorial` was skipped for lack of an effort signal; do not guess.',
    'A confidential backend feature with an unset scope still needs `user_facing`.',
    'a type the table does not require for the scope never completes the gate.',
    'with the `feature_id` and a required `doc_type` from the table above.',
    "Every doc type the feature's `feature_scope` requires has its doc (Required doc types).",
    '`skills/zensu-docs/SKILL.md`, `skills/zensu-implement/SKILL.md`',
  ]) assert.ok(flat.includes(rule), `missing rule: ${rule}`);
  assert.doesNotMatch(flat, /usually warrants `internal`|Pick the type by what the reader needs/);
  assert.doesNotMatch(guide, /^\| `default` \|/m);
});

test('the docs skill takes the doc type from the guide table at the plugin root and keeps no copy', () => {
  const docs = normalize(read('skills/zensu-docs/SKILL.md'));
  assert.ok(docs.includes(`**view the table under "${SCOPE_TITLE}" in \`{plugin_root}/docs/documentation-guide.md\` before you name a target type**`));
  assert.ok(docs.includes('That table is the one copy of the rule, and `/zensu-implement` Step 6 reads it too.'));
  assert.ok(docs.includes("Derive the required `doc_type`(s) from the guide's table (Doc type by feature scope above)."));
  assert.ok(docs.includes('Sibling `/zensu-implement` Step 6 takes its doc type(s) from the same guide'));
  assert.doesNotMatch(docs, /an older backend\), default to `user_facing`/);
});

test('the guide holds the only feature_scope table rows in the plugin', () => {
  const rows = scopeRowsUnder(plugin);
  assert.deepEqual(rows.filter(row => !row.startsWith(`${GUIDE}: `)), []);
  assert.equal(rows.length, 4);
});

test('the scope-row scan flags planted rows and leaves other api tables alone', () => {
  const planted = ['| `api` | `api_reference` | `developer` |', '| `default` | `user_facing` | `end_user` |', '| unset | `adr` | `internal` |'];
  const other = ['| `api` | REST endpoints | `curl` |', '| `api` | status code, response body |', '| `api_reference` | `developer` | API endpoints |'];
  assert.equal(scopeRows(planted.join('\n')).length, planted.length);
  assert.equal(scopeRows(other.join('\n')).length, 0);
});

test('implement Step 1 and Step 6 pick the required doc types from the guide table and confirm docs_complete', () => {
  const implement = read('skills/zensu-implement/SKILL.md');
  const step1 = section(implement, '### Step 1:', '### Step 2:');
  const step6 = section(implement, '### Step 6:', '### Step 7:');
  assert.ok(step1.includes('`feature_scope` and `estimated_effort` that Step 6 picks the doc type from'));
  for (const text of [
    "**view `{plugin_root}/docs/documentation-guide.md`** (the plugin's guide, not a file of this project) first",
    `The table under "${SCOPE_TITLE}" in that guide maps the \`feature_scope\` and \`estimated_effort\``,
    'a feature with an unset scope needs `user_facing`, even a confidential backend feature',
    'an `api_reference` doc alone leaves `documentation must be complete before release` in place',
    'Run the items below once per required type, with that type as every `<type>` and `--doc-type`',
    '`--doc-type` (required): the required type this pass documents',
    "`--audience` (optional): end_user | developer | admin | internal; pass the audience the guide's table gives the type",
    'read `docs_complete` from `zensu features get <feature-uuid>`',
    'report the docs as open, never as complete',
  ]) assert.ok(step6.includes(text), `Step 6 lost: ${text}`);
  assert.doesNotMatch(step6, /\*\*view `docs\/documentation-guide\.md`\*\*/);
  assert.ok(readsBefore(step6, 'zensu link docs <feature-id>', 'read `docs_complete` from'));
  for (const recipe of ['zensu wiki create --product <product-id> --title <title> --content <markdown>', 'One-call form.', '`--content` (optional): wiki page markdown']) {
    assert.ok(step6.includes(recipe), `Step 6 lost its recipe: ${recipe}`);
  }
});

test('implement Step 7 reads the active revision first and creates none while one is open', () => {
  const step7 = section(read('skills/zensu-implement/SKILL.md'), '### Step 7:', '### Step 8:');
  for (const text of [
    `it refuses a new one with HTTP 400 \`${REFUSAL}\``,
    'A new top-level feature starts with an open `v1`',
    `Re-read the feature with \`${GET}\` and take \`active_revision_id\` and \`stage\` from it`,
    '**A revision is open** when `active_revision_id` is set and `stage` is neither `shipped` nor `superseded`',
    'Create nothing: this work belongs to that revision',
    '(stage `<stage>`) holds this work; no new revision created',
    `**No revision is open** (\`stage\` is \`shipped\` or \`superseded\`, or \`active_revision_id\` is null): run \`${REVISION}\``,
    `If it still answers \`${REFUSAL}\`, a revision opened in the meantime: report it as in item 2 and do not retry`,
    '`--scope-summary` (required)',
  ]) assert.ok(step7.includes(text), `Step 7 lost: ${text}`);
  assert.ok(readsBefore(step7, GET, REVISION), 'Step 7 must read the feature before it creates a revision');
});

test('the order check passes the read-first text and fails a late or a missing read', () => {
  assert.equal(readsBefore(`1. Re-read with \`${GET}\`. 3. Run \`${REVISION}\`.`, GET, REVISION), true);
  assert.equal(readsBefore(`Run \`${REVISION}\`, then check \`${GET}\`.`, GET, REVISION), false);
  assert.equal(readsBefore(`Run \`${REVISION}\`.`, GET, REVISION), false);
});

test('implement reports the docs gate and both revision outcomes', () => {
  const implement = read('skills/zensu-implement/SKILL.md');
  const summary = section(implement, '### Summary', '## Important Notes');
  const cli = section(implement, '## CLI Commands Used', '## Agents & Skills Used');
  assert.ok(summary.includes('Documentation linked (doc type(s) and whether `docs_complete` is `true`)'));
  assert.ok(summary.includes('Revision: the one created (version number), or the open revision this work belongs to (id and stage)'));
  assert.doesNotMatch(summary, /Revision created \(version number\)/);
  assert.ok(cli.includes('| `zensu features get` | 1, 6, 7 |'));
  assert.ok(cli.includes('| `zensu features revision` | 7 | Create a feature revision when none is open |'));
});
