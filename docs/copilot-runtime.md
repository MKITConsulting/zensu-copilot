# Native Copilot runtime and validation

## Package and policy boundary

Version 0.2.0 is an owned native implementation. `src/plugin/` contains the policy
engine, shell helpers, skills, agents and documentation; `src/` contains Copilot
execution, transcript, session-trail and headless modules. `scripts/build.js`
copies those files byte-for-byte into `dist/zensu`. It performs no source-host
import, string patching, schema emulation or skill/agent rendering. The build works
without `upstream/`; that immutable snapshot is used only for historical provenance
and parity verification. Source licensing is retained.

The root `plugin.json` uses Agent Plugins format. Copilot registrations live in
`com.github.copilot/`; `hooks/registry.json` lists native policy handlers in order.
`build.json` records owned source paths and final SHA256 hashes. The installed
runtime needs neither the source checkout nor another coding host/plugin.

## Direct native contracts

The dispatcher receives one native event name and its JSON on stdin. Policies
consume `eventName`, `sessionId`, `cwd`, `toolName`, `toolArgs`, `toolResult`,
`agentId`, `agentType` and `parentAgentId` directly. Tool names remain `bash`,
`view`, `create`, `edit`, `task`, `grep`, `glob`, `apply_patch`, etc. Native input
validation rejects foreign envelopes instead of translating them. The actual
Copilot shell-hook wire field `stop_hook_active` is accepted as a boolean only
for `agentStop` and `subagentStop`; it does not bypass completion gates.

Patch inspection produces native-shaped file operations solely to inspect every
create/update/delete/move endpoint. Every native search root is inspected. This
is bounded policy analysis, not another host's tool protocol. Actual original
arguments are retained; unknown mutation schemas and ambiguous paths fail closed.
Native shell results distinguish transport success from the host's terminal exit
footer. Tasks distinguish dispatched, failed and actually completed results.

Policies return flat native decisions/context. No nested foreign hook output is
accepted. A policy error or whole-event timeout denies the operation; a failed
stop gate preserves pending state. Copilot's bounded continuation budget cannot
turn incomplete work into a completed chain.

The tool-event deadlines grow with the work: 50 s for `preToolUse` and 35 s for
`postToolUse` per normalized operation (one patch file or search root), capped at
250 s. Every other event keeps 35 s. A policy handler that outlives its own timeout
is killed with SIGKILL, so a signal trap cannot stretch the deadline. GitHub's
Copilot CLI hooks reference documents an expired hook `timeoutSec` as fail-open
and states no maximum, so every registration leaves at least 10 s between the
dispatcher's fail-closed deadline and its host timeout (260 s for both tool
events). That host behavior is documented, not yet observed in a native capture.
Every matching policy still runs once per normalized operation, so each gate sees
every file.

## Identity and data

Native child correlation preserves the root owner and child authority. An unknown
child cannot become the main thread. Before an admitted Bash call the dispatcher
binds `COPILOT_PLUGIN_ROOT`, `COPILOT_PLUGIN_DATA`, `COPILOT_SESSION_ID`,
`COPILOT_PROJECT_DIR` and protected `ZENSU_BOUND_SESSION_ID`. The helper validates
the selector, executing root, private record, project and runtime digest.
Foreign ambient identity is discarded, never translated or used as a fallback.

| Location | Content |
| --- | --- |
| `~/.zensu/config.json` | Shared Zensu defaults |
| `<project>/.zensu/config.json` | Project overlay; `ZENSU_CONFIG` replaces both inputs |
| `<project>/.zensu/state/` | Bound CAS workflows, leases and evidence state |
| `COPILOT_PLUGIN_DATA` / host `PLUGIN_DATA` | Native plugin-private data |
| `<COPILOT_HOME>/zensu/plugin-data/` | Plugin data fallback |
| `<plugin-data>/copilot-sessions/<sha256(id)>.json` | Native session observations and child correlation |
| `<COPILOT_HOME>/session-state/<id>/events.jsonl` | Actual native session history, read-only |
| `<COPILOT_HOME>/session-state/<id>/workspace.yaml` | Supported native scalar workspace metadata |

