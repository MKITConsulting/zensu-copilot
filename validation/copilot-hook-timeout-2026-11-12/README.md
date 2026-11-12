# Copilot CLI hook timeout ordering — native capture, 2026-11-12

**Outcome: the ordering the dispatcher budget relies on holds.** Copilot CLI
waited the full 250 s for a `preToolUse` command hook registered with
`timeoutSec: 260` and applied the deny the hook then wrote. A `preToolUse` hook
that outlived `timeoutSec: 5` was terminated, and the tool call ran: the host
timeout is fail-open. Both observations match GitHub's
[hooks reference](https://docs.github.com/en/copilot/reference/hooks-configuration)
and the design in [docs/copilot-runtime.md](../../docs/copilot-runtime.md): a
fail-closed dispatcher deadline of at most 250 s inside a 260 s host timeout.
No observation contradicts it.

This is a native capture: real Copilot CLI processes, a real model turn and the
native hook runner. It is not a fixture test, and no test reads these files.

## Setup

- macOS on Apple silicon (`darwin-arm64`), headless prompt mode:
  `copilot -p … --output-format json`.
- Copilot CLI 1.0.107 for run a and 1.0.109 for run b. Copilot's built-in
  auto-update downloaded 1.0.109 while run a was waiting, and the next launch
  used it. The 1.0.108 and 1.0.109 changelogs list hook changes for `ask`
  handling, `additionalContext: null` and Policy Helper locks, but none for hook
  timeouts.
- Model: `--model auto`. Automatic selection chose `mai-code-1.1-flash`, the only
  model the account offered in this setup. Two earlier attempts with
  `--model claude-haiku-5.5` and `--model gpt-6-luna` stopped with "not available"
  before any model turn or hook invocation (`setupAttempts` in `capture.json`).
- Isolation: every run used a new, empty `COPILOT_HOME`, so no installed plugin
  (an installed Zensu release included), user hook, user setting or trusted-folder
  entry took part. Copilot authenticated with the GitHub CLI's active account
  through `COPILOT_GITHUB_TOKEN`, hidden from tools by `--secret-env-vars`. The
  regular Copilot home's `config.json`, `settings.json`, installed-plugin files,
  plugin data and session-state count were identical before and after each run.
- Every run had its own disposable Git repository with exactly one repository hook
  file, `.github/hooks/probe.json`, loaded through `--trust-folder`. The debug log
  confirms "Loading repo hooks in prompt mode (folder is trusted or opt-in set)".
- Further flags: `--allow-tool 'shell(touch)' --no-custom-instructions
  --disable-builtin-mcps --no-ask-user --sync-session=off --log-level debug`. Only
  `touch` was pre-approved, so the probe hook was the only gate on the requested
  call.
- Prompt: run exactly `touch probe-<run>-ran.txt` with the bash tool; if it is
  denied or fails, reply `DONE` without retrying.

[probe-hook.sh](probe-hook.sh) logs its own start, sleeps in a child process
(`sleep N & wait`), logs SIGTERM, SIGHUP or SIGINT if one arrives, and then writes
a `deny` decision. It allows any other tool call at once and denies a repeated
target call at once; neither case occurred.

| Run | `timeoutSec` | Hook behaviour | Expectation from GitHub's reference |
|---|---:|---|---|
| a | 260 | sleeps 250 s, then denies | deny applied after about 250 s |
| b | 5 | sleeps 60 s, then would deny | terminated after 5 s, call proceeds (fail-open) |

Run a sleeps 250 s rather than 120 s because 250 s is the dispatcher's maximum
fail-closed deadline; a shorter sleep would not rule out a host cap between 120 s
and 250 s.

## Run a — deny after 250 s within `timeoutSec: 260` (Copilot CLI 1.0.107)

| UTC | Source | Event |
|---|---|---|
| 11:14:26.439 | native | `tool.execution_start`, `bash`, `touch probe-a-ran.txt` |
| 11:14:26.443 | native | `hook.start`, `preToolUse` |
| 11:14:26.460 | hook | process started; stdin read at 11:14:26.478 |
| 11:18:36.542 | hook | 250 s sleep finished |
| 11:18:36.550 | hook | deny written to stdout |
| 11:18:36.552 | native | `hook.end`, `success: true`, "Denied by preToolUse hook: probe-a: deny after 250 s" |
| 11:18:36.554 | native | `tool.execution_complete`, `success: false`, error code `denied` |
| 11:18:37.846 | native | assistant reply `DONE` |

- `hook.start` to `hook.end`: 250.109 s. The debug log shows no host timer,
  warning or signal during the wait.
- The marker file was not created. Copilot exited 0, and no hook process remained.

## Run b — hook outlives `timeoutSec: 5` (Copilot CLI 1.0.109)

| UTC | Source | Event |
|---|---|---|
| 11:28:31.609 | native | `tool.execution_start`, `bash`, `touch probe-b-ran.txt` |
| 11:28:31.610 | native | `hook.start`, `preToolUse` |
| 11:28:31.632 | hook | process started; stdin read at 11:28:31.647 |
| 11:28:36.620 | hook | SIGTERM received, 5.010 s after `hook.start` |
| 11:28:38.615 | debug log | signalling the hook's process group failed: `killpg` returned EPERM |
| 11:28:38.615 | debug log | "preToolUse hook from ".github/hooks/probe.json" timed out; allowing the tool call to proceed" |
| 11:28:38.615 | native | `hook.end`, `success: false`, "HookTimeoutError: Hook command timed out after 5 seconds" |
| 11:28:40.351 | debug log | shell permission request routed through the normal permission service |
| 11:28:40.368 | native | `tool.execution_complete`, `success: true`, exit code 0 |
| 11:28:41.532 | native | assistant reply `DONE` |

- The marker file was created: the tool call ran after the timeout, through the
  normal permission flow that `--allow-tool 'shell(touch)'` approves. Copilot
  exited 0.
- The hook never reached its deny. When Copilot exited, 10.8 s after the hook
  started, neither the hook nor its `sleep 60` child was running, so the signal
  also reached the child. That a process-group SIGTERM came first and the failed
  `killpg` two seconds later was a follow-up kill of an already exited group is
  inferred from this one run.

## What this establishes

- No host cap below the configured value up to 250 s: a `preToolUse` deny written
  250 s after the hook started, within `timeoutSec: 260`, was awaited and applied.
- A host timeout is fail-open for `preToolUse`: the call continued into the
  normal permission flow and ran, as GitHub's reference states. This is why every
  dispatcher deadline has to expire before its `timeoutSec`.
- The host terminates a timed-out command hook with SIGTERM and reports the
  timeout about 2 s later.
- In native events `tool.execution_start` precedes the `preToolUse`
  `hook.start` (by 4 ms and 1 ms here), so it does not by itself show that a tool
  ran.

## Limits

- One run per case on one machine, in prompt mode only. Interactive mode,
  autopilot and ACP were not exercised.
- The probe used a repository hook. The Zensu dispatcher is registered as a
  plugin hook; GitHub's reference gives one timeout rule for every source, but
  the plugin registration was not exercised here.
- Run a and run b ran on different patch versions, 1.0.107 and 1.0.109.
- Not exercised: a hook that answers between 250 s and 260 s (the 10 s margin
  itself), `postToolUse` (also 260 s), the 90 s `sessionStart` and
  `userPromptTransformed` registrations, and a hook that ignores SIGTERM.
- The before/after comparison covers the regular Copilot home only. The 1.0.109
  download landed in Copilot's shared package cache outside it, as any normal
  launch would have done.
- Raw evidence (stdout JSONL, session events, debug logs, hook logs) is retained
  locally and is not part of this public changeset; `capture.json` records its
  SHA-256 digests. Session identifiers, account names and local paths are omitted.

## Files

- `capture.json`: redacted structured capture of both runs and the two setup
  attempts.
- `probe-hook.sh`, `setup.sh`, `run.sh`, `analyze.py`: the harness used. Copy the
  folder to a scratch directory first, because `setup.sh` creates the run folders
  next to itself. `run.sh <a|b> isolated` starts a live Copilot session and uses
  one premium request.
