# Automatic work capture

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

Linux and macOS CI validate the complete packaged integration suite. An isolated
native session on 2026-10-24 loaded only the frozen current plugin and delivered
sessionStart and prompt events with the same native session ID and workspace.
The provider returned quota_exceeded (402) before any model result or agentStop,
so full native capture acceptance remains unverified. The test used Copilot's
own existing login; no GitHub token was read or transferred. Global settings
were verified unchanged, and no work goal or submission was created.

A fresh isolated Copilot CLI 1.0.100 probe on 2026-10-25 at 14:35 UTC
again returned quota_exceeded (402), explicitly reporting an exhausted monthly
quota. The probe used the existing native login and observed startup, prompt and
session-end events without a model result or agentStop submission. The tested
runtime was `db11ef2809315e0365bbc2b8ffd65f5b28c8cea1`, before synchronizing the
subsequent feature-context documentation/read mapping from main. Global settings
and monitored marketplace hashes remained unchanged. Full native capture
acceptance is still unverified, and no work goal or result was created.
