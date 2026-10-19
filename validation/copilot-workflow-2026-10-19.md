# Copilot live Zensu workflow audit — 2026-10-19

**Outcome: complete with assisted same-session recovery.** The native marketplace installation completed implementation, the full five-perspective panel, primary and independent second judge, finding verification, consume review, terminal self-review corrections and ticket-bound chain close. The initial primary judge and finding verifier failed; their failures remain in the evidence. This was not an uninterrupted unattended pass.

## Tested configuration

- Copilot CLI 1.0.98; installed Zensu 0.2.0; native model auto-selection resolved to gpt-6-luna.
- Existing user installation and authentication; unique session and temporary Git project. No plugin-directory override or compatibility runtime.
- Vanilla implementation, full review panel, required full-suite and acceptance gates. Effective automatic routing severity: critical.
- Session: `f4a76077-8dab-4df8-9256-3b43c5e3ced5`.
- Project: `/private/tmp/zensu-workflow-live-z3lbjucv/project`.
- No source/plugin changes. All 252 installed files still match the release receipt; global configuration hashes are unchanged.

## Work and final verification

Copilot implemented an integer-safe invoice quotation API and JSON stdin CLI with discount rounding, input validation, packaged executable, tests and documentation. It independently found and fixed an npm-bin symlink dispatch bug before formal review. Review then found a missing durable package-bin regression test, unbounded stdin, and an advisory missing Node engine declaration. Terminal self-review fixed the first two, including a documented 1 MiB input cap, and retained the engine suggestion as open.

- 19 tests passed; lint and build passed. Both production source files achieved 100% lines, branches and functions.
- Four acceptance criteria passed on the final tree. Old acceptance records were actually rejected as stale after edits, then renewed.
- Final edit-landing audit: 12 claims landed, 0 unlanded, unverified or pending, 1 verified-no-change exemption.
- Five completed aspect reviewers, two substantive judges after one rejected primary attempt, one consume reviewer and one terminal self-review fix round.
- No second aspect panel is required here: critical-only routing parks IMPORTANT findings for terminal self-review, whose contract forbids another reviewer spawn.
- Terminal chain closed; persisted workflow state `implementation_complete`, revision `8`, `chainDone=true`, `codeReviewDone=true`, `reviewTicketConsumed=true`, `selfReviewFixed=true`, no bypasses.
- Independent audit: 16 checks passed against a freshly packed, offline-installed consumer, including 200 seeded arithmetic cases, exact size-limit boundaries, invalid input, output/exit contracts and source-to-installed SHA-256 equality.

## Intervention and limitations

The harness interrupted only its own session after the first consume result, then resumed the same session without resetting state. It requested a substantive primary-judge retry using the real edit-landing terminal summary and a corrected collision-free finding-verifier input. Both succeeded. Historical DEGRADED and rejected-judge records remain visible. The resume launcher initially supplied an incompatible --name option; that harness error was corrected before any model execution.

The recovery prompt initially expected another full panel; source inspection corrected that interpretation. The final Copilot summary calls that requested rerun a process gap, but the actual configured terminal self-review route is valid and explicitly forbids another reviewer spawn. This is a harness wording conflict, not an omitted required native stage. The initial interrupted process returned exit 0 while the chain remained open, so process exit alone was not used as proof of completion.

This audit proves the local native workflow, not every Zensu skill, strict RED-GREEN mode, SaaS mutations, external MCP services or standalone Zensu CLI backend workflows. Cross-plugin findings below are grounded in the immutable tracked upstream snapshot where stated; other installed plugins were not live-tested.

## Findings

13 open improvement findings: 1 high, 6 low, 6 medium. Product-code findings in the temporary test app are separate from these workflow findings.

### WF-001 — Hook-injected shell bindings are mistaken for forbidden model-authored overrides

**MEDIUM · observed-live · Copilot native integration**

Seven successful native context/policy probes preceded tdd-begin. Copilot repeatedly described the automatically added selector export prefix as its own mistake. The run recovered without intervention. After closure a command carrying the context marker without bound exports was refused as Malformed session binding; the model retried with the valid bound command and recovered.

**Recommended change:** Document the exact hook-generated prefix and its provenance in model-visible instructions; instruct the model to submit only the original command and accept successful results without replaying or removing the hook prefix.

