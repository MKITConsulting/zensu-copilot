# Native Copilot AI-work capture validation

- Date: 2026-10-25, 16:38–16:54 UTC.
- Tested source: `63acbf4db8f26adc1481f99ce62b1f3c1230d96e`.
- Host: Copilot CLI 1.0.100; Zensu CLI 0.11.0.
- Model: local Ollama 0.14.2, Qwen3 4B Q4_K_M, isolated alias with a 65,536-token context.
- Native session: `f09a2db2-c6dc-4eb8-8485-7b63e4f9325c`.
- Explicit-checkpoint result: `50915e8247688b26b673e9fb82eac954bb48f02b`.
- Automatic-Stop result: `8d5563eea92d9cb56a162842eead8125a9cbee03`.

## Setup and source binding

The actual installed CLI loaded only a frozen, separately staged candidate in a
disposable Git project. All 277 staged files retained their original hashes.
The 241 runtime files under `hooks/`, `skills/`, `com.github.copilot/` and
`harness/` matched the 0.3.0 release preparation byte-for-byte; subsequent changes
are version metadata and documentation, including the intervening 0.2.2 release.

The official local-provider configuration selected the model for this process
only. No Copilot credentials were transferred to another service, and no other
host's login was borrowed. Native tools used the existing personal Zensu CLI
OAuth login. Individual native confirmations approved the fixture edit, the
specific shell commands and access to the separately staged helper. Folder trust
was session-only. Monitored global settings and installed marketplace payload
hashes were unchanged when the host exited successfully.

## Observed behavior

1. Native sessionStart delivered the capture primer with the real session and
   workspace binding. The model called the exact helper to declare the agreed
   goal; the actual response was `recording`.
2. A native edit added one verified line to README.md. The native Stop after
   this edit left the unit at version 1, without a result, while Git was dirty.
3. One sequential native Bash call verified the fixture, committed only
   README.md, checked a clean worktree and invoked checkpoint twice. Actual tool
   output was `submitted_for_review`, then `already_submitted`, with the same
   result-specific review URL. Independent CLI read-back after Stop found exactly
   two events: one start and one submission, version 2.
4. To prove positive automatic delivery, a second explicitly authorized fixture
   revision was edited and committed. The model made no ai-work helper call in
   that commit turn. The real native `agentStop` completed, and independent
   read-back then found version 3 with exactly one additional submission bound to
   the new commit. This distinguishes actual automatic delivery from merely
   observing that a Stop hook fired.
5. Both result actors matched the authenticated owner and reporting user, with
   `cli_authenticated` provenance and criteria `native-capture-v1`. `decision`
   remained null and `canManage` was false for the CLI. No result acceptance or
   revocation was attempted.
6. An authenticated read-only browser check showed the first submitted result
   in both My work and Organization: matching responsibility, commit and
   criteria, Awaiting acceptance, and a CLI/plugin provenance label. No decision
   fields were changed.

## Limits and excluded attempts

This was a guided integration probe with sequential prompts. It proves the
native capture path and automatic Stop delivery, not autonomous planning quality
or every workflow skill. The small model inaccurately summarized both explicit
checkpoints as submissions; the actual tool JSON and independent server events
proved that the second was an idempotent repeat.

Two earlier headless local-model attempts failed. One composed compound commands without the required native approvals and then
invented a review URL. The other issued dependent
operations concurrently, failed its edit and Git commit, and still claimed
success. Both were rejected after independent Git/state inspection; neither
created a goal or result. The interactive follow-up identified the missing host
path-access confirmation for the separately staged helper, independently of
those model errors. Earlier cloud-provider 402 quota failures are also excluded.

An auxiliary host request for `gpt-5.4-nano` received model-not-found from the
local provider. It was not substituted or redirected to a paid provider; the
configured main local model completed the capture probe. This is not a claim
that every Copilot auxiliary feature supports the local model.

No IDE Copilot capture is claimed. Human acceptance remains an explicit web
action. These submitted test results remain unaccepted.
