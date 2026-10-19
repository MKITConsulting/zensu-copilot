# Implementation and review workflow

`/zensu-tdd` implements in the main Copilot thread. Vanilla is the default; strict
RED/GREEN is selected explicitly. Both modes retain the evidence and review chain.
The skill and its references contain the exact runnable procedure; this document
explains the state and authority boundaries.

## 1. Preparation and planning

Read the specification and repository instructions, verify required dependencies,
and settle missing human decisions. Record ordered requirements, acceptance
criteria, dependency-aware steps, the validation strategy and append-only evidence
log. Select an exposed progress tool or a real `.zensu/progress/` checklist; it is
separate from the plan's Steps Status column and is never proof of execution.

An ordinary implementation request does not implicitly arm this workflow.
`--tdd-begin` explicitly starts it in the bound native session. If planning occurs
through `exit_plan_mode`, first write the complete proposed plan to the exact
`plan.md` path supplied by Copilot for this session. This native file is separate
from the repository's `.zensu/plans/` audit artifact; never guess its location from
cwd. The tool's `summary` is only an overview. Only correlated native human approval
with the complete accepted file bytes in `response.planContent` authorizes the
approved durable run; a successful tool call alone is insufficient. A missing
native plan path or approval receipt leaves the planning gate pending.

## 2. Frozen implementation mode

The session mode choice wins, followed by a caller's explicit strict request,
`hooks.tddImplementation`, then vanilla. Caller escalation can select strict but
cannot lower discipline from a specification body. The winner is frozen for the
chain; later configuration edits do not change the running mode.

Vanilla implements with relevant tests and evidence but without mandatory
RED/GREEN phase transitions. Strict follows the per-step state machine:

`RED_WRITE → RED_RUN → RED_FAIL → IMPL → GREEN_RUN → GREEN_PASS → REFACTOR`.

Test writes, implementation writes and refactors are admitted according to the
current phase and step. RED-failure evidence cannot be borrowed from another step.
No mode allows direct writes to the session state to bypass a gate.

## 3. Evidence audit

Run relevant tests, build, coverage and the configured full suite. Record actual
commands and exits with the evidence runner; preserve tree fingerprints and scope.
Audit edit landing against the plan/log and real files. Update every plan step and
acceptance criterion with observed evidence, blocked status or explicit attestation
as appropriate. Never turn unchecked claims into completed work.

`--tdd-complete` records implementation completion, not review completion. The
full-suite and acceptance terminus gates independently examine their newest valid
records on the current tree. Missing, stale, failed or wrong-scope evidence remains
incomplete. Supported CI deferral is a pending verified pipeline, not a local pass.

## 4. Full native review chain

Obtain the one-use ticket and complete REVIEW PACKET v1 over the aggregate diff.
Run the configured read-only aspect panel through native tasks. Preserve exact
files, safe subtrees, lease roles, changed-file set and run/attempt/chain bindings.
Use the optional judge and independent second judgment where configured, verify
surviving finding anchors, and retain false-positive/unverified dispositions.

The consume-mode `zensu:code-reviewer` must actually complete. A launched task,
transport success, timeout, refusal or failed result cannot consume its ticket.
Apply eligible findings in the main thread, rerun affected checks and repeat within
the configured budget. Preserve severity policy, fix-loop counters and convergence.
An exhausted budget remains visible and recoverable via the exact recovery skill.

Once the code review converges, record `--code-review-done` with the claimed ticket,
then run terminal `/zensu-self-review`. Its bounded final fix round must be tested
and reported. `--chain-done` closes only the current authorized review generation
with required full-suite/acceptance evidence. Report every bypass and limitation.

## 5. State and session ownership

The immutable Session Control record binds the Copilot session, project root,
installation and digest. Mutable CAS state and evidence live under `.zensu/state`
and the bound plugin data. Native `sessionId`, child identities and actual event
records supply authority. Model text, newest-file selection and another session's
state never do. A fork/handoff is not an automatic chain transfer.

The native dispatcher passes actual Copilot events directly to policies. Its shell
binding supplies `COPILOT_PLUGIN_ROOT`, `COPILOT_PLUGIN_DATA`,
`COPILOT_PROJECT_DIR`, `COPILOT_SESSION_ID` and `ZENSU_BOUND_SESSION_ID`. The helper
rejects changed session selectors. Native transcript readers inspect the actual
`events.jsonl`, without producing a second host-shaped transcript.

## 6. Outer Autopilot and work orders

An Autopilot run has its own durable owner, stage, attempt, feature/PR head and
validation requirements. Inner implementation completion does not finish the
outer run. Lease loss, pending questions, changed PR heads and failed acceptance
must be resolved through their corresponding transitions. Claimed work orders
retain lease renewal, watchdog, cancellation and process supervision.

## 7. Logging, publication and recovery

Keep the plan's step table, append-only run log, user-facing progress and evidence
records distinct. Paths, credentials and user data must be safe for the intended
audience; a committed plan/log is a published artifact, not private scratch space.
State and lease files remain ephemeral and must not be committed accidentally.

`agentStop` enforces pending obligations with a bounded host continuation budget.
Host termination preserves pending state instead of inventing completion. Diagnose
with `/zensu-doctor`, then use `/zensu-recover-chain`, `/zensu-adopt-session` or
`/zensu-reset-review-limit` only for their specific validated cases. See
[Session Control](session-control.md), [gates](gates.md), [review-chain](review-chain.md)
and the skill references for the exact commands and packet schemas.
