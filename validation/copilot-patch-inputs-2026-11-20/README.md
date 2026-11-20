# Copilot CLI patch inputs — native capture, 2026-11-20

**Outcome: the per-operation policy input of PR #30 and its line-break rejection
hold in the real host.**

- A 95,019-byte `apply_patch` over five files (six normalized operations) is
  denied by the `main` build with `reviewer-capability-v1 deny: trusted hook
  payload is empty or too large`. With the PR #30 build it passes every Zensu
  policy and Copilot applies it.
- Copilot CLI 1.0.109's own `apply_patch` starts a new line at a lone CR: a
  probe header hidden behind a lone CR created a second file. It keeps U+2028 and
  U+2029 inside the line. PR #30 denies all three before any policy runs. For a
  lone CR that rejection matches a real host split; for U+2028 and U+2029 it is
  stricter than the host.

This is a native capture of the host: real Copilot CLI 1.0.109 processes, its
hook runner, the plugin loaded through `--plugin-dir`, and its own `apply_patch`
writing to disk. The model is not real. A loopback OpenAI-compatible provider
started by [probe.mjs](probe.mjs) answers every request with a scripted
`apply_patch` call, so the patch bytes are exact and no premium request was used.
It is not a fixture test, and no test reads these files.

## Setup

- macOS on Apple silicon (`darwin-arm64`), Node v26.13.1, Copilot CLI 1.0.109 in
  prompt mode: `copilot -p … --output-format json`.
- Offline model: `COPILOT_OFFLINE=true` with `COPILOT_PROVIDER_BASE_URL` set to the
  probe's loopback provider, `COPILOT_PROVIDER_TYPE=openai`,
  `COPILOT_PROVIDER_WIRE_API=completions` and `COPILOT_MODEL=gpt-5.4`. There was no
  GitHub authentication and no token, and every run reported `premiumRequests: 0`.
- For this model Copilot offers `apply_patch` as a custom freeform tool. Its Lark
  grammar ends every line with LF. The provider answers the first request with one
  custom tool call that carries the scripted patch, and every later request with
  a short text reply.
- Isolation: every run had a new, empty `COPILOT_HOME` and a temporary `HOME`. Its
  `PATH` held only `node`, `git` and the system directories, so no hook could
  reach the Zensu CLI. `COPILOT_PLUGIN_DIR_ONLY=true` and `COPILOT_AUTO_UPDATE=false`
  were set. These were identical before and after every run: the regular
  Copilot home's settings, permission and MCP files, its installed Zensu plugin,
  its session-state count, `~/.zensu/config.json` and the listing of Copilot's
  package cache.
- Plugins: `dist/zensu` built from PR #30 at `ade60a15` (rebased onto `main`
  `b430f044` and later squash-merged as `604e9aaa`) and from `main` at `b430f044`. Each build was frozen into a copy and
  passed with `--plugin-dir`. `ZENSU_COPILOT_CAPTURE_DIR` recorded every native
  hook payload.
- Flags: `--no-auto-update --no-ask-user --disable-builtin-mcps --allow-all-tools
  --log-level debug`. The provider issued exactly one tool call per run, so
  `--allow-all-tools` admitted nothing else.

## Multi-file patch

[make-scenarios.mjs](make-scenarios.mjs) builds one patch of 95,019 bytes:

- it adds `src/added.js` (32 KiB);
- it replaces 16 KiB of `src/updated.js`;
- it moves `src/moved.js` to `src/destination.js`;
- it deletes `src/deleted.js`;
- it adds `src/second.js` (32 KiB).

| Run | Plugin | Native result |
|---|---|---|
| `multi-main` | `main` `b430f044` | `Denied by preToolUse hook: reviewer-capability-v1 deny: trusted hook payload is empty or too large`, then the session-binding block; no file changed |
| `multi-pr30` | PR #30 `ade60a15` | `Added 3 file(s)`; the four written files match the patch byte for byte, and the moved and deleted sources are gone |

[replay.mjs](replay.mjs) fed the captured native `preToolUse` payload into each
build's packaged dispatcher with a recording spawn. In that payload the freeform
patch is a 95,019-byte string.

| Build | Operation inputs | Smallest | Largest | Over 1 MiB | Embeds the patch |
|---|---:|---:|---:|---:|---|
| `main` | 6 | 1,573,578 B | 1,636,853 B | 6 | yes |
| PR #30 | 6 | 734 B | 32,351 B | 0 | no |

## Lone CR, U+2028 and U+2029

In this probe patch, `<SEP>` stands for each of the three characters:

```text
*** Begin Patch
*** Add File: visible.txt
+line one<SEP>*** Add File: hidden.txt
+line two
*** End Patch
```

| Separator | Copilot without a plugin | PR #30 plugin | Operations `main`'s policies receive (replay) |
|---|---|---|---|
| lone CR | `Added 2 file(s)`: `visible.txt` holds `line one`, `hidden.txt` holds `line two` | denied: `Zensu could not safely interpret preToolUse: patch-ambiguous-line-break`; no file | one: `create visible.txt` |
| U+2028 | `Added 1 file(s)`: `visible.txt` keeps the separator and the header text in its first line | denied with the same reason; no file | one: `create visible.txt` |
| U+2029 | as for U+2028 | denied with the same reason; no file | one: `create visible.txt` |

Copilot's parser splits at a lone CR, while patch inspection on `main` splits only
at LF. For a lone CR, `main`'s per-file policies therefore see one file while
Copilot writes two, and the second file reaches no per-file policy. PR #30's
rejection closes that gap. For U+2028 and U+2029, the host and the inspection agree,
and the rejection only refuses patches that put those characters in file content.

## Files

- [capture.json](capture.json) is the redacted summary. Run directories are shown as
  `<project>`. It holds:
  - every run's tool result, written-file digests and small file contents;
  - the native hook events, the replay results;
  - SHA-256 digests of each run's raw `output.jsonl`, `stderr.txt` and `run.json`.
- [probe.mjs](probe.mjs), [make-scenarios.mjs](make-scenarios.mjs),
  [replay.mjs](replay.mjs) and [summarize.mjs](summarize.mjs) are the harness. The
  runs used the same scripts with `/opt/homebrew/bin` written in; the committed probe
  resolves `copilot` and `git` from `PATH`.
- The raw evidence stays local and is not committed: provider requests, debug logs,
  native hook payloads and session state.

## Not exercised

- A hosted model. Nobody tested whether a real model, under the grammar Copilot
  sends, emits a lone CR inside a patch line.
- Interactive mode, the `responses` wire API, Windows and other Copilot versions.
- A path that a policy protects. The probe only shows that the second file escapes
  per-file inspection; it did not exercise a policy that would have denied it.
