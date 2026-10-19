# Workflow fixes and repeated native validation

The original [live audit](../copilot-workflow-2026-10-19.md) remains unchanged.
Its thirteen findings are the scope of this follow-up. This directory separates
source inspection, blocked attempts, and the new Copilot run. A prepared harness
or a successful CLI exit is not evidence of a completed workflow.

The [per-finding resolution matrix](finding-resolution.json) keeps implementation,
deterministic validation and native observations separate. All thirteen corrections
and follow-up audit-scope repairs are implemented locally. The final frozen payload
passed the complete native workflow in fresh session
`0d27dc52-0d1a-4e86-8fb7-c40dd02b69d1`: implementation, five aspect reviewers,
primary and independent second judges, ticket-bound consume review, one terminal
self-review with a fix round, and valid chain closure. All mandatory checks in
the [final read-only analysis](final-native-analysis.json) pass. Copilot CLI
1.0.98 used the observed `gpt-6-luna` model without a model override and exited
0 at 20:46:06 UTC after 2,637 seconds. The first native run
[failed workflow validation despite app acceptance](first-run-observations.md).
The second was deliberately interrupted when the scope defect was confirmed.
Both frozen source/test checkpoints remain preserved in
[first-package-checkpoint.json](first-package-checkpoint.json) and
[second-package-checkpoint.json](second-package-checkpoint.json).

The [final observations](final-run-observations.json) preserve native call IDs,
hashes and limits. All four ACs and the full suite bind to the independently
checked final tree. The canonical receipt has 11 certified claims, with current
snapshots and a matching log/session/generation. The independent offline installed
consumer passed all 14 original assertions, including 200 seeded arithmetic
samples and the safe-integer boundary. Of two optional comparisons with the prior
implementation, one passed and the over-limit diagnostic wording differed; that
wording is outside the original four criteria. Frozen payload, marketplace
installation and monitored global configuration remained unchanged.

Ten original findings have positive native observations. WF-003 and WF-006 retain
deterministic coverage for negative branches not exercised by this final run.
WF-001's repeated prehook prefixes have ambiguous authorship and are unassessed;
ordinary native bindings succeeded. A genuinely authored protected export was
correctly blocked and recovered on the next turn. No gate bypass was observed.

The run recovered from 19 native path-permission denials, documented with
qualified causes in [permission evidence](permission-friction-proof.json).
The future harness now sets `PWD` consistently with its actual project cwd;
the [fake-CLI regression](harness-pwd-fixture.json) passed after the run exited.
This controller correction has not been claimed as a fourth native model run.
Three standalone audit attempts omitted the session operand; two printed clean
summaries, yet none updated the canonical receipt. Closure correctly refused it, then the
model recovered with its explicit bound session and current predicates. The
[clearer-diagnostic UX follow-up](omitted-session-audit-ux.md) is implemented for
0.2.1 after that run. Its release checks and focused native evidence are recorded
separately in [release validation](release-0.2.1-validation.json).

## Deterministic validation

The [package validation report](package-validation.json) records the completed
`npm run verify`: 485/485 Node tests and 6/6 marketplace tests passed. The package
check verified 1,015 immutable snapshot files, 272 owned package hashes and 128
runtime syntax checks. The [frozen inventory](frozen-package-inventory.json)
contains all 273 files including `build.json`; every owned source and copied
payload hash matched when recorded. The final frozen checkpoint build digest is
`b546f71883e6d0683bc036a4d4c9f1d5408938637d09ae9638add995acedd076`.
This historical checkpoint was local and uncommitted against
`fd627713dbaf4d11df03ed19e6fd531e0195e42e`. Its hashes and per-finding observations
remain the evidence for that run; the later release adds the audit UX correction.

[Source assertions](source-contract-checks.json) cover documentation contracts
separately from executable fixture tests. The secondary review found and repaired
packet size round-tripping, limited non-Git compatibility, harness child cleanup,
harness status reporting, cumulative audit scope, copied shell header recovery,
and final progress consistency. The independent [scope-fault recheck](audit-scope-independent-fixture.json)
is a deterministic shell fixture, separate from the live model runs. The harness cleanup proof is an explicitly
[fake-CLI fixture](harness-signal-fixture.json), with no model execution.

