# Copilot CLI parity map

The baseline is Zensu Claude Code **0.27.0**, commit
`65d6aba7e3f6c0d98af2a02c9b4854c1f0c78980`. The build retains all 32 skill
entry points and six specialist agents. Version 0.2.1 owns and directly implements the workflow engine against native
Copilot contracts; no source-host adapter is built or loaded. Retained workflow instructions are not evidence that a
live Copilot run has satisfied every acceptance criterion.

## Native distribution

Copilot distribution uses its own `.github/plugin/marketplace.json` on the
generated `marketplace` branch. The catalog pins the complete native release
package to a full Git commit SHA; users install `zensu@zensu` after registering
`MKITConsulting/zensu-copilot#marketplace`. Release automation publishes the
verified archive bytes and an immutable `marketplace/vX.Y.Z` tag. No Claude
marketplace manifest or compatibility loader is used. See the
[publication guide](https://github.com/MKITConsulting/zensu-copilot/blob/main/docs/marketplace.md).

## All 32 skills

Every command below is emitted as a native skill directory with a `SKILL.md` and
its original references/assets. A command invokes a workflow with its existing
authorization requirements; listing it does not authorize external writes.

| Copilot command | Capability retained | Native adaptation or dependency |
| --- | --- | --- |
| `/zensu-adopt-session` | Diagnose/repair session binding, restore or reanchor workflow state | Copilot session identity and runtime digest; repair confirmation retained |
| `/zensu-autopilot` | Approved specification through implementation, review, PR/MR and acceptance loop | Native planning/review tasks; durable owner/worktree lease; requires forge and selected validation driver |
| `/zensu-autopilot-adopt` | Resume a durable run whose owner can be transferred | Existing owner-activity, scope and claim checks retained |
| `/zensu-autopilot-release` | Explicitly release/cancel a durable Autopilot run | Existing release preconditions retained; not session-trail handover release |
| `/zensu-bootstrap` | Create a tracked product from a plan, with features, journeys and security profiles | Zensu CLI/auth; generated project guidance uses `AGENTS.md` |
| `/zensu-converge` | Audit plan requirements against implementation and propose flow-back edits | Read-only by default; confirmed plan edits only; headless execution remains report-only |
| `/zensu-cover` | Add meaningful missing tests around existing behavior | Main-thread test authoring and configured native review panel |
| `/zensu-delivery-route` | Select/status session or configured direct/TDD delivery route | Session-bound helpers; existing explicit user-choice rules |
| `/zensu-docs` | Author, publish/link and verify feature documentation | Zensu CLI and feature scope; publication authorization retained |
| `/zensu-doctor` | Read-only setup, config, binding, workflow, lease and recovery diagnostics | Native manifest/events/agents, bounded Copilot version probe; no Claude settings inspection |
| `/zensu-full-suite` | Choose local/CI/automatic full-suite execution with evidence | CI deferral still restricted to the supported, verified GitHub.com PR pipeline |
| `/zensu-gauntlet-loop` | Evidence-driven builder, two sequential critics, synthesis and disagreement arbiter | Native read-only analysis tasks; main thread owns builds and captures; no external Workflow engine |
| `/zensu-ghost-scan` | Discover undocumented repository features and import reviewed results | Native read tools; Zensu CLI/auth for imports |
| `/zensu-implement` | Implement a tracked feature and link source/tests/docs with a revision | Zensu feature/security context plus native main-thread implementation/review |
| `/zensu-pilot` | Diagnose feature lifecycle state and offer the next appropriate workflow | Native question and skill composition; tracked mode needs Zensu CLI |
| `/zensu-plan-review` | Cast parallel read-only plan reviewers and synthesize amendments | Named native plan-review agents; no implementation or implicit approval |
| `/zensu-pr-fix-findings` | Triage, implement, verify and resolve open review findings | Forge CLI plus main-thread changes and review chain; explicit requested remote updates |
| `/zensu-pr-team-review` | Scout, cast reviewers, debate/synthesize and publish consolidated PR/MR feedback | Native PR-review workers and forge CLI |
| `/zensu-pulse` | Privacy-oriented session boundaries and feature-touch journal | Native lifecycle boundary; Zensu CLI/auth and configured telemetry setting |
| `/zensu-recover-chain` | Inspect and recover stalled review-chain state | Existing CAS workflow state and recovery checks |
| `/zensu-reset-review-limit` | Grant additional auto-fix review rounds | Same session-bound round budget reset |
| `/zensu-self-review` | Terminal senior self-review and bounded final fix | Main-thread final report only after the review chain satisfies its gates |
| `/zensu-security-review` | Classification, security-state review, tests and STRIDE analysis | Native tools plus tracked-feature backend operations where requested |
| `/zensu-session-trail` | Discover, inspect, hand over, label and trace sessions | Native event/workspace reader and Copilot resume guidance; ten verbs listed below |
| `/zensu-setup` | Guided project/global plugin configuration and optional Zensu login | Deep-merge preserved; config does not modify Copilot tool permissions |
| `/zensu-tdd` | Vanilla or strict RED/GREEN implementation, evidence and guaranteed review chain | Native progress checklist and tools; explicit reviewer completion and approval contracts |
| `/zensu-tdd-mode` | Inspect/select vanilla versus strict implementation mode | Same configuration precedence and session override |
| `/zensu-verify-feature` | Validate each acceptance criterion against the running artifact | Browser, API, CLI, library, async, IaC, mobile, desktop and custom driver contracts retained; tools required separately |
| `/zensu-wargame` | Concrete execution plan with expected observations, failures and counter-moves | Native read-only challenge/review; host-specific goal/scheduler controls are not supplied by the plugin |
| `/zensu-work` | Execute a claimed work order and maintain its lease/status/questions | Native headless launcher; contract v1 supports kind `implement` |
| `/zensu-zen-mode` | Session mode with intent tracking, hypothesis loop and completion discipline | Native session-bound state; host limits remain visible |
| `/zensu-help` | Explain plugin/product concepts and configuration | Native command names and runtime guidance; no workflow is executed merely by asking |

The review engine retains lean/full aspect panels, optional judge, independent
first-review judging, finding verification, one-use review tickets, incremental
re-review, fix-round limits, convergence and terminal self-review. Implementation
remains in the main thread. Progress uses `update_todo` when exposed, another
exposed progress tool, or a real `.zensu/progress/` Markdown checklist. That
checklist is separate from plan-step status and the append-only evidence log.
The native `skill` tool loads a named skill, for example
`{ "skill": "zensu-doctor" }`. Reading the selected native `SKILL.md` directly is
an explicit fallback, not an invented tool.

File creation/edits use exposed `apply_patch` or native create/edit tools. Missing
`create` alone does not block a host that offers patch-based creation. Questions
use `ask_user` when available or real interactive conversation; an unanswered
required decision in headless execution remains pending. These fallbacks do not
waive file-mutation gates, test evidence or native human plan-approval receipts.

Native interactive planning writes the complete specification, acceptance criteria
and required run marker into the exact `plan.md` path Copilot supplies for the
session before calling `exit_plan_mode`. Its `summary` is only a concise overview.
Repository `.zensu/plans/` files remain audit artifacts and do not replace that
native file. The plugin never guesses its location from cwd; a missing supplied
path leaves planning pending. Approval binds the correlated human response's
`response.planContent` bytes, including the run marker, rather than the summary.

## All six agents

Each native definition has a bare name and permits only `view`, `grep` and
`glob`. Registration and tool restrictions are distinct from proof that a host
spawn succeeded. Unknown child identities never inherit main-thread authority.
Copilot supplies the `zensu:` plugin namespace for task selection. A native
`task` call requires `agent_type`, a descriptive `name` and `prompt`; include the
complete required review packet, and use the advertised execution mode.

| Native agent | Role |
| --- | --- |
| `zensu:zensu-plm` | Read-only product-lifecycle context and guidance |
| `zensu:code-reviewer` | Coordinate/consume the review packet and report chain verdicts |
| `zensu:review-aspect` | Review one configured aspect with bounded, evidenced findings |
| `zensu:review-judge` | Independent synthesis and adjudication of aspect results |
| `zensu:plan-review-worker` | Validate a plan from its assigned review perspective |
| `zensu:pr-review-worker` | Review a PR/MR diff with its assigned persona |

Gauntlet artifact critics can use the host's built-in read-only `explore` agent
when suitable. That is not a seventh packaged specialist or proof of the
specialist workflow's lifecycle guarantees.

## Native hook map

The package registers these **11** events in
`com.github.copilot/hooks/hooks.json`:

| Native event | Runtime responsibility |
| --- | --- |
| `sessionStart` | Bind native session/project/install; startup rules, session state, Pulse and journal |
| `sessionEnd` | End observation and run supported lifecycle cleanup |
| `userPromptSubmitted` | Record original prompt observation without double-routing the workflow |
| `userPromptTransformed` | Route the transformed prompt into policy, intent and session-ledger hooks |
| `preToolUse` | Validate native tool names **and arguments**; gate writes, tools, review and approval; bind Bash helper context |
| `postToolUse` | Inspect actual native outcomes, capture test/review evidence and advance permitted transitions |
| `postToolUseFailure` | Preserve failure state; explicitly prohibit success/approval/review evidence from a failed call |
| `subagentStart` | Correlate a native child identity and its read-only role |
| `subagentStop` | Consume an actual child completion/result with its identity |
| `agentStop` | Enforce pending implementation/review/Autopilot completion obligations |
| `preCompact` | Reset the prompt-ledger segment for compaction without guessing context utilization |

Shell/parser failures in a policy gate deny the operation. A failed stop gate
keeps the workflow pending. An asynchronous task launch is never a completed
review.

## Session trail and headless work

All ten session-trail verbs exist: `instances`, `list`, `show`, `handoff`,
`limited`, `takeover`, `lineage`, `adopt`, `release`, `label`. The provider reads
native Copilot `events.jsonl`, supported scalar `workspace.yaml` metadata and
the plugin's own registry. It reconstructs the last successfully saved native
checklist, historical human plan response and correlated task launches/results.
Checkboxes are claims, asynchronous dispatch is not completion, and an old plan
response is not new authorization. It never uses another host's transcript as
fallback or presents a child alias as a separately resumable session.

Takeover prepares an inspection brief, a `copilot --resume` command and optional
provisional lineage; it starts no process. `release --apply` writes a local
handover-complete receipt, not a host archive action. Labels are plugin-local.
Lineage backfill uses explicit detached-continuation metadata only; `parentId`
inside an event links events, not sessions. Native fork prose does not establish
an authoritative lineage edge.

`harness/manifest.json` advertises `zensu-copilot`, contract version 1 and kind
`implement`. The native launcher keeps the work-order lease, watchdog,
cancellation, process supervision and release contracts, while launching Copilot
with a fixed session ID and consuming its JSON event/result stream. It does not
grant unrestricted permissions. A live backend work-order round trip must be
tested separately from launcher fixtures.

## Explicit host differences

| Source-host behavior | Copilot behavior and proof boundary |
| --- | --- |
| Claude Desktop windows, accounts, task chips, presets and archive protection | No native CLI equivalent; not simulated. Desktop-pool hooks are not shipped; native reanchor uses conservative session ownership evidence. |
| Queued or withdrawn user messages | Not recoverable from persisted native session events; state is unknown. |
| Process liveness from session existence | Registry starts with `pid: null`; activity is an observation, not a verified live process. PID liveness needs a matching process-start identity. |
| Context occupancy/nudge percentage | No percentage is inferred from transcript size; unavailable utilization stays unknown. |
| Skill tool and task-list APIs | Native skill loading and `task` replace their source-host counterparts. Progress uses exposed `update_todo`, another exposed progress tool or a real local checklist; none is assumed universally available. |
| External Workflow/Ultracode review import | Direct native custom-agent panel supplies the review; external acceleration is not assumed. |
| Planning tool returning success | Does not mean human approval. Only a correlated accepted native human plan response can start durable approved work. |
| Remembering browser-origin approval | Requires the exact native Bash hook permission request and an approved human-response completion. Missing or automated receipts do not populate the cache. Explicit parent navigation policy remains supported. |
| Unlimited continuation from stop hooks | Copilot can bound continuation. Pending state survives; resume explicitly instead of marking incomplete work done. |
| Claude settings/auto-mode diagnostics | Native doctor checks package files and reports unknown effective Copilot permissions. It never reads Claude settings. |
| PowerShell policy parsing | Unsupported and denied; use Bash. |
| LSP rename and unknown mutating LSP operations | Unsupported and denied. Recognized read-only definition/reference/hover/symbol/call queries remain available. |
| Dynamic workflow execution/management tools | Denied because their nested operations cannot be accounted for by the native policy boundary. Use the direct custom-agent review panel. |
| Browsers, desktop automation, schedulers and publishing services | External capabilities; driver/host availability must be verified. No implicit browser or scheduling service ships here. |
| Shared Zensu configuration | `~/.zensu/config.json` remains shared by design; use project config or `ZENSU_CONFIG` for separate choices. Native session/runtime state is isolated. |

Four source-host execution/render utilities and `templates/workflows/` are
excluded from the generated package. Use the native harness for work orders and
direct native panels for review; upstream Claude E2E/Promptfoo runs do not
validate this port.

## Evidence levels

Native workflow reliability uses owned Copilot helpers:

- `review-packet-v1.js` enumerates the cumulative change set and creates one
  immutable evidence packet. The native dispatcher injects identical canonical
  bytes into each reviewer call; reviewer-specific metadata stays outside it.
- The required primary judge must complete on that generation, round and tree
  before consume review. An additive second judge or a successful launch cannot
  satisfy this stage. Disabled-judge and lean-panel rules remain explicit.
  Session Control supplies the authoritative project anchor even when the native
  host retains its original working directory after reanchoring.
- Finding verification accepts a JSON file, so finding text is not shell input.
  Quality verdicts describe findings; the native post-review hook supplies the
  workflow route under the effective severity policy.
- Execution-start and terminal helpers reconcile the bound progress artifact.
  A closed-generation result is report-only; it never grants new review work or
  converts unverified tests into completion evidence.
- Edit-landing receipts retain the generation's append-only claims, original
  audit context and file snapshots, including after failed audits. Current
  literal predicates and file hashes can resolve pending claims; omitting
  arguments cannot clear them. Terminal closure requires a clean, current
  receipt. An active authoritative native session refuses an omitted `--session`
  before grading, with an exact quoted recovery command. This refusal validates
  the existing native session record without adopting or promoting an identity.
  Standalone audits outside active workflows disclose that they write no workflow
  receipt; read-only inventory remains available separately.
- Copied shell-binding comments are safely rebound before policy checks.
  Complete native export blocks are recognized exactly; ordinary command bytes
  remain intact and incomplete protected-selector exports are refused.
- Verification loads bounded reference files and permits one observed acceptance
  run to support several separately recorded criteria on the same current tree.
  Synthetic diagnostics are allowlisted; raw subject/network output remains
  suppressed.
- Audit, review-chain and terminal self-review instructions also use bounded
  references. Native startup explains how to continue a size-limited `view`
  through explicit line ranges; successful transport alone is not a full read.
- Copilot's observed `rg` alias is validated against its read-only argument schema
  and uses the same policy checks as `grep`. Its native execution and arguments
  are preserved; private paths, traversal and evidence leases keep their limits.

These are native implementation contracts. Their fixture and live results are
recorded separately; shared-source audits of other ports do not certify those
hosts or change their installations.

- **Packaged:** all 32 native skills, six agents and 11 event registrations;
  source files are copied without transformations and the build works without
  the original source snapshot.
- **Fixture-tested:** direct native event/tool contracts, real local policy and
  evidence transitions, session isolation and reanchoring, permission receipts,
  native transcript attribution, complete review closure and launcher control.
- **Live:** see [the current validation record](copilot-runtime.md#observed-validation-record).
  Native 0.2.0 completed a local library workflow, observed acceptance and the
  complete native review/self-review chain on Copilot CLI 1.0.98.
- **Separate acceptance:** real human approvals, finding/fix rounds, external
  backend/forge work, browser/other validation drivers and backend work orders.
  A successful local workflow does not certify these external flows.

The existing Zensu service's `doc claude-md[-context]` and `generate_claude_md`
operation names are retained service API contracts. They do not load, execute or
proxy another coding host. Product instructions are authored as native `AGENTS.md`.

## AI work capture

The native main-session helper records explicit goals and clean commit results
through personal CLI OAuth. Native Bash binding carries the capture principal;
partial/unknown child identity cannot borrow it. agentStop retries within the
remaining dispatcher budget. The pre-handoff checkpoint returns the exact review
link; acceptance and revocation stay in the authenticated web UI. No IDE coverage
is implied. See [the capture contract](ai-work-capture.md).