Copilot replaces local installations in place. Resuming a session bound to the
previous bytes therefore remains blocked until the user explicitly authorizes
`/zensu-adopt-session --confirm`. The repair checks the replacement build receipt,
private-store ownership, identity, project and compatible persisted state under
locks. It archives the old binding and superseded review leases, while preserving
the workflow bytes, revision, pending tickets and completion flags. Ordinary
hooks and automatic adoption never waive a runtime digest mismatch. Copilot may
create the surrounding plugin-data container with `0755`; it must be owned by the
current user, canonical and not writable by group/others. The private
`session-control/v1/records` hierarchy remains strictly `0700` with `0600` records.

There is no compatibility configuration directory or generated transcript store.
Native readers inspect original event envelopes and correlate tool-call IDs.
Duplicate tool requests, assistant narration, automatic messages, child messages
and successful asynchronous dispatches cannot fabricate human activity or review
evidence. Existing records are observations, not assumed process liveness.

## Approvals and reviewer results

Plan approval requires the uniquely correlated native `human_response.recorded`
event, accepted plan bytes and implementation action. Feedback, rejection,
`exit_only`, automation and transport success leave the plan pending.

Remembered browser consent requires the exact native hook permission request for
the Bash arguments/tool call and an approved completion whose decision source is
human response. Missing/ambiguous/automated receipts never populate consent.
Explicit parent navigation policy remains supported. Native reviewer refusals are
read from structured request/completion pairs; failure prose is not a permission
receipt. A later successful background dispatch does not erase a refusal.

The review engine retains complete panels, independent judges, finding
verification, one-use tickets, leased read roles, convergence, bounded fixes and
terminal self-review. All six packaged agents remain read-only. Main-thread
implementation uses the actual exposed native editing tools. Required unanswered
questions remain pending even in headless execution.

## Tools and capabilities

Native `task` requires the advertised schema including `agent_type`, `name`,
`description`, `prompt` and execution mode. Copilot supplies the plugin namespace,
for example `zensu:code-reviewer`. Native `skill` can load `zensu-doctor`; direct
`view` of the chosen skill is also supported. File-tool paths must be expanded
absolute paths, not shell-variable text.

Progress uses exposed `update_todo({todos: "..."})`, another real progress tool,
or a `.zensu/progress/` Markdown checklist. It stays distinct from plan-step
status and the evidence log. Missing `create` is not a blocker when `apply_patch`
is exposed. Missing questions never grants approval. PowerShell, mutating LSP and
unaccounted dynamic workflow operations remain denied.

The doctor directly checks the native manifest, registrations, agents, skills,
rule carriers, configuration, binding, workflow/lease state and a bounded Copilot
version probe. It does not read another host's settings or claim unprobed effective
permissions/MCP access are healthy.

## Headless work-order launcher

`harness/launcher.js` selects exactly one native plugin using Copilot's read-only
plugin inventory. An identical installed package is reused without `--plugin-dir`;
a missing installation loads the requested directory, while stale, disabled,
duplicate or unverifiable installations stop with a repair diagnostic. It then
runs Copilot with a fixed native session ID, JSON event stream, explicit caller
permissions, no automatic update, no remote
export, no built-in MCPs and no unanswered question interaction. It owns process
supervision, lease watchdog/renewal, cancellation, identity checks, bounded output
drain and release. A terminal success must name the claim's session ID; a missing
result, lease loss, blocked outcome or failure cannot report success. Optional
logs are private and redact known credential values.

The existing Zensu service still calls its product-document endpoints
`doc claude-md`, `doc claude-md-context` and `generate_claude_md`. These are remote
product API names, not a coding-host bridge. Their context is used to author
Copilot-oriented `AGENTS.md`; no other coding host is installed or invoked.