## Copilot retest

The [same four invoice criteria](invoice-retest-prompt.txt) use the exact original
baseline tree from commit `1f1d96a026b1f63f716518f185e4cb2119c94c10`. The test
starts in a new temporary Git repository and a fresh Copilot session. It requests
the configured full native review chain and follows its actual severity routing;
it does not require an extra reviewer panel after terminal self-review.

The [retest plan](retest-plan.json) names the required completion evidence. The
harness has separate prepare, freeze, and run actions:

```bash
python3 scripts/live-copilot-workflow-retest.py prepare
# After the patched build and package checks have passed:
python3 scripts/live-copilot-workflow-retest.py freeze --run-dir <printed-directory>
# This action starts the real model run:
python3 scripts/live-copilot-workflow-retest.py run --run-dir <printed-directory>
```

Freeze rejects a distribution whose build inventory differs from current owned
sources, copies it byte-for-byte, records every payload hash, and makes the copy
read-only. Native `plugin list --json` must then show exactly one enabled plugin:
the external Zensu copy. The run retains normal authentication and model settings.
It records JSONL events, native hook captures, session identity, the exact command,
payload hashes, and monitored global/marketplace integrity before and after.

After observed native chain completion, run `python3 <run-directory>/validate-independent.py`
to pack the final project, install only its own tarball offline into a fresh
consumer, and run the preserved independent assertions. These include 200 seeded
exact-arithmetic samples and the maximum-safe-integer boundary. The original
four-criterion checks are labeled separately from the prior implementation's two
one-MiB input-limit checks; those two are regression comparisons, not additional
requirements silently added to the original specification. This check does not
launch a model, rewrite project source, or substitute for native review evidence.

After that owned process has exited, preserve its exact referenced native records:

```bash
python3 validation/copilot-workflow-fixes-2026-10-19/capture-native-evidence.py \
  --run-dir <run-directory> --session-id <exact-main-session-id>
```

This controller reads only helper-referenced IDs in that main session's captured
Copilot plugin-data directory and copies their records and full/acceptance logs
with a source-path/hash manifest. It never lists another session. The analyzer
then verifies the latest full suite and all four AC records against their native
references, captured logs and independently checked current tree. Required gates,
the full review panel and the native bypass ledger are checked separately.

Analyze a captured run without invoking its model or workflow helpers:

```bash
python3 scripts/analyze-native-workflow.py \
  --run-dir <run-directory> --session-id <exact-main-session-id>
```

Repeat both flags in the same order to compare independent runs. The analyzer
reads only the named run directories, with bounded read-only Git inventory commands
for the plain invoice project, and reports packet digests, native worker
completion, ordering, bound closure, original and managed progress rows, the four
AC records, independent installed-package checks and recorded global integrity.
Exit 0 requires every mandatory check to pass; exit 1 reports a failure or invalid
evidence; exit 2 means evidence is incomplete. A zero Copilot exit alone never
proves a completed workflow. Failed or superseded runs keep their own identities
and frozen build hashes. Unexercised negative branches remain explicitly separate
from passed native observations. Pre-hook context-prefix replay candidates are
unassessed because a host retry can echo rewritten arguments; execution-start
prefixes injected by the hook are expected.

The final scoped edit-landing receipt must match the exact session, generation,
append-only log prefix, certified claims and current file snapshots. Raw Git blob
hashes, executable modes and the current file inventory are checked independently
without `git add`, `write-tree`, workflow helpers or state changes. Attributes,
submodules, linked metadata and nested claim roots remain unassessed. A repeated
audit may omit an earlier flag when its certified scope demonstrably retains the
pending dirty paths; a clean boolean alone does not establish that preservation.

`PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-native-workflow-analyzer.py`
runs 29 deterministic analyzer safety and false-positive fixtures. These fixtures
contain no model execution and cannot establish live workflow acceptance.

