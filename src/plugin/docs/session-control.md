# Session Control

## Native identity and principals

The Copilot hook envelope supplies `sessionId`, `cwd` and, for children,
`agentId`, `parentAgentId` and `agentType`/`agentName`. The dispatcher validates
those fields, correlates native child observations, and preserves the root owner
without treating an unclassified child as a main agent. No transcript filename,
latest session, model claim or foreign-host environment supplies an identity.

`sessionStart` creates or validates the private Session Control record against
canonical project and executing plugin roots, plugin data, package version,
source revision and runtime digest. The record binds every later tool call.
Workflow state lives under that recorded project's `.zensu/state/`; current tool
`cwd` locates relative files and cannot silently replace the recorded anchor.

Copilot may update an installed package in place. Changed bytes at the recorded
path remain a hard runtime-digest failure for normal reads and automatic hooks.
`/zensu-adopt-session` can diagnose a strictly checked native replacement;
`--confirm` is the explicit user-authorized repair. It accepts the loss of the
overwritten old bytes only after verifying the private owner/session/project
binding, workflow schema and revision, full replacement build receipt, and a
compatible non-downgrade version. Record and workflow snapshots are rechecked
under their existing locks. The old record is archived by digest; only the
record's runtime digest, matching source revision and package version change.
Workflow bytes, revision, tickets and completion flags remain unchanged.
Superseded runtime-bound review leases are archived, so pending reviewers must
obtain fresh leases. A partial cleanup is reported and `--confirm` retries it.
The build receipt proves package consistency, not publisher authenticity or the
integrity of unavailable old bytes. This repair never runs automatically.

The main thread has `main-v1`. Named review agents have `reviewer-readonly-v1`;
plan/PR evidence workers have `evidence-worker-v1`. Other classified children use
`host-profile-v1`, with explicit restrictions. Missing child classification never
inherits the main thread's authority. All six packaged specialist definitions
permit only `view`, `grep` and `glob`. The policy can restrict host capabilities;
it cannot grant a tool that Copilot did not expose or authorize.

Reviewer reads are confined to the packet's exact files and safe subtrees. Native
`view.path` and every `grep.paths`/`glob.paths` entry are checked. Evidence workers
must hold the appropriate role-bound read lease. Leases are inspected, renewed,
finalized and swept according to the review-evidence protocol, not inferred from
a task handle or a claimed report.

## Native helper binding

Before an admitted Bash call, the hook binds `COPILOT_PLUGIN_ROOT`,
`COPILOT_PLUGIN_DATA`, `COPILOT_PROJECT_DIR`, `COPILOT_SESSION_ID` and the protected
`ZENSU_BOUND_SESSION_ID`. The helper checks the selector and executing installation
before resolving state. These are plugin-owned shell bindings, not a claim that
Copilot exports them to arbitrary external shells. No foreign-host alias or
configuration directory is involved.

The write gate denies changes to protected selectors. A helper cannot switch
from session A to session B by overriding `COPILOT_SESSION_ID`. Runtime drift,
unsafe paths, symlinks/hardlinks in private state, corrupt mandatory baselines and
conflicting identities fail closed. The shared configuration files remain
`~/.zensu/config.json` and `<project>/.zensu/config.json`, or `ZENSU_CONFIG`.

## Workflow state and evidence

State filenames use domain-separated `scv1_…` keys; transitions use monotonic
revisions and atomic compare-and-swap operations. The immutable record is separate
from mutable workflow state. Direct edits do not replace an authorized transition.
Review tickets, run/attempt/chain bindings, leases, round limits, pending rearm,
full-suite records and acceptance observations retain their separate authority.

Native transcript readers inspect real `events.jsonl` records and correlate tool
calls/results and permission receipts by identity. They never synthesize another
host's transcript. A task launch is not a completed review, tool transport success
is not shell exit zero, and assistant prose is not a human instruction or approval.

## Unbindable sessions

Run `/zensu-doctor` and retain the exact binding failure. `/zensu-adopt-session`
reports first and applies only explicitly confirmed repairs supported by the
current state: verified in-place runtime replacements, declared plugin-lineage changes, a pruned installation, a missing
mandatory baseline or a missing recorded root. Invalid/tampered records are not
silently accepted. `/zensu-recover-chain` handles the specific validated stale
rearm shapes; `/zensu-reset-review-limit` only extends the round budget and does
not create a missing review ticket or completed reviewer.

Session reanchoring keeps the same Git repository and requires an explicitly
confirmed registered worktree, no open owned chain/run and conservative exclusion
of competing native session claims. Unknown activity is not proof a checkout is
free. This is separate from adoption and never moves open evidence to a new root.
See [worktree ownership](worktree-keep.md) and the adoption skill's exact report.

A native fork or resume is not an implicit transfer of another session's workflow.
Session-trail handoff/takeover prepares a brief and a resume command; it grants no
permission to archive, overwrite or continue another owner without user authority.

These checks govern tool workflow behavior. They are not an OS sandbox against a
malicious process running as the same user. Use external isolation for untrusted code.