## Local validation

```bash
npm run verify
```

The suite combines native protocol/runtime/integration tests with owned regression
tests for evidence, acceptance, review ledger, finding verification, aspect
activation and full-suite CI contracts. Those regressions execute the native
owned engine, not the historical snapshot. A hermetic build test removes all
source-host files and verifies deterministic byte-identical packaging.

Fixtures cover native envelopes, failed/async results, independent session
bindings, selector mutation, guarded patches/searches, protected records, strict
RED/GREEN and terminal gates, real local evidence commands, human receipt
correlation, reviewer denials, session trail, reanchor claims and headless
cancellation. Synthetic events are not presented as a live Copilot test.

## Live acceptance after installation

Use a disposable Git repository and fresh Copilot session. Freeze the exact build
before starting. Verify discovery, `/zensu-doctor`, bound Bash and file tools,
then complete a small local implementation and its complete review/self-review
chain. Inspect actual native events, evidence records and final state. Test human
approval, finding/fix, backend/forge, browser and work-order flows separately with
authorized disposable data. Never mutate real product records for a smoke test.

## Observed validation record

Native 0.2.0 was validated on **2026-10-19**, using **Copilot CLI 1.0.98**.
The final automated run of `npm run verify` passed **420/420 tests**, with no
failures, cancellations or skips. The package check verified 1015 immutable
historical files, 252 emitted file hashes, 32 skills, six agents, 11 native hook
events and 125 runtime syntax checks.

The clean installed-plugin live session was
`fdd809e7-f38a-4df5-8ae5-1ea76c2220a7`. Its frozen `build.json` SHA256 was
`d655362c685ffab29713478d767c4115f949f9781b893a9b2d6c371b66e5ec28`.
Captured hook events identified exactly one installed Zensu package; every file
matched that receipt. The disposable library fixture demonstrated:

- Native doctor discovery with no blockers, bound Bash and native patch edits.
- Implementation of `negate(n)` while preserving the existing `double(n)` API.
- Four passing tests, successful build and 100% source coverage.
- Two acceptance criteria observed by real commands in a throwaway npm consumer,
  with persisted evidence tied to the current tree.
- Three native review-aspect completions, an independent judge, finding
  verification, code-review completion and one-use review-ticket consumption.
- Terminal self-review and `chainDone: true`, with required full-suite and
  acceptance gates passing and no bypass-ledger entries.

A redundant second judge invocation contained a mismatched evidence summary and
was explicitly discarded; the independently completed first judge used the correct
packet. An earlier duplicate-install smoke run and an earlier run exposing the
native `stop_hook_active` wire field were aborted and are not completion evidence.
Both integration defects were repaired and regression-tested before the clean run.

The final package additionally contains the tested explicit in-place runtime
adoption repair, the exact native recovery-command/skill routing, updated
diagnostics and this documentation. The initial resume attempt exposed an overly
strict recovery-command recognizer; it was stopped with both binding and workflow
bytes unchanged, then repaired and covered by an actual dispatcher regression. A second resume
attempt identified an overly strict check on Copilot's `0755` data container;
the check now distinguishes that host container from the `0700` private hierarchy.
Neither failed attempt changed the original binding or workflow. The frozen workflow
receipt above therefore identifies the full-chain test build, not the final
installed receipt. Final install hashes and same-session resume/adoption results
are recorded separately in the checkout's `validation/native-acceptance.json`,
so writing the attestation does not alter the package it attests.

Strict RED/GREEN, failed/async events, negative approval cases, pending-chain
preservation during updates, reanchoring and launcher cancellation were exercised
by fixtures. Native session-trail also read an actual Copilot session. Real human
plan/browser approvals, finding/fix rounds, external Zensu/forge operations,
browser/other validation drivers and backend work-order round trips still require
separate live acceptance. This local run does not certify those external flows or
provide the original host's Desktop-only capabilities.
