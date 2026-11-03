# Automatic work capture

## Recover a blocked local receipt

Recovery never uploads a report, accepts a result, repairs attribution or changes
server history. Run these commands in the affected worktree with the exact
capture key supplied by its plugin; do not borrow another conversation's key.

```sh
zensu ai-work recover --session <capture-key>
zensu ai-work recover --session <capture-key> --archive <active-receipt-sha256> --confirm
zensu ai-work recover --session <capture-key> --restore <archived-receipt-sha256> --confirm
```

Inspection is offline and returns the active receipt digest, its reason and the
same session's archives. Archive requires the exact inspected digest and explicit
confirmation. Restore requires an empty active slot, checks the digest and leaves
the archive intact. Its working copy is paused using the existing `capturePaused`
flag, which older plugin versions also honor; only an explicit validated `begin`
can resume reporting. All other JSON values are retained without numeric rounding. All mutations share the capture lock; a held or stale lock is
reported for inspection, never forcibly removed. No OAuth login is needed.

A new, explicitly scoped `begin` preserves an old receipt lacking product or
feature scope before replacing it, including its pending event and unknown fields.
The result's `recoveredReceipt` identifies that local archive. Missing or rejected
new scope leaves the legacy receipt untouched. A fully scoped pending report still
requires its exact retry or explicit CLI archival; it is never silently retargeted.

Archives live at `<git-dir>/zensu-ai-work-v1/recovery/<capture-key>/<sha256>.json`.
They retain the original bytes, event IDs, expected version and any review details.
They are private, outside tracked files, and are never scanned or submitted by Stop.
Restoration does not make legacy scope valid: use a new explicitly confirmed goal
for new work. Every restored valid receipt requires an explicit `begin` for its original
goal before retrying; restoration alone never enables Stop reporting. Archival is not evidence that a previous request
failed at the server; a lost response may already have been recorded. Check that
original work's server history explicitly before any manual resubmission, and keep
its original event ID for retries. Never delete or edit receipts to unblock capture.



## Feature scope per work objective

Automatic capture requires both the confirmed repository product and an explicitly
selected feature for each goal: pass `--feature <feature-uuid>` to `begin`.
The server derives the product from the feature and validates an optional
`--feature-revision <revision-uuid>`. Never infer confirmation from a branch,
repository, title or a previous goal.

For product-wide maintenance, explicitly pass `--maintenance-reason <reason>`
instead of a feature. Cross-product work requires explicit human intent and
`--cross-product-reason <reason>`. These choices are mutually exclusive.
Without a goal scope, capture returns `skipped_missing_feature`; development
continues. A rejected or incomplete goal change pauses the old receipt, including
Stop capture, until an explicit valid `begin` resumes it. Fully scoped pending
reports retain their frozen identity and must be retried under their original
goal or explicitly archived locally. Legacy receipts can be preserved separately
when a new explicitly scoped goal begins, as described above.

Receipts freeze feature, optional revision, exception reason and product.
Legacy receipts without feature scope cannot automatically submit new results.
Historical server records and human acceptance remain unchanged. Upgrade the
feature-scope backend first, then CLI, then plugins; older servers/CLIs fail closed.


## Confirmed product scope

Automatic capture requires an explicitly human-confirmed repository product.
After the user confirms the exact product, run `zensu ai-work bind --product <uuid> --confirm`
in the repository. Never infer confirmation from a folder name, remote, existing
configuration, a prior unassigned record, or permission to implement a task.
The CLI validates the product against the current personal OAuth account and
organization. Its private binding lives in the Git common directory, outside
tracked files, and is shared by worktrees of that repository. It contains IDs and
an origin fingerprint, never credentials or the remote URL.

`zensu ai-work context` revalidates the binding. A host, account, organization,
origin or product-access change requires renewed explicit confirmation. Missing
bindings return `ready=false` and `workScope=unassigned`; the helper returns
`skipped_unassigned` without creating a work entry. Continue authorized coding.
Do not create a placeholder or silently switch to cross-product capture.

Only when the user explicitly requests work spanning products, supply
`--cross-product-reason <specific-reason>` on `begin`. The reason is required for
that goal and cannot be a repository default. Normal product work (including its
tests) keeps the confirmed product; run purpose and product scope are independent.

Receipts freeze product/cross-product scope, reason and authenticated identity
before declaration. Checkpoints revalidate the same scope. A changed binding
cannot retarget a pending report. Legacy receipts without confirmed scope remain
untouched and cannot auto-submit new results: use a new explicitly scoped goal.
Existing unassigned server entries appear in the separate **Unassigned** tab,
excluded from regular result metrics, with history and human acceptance retained.

