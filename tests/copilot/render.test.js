'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const plugin = path.resolve(__dirname, '../../src/plugin');
const upstream = path.resolve(__dirname, '../../upstream/zensu-claude-code');
const skillName = name => name.startsWith('zensu-') ? name : `zensu-${name}`;
const SKILLS = fs.readdirSync(path.join(plugin, 'skills')).map(name => name === 'zensu-help' ? name : name.slice(6));
const read = file => fs.readFileSync(path.join(upstream, file), 'utf8');
const skill = name => fs.readFileSync(path.join(plugin, 'skills', skillName(name), 'SKILL.md'), 'utf8');
const reference = file => { const [name, ...rest] = file.split('/'); return fs.readFileSync(path.join(plugin, 'skills', skillName(name), ...rest), 'utf8'); };

test('all 32 native skills retain their evidence discipline and distinct native names', () => {
  assert.equal(SKILLS.length, 32);
  const names = new Set();
  for (const name of SKILLS) {
    const source = read(`skills/${name}/SKILL.md`);
    const result = skill(name);
    const nativeName = skillName(name);
    assert.match(result, new RegExp(`^---\\nname: ${nativeName}\\n`), name);
    assert.ok(!names.has(nativeName), name);
    names.add(nativeName);
    const evidence = source.match(/<!-- zensu:evidence-discipline -->[\s\S]*?<!-- \/zensu:evidence-discipline -->/);
    if (evidence) assert.ok(result.includes(evidence[0]), `${name}: evidence block changed`);
    assert.doesNotMatch(result, /CLAUDE_(?:PLUGIN_ROOT|PLUGIN_DATA|CODE_SESSION_ID|PROJECT_DIR)/, name);
    assert.doesNotMatch(result, /(?<!<!-- )\/zensu:/, name);
    if (name !== 'session-trail') assert.match(result, /Every task call requires a unique name, description, prompt/, name);
  }
});

