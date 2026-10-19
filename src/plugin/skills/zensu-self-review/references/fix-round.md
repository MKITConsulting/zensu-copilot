## Phase 4: Fix Round or Finalize

view the one-fix-round latch: `selfReviewFixed` in the session chain-state.

- **If `selfReviewFixed` is false AND there is at least one must-fix finding** — take
  EXACTLY ONE fix round, in this main thread, under the still-active PreToolUse
  phase-gate. For each must-fix: RED test, then IMPL, then GREEN (re-enter the
  `/zensu-tdd` Phase 4 discipline). In a vanilla-mode session — verify with
  `COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh" --mode` (echoes `vanilla`) — apply each
  must-fix directly instead: no RED→GREEN cycle required, the gate passes through.
  Run every test, build or other project command of this round as
  `cd "<project root>" && <command>`, where `<project root>` is the path `--project-root`
  printed in Phase 1: the bash tool returns to the session's start directory, which after
  `/zensu-adopt-session --reanchor` is not the bound root. `--evidence-run` needs no prefix.
  Then log `{step_id} IMPL completed — files: {list}` for the fixes and re-run
  the `/zensu-tdd` Phase 6 **step 1 full suite** over the amended tree through the
  evidence runner:
  `COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh" --evidence-run --scope full --cmd '<full test command>' --log <run-log>`
  — this is the chain's last edit, so this is
  the run whose verdict describes the tree that ships, and Phase 5 checkpoints are
  scoped and cannot stand in for it.
  **In CI mode** — `COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh" --full-suite-policy`
  prints `full suite: ci` — run the Phase 6 affected-suite command instead:
  `COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh" --evidence-run --scope scoped --cmd '<the tests affected by the change>' --log <run-log>`,
  covering the suites of every file this chain changed, never `--scope full`: the
  runner refuses it, and the repository's CI pull-request pipeline runs the full suite.
  This stage is often forced cold and never ran `/zensu-tdd` Phase 1, so resolve the
  suite command in THIS order. (1) `evidence.fullSuiteCommand` — when the project
  configures it, drop `--cmd` and the runner uses it. (2) The project's own
  metadata — `AGENTS.md`, `package.json` `scripts`. (3) Only if both yield nothing,
  the `cmd:` of the newest `EVIDENCE RUN — scope=full` line in the run log (that log
  resolved as the finalize branch below resolves it). Never the reverse: a run log
  is COMMITTED in consuming repos and is selected here by mtime, so a command mined
  from it is repository content you would be executing — and it is REDACTED
  (`<project>`, `~`, `<home>`), so a command carrying a placeholder is not runnable
  and counts as "yields nothing". When the metadata and the log disagree, run the
  metadata one and log `FULL SUITE COMMAND MISMATCH — metadata={a} log={b}` into
  `## Open`. When nothing yields a command, log `FULL SUITE UNRESOLVED — {reason}`,
  carry it into `## Open` and claim NO test verdict. The runner's own summary line
  is this run's verdict. Then
  invoke the `/zensu-tdd` Phase 6 step 5b **Edit Landing Audit** —
  when that procedure is not in your context, `view` it from
  `${COPILOT_PLUGIN_ROOT}/skills/zensu-tdd/references/audit-integrity.md`, whose `{plugin_root}` is
  `${COPILOT_PLUGIN_ROOT}`; re-invoking the `/zensu-tdd` skill is forbidden below —
  using the actual helper command and the inputs that reference documents, including
  explicit `--session "${COPILOT_SESSION_ID}"`. If omitted, follow the
  `AUDIT SESSION REQUIRED` recovery command; standalone output is not a receipt. Its terminal
  `EDIT LANDING AUDIT — ...` line is the complete receipt summary; no additional close
  marker exists. Resolve the bound root and preserve the captured baseline, session epoch
  and paths dirty before this fix round. Missing shell variables are not evidence for an
  empty baseline or epoch: omit unavailable arguments only when the existing receipt's
  persisted `auditScope` supplies them; otherwise recover the original context or report
  the blocker. Never widen the change set to conceal an unresolved claim. A mechanical replacement
  that matched nothing must remain visible. `CLAIM WITHDRAWN — {step_id}: {file}` records
  a withdrawal but does not retire a claim from the append-only log or clear its failed
  receipt. Carry every unresolved `EDIT NOT LANDED` line into the report, leave the chain
  open, and obtain authorization before abandoning the generation and starting corrected
  scope. Never report that withdrawal alone made the audit clean.
  For `PENDING PREDICATE`, read the target files and the exact historical/new claim labels,
  then follow step 5b(c)'s `--predicates <JSON file>` recipe. Calculate SHA-256 from each
  current file and supply literal predicates for the intended change, repeating proof
  entries for every relevant claim label on a changed previously certified file. Preserve
  the existing scope and rerun the audit until it actually returns exit 0 with a clean
  receipt. Omitting `--dirty-before` inherits its scope; it is never a remedy for pending
  claims. Do not handwrite a receipt or reset the generation to make this fix pass.
  Read missing instructions with native `view` in this same invocation; do not reload
  either workflow skill. Only after the audit is clean continue to the latch below.
  After the single fix round, set the latch with
  `COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh" --self-review-fixed --claimed-review-ticket "<review-ticket>"`.
  Complete any remaining affected build/coverage and acceptance evidence on the amended
  tree; reuse the full-suite run already produced above while that tree is unchanged.
  Confirm the intended fixes by reading their targets, then continue directly to the finalize
  branch below in this same invocation. Keep the captured ticket and any verified Autopilot
  envelope unchanged. Do not invoke `/zensu-self-review` again; a second invocation creates
  redundant post-completion work and grants no second fix round. In this branch you MUST NOT:
  - run `--tdd-complete` (implementation is already complete);
  - spawn the `zensu:code-reviewer` agent — self-review is terminal, so do not spawn it;
  - re-invoke the whole `/zensu-tdd` skill (its Phase 6 tail would re-spawn the reviewer).