Requires the product-scope backend and CLI `ai-work bind`, `context --cross-product`,
and `start --product/--cross-product-reason`. Upgrade backend, CLI, then plugins;
missing protocol support is visible incomplete capture. No fallback to an older
unscoped command is allowed. Submission never accepts a result.


A personal `zensu auth login` identifies the reporting account. Use Zensu CLI v0.11.0 or newer. The CLI must
provide `ai-work context/start/get/submit`, and the server must provide the
capture endpoints and CLI provenance migration. Missing prerequisites remain
visible incomplete capture; never borrow credentials or change login automatically.

Record one already agreed implementation goal using a stable task key, a concise
objective (at most 160 characters), and the agreed criteria version or digest.
Reuse all three on retries; changed scope uses a new task key. Do not record work
for startup, greetings or read-only questions. Capture applies in direct mode too
and is independent of private Pulse opt-in.

Only a new clean Git HEAD is submitted. A private receipt in the worktree Git
metadata persists stable IDs before requests, binds API host and reporting account,
and retries the same result after interrupted delivery. Dirty or unchanged work,
identity changes and version conflicts remain incomplete. Do not discard pending
receipts to hide an error. A process crash can leave a lock requiring inspection.

Include the returned exact `reviewUrl` at handoff. Human acceptance and revocation
are explicit authenticated web decisions about that result version. Never accept
from an agent, infer approval from a merge/release/test, or operate the decision
dialog on the human's behalf. Later results do not inherit acceptance. Attribution
identifies an authenticated reporting account, not human code authorship.

No code, transcripts, prompts, diffs, file lists, credentials or token usage are
uploaded. Both dashboard scopes use the same canonical units and credits.

## Copilot CLI

Use the native main session's helper from the SessionStart primer:
`node <plugin-root>/hooks/native/helper.js ai-work begin --task <key> --title <objective> --criteria <version> --feature <uuid>`
and `node <plugin-root>/hooks/native/helper.js ai-work checkpoint --review-file <explicit-review.json>` after the final
commit. Quote each argument. The native Bash hook supplies session and principal
bindings; do not supply or override them. Child sessions cannot report work.
`agentStop` provides a bounded retry backstop; run the agent checkpoint before
handoff so its review link is in the visible response. No IDE Copilot capture is
claimed by this CLI plugin.

## Validation boundary

