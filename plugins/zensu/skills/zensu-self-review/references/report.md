### Final report

Render a CHAIN-END SUMMARY as TABLES, not prose: every section below is a table
plus at most one line of text, never a paragraph — the sole exception is
`## Open`, which ends with the bypass-ledger line followed, when it applies, by the
converge offer. Keep it scannable — no restating, no narration of the process, no
filler.

Mark every status and verdict cell with a leading marker: 🟢 good (passed, clean, done, met), 🟡 attention (partial, advisory, skipped, not measured), 🔴 bad (failed, must-fix, dropped, contradicted, blocked, not landed, unverified, unresolved predicate, verification degraded, a gate bypassed), ⚪ not applicable — admissible ONLY where the source of the value itself says the item does not apply, which today means exactly one case: a requirement row the plan already marks deprecated. An outcome that was merely not run is 🟡, never ⚪. The marker PREFIXES the cell value and NEVER replaces it: every verbatim literal keeps its own words unchanged after its marker, subject only to the pipe-escaping rule below, which the renderer undoes so the reader still sees the original text. A marker never stands alone and is never separated from the words it marks by a line break. The ## Open table has no status or verdict column and takes no marker.

Sections IN THIS ORDER, the TL;DR LAST (pull from your own context; do
NOT re-spawn any agent):