**Scope evidence:** None; this wrapper is Copilot-specific.

**Source anchors:** `src/context.js:87`; `src/dispatcher.js:128`; `src/plugin/skills/zensu-tdd/SKILL.md:21`.

### WF-002 — Review file enumeration refers to a removed procedure

**MEDIUM · source-confirmed · Shared workflow documentation**

Review-chain and self-review instructions require the Phase6 step5b(b) enumeration unchanged, while current audit5b(b) contains verdict handling after enumeration moved into a helper.

**Recommended change:** Provide one canonical change-set helper/output contract and reference it directly from review and self-review, including untracked and mid-run-committed files.

**Scope evidence:** Exact stale reference also exists in tracked upstream/zensu-claude-code/skills/tdd/references/review-chain.md:7 and skills/self-review/SKILL.md:44,107. Other installed plugins were not inspected.

**Source anchors:** `src/plugin/skills/zensu-tdd/references/review-chain.md:7`; `src/plugin/skills/zensu-tdd/references/audit.md:52`; `src/plugin/skills/zensu-self-review/SKILL.md:62`; `src/plugin/skills/zensu-self-review/SKILL.md:125`.

### WF-003 — Unlanded-edit recovery instructions contradict the evidence helper

**MEDIUM · source-confirmed · Shared workflow documentation**

Review-chain says to land the edit or withdraw the claim and rerun. Audit instructions and helper say a withdrawn claim cannot clear the failed receipt.

**Recommended change:** Align recovery instructions with the actual grader: land and re-audit, or explicitly preserve failure and start a properly authorized fresh generation when the claim cannot be satisfied.

**Scope evidence:** Same contradictory text exists in the tracked upstream workflow references. This branch was not exercised in this live test.

**Source anchors:** `src/plugin/skills/zensu-tdd/references/review-chain.md:6`; `src/plugin/skills/zensu-tdd/references/audit.md:53`; `src/plugin/hooks/lib/zensu-log.sh:1865`.

### WF-004 — Documentation advertises external review imports not shipped by the native port

**LOW · source-confirmed · Copilot documentation**

modes.md mentions external-review imports and configuration.md documents the external-review helper, while native review-chain docs say the helper/templates do not ship.

**Recommended change:** Remove unsupported import instructions or clearly mark them as unavailable; keep native agent review as the single supported execution path.

**Scope evidence:** Port-specific stale documentation inherited from an upstream feature; no runtime compatibility layer observed.

**Source anchors:** `src/plugin/skills/zensu-tdd/references/modes.md:9`; `src/plugin/docs/configuration.md:70`; `src/plugin/docs/review-chain.md:83`.

### WF-005 — Oversized verification skill cannot be read in one native view call

**MEDIUM · observed-live-and-source-confirmed · Shared skill structure; Copilot read limit observed**

Native view call_mKS5YwujO4FKSYDfM6aMaaic at 2026-10-19T18:10:52.908Z returned success=true but no content: File too large to read at once (44.1 KB). Copilot recovered with view_range. Native entrypoint is45120bytes/585lines; tracked upstream counterpart40221bytes/568lines.

**Recommended change:** Split verification into a compact safety/driver-selection entrypoint and bounded references per driver, lifecycle and chain recording. Explicitly handle content-limit responses even when the transport reports success.

**Scope evidence:** Large monolithic skill is also present upstream; only Copilot read-limit behavior and recovery were live-tested.

**Source anchors:** `src/plugin/skills/zensu-tdd/references/audit.md:70`; `src/plugin/skills/zensu-verify-feature/SKILL.md`; `upstream/zensu-claude-code/skills/verify-feature/SKILL.md`.

### WF-006 — Synthetic local acceptance runs suppress all assertion diagnostics

**LOW · observed-live-and-source-confirmed · Shared acceptance verification instructions**

All four exit-code acceptance commands redirected stdout and stderr to /dev/null. AC004 combined tests, lint, build, coverage and a documentation check without retaining which assertion would fail. The commands passed; a failing diagnostic-loss case was not exercised.

**Recommended change:** Retain credential-blind handling for raw application/network output while allowing bounded synthetic diagnostics such as criterion ID, check name, exit code and sanitized assertion category. Do not remove suppression globally.