Native capture passed in an isolated, guided Copilot CLI 1.0.100 session using
a local Ollama model and Zensu CLI 0.11.0 on 2026-10-25. The real host declared a
goal, edited and committed the fixture, submitted the result and repeated the
checkpoint without a duplicate. A second clean commit was submitted exclusively
by the native `agentStop` hook, with no model-issued checkpoint. Independent
live read-back verified authenticated attribution and no human decision.
See the [native validation report](https://github.com/MKITConsulting/zensu-copilot/blob/main/docs/validation/2026-10-25-native-ai-work-capture.md)
for source binding, model limitations and excluded failed probes.

Earlier quota-blocked probes below remain historical evidence, not successful
native validation.

Linux and macOS CI validate the complete packaged integration suite. An isolated
native session on 2026-10-24 loaded only the frozen current plugin and delivered
sessionStart and prompt events with the same native session ID and workspace.
The provider returned quota_exceeded (402) before any model result or agentStop,
so that probe did not verify full native capture. The test used Copilot's
own existing login; no GitHub token was read or transferred. Global settings
were verified unchanged, and no work goal or submission was created.

A fresh isolated Copilot CLI 1.0.100 probe on 2026-10-25 at 14:35 UTC
again returned quota_exceeded (402), explicitly reporting an exhausted monthly
quota. The probe used the existing native login and observed startup, prompt and
session-end events without a model result or agentStop submission. The tested
runtime was `db11ef2809315e0365bbc2b8ffd65f5b28c8cea1`, before synchronizing the
subsequent feature-context documentation/read mapping from main. Global settings
and monitored marketplace hashes remained unchanged. Full native
capture remained unverified by that probe, and no work goal or result was created.


## Declared source and run purpose

The reporter supplies its plugin name and packaged version automatically. These
are client declarations; personal OAuth authenticates the reporting account,
not the host or authorship. Use `--run-kind work` (the default) for normal product
implementation, including writing/running tests. Use `--run-kind test` explicitly
when the goal itself is a validation, demo or capture probe. Never guess from the
title, test commands or a green suite. Preserve the agreed purpose on retries.

New receipts freeze source, version and initial purpose before the first request.
An upgrade preserves existing receipt metadata; a receipt without confirmed product scope cannot resume automatic reporting. Historical receipts keep missing
metadata unknown; do not rewrite or delete them to force attribution. Purpose
corrections belong to the current owner/admin in the web UI, with a reason; the
reporter cannot classify, accept or revoke. Both dashboard scopes exclude declared
tests by default but offer an include-tests switch. Unknown records remain visible.
Billing credits stay separately unfiltered because they are not linked to runs.

Requires a CLI supporting the `ai-work start --source --source-version --run-kind`
flags and a backend supporting run metadata. Upgrade backend and CLI before the
plugin. Missing support is an incomplete capture, never a silent fallback. The
internal `--legacy-metadata` flag only replays pre-metadata receipts unchanged.

## Check scope before implementation

Use the same native helper and session/workspace arguments shown above, replacing
`begin` with `preflight` and omitting task/title/criteria. Confirmed per-goal feature
or exception flags are optional for this read-only check. It checks CLI
capabilities before requesting context and returns a precise prerequisite status.
Ask once for missing product/feature confirmation early, reuse a valid product
binding, and continue coding if scope is unavailable. Do not create placeholder
work or infer consent from discovery.

If reporting was explicitly declined, call the same native helper with `pause`
instead, without goal flags. This is local only; it preserves pending receipts,
suppresses preflight/context and Stop submissions, and asks no scope questions.
Only an explicitly authorized, confirmed `begin` clears this pause after success.
A failed or incompatible begin keeps the pause. CLI capability checks run again
before begin/checkpoint writes, so a later downgrade cannot drop required flags.

See [CLI installation and updates](cli-install-update.md), including `zensu update`,
the fallback for older versions, PATH diagnostics and all preflight statuses.

## Explain the result before human acceptance

Before the final checkpoint, write an explicit review JSON file and pass its path
with `--review-file`. This sends authored result descriptions to the selected API
host in addition to capture metadata; stay within the user's approved disclosure
scope. Never copy transcripts, diffs, credentials or private tool output. State
what changed, the agreed acceptance criteria, actual check results and remaining
limitations. Do not invent a passed check. The file is limited to 32 KiB:

```json
{
  "summary": "Added version-bound review details to the acceptance dialog.",
  "artifactUrl": "https://git.example.test/team/repo/commit/0123456789012345678901234567890123456789",
  "acceptanceCriteria": [
    {"text": "The reviewer sees implementation, criteria and evidence.", "status": "met"},
    {"text": "Manual production validation", "status": "not_checked"}
  ],
  "evidence": [
    {"label": "Focused tests", "description": "18 tests passed locally."},
    {"label": "Pull request", "url": "https://github.com/example/project/pull/123"}
  ],
  "limitations": "Not deployed; production validation is pending."
}
```

Criteria statuses are `met`, `not_met`, or `not_checked`, reported by the agent.
They are never human acceptance. Use at most 20 criteria and 20 evidence entries.
Summary/limitations allow 4000 characters, criteria 1000, evidence labels 200,
and evidence URLs/descriptions 2000. An evidence entry needs a description or
an HTTP(S) URL without embedded credentials. Links are references, not fetched
or independently verified by capture.

Requires a CLI supporting `ai-work submit --review-file` and a backend supporting
`reviewDetails`. Upgrade backend, CLI, then plugin. The helper freezes the content
inside its private pending receipt, passes a temporary private file to the CLI,
and confirms the saved content. A changed file cannot rewrite a pending result;
retry the frozen submission first. A changed report at the same commit creates
a new result version and does not inherit acceptance. Stop can replay a pending
report without the original file. Without an explicit file it preserves legacy
metadata-only capture; the web dialog marks absent information rather than
reconstructing it from earlier conversations.

### Link the immutable artifact to its source system

When the exact source URL is known and its disclosure is authorized, include
optional `artifactUrl` in the explicit review file. For a commit result, use the
source system's commit page for the full checkpoint HEAD, never a branch or
pull-request URL. Keep the actual repository and host; do not infer them from a
product name or unrelated evidence. Omit the field when the URL is unknown.
The helper does not discover or transmit local Git remotes automatically.

The field accepts up to 2000 characters, HTTP(S) only, without URL credentials,
whitespace, backslashes or control characters. Self-hosted systems are supported.
The web dialog and submission history link the artifact reference to this URL;
it remains a reporter assertion, not independent provenance verification.

Upgrade the backend and typed CLI to versions supporting `artifactUrl` before
using it. The helper freezes and confirms it with all other review details;
changing the URL requires a new result and never transfers human acceptance.
Old reports without a URL stay unchanged. An unsupported server/CLI is visible
incomplete capture, never permission to silently omit the field from a retry.
