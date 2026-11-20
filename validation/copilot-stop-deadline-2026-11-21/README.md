# Copilot CLI stop deadline — native capture, 2026-11-21

**Outcome:**

- **0.8.6 releases the slow stop.** When the stop checks run past the old 35 s
  budget, the released 0.8.6 build releases the `agentStop` with the
  "no completion was proven" notice. Copilot does not start another turn.
- **0.8.5 blocks it and loops.** The released 0.8.5 build blocks the same stop
  with "Internal hook deadline exceeded; workflow remains pending", and Copilot
  asks the model again after every block.

The three runs:

- **0.8.6, slow.** Every plugin hook Node start after the model's turn was delayed
  by 50 s. `agentStop` ran 66.3 s and returned `{}`. Its hook stderr carried the
  shared stop checker's notice: `zensu chain-enforcer: releasing agentStop — the
  agentStop checks did not finish within 45s and were stopped before reaching a
  decision, … no completion was proven, only the wait was bounded, and the next
  agentStop evaluates again.` Copilot made one model request and exited 0.
- **0.8.5, slow.** Same delay. The two stops ran 36.1 s and 35.6 s and each returned
  `{"decision":"block","reason":"Zensu Copilot runtime failed: Internal hook deadline exceeded; workflow remains pending"}`.
  Copilot added that reason as a new user message and requested the model again,
  twice. The probe stopped the run when the third model request arrived.
- **0.8.6, no delay (control).** `agentStop` ran 9.0 s and returned `{}`. Copilot
  made one model request and exited 0.

This is a native capture of the host. It used real Copilot CLI 1.0.109 processes
and their hook runner, with the released plugin bytes loaded through `--plugin-dir`.

The model is not real. A loopback OpenAI-compatible provider started by
[stop-probe.mjs](stop-probe.mjs) answers every request with a short text, so no
premium request was used. This is not a fixture test, and no test reads these
files.

## Setup

**Host:** macOS 26.7.2 on Apple silicon (`darwin-arm64`), Node v26.13.1, and
Copilot CLI 1.0.109 in prompt mode (`copilot -p … --output-format json`).

**Released bytes:** the assets of the GitHub releases `v0.8.6` (tag on `7c95dcf`)
and `v0.8.5`, checked against each release's `SHA256SUMS`:

| Release | Tarball SHA-256 | `build.json` SHA-256 |
| --- | --- | --- |
| 0.8.6 | `c7971a95bc3e0f650fc687efa63b1c17da22badfa1236a7debfb46554893e254` | `68356eea516ed70fe905565501e29fe1dfd9d480a0e4e36d770c53d6d029ebe5` |
| 0.8.5 | `30e2d629dd119c730810d5c747611ae57cc0e5ecffb698facdacaf2334b837c5` | `219de5868f1c2aea89896b1886620d444b06061dfc12269585f3de7b4b1288a0` |

Each tarball's `zensu/` tree was checked against its released `build.json`
inventory, before and after the runs: 286 files, none missing, none extra,
none different. The tree was read-only during the runs. Its native registration
gives `agentStop` 90 s in 0.8.6 and 45 s in 0.8.5.

**Offline model and isolation:** set up as in
[`copilot-patch-inputs-2026-11-20`](../copilot-patch-inputs-2026-11-20/README.md):

- Model and provider: `COPILOT_OFFLINE=true` with a loopback
  `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE=openai`,
  `COPILOT_PROVIDER_WIRE_API=completions` and `COPILOT_MODEL=gpt-5.4`. No
  authentication method succeeded, `gh auth token` was never called, and every
  run reported `premiumRequests: 0`.
- Isolation: every run had a new, empty `COPILOT_HOME`, a temporary `HOME`, and a
  `PATH` holding only `node`, `git` and the system directories.
  `COPILOT_PLUGIN_DIR_ONLY=true` and `COPILOT_AUTO_UPDATE=false` were set.
- Flags: `--no-auto-update --no-ask-user --disable-builtin-mcps --allow-all-tools
  --log-level debug`.
- Unchanged before and after every run: the regular Copilot home's settings,
  permission and MCP files, its installed Zensu plugin, its session-state count,
  `~/.zensu/config.json` and the listing of Copilot's package cache.

**Prompt:** `Reply with the single word done.` The provider answered every chat
request with `Probe complete.` and no tool call. The model's turn therefore
ended at once, and the next hook event was `agentStop`.

**Load:** other jobs were running on the machine. The 1-minute load average was
89, 103 and 126 at the start of the three runs.

## Injected delay

[slow-hooks.cjs](slow-hooks.cjs) is loaded into every Node process of a run
through `NODE_OPTIONS=--require <path>`, and reads its settings from
`STOP_PROBE_CONFIG`. It acts on a Node process when either is true:

- its script lies inside the plugin root, except `hooks/native/dispatcher.js`;
- it runs with `node -e`.

It logs such a start. After the provider has answered a model request, the
probe writes a `stop-phase` file. From then on, every such start first sleeps
`delayMs` with `Atomics.wait`, before any hook code runs. `delayMs` was 0 in the
control run and 50,000 in both slow runs. The dispatcher and Copilot's own Node
process were never delayed.

Delayed Node starts:

- slow-0.8.6: two delays, both `node -e`.
  1. The stop checker's first Node start, 1.0 s after `agentStop` began. The
     checker's own 45 s watchdog killed it.
  2. The Zen presentation hook's Node start. The dispatcher killed it at that
     hook's 20 s timeout.
- slow-0.8.5: ten delays, all `node -e`, across the two stops and the two
  injected prompts.

## Results

| Run | Plugin | Delay | Model requests (s after launch) | `agentStop` (s) | `agentStop` output | End |
| --- | --- | --- | --- | --- | --- | --- |
| control-0.8.6 | 0.8.6 | 0 | 1 (30.8) | 9.0 | `{}` | exit 0 after 42.6 s |
| slow-0.8.6 | 0.8.6 | 50 s | 1 (39.5) | 66.3 | `{}` and the release notice | exit 0 after 110.1 s |
| slow-0.8.5 | 0.8.5 | 50 s | 3 (70.2, 188.1, 308.1) | 36.1, 35.6 | `block`: Internal hook deadline exceeded | stopped by the probe at 309.3 s |

The slow 0.8.6 stop wrote three stderr lines. They arrived as one hook stderr
entry:

1. Bash's job notice that the checker's watchdog killed its worker. The shared
   checker prints this whenever the watchdog fires, so this line does not
   indicate a failure.
2. The shared checker's release notice. It names 45 s, the deadline the
   dispatcher hands the checker when `ZENSU_STOP_DEADLINE_SECONDS` is unset.
3. `Zensu Zen presentation unavailable at stop; workflow policy decisions are unchanged.`

The stop ended after 66.3 s, inside the 80 s dispatcher budget and the 90 s
registration. The output contains exactly one user message: the prompt.

In slow-0.8.5, both stops blocked once the dispatcher's 35 s budget had run out.
Copilot recorded the block reason as user messages 2 and 3, each followed by a
model request. The first stop is the same loop that the real-model run on
2026-11-20 showed with 0.8.4 under real machine load.

## Limits

- **Scripted model.** The model was scripted, so this shows how the host and
  the plugin handle the stop. It does not show how a real model reacts to the
  release notice.
- **Injected delay.** The slow stop checks came from the injected delay, not
  from real machine load.
- **Paths exercised.** The live run exercised the shared checker's release path.
  The dispatcher's own exhaustion path, where its budget runs out or a check is
  killed at its timeout, is covered only by `tests/copilot/stop-deadline.test.js`.
  `subagentStop` was not exercised.

## Files

- [stop-probe.mjs](stop-probe.mjs) runs one scenario:
  `node stop-probe.mjs <run-root> <name> <plugin-dir> <delay-ms> 3`. The last
  argument is the model request at which the probe stops a run.
- [slow-hooks.cjs](slow-hooks.cjs) is the injected delay.
- [summarize.mjs](summarize.mjs) builds [capture.json](capture.json) from the
  run directories, with local paths replaced by placeholders:
  `node summarize.mjs <run-root> control-0.8.6 slow-0.8.6 slow-0.8.5`.

Raw transcripts, provider request bodies, debug logs and session identifiers are
not included.