- **Otherwise** (no must-fix, OR `selfReviewFixed` is already true) — finalize:
  1. Standalone handoffs keep the unqualified terminus: run `COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh" --chain-done --claimed-review-ticket "<review-ticket>"`. For a verified Autopilot binding, run `COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh" --chain-done --autopilot-run "$RUN_ID" --autopilot-attempt "$ATTEMPT" --chain-id "$CHAIN_ID" --claimed-review-ticket "<review-ticket>"`. This is the ticket- and generation-bound chain terminus, and it applies the full-suite gate: it prints a `FULL SUITE — <state> | …` line on stderr and refuses (exit 1) on a missing, red, running, interrupted or stale full-suite record — in CI mode on a missing, red, running, interrupted or stale local test run, and it passes as `deferred-ci` with a second `FULL SUITE — CI contract` line. On such a refusal the chain stays open: run the command its `run:` segment names, or wait for a `running` record to land, then run this step again. It applies the acceptance gate as well: it prints `ACCEPTANCE — <state> | …` lines and refuses while any active criterion lacks a `pass` on the current tree; on that refusal follow the remedy the line names: a `run:` segment means run `/zensu-verify-feature --chain` with the log it names, then this step again; a `fix:` segment means a criterion fails on this tree and needs the one fix round; an `add:` or `restore:` segment, or a refusal with no remedy, goes into your report and to the user. If the refusal is `failed` and the one fix round is already spent, do not edit again: carry the refusal line into your report, stop, and leave `ZENSU_FULL_SUITE_GATE` to the user. The same holds for a criterion that is still `fail` or `partial` after the spent round: carry the `ACCEPTANCE — …` refusal into your report, stop, and leave `ZENSU_ACCEPTANCE_GATE` to the user. Any other failure is stale: stop and do not render a successful final report.
     The terminus also requires a clean, fresh edit-landing receipt for this generation,
     run log and current tree. If it reports an edit-landing refusal, preserve the open
     chain and follow the printed, session-bound audit command with its original scope and any required current predicate
     proofs; a green suite and acceptance record do not override that refusal. Do not
     render a successful report until the actual terminus succeeds.
  2. **Carry the full-suite verdict.** Copy every `FULL SUITE — …` line the terminus
     printed — the verdict, plus the `flaky` line and the gate-mode disclosure when
     present — into the `Full suite` verdict cell verbatim. Copy every `ACCEPTANCE — …`
     line the same way into the `Acceptance` verdict cell.
  3. Confirm `--chain-report --claimed-review-ticket "<review-ticket>"` reports `closed`, render the final report from [report.md](report.md), then stop. The terminus synchronizes the bound progress artifact; carry any `WORKFLOW PROGRESS — unresolved` warning into the report. Do not invoke this or another workflow skill again after closure.