**Scope evidence:** Same blanket output-suppression rule exists in the tracked upstream snapshot. Other installed plugins and standalone Zensu CLI were not tested.

**Source anchors:** `src/plugin/skills/zensu-verify-feature/SKILL.md:119`; `src/plugin/hooks/lib/evidence-run-v1.js:1229`; `upstream/zensu-claude-code/skills/verify-feature/SKILL.md:101`.

### WF-007 — Required execution and progress markers are not maintained reliably

**LOW · observed-live · Workflow logging ergonomics**

Copilot armed the native vanilla chain before edits but omitted the separate EXECUTION STARTED log marker. It explicitly disclosed the omission in the review packet rather than backdating it. Real tests, CHECKPOINT and audit evidence are present. At the end, the separate progress checklist still marked Phase 6 audit and Review chain unchecked/in progress, despite successful terminal state and final report.

**Recommended change:** Have a structured implementation-start helper emit the required marker and relevant metadata automatically instead of relying on a separate model-authored ceremonial log line. Reconcile the final progress checklist from completed native stage evidence at chain close, so it cannot contradict the final report.

**Scope evidence:** Native contract and this live run only; no claim of missing tests or skipped hard gates.

**Source anchors:** `src/plugin/skills/zensu-tdd/references/execution.md:24`; `src/plugin/skills/zensu-self-review/SKILL.md:15`.

### WF-008 — Manually duplicated review packets drifted despite an identical-bytes contract

**LOW · observed-live · Review packet reliability**

The conventions reviewer packet has one extra leading space before diff_summary; the other four do not. The evidence was semantically equal, but not byte-for-byte identical as required.

**Recommended change:** Generate a canonical immutable evidence packet with a content hash/reference, validate each dispatch against it, and keep reviewer-specific perspective outside that packet.

**Scope evidence:** Observed in Copilot; shared manual-packet design may benefit from the same helper, but other hosts were not tested.

**Source anchors:** `src/plugin/skills/zensu-tdd/references/review-chain.md:9`.

### WF-009 — Primary judge rejected valid evidence and the workflow continued without substantive primary review

**HIGH · observed-live-and-source-confirmed · Shared review contract and completion reliability**

Primary judge call_q2JCilMZlZt3pdBc23uswzt3 rejected the actual EDIT LANDING AUDIT terminal summary as a missing close marker. The independent second judge accepted identical evidence. Main logged the primary as unavailable and advanced to consume review; completing the requested whole chain required an explicit same-session recovery intervention.

**Recommended change:** Define and validate the edit-landing receipt/summary schema deterministically before dispatch. Make primary-judge completion an explicit required stage or return a clearly partial result; an additive second judge must not silently substitute for it. Provide bounded retry with preserved original evidence.

**Scope evidence:** Ambiguous close-marker wording also exists in the tracked upstream agent. Failure/recovery behavior was tested only in Copilot.

**Source anchors:** `src/plugin/com.github.copilot/agents/review-judge.agent.md:42`; `src/plugin/hooks/lib/zensu-edit-landing.sh:891`; `src/plugin/skills/zensu-tdd/references/audit.md:50`; `upstream/zensu-claude-code/agents/review-judge.md:38`.

### WF-010 — Quoted heredoc delimiter collided with the required FINDINGS payload marker

**MEDIUM · observed-live-and-source-confirmed · Shared finding-verification shell input protocol**

The first finding verifier command used FINDINGS as both shell heredoc delimiter and payload section marker. The heredoc ended early; remaining finding lines were attempted as shell commands. Exit127 and total0 instead of3 were correctly recorded as DEGRADED, followed by manual source verification. No harmful command ran.

**Recommended change:** Accept a structured packet file/JSON input through a canonical helper. If heredocs remain, require a generated delimiter absent from the complete payload and validate the summary count before accepting the run. A quoted delimiter alone does not prevent delimiter collisions.

**Scope evidence:** Same quoted-heredoc/marker-form instructions exist in the tracked upstream reference. The actual model-generated collision was observed in Copilot only.

**Source anchors:** `src/plugin/skills/zensu-tdd/references/review-chain.md:13`; `upstream/zensu-claude-code/skills/tdd/references/review-chain.md:13`.

### WF-011 — Reviewer fix directive contradicts effective critical-only convergence policy