test('TDD initialization replaces the legacy progress API as a procedure', () => {
  const result = skill('tdd');
  assert.match(result, /5\. Initialize the selected progress channel/);
  assert.match(result, /Only when `update_todo` is exposed/);
  assert.match(result, /\{todos: "- \[ \] TDD: Analyzing spec and creating plan \(in progress\)"\}/);
  assert.match(result, /If no progress tool is exposed, create and maintain a real Markdown checklist/);
  assert.match(result, /\.zensu\/progress\/\{SESSION_TS\}_tdd-\{slug\}\.md/);
  assert.match(result, /must not replace the plan's Steps-table Status column or the append-only evidence log/);
  assert.match(result, /blocked\/cancelled steps stay unchecked/);
  assert.doesNotMatch(result, /TaskCreate|TaskUpdate|select:|activeForm|addBlockedBy|update_todo\(subject/);
  for (const marker of ['--tdd-begin', '--tdd-complete', '--evidence-run', 'RED → IMPL → GREEN', 'main-v1', 'reviewer-readonly-v1']) {
    assert.ok(result.includes(marker), marker);
  }
  assert.doesNotMatch(result, /Ultracode|--external-review|templates\/workflows/);
});

test('TDD selects exposed editing and question tools without inventing capabilities or waiving gates', () => {
  const result = skill('tdd');
  const planning = reference('tdd/references/planning.md');
  assert.match(result, /plugin does not guarantee create, edit, ask_user or update_todo are exposed/);
  assert.match(result, /prefer exposed apply_patch \(Add File\/Update File as appropriate\)/);
  assert.match(result, /Do not write production source through Bash/);
  assert.match(result, /Missing ask_user never grants approval, authorizes an installation, or waives an evidence gate/);
  assert.match(result, /headless\/no-question execution, honor already explicit user decisions/);
  assert.match(planning, /available native file-editing tool.*apply_patch.*Add File/);
  assert.doesNotMatch(planning, /\*\*create tool\*\*|\*\*Write tool\*\*/);
  assert.match(planning, /full body must NOT go through bash/);
  assert.match(planning, /coverage-tool-decision-required/);
  assert.match(planning, /default 90% lines/);
  assert.match(planning, /standalone mode uses the available user-question channel/);
});

test('independently loaded TDD references preserve dependency/evidence semantics with native progress', () => {
  const planning = reference('tdd/references/planning.md');
  assert.match(planning, /complete ordered checklist/);
  assert.match(planning, /dependency graph in the plan/);
  for (const item of ['[test]', '[impl]', '[verify]', '[wire]']) assert.ok(planning.includes(item));
  assert.match(planning, /Leave them unchecked/);
  assert.doesNotMatch(planning, /TaskCreate|TaskUpdate|activeForm|addBlockedBy|blockedBy/);
  for (const file of ['execution.md', 'modes.md', 'discipline.md']) {
    const body = reference(`tdd/references/${file}`);
    assert.match(body, /update_todo/, file);
    assert.doesNotMatch(body, /TaskCreate|TaskUpdate|update_todo `cancelled`/, file);
  }
  assert.match(reference('tdd/references/execution.md'), /BLOCKED\/cancelled and leave them unchecked/);
});

test('native review route keeps the complete panel, judges, verification, ticket and terminal chain', () => {
  const result = reference('tdd/references/review-chain.md');
  assert.match(result, /Native review engine/);
  assert.match(result, /Spawn ONE parallel batch/);
  for (const marker of [
    'zensu_review_panel', 'aspect-activation-v1.js', 'ASPECT ACTIVATION UNAVAILABLE',
    'zensu:review-aspect', 'zensu:review-judge', 'judge_run: second', 'JUDGE-B<n>',
    'Finding Verification Gate', 'criticalReproduction', 'FINDING REPRODUCTION',
    'PRE-MERGED FINDINGS (fan-out)', 'REVIEW-TICKET: ${REVIEW_TICKET}',
    'AUTOPILOT-BINDING: run=${RUN_ID} attempt=${ATTEMPT} chain=${CHAIN_ID}',
    '--review-ticket', '--code-review-done', '--chain-done', 'review-ledger-v1.js',
    '[Panel-FP-neutralized — do not fix]', '[Unverified — do not fix]',
  ]) assert.ok(result.includes(marker), marker);
  assert.match(result, /agent_type='zensu:code-reviewer',?`?,? `?mode: "sync"/);
  assert.doesNotMatch(result, /--external-review|scriptPath|external_review|import path|Workflow tool|subagent_type|run_in_background/);
  assert.match(result, /view_range/);
});

test('native plan acceptance is explicit at the autopilot gate and preserves durable marker ordering', () => {
  const result = skill('autopilot');
  const gate = result.slice(result.indexOf('**0.D — Confirm.**'), result.indexOf('### Phase 1 — Build'));
  assert.match(gate, /explicit user approval of this exact plan/);
  assert.match(gate, /Feedback, cancellation, `exit_only` and successful transport are not approval/);
  assert.match(gate, /native `summary` string/);
  assert.match(gate, /native human-response receipt correlated to this tool call and these plan bytes/);
  assert.match(gate, /exact native `plan\.md` path from Copilot's plan-mode/);
  assert.match(gate, /Do not guess a cwd-relative `plan\.md`/);
  assert.match(gate, /Save the complete plan, including the exact `<!-- zensu-autopilot:<RUN_ID> -->` marker/);
  assert.match(gate, /Read it\s+back and verify its full contents and single marker before creating the durable run/);
  assert.match(gate, /summary is only an overview; it must\s+not replace the complete plan saved in the native file/);
  assert.match(gate, /`response\.planContent`/);
  assert.match(gate, /keep the run at PLANNING/);
  assert.match(gate, /Never synthesize an approval receipt/);
  assert.doesNotMatch(gate, /--user-approved|helper\.js|zensu-approve-plan/);
  assert.match(gate, /Remove every pre-existing `<!-- zensu-autopilot:/);
  assert.match(gate, /Immediately before `exit_plan_mode`, create the durable run/);
  assert.match(gate, /--autopilot-begin/);
  assert.match(gate, /PLANNING/);
  assert.match(reference('autopilot/rules/work-order.md'), /Never call `exit_plan_mode`/);
});

test('native planning instructions distinguish full host plan bytes from the tool summary', () => {
  for (const name of SKILLS.filter(name => name !== 'session-trail')) {
    const contract = skill(name).split('# /zensu-')[0];
    assert.match(contract, /first write the complete plan to the exact `plan\.md` path supplied by Copilot for this session/, name);
    assert.match(contract, /full specification, acceptance criteria and any required run marker in that file/, name);
    assert.match(contract, /If Copilot has not supplied the path, keep approval pending/, name);
    assert.match(contract, /concise overview in its `summary` string; the summary does not replace the plan file/, name);
    assert.match(contract, /exact approved file bytes in `response\.planContent`/, name);
    assert.doesNotMatch(skill(name), /presented plan in its summary|Supply the presented plan through|tool_response\.(?:plan|filePath)/, name);
  }
  for (const template of ['autopilot-spec.md', 'tdd-plan.md']) {
    const body = fs.readFileSync(path.join(plugin, 'templates', template), 'utf8');
    assert.match(body, /plan\.md path supplied by Copilot/, template);
    assert.match(body, /summary is only (?:a concise )?(?:an? )?overview/, template);
    assert.match(body, /[Nn]ever\s+guess/, template);
  }
  assert.match(skill('plan-review'), /`exit_plan_mode\.summary` is only an overview, not a complete plan source/);
});

test('main-thread skill handoffs resolve generated paths without a foreign Skill invocation', () => {
  assert.match(skill('implement'), /\{plugin_root\}\/skills\/zensu-tdd\/SKILL\.md/);
  assert.match(reference('tdd/references/audit.md'), /skills\/zensu-verify-feature\/SKILL\.md/);
  assert.match(reference('tdd/references/review-chain.md'), /skills\/zensu-self-review\/SKILL\.md/);
  assert.match(skill('pilot'), /skills\/zensu-<name>\/SKILL\.md/);
  assert.match(skill('implement'), /THIS main thread/);
});

test('native worker spawn examples keep exact dedicated identities and real completion contracts', () => {
  const plan = skill('plan-review');
  const pr = reference('pr-team-review/references/spawn.md');
  assert.match(plan, /agent_type: zensu:plan-review-worker/);
  assert.match(pr, /agent_type: zensu:pr-review-worker/);
  assert.match(pr, /mode: "background"/);
  assert.match(pr, /host-generated background agent id/);
  assert.match(pr, /private SubagentStop validator/);
  assert.match(reference('pr-team-review/rules/workflow.md'), /finalize --lease-id/);
  assert.match(reference('pr-team-review/rules/workflow.md'), /--expected-role/);
  assert.match(pr, /\.github\/agents\/zensu-review-\*\.agent\.md/);
  assert.doesNotMatch(plan + pr, /subagent_type|run_in_background|`Agent`/);
});

test('all six agents have distinct native identities and strictly read-only tool grants', () => {
  const files = fs.readdirSync(path.join(upstream, 'agents')).filter((file) => file.endsWith('.md'));
  assert.equal(files.length, 6);
  for (const file of files) {
    const name = file.replace(/\.md$/, '');
    const result = fs.readFileSync(path.join(plugin, 'com.github.copilot/agents', `${name}.agent.md`), 'utf8');
    const identity = `zensu:${name}`;
    assert.match(result, new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(result, /tools: \["view", "grep", "glob"\]/);
    assert.match(result, /include-custom-instructions: true/);
    assert.ok(result.includes(`Native custom-agent identity: \`${identity}\``));
    assert.doesNotMatch(result.split('---')[1], /bash|edit|create|task|model:|background:|maxTurns:/);
    assert.match(result, /<!-- zensu:evidence-discipline -->/);
    assert.match(result, /`view` uses `path`; `grep` and `glob` use `paths`/);
    assert.match(result, /never omit it, use the repository root, or widen a read lease/);
    assert.doesNotMatch(result, /never omit `path`|Never omit `path`/);
  }
});

test('reviewer injection contracts use native search paths while preserving exact-file and safe-subtree scopes', () => {
  for (const body of [skill('plan-review'), reference('pr-team-review/references/spawn.md')]) {
    assert.match(body, /only with `paths` explicitly set to one safe subtree \(or an array of safe subtrees\)/);
    assert.match(body, /every entry listed verbatim in `SAFE_SUBTREES`/);
    assert.match(body, /Never search or traverse/);
  }
});

test('gauntlet uses native critic tasks without unsupported host orchestration or identity promises', () => {
  const result = skill('gauntlet-loop');
  const harness = reference('gauntlet-loop/references/harness.md');
  assert.match(result, /Missing native agent identity never grants main-thread authority/);
  assert.match(result, /Implementation, fixes, shell commands, captures and Zensu lifecycle mutations stay in the main thread/);
  assert.match(result, /Perform one bounded builder pass in the main thread/);
  assert.match(harness, /Critic 2 starts only after Critic 1 completes/);
  assert.match(harness, /Critic 3 is a new task/);
  assert.match(harness, /Blinding an A\/B comparison/);
  assert.match(harness, /Randomize per round/);
  assert.match(harness, /do not promise unattended wakeups/i);
  assert.doesNotMatch(result + harness, /SendMessage|ScheduleWakeup|SendUserFile|preview_start|`Workflow`|Ultracode|ultracode|isolation: "worktree"/);
});

test('all skill references are authored without known incompatible executable protocols', () => {
  const files = fs.readdirSync(path.join(plugin, 'skills'), { recursive: true }).filter((file) => file.endsWith('.md'));
  for (const file of files) {
    const result = fs.readFileSync(path.join(plugin, 'skills', file), 'utf8');
    assert.doesNotMatch(result, /TaskCreate|TaskUpdate|subagent_type|run_in_background|Skill tool|Workflow tool|`Workflow`|SendMessage|ScheduleWakeup|SendUserFile/, file);
    assert.doesNotMatch(result, /~\/\.claude\/settings\.json/, file);
  }
  assert.match(skill('doctor'), /actual Copilot task refusal/);
  assert.match(skill('doctor'), /Never widen your own tool permissions/);
});






test('native session-trail documents cover every original reference and name actual boundaries', () => {
  const directory = path.join(plugin, 'skills/zensu-session-trail/references');
  const files = fs.readdirSync(path.join(upstream, 'skills/session-trail/references')).filter((file) => file.endsWith('.md'));
  assert.deepEqual(fs.readdirSync(directory).sort(), files.sort());
  for (const file of files) {
    const text = fs.readFileSync(path.join(directory, file), 'utf8');
    assert.ok(text.startsWith('# '), file);
    assert.doesNotMatch(text, /~\/\.claude|CLAUDE_CONFIG_DIR|mcp__ccd|spawn_task|start_session/, file);
  }
  assert.match(fs.readFileSync(path.join(directory, 'commands.md'), 'utf8'), /release.*--apply/);
  assert.match(fs.readFileSync(path.join(directory, 'takeover.md'), 'utf8'), /copilot --resume/);
  assert.match(fs.readFileSync(path.join(directory, 'limits.md'), 'utf8'), /task IDs are not resume IDs/);
});