The process uses `--plugin-dir` with `COPILOT_PLUGIN_DIR_ONLY=true`. GitHub
documents this as an ephemeral way to select a deterministic plugin set. Two
copies at different cache paths can otherwise both contribute hooks even when
they have the same plugin name. Local Copilot CLI 1.0.98 confirmed the installed
copy is disabled only for this process and the explicit copy is enabled.
See [GitHub's plugin directory guide](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/plugin-directories)
and [plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference).
No marketplace install, uninstall, enable, disable, or global configuration write
is part of the harness. `COPILOT_AUTO_UPDATE=false` and `--no-auto-update` suppress
automatic updates for this invocation.

## Other hosts: inspection and blocked validation

The [cross-host matrix](cross-host-matrix.json) records all thirteen findings
against the sibling repositories, with exact source paths and line numbers,
repository heads, ownership rules, and limits. Those repositories were inspected
without edits. Their source findings are not represented as live failures.

| Surface | Observation | Evidence |
| --- | --- | --- |
| Antigravity 1.4.2 / Zensu 0.2.0 | The same invoice task reached native plugin startup, then the host rejected the first model turn because its individual quota was exhausted. Zero model tokens, no implementation or review; exit 3. | [Attempt report](antigravity-live-attempt.json), [installed payload hashes](antigravity-installed-plugin.json) |
| Codex 0.157.1 / installed Zensu 0.3.2 | No model run launched. Installed startup rewrites a shared plugin-root selector, and its legacy session resolver can fall back to foreign transcripts. That conflicts with this test's unchanged-global-state and no-Claude-access boundaries. | [Installed preflight](codex-installed-preflight.json) |
| Kiro 2.32.0 | Host-side `whoami --format json` returned exit 1 and `{"account":null}`. No authenticated workflow could start. | [Cross-host matrix](cross-host-matrix.json) |
| Standalone Zensu CLI 0.9.0 | Typed REST client; it does not implement the plugins' local coding, review, or acceptance-evidence engine. The invoice workflow is not a CLI backend operation. | [Cross-host matrix](cross-host-matrix.json) |
| Claude source checkout | All thirteen shared causes were inspected read-only at the recorded source HEAD. Existing files and untracked artifacts were preserved; no Claude process or model session was started. | [Current-source audit](claude-source-audit.json) |

Antigravity already splits its verification skill into bounded files. Its
current review instructions also omit the old land-or-withdraw shortcut. Other
shared causes remain visible in its source. Codex and Kiro have older workflow
surfaces, so absent judges or acceptance recorders are classified as not
applicable rather than silently counted as repaired. The installed Codex payload
differs from the sibling checkout; those two provenance levels remain separate.

Raw Antigravity evidence is retained at
`/private/tmp/zensu-cross-host-agy-10h2m6qs/`. The Codex preflight source is retained
at `/private/tmp/zensu-codex-installed-preflight-kkqr59js/`. The current Claude
[source checkout audit](claude-source-audit.json) is authorized read-only and
recorded separately from the immutable upstream snapshot. No Claude configuration,
sessions, installed plugins, credentials or live process were accessed. Existing
Claude and CLI checkout artifacts were preserved.

The [source-repository postcheck](other-repositories-postcheck.json) compared all
five sibling HEADs and exact Git status lists with the recorded preflight at
20:50:11 UTC. All matched, including the preexisting CLI and Claude changes.
This establishes no observed checkout-status change; it does not claim a
byte-for-byte comparison of preexisting modified or untracked contents.

The [isolated shared-cause fixture](shared-audit-context-fixture.json) also executes
byte-identical copies of the Claude and Antigravity edit-landing helpers against
the same dirty-before omission and synthetic Git-fault cases used for Copilot.
Both retain the defect: a pending claim becomes clean after an omitted-context
retry; a Git fault removes the prior receipt and the following retry becomes
clean. The fixed Copilot control, copied with all 81 hook-library dependencies
from the final frozen payload, preserves the pending scope in the identical
scenarios. Each fixture uses a fresh Git project and an allowlisted environment with
temporary HOME, configuration and session paths. No host/model is launched and
the sibling sources are unchanged. This deterministic reproduction is separate
from native invoice workflow validation. The older helpers do not support the
new predicate option, so that additional branch is explicitly not comparable.
All three controls use explicit receipts without a session operand; active
binding is separately covered by the 19 Copilot scope tests and the native run.