**MEDIUM · observed-live-and-source-confirmed · Shared review verdict semantics**

The consume reviewer reported 2 IMPORTANT and 1 SUGGESTION, labeled PASS WITH SUGGESTIONS, and added Fix round required. The authoritative appended hook guidance correctly resolved hooks.autoFixSeverity=critical and instructed parking IMPORTANT findings before terminal self-review. Self-review then fixed the two IMPORTANT findings in its permitted single round, without another reviewer, as its contract explicitly requires. The model-authored directive and effective routing were inconsistent. The main-agent consume prompt explicitly requested a PASS/fix-round directive but omitted the effective severity policy; the extra Directive section is not prescribed by the reviewer output template.

**Recommended change:** Give the consume reviewer the effective severity/convergence decision and derive its verdict and next-action text from that same decision. Keep any required terminal self-review correction distinct from a routed panel re-review.

**Scope evidence:** The verdict rubric is shared with the tracked upstream agent; the conflicting extra directive was model-authored in this Copilot run. No missing second panel is alleged for this configured branch.

**Source anchors:** `src/plugin/com.github.copilot/agents/code-reviewer.agent.md:88`; `upstream/zensu-claude-code/agents/code-reviewer.md:84`; `src/plugin/hooks/lib/zensu-config.sh:491`; `src/plugin/skills/zensu-self-review/SKILL.md:203`; `src/plugin/skills/zensu-self-review/SKILL.md:302`.

### WF-012 — Identical package acceptance suite reruns once per criterion despite reusable evidence

**LOW · observed-live-and-source-confirmed · Acceptance execution efficiency**

Final AC-001, AC-002 and AC-003 each reran the same package consumer suite on tree c6af75c8900f, rebuilding, packing and installing the unchanged package three times. Each run was valid. The recorder permits one current acceptance-scope record to support multiple AC verdicts, with criterion-specific observations.

**Recommended change:** Document a shared-run pattern: run the suite once, then immediately record each explicitly covered AC separately with the same evidence-run reference. Preserve exact assertion-to-criterion mapping and freshness checks.

**Scope evidence:** Observed in Copilot and grounded in its recorder contract. A reusable pattern may help other plugins or CLI workflows; those executions were not tested.

**Source anchors:** `src/plugin/hooks/lib/acceptance-verify-v1.js:397`; `src/plugin/hooks/lib/acceptance-verify-v1.js:481`; `src/plugin/hooks/lib/acceptance-verify-v1.js:502`; `src/plugin/skills/zensu-verify-feature/SKILL.md:125`.

### WF-013 — Self-review skill is reinvoked after successful chain closure

**LOW · observed-live · Terminal workflow and report ergonomics**

The native self-review skill loaded at 18:29:07Z, again before close at 18:35:53Z, and after successful chain-done at 18:36:49Z. No intervening user message or stop directive requested the post-close invocation. The model then repeated helper/status discovery, including one malformed-binding refusal and oversized search output. The protected chain stayed closed and no additional source edit occurred. Final summary eventually arrived at 18:39:52Z, about 3m17s after successful close.

**Recommended change:** Add an explicit completed-generation fast path: verify the bound closed chain once, render the existing final evidence and remaining findings, and do not restart review discovery or mutation. Return a clear terminal/report-only result from chain-done.

**Scope evidence:** Model-generated native reinvocation observed only in Copilot. A completed-generation guard is a candidate shared-workflow improvement; no equivalent live failure is asserted for other hosts.

**Source anchors:** `src/plugin/skills/zensu-self-review/SKILL.md:48`; `src/plugin/skills/zensu-self-review/SKILL.md:307`.

## Evidence

- Structured audit: `/Users/marcelkarras/IdeaProjects/dev.zensu/zensu-copilot/validation/copilot-workflow-2026-10-19.json`.
- Raw local evidence: `/private/tmp/zensu-workflow-live-z3lbjucv`. Native transcripts, hooks, initial and recovery outputs, prompts, exit records, exact-session evidence/acceptance snapshots and independent package checks are retained separately from fixtures.
- Raw transcripts are temporary local artifacts; the structured audit and this report retain the durable findings, selected native outcomes and provenance.
- No commits, pushes, releases, external issue creation or plugin fixes were performed by this audit.
