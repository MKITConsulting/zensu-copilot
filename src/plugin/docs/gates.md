# Native Copilot gates

All policies run from `hooks/registry.json` through the native dispatcher. Inputs
use Copilot `eventName`, `sessionId`, `toolName`, `toolArgs` and `toolResult`.
Outputs are native `permissionDecision`, `permissionDecisionReason`,
`additionalContext`, or stop `decision`/`reason`. No foreign-hook envelope is
emitted or decoded. The following gates remain independent.

## Session and capability gate

Every tool validates Session Control and the mandatory baseline. Child identity
selects a confined principal; unknown children cannot inherit main authority.
Named reviewer/evidence/PLM agents are read-only. Leased reads and safe-subtree
searches are checked against every native search root. Native `apply_patch` is
parsed with a bounded grammar and every create/update/delete/move endpoint is
checked. Ambiguous whitespace paths and unknown mutation formats are denied.
Recognized read-only LSP operations are admitted; rename, PowerShell and unaccounted
dynamic workflow mutations are denied. [Session Control](session-control.md)
describes binding and recovery.

## Zensu CLI workflow gate

Lifecycle mutations require a main-thread workflow begun with an explicit allowed
operation set. The CLI command parser maps real Zensu subcommands to backend
operations; read-only context queries remain available. Subagents cannot mutate
tracked feature state or launch an independent product workflow. A token's presence
is not an authorization to mutate arbitrary products.

## Source-write and private-state gates

The source-write parser examines Bash commands, nested shell forms, environment
assignments and control-flow directories. It prevents source writes that bypass
native edit/evidence controls and protects session selectors. The private-data
guard prevents direct tool writes to plugin records, runtime files and mutable
workflow state. Explicit opt-outs retain their original scope and disclosure;
configuration cannot silently waive a frozen active chain's requirements.

## Secret scan

Proposed file content and supported shell writes are checked for known credential
patterns before admission. Post-tool artifact redaction protects generated
artifacts. This scanner is a bounded pattern control, not proof that arbitrary
content contains no secret. Never print authentication tokens or inspect unrelated
credential stores for a test.

## TDD phase gate

`--tdd-begin` freezes vanilla/strict mode using the session choice, an explicit
strict caller request, configuration, then the vanilla default. Vanilla permits
implementation without a RED/GREEN ceremony while retaining review/evidence.
Strict mode admits writes by the actual phase, step and RED-failure evidence.
Test-path classification rejects symlink/hardlink tricks. Both modes protect state
files and retain full-suite, acceptance, coverage and terminal review obligations.

## Review admission and completion

Native tasks use the exact namespaced agent identity, required packet and current
review ticket. Packet/lease/role mismatches fail closed. Native synchronous
completion or a correlated real child result is required; a background dispatch
cannot consume a ticket. Failed or refused reviewers leave the chain pending.
The configured panel, independent judges, finding verification, severity filters,
convergence, bounded fix rounds and terminal self-review stay in force.

## Plan approval

Before requesting native approval, write the complete specification, acceptance
criteria and required run marker to the exact `plan.md` path supplied by Copilot
for the current session. Use an exposed native editing tool and verify the saved
contents. A repository audit plan is a separate artifact; never guess the native
path from cwd. Missing native plan location keeps approval pending. The tool's
`summary` is only a concise overview of that file.

`exit_plan_mode` transport success does not approve a plan. The native approval
reader requires the uniquely correlated `human_response.recorded` event, accepted
file bytes in `response.planContent` and implementation action. Rejection, feedback, exit-only, automation
and model-set flags leave planning pending.

## Browser consent

The origin floor and optional parent navigation policy constrain navigation.
Unknown origins require a native human permission decision. Persisting consent
requires a correlated request/completion pair; command success cannot manufacture
it. See [the browser consent contract](verify-feature-consent-spec.md).

## Requirements, full-suite and acceptance gates

The implementation plan records traceable requirements/acceptance criteria.
Full-suite evidence is tied to the current Git tree, actual runner exit and
configured command. A stale, failed, corrupted, incomplete or wrong-scope record
cannot satisfy the required gate. CI deferral requires the verified supported
pipeline and preserves its pending state; it is never a local pass.

Acceptance records bind each criterion to observed evidence from an available
validation driver. Scoped test success is not a substitute for full-suite or live
acceptance evidence. Attestation and observation stay distinguishable. The final
report states failures, missing evidence, bypasses and the current tree.

## Stop and recovery

`agentStop` preserves pending implementation, review, self-review and outer
Autopilot obligations. Its bounded continuation budget does not mark incomplete
work done. An unavailable/corrupt gate blocks completion. Recovery uses validated
state transitions; `/zensu-doctor` and the exact recovery skill provide remedies.
No repair may invent a reviewer completion, human approval or test result.
