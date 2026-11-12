# Copilot TDD edit gate: one native process per invocation

## Change

The `edit`/`create` TDD gate (`hooks/pre-edit-tdd-reminder.sh`) runs once per
normalized file operation, so its cost multiplies with patch size. On `main`
(c027277) one invocation started 9 to 15 short-lived `node` processes: the
principal check, the hook-session binder, three payload-field parsers, the
session-key derivation, the bound-project validation, up to six separate
workflow-state reads that each loaded `session-control-core-v1.js`, the path
classifier and the deny renderer, plus `bash`, `uname`, `tr`, `basename`,
`stat`, `head`, `sed` and `grep` forks.

On macOS and Linux the hook now reads the payload once and runs
`hooks/lib/tdd-edit-gate-v1.js`, which performs every check of the shell gate in
order inside one process and reads the workflow state once. Bind failures and
bound-project validation failures still render through the existing bash deny
emitters. Git Bash on Windows and unrecognized platforms run the previous shell
implementation, moved unchanged apart from its root derivation to
`hooks/lib/zensu-tdd-edit-gate.sh`. Calls made with `ZENSU_TDD_GATE=off` go to
that shell implementation before any `node` process starts, and the native
process hands the decision to it for inputs whose shell meaning depends on the
locale or the installed tools. It does the same for every call while
`hooks/lib/zensu-host-path.sh` is missing or one of the tools that implementation
runs (`uname`, `basename`, `tr`, `stat`, `head`, `sed`, `grep`) is not on `PATH`.

## Decision parity

`tests/copilot/tdd-edit-gate.test.js` runs the shell implementation and the new
hook on shared fixtures and compares exit status and stdout byte for byte across
strict, vanilla and unarmed sessions: every FSM phase, state-file and `.zensu`
path classes, relative, drive, UNC, uppercase and traversal spellings, captured
trailing newlines, NUL bytes and lone surrogates, a doubled byte-order mark, a
step id that bash's `echo` reads as an option, missing, corrupt and symlinked
state files, non-main principals, invalid payloads, bind failures, a missing
`node`, a missing `zensu-host-path.sh`, `uname` or `tr`, the hook's branch for
unrecognized platforms and, where one is
installed, a non-UTF-8 multibyte locale. It also compares `ZENSU_HOOK_LOG` lines
and the bypass ledger, checks the test-path rules against `tdd_is_test_path` over
names, case, file headers and links, checks the capture rules against bash
command substitution, and asserts exactly one `node` start per invocation.
`tests/copilot/native-policy.test.js` keeps its once-per-invocation and
fail-closed project-validation assertions for the gate.

## Measurement

Method: a scratch harness (not part of the package) created one fresh fixture per
scenario and package — temporary project with `git init`, private plugin data,
`sessionStart` through `copilot-session-control-v1.js`, then `zensu-log.sh
--tdd-begin` for vanilla and `--tdd-begin --tdd-mode strict` for strict — and
invoked `bash <package>/hooks/pre-edit-tdd-reminder.sh` with one `edit` payload,
alternating the baseline package (built from c027277) and the new package (built
from this change) on every run. `node` starts were counted with a
`NODE_OPTIONS=--require` counter in a separate pass, followed by one untimed
warm-up run per package. The dispatcher figures ran
`node <package>/hooks/native/dispatcher.js preToolUse` with a five-file
`apply_patch`, which the dispatcher splits into five `edit` operations and runs
the five matching policies on each: three `edit|create` policies, this gate
among them, and two `.*` policies.

These are local fixture measurements on one 16-core macOS machine under the
stated load. They are not a live Copilot CLI run, and the shell implementation
on Git Bash for Windows was not exercised.

Machine: Apple M3 Max, 16 cores, macOS 26.7.2, Node.js v26.9.0, `/bin/bash`
3.2.57. The 1-minute load average was sampled before every run pair.

The tables were measured before the last review fix, which adds the check that
`hooks/lib/zensu-host-path.sh` and the seven tools listed above are present.
Timed in process on the same machine with a 30-entry `PATH`, the first call of
that check, the one each gate invocation pays, took 0.5 to 1.4 ms in three runs
at a 1-minute load average of 12. The tables were not re-measured for it.

### One gate invocation

Eleven interleaved runs per package and scenario, in milliseconds. p90 is the
nearest-rank value, the tenth of eleven samples. Both packages returned the same
decision, compared as the permission and the first 48 characters of the reason,
on every run; the harness aborts when a decision changes between runs. Byte
equality of the decisions is what the parity suite asserts.

| Scenario | Decision | `node` starts before → after | Median before | Median after | p90 before | p90 after | Load |
|---|---|---|---|---|---|---|---|
| Unarmed session | allow | 9 → 1 | 913 | 139 | 980 | 171 | 5–6 |
| Vanilla chain armed | allow | 11 → 1 | 1066 | 130 | 1103 | 137 | 6–8 |
| Strict, no phase declared | deny (phase) | 15 → 1 | 1709 | 141 | 1843 | 147 | 7 |
| Strict, `RED_WRITE` declared | allow | 14 → 1 | 1710 | 145 | 1801 | 199 | 7–10 |
| Strict, edit of `.zensu/state/x.json` | deny (state file) | 11 → 1 | 1110 | 140 | 1259 | 150 | 11 |

The median falls by 774 to 1568 ms per invocation, a factor of 6.6 to 12.1.

### Packaged dispatcher, five-file `apply_patch`

Five interleaved runs per package and scenario, in milliseconds, for one
`preToolUse` dispatch that runs the five matching policies for each of the five
files. With five samples the maximum is reported instead of a p90.

| Scenario | Dispatcher result | Median before | Median after | Max before | Max after | Load |
|---|---|---|---|---|---|---|
| Unarmed session | allow | 7596 | 3332 | 8322 | 3843 | 9–11 |
| Vanilla chain armed | allow | 7849 | 3159 | 8118 | 3292 | 7–9 |
| Strict, no phase declared | deny (phase) | 10258 | 3207 | 10892 | 3273 | 5–6 |

The five-file dispatch is 56 to 69 percent faster. Of the remaining 3.2 to 3.3
seconds, the five gate invocations account for about 0.7 seconds at the
single-invocation medians above; the rest is the other four policies and the
dispatcher itself, which this change does not touch.