```
## Problem
Exactly ONE sentence: the feature, bug, or need this session addressed.

## What I built
Table, columns: # | Deliverable | Status | Link. One row per deliverable, max 15
words per cell, Status is 🟢 done / 🟢 merged / 🟢 built-tested / 🔴 blocked, Link
is a PR URL or `—`.

Then a second table, columns: Check | Verdict, with exactly these rows — Feature,
Files modified, Tests created, Full suite, Acceptance, Build, Coverage, native file editing landing,
Finding verification, Gates bypassed, Plan, Log. (The delegate renderer also
carries `Mtime audit` after `native file editing landing`; every other row and their order are
shared.) Verdict cells are values, not
sentences. Mark a cell when its value is a STATE; leave it unmarked when the value
is a title, a path, or a bare count with no target — that is Feature, Files
modified, Plan and Log, and every other row above is marked. A count measured
AGAINST a target IS a state, so `{N}/{M} GREEN` and `{N}/{M} files >= {threshold}`
take 🟢 when the target was met, 🔴 when it was not, 🟡 when the run was skipped.
**Gates bypassed** takes 🟢 ONLY for the literal `none` read from a valid document
and 🔴 for anything else, including a named escape, the `UNREADABLE — …` form and
any wording this renderer does not recognize; it repeats the
`## Open` bypass-ledger line rather than replacing it. Run the `--bypass-list`
command from `## Open` ONCE before rendering this table and feed its output to
both places — never substitute `none` for a value you did not read. **Finding verification**
carries the `FINDING VERIFICATION — {n} verified, …` line and any
`FINDING VERIFICATION DEGRADED — <reason>` line verbatim, 🔴 when a DEGRADED
line is present or the unsupported or phantom count is non-zero (an
off-changeset finding is not by itself a defect), 🟡 not run
(hooks.findingVerification disabled) when the gate was skipped and emitted no
line at all, and 🟢 only when the gate RAN and neither condition holds —
never ⚪. Two further rows carry text VERBATIM and
must never be dropped, paraphrased, or shortened: **native file editing landing** takes the step 5b
terminal summary line plus any `EDIT NOT LANDED` line and the `UNVERIFIED (no claims logged)`
or unresolved `PENDING PREDICATE` close (those are NOT clean states, and both
take 🔴, never 🟡) — a claimed edit
that never produced a change must not vanish between the Phase 6 report and this
summary; **Full suite** takes the `FULL SUITE — …` lines `--chain-done` printed
(Phase 4 finalize step 2): 🟢 only for `pass`; 🟡 for `pass-tree-unverified`,
`deferred-ci`, `not-applicable`, `not checked` and an advisory `missing`; 🔴 for every other
state, advisory or not, including `escaped`. Both verbatim cells follow the `## Open` escaping rule
(`\` first, then `|`), for the same reason: an unescaped pipe splits the row and
the renderer drops the cells past the last column. **Acceptance** carries text VERBATIM
under the same rule: the `ACCEPTANCE — …` lines `--chain-done` printed (Phase 4 finalize
step 2), 🟢 only for `pass`; 🟡 for `pass-tree-unverified`, `not-applicable`,
`not-checked` and an advisory `incomplete` that lists only missing criteria; 🔴 for
every other state, advisory or not, including `escaped`.

When the session plan carries a ## Requirements table, add a third table, columns:
ID | Status, keyed by its stable IDs (AC-###/FR-###: 🟢 met / 🟡 partial /
🔴 contradicted / 🔴 dropped / ⚪ deprecated). ⚪ is bound to PROVENANCE, never to
judgement: use it only when that requirement row in the plan already carries
that status. A requirement this session did not implement is 🔴 dropped even if it
was retired mid-session. One row per requirement, no commentary. When the plan
carries NO `## Requirements` table, omit the table and write the single line
`🟡 Requirements: no ## Requirements table in the session plan — per-requirement
status not tracked`, so an untracked chain never reads like a fully met one.

## How I built it
Exactly ONE line: the TDD discipline followed, the final zensu:code-reviewer verdict
(PASS / suggestions-only / max-rounds reached), findings by severity, files reviewed.

Then a table, columns: Round | Findings | Fixed | Result. One row per code-review
round 1..N including rounds that fixed nothing; a round with ZERO findings reads
🟢 `PASS — 0 findings, nothing to fix`, and a round that had findings never claims
that literal. Mark each Result 🟢 for a clean round AND for
an ordinary round whose findings were all fixed and re-verified, 🟡 for a max-rounds
convergence that left findings open AND for a round whose findings were deliberately
deferred as suggestions rather than fixed, 🔴 for a round whose fixes did not
land. Always include the final clean verification
round. Skip this section only if no review round ran at all.

## Self-Review Summary
Table, columns: Dimension | Verdict | Note. One row per reviewed dimension
(architecture, consistency, edge-cases, test coverage, security, simplification,
conventions), Verdict is 🟢 clean / 🟡 advisory / 🔴 must-fix, Note max 12 words. Close with
ONE line: whether the single fix round ran and what it changed, and, when the findings
ledger yielded candidates, how many of them this stage fixed without a re-review.

## Open
Table, columns: Item | Type | Next step. One row per deferred suggestion or
max-rounds finding requiring a manual fix, one row per open findings-ledger entry
(state `deferred`, `parked` or `routed-unfixed`, under the id the ledger lists, a
`G<g>:` prefix included) when `hooks.reviewConvergence` is enabled and
`review-ledger-v1.js --report` answers `status=ok` or `status=partial` — never a
second row for an id already listed — plus the `FINDINGS LEDGER PARTIAL` or
`FINDINGS LEDGER UNAVAILABLE` row the must-fix step names, one row per `FULL SUITE COMMAND MISMATCH`
or `FULL SUITE UNRESOLVED` line, and one row per advisory `FULL SUITE —` line that
did not pass, carrying that line verbatim under this escaping rule, applied in this order: first write every `\`
as `\\`, then every `|` as `\|`. An unescaped pipe splits the row and the
renderer drops the cells past the third, the very verdict clause the row
exists to surface; the other order turns an already-escaped `\|`
inside a shell command back into a delimiter. The same rule applies to every
carried line in this report — the `Full suite`, `Acceptance` and `native file editing landing`
verdict cells in `## What I built`. Add one row per advisory `ACCEPTANCE —` line that did
not pass and one per `EXTERNAL REVIEW DEGRADED — …` line, each verbatim under the same rule.
native file creation the single line `Nothing open.` only when that table has
no rows at all, because a carried line is always a row.

Always render the bypass-ledger audit line next, in both cases — whether or not
the table has rows: run
`COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh" --bypass-list` and render its output as
`Gates bypassed during this session: <output>`. The verb echoes `none` only when
it read a valid workflow document that recorded no escape; that is the ONLY
spelling that may claim a clean ledger. On exit 3 it prints an `UNREADABLE — …`
line on stdout, and that line is carried verbatim under the same ordered `\` then
`|` escaping rule as every other carried line. On any OTHER non-zero exit —
notably exit 2, session identity unavailable — stdout is EMPTY and the diagnosis
went to stderr; render `UNREADABLE — <the stderr line>` there, never an empty
value and never `none`. Never substitute `none` for a value you did not read: an
unread ledger is not a clean ledger.

This line covers the surfaces this stage renders. It is NOT a session-wide
guarantee. The authoritative residual list is the "What the ledger does and does
not prove" paragraph in `docs/configuration.md`; do not restate it here. The one
residual that matters for THIS line: a workflow document that is edited but still
schema-valid renders `none`, because validation is structural and the `bypasses`
array carries no authenticity signal. Do not describe the ledger as proof that no
gate was escaped — it is proof only of what a readable document recorded.

Then, for a STANDALONE handoff only, when the session plan carries a
`## Requirements` table, close `## Open` with ONE more line, exactly:
`Optional next step: /zensu-converge — flow-back audit of the code against the plan's Requirements table.`
It is an offer only — never run it unasked — and it never gates, delays, or
precedes the `--chain-done` terminus, which already landed before this report
renders. Omit the line entirely for an Autopilot-bound handoff:
`/zensu-autopilot` runs converge report-only at its own step 2b and that run is
non-interactive. Omit it too when the session plan carries no `## Requirements`
table, because converge would have nothing to anchor on.

## TL;DR
Exactly ONE sentence, and it is the last section: what shipped and the test verdict.
```

