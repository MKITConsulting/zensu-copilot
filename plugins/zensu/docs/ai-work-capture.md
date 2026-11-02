# Automatic work capture

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
`node <plugin-root>/hooks/native/helper.js ai-work begin --task <key> --title <objective> --criteria <version>`
and `node <plugin-root>/hooks/native/helper.js ai-work checkpoint` after the final
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
