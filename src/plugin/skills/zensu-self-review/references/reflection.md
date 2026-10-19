## Phase 1: List Changed Files

List every file you changed or created in this session from context, then cross-check with
the same canonical enumerator used by review packets. Resolve the bound root with
`PROJECT_ROOT="$(COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "$ROOT/hooks/lib/zensu-log.sh" --project-root)"`
and require a nonempty existing root. Set `TOP="$PROJECT_ROOT"` for the project-scoped
configuration and ledger commands below. Run
`node "$ROOT/hooks/lib/review-packet-v1.js" changes --root "$PROJECT_ROOT"`
with `--baseline "$BASELINE_SHA"` only when that exact session-baseline SHA was captured.
The helper unions tracked, staged, untracked and baseline-to-HEAD changes, handles an unborn
HEAD and omits workflow artifacts. Its `changed_files` array is authoritative enumeration,
not an edit-landing verdict; audit step 5b(b) is the receipt summary, not an enumeration recipe.
A helper failure remains a blocker; do not fall back to a bare diff. If the union is empty
while context names session changes committed mid-run without a surviving baseline, review
those known files and disclose that limitation instead of claiming no changes.

If there are NO changes this session, close only the verified generation. For a
standalone handoff run
`COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh" --chain-done --claimed-review-ticket "<review-ticket>"`.
For an Autopilot-bound handoff run
`COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh" --chain-done --autopilot-run "$RUN_ID" --autopilot-attempt "$ATTEMPT" --chain-id "$CHAIN_ID" --claimed-review-ticket "<review-ticket>" --outcome no-changes`.
State "No changes — self-review skipped" only after the command succeeds. This
branch is a chain terminus and carries the same disclosure duty as the Final
report, so before stopping also run the `--bypass-list` command from the `## Open`
section in [report.md](report.md), and render its output as
`Gates bypassed during this session: <output>`, under the same rules stated
there. A gate escape needs no file change to be recorded — `ZENSU_MCP_GATE` is
reachable without one — so a zero-change chain is
exactly where an undisclosed escape would otherwise hide. Then stop. Every command uses Copilot's natively rendered `COPILOT_PLUGIN_ROOT`
directly inside a quoted shell parameter; never paste its value into shell source.

## Phase 2: Analyze

view the current content of each changed file with the view tool. view the project
root `AGENTS.md` so you apply the governing conventions. Score each change on:

- **Architecture**: does the approach fit the existing structure? Are better patterns available?
- **Consistency**: does the code follow the patterns used elsewhere in the codebase?
- **Edge-cases**: missing boundary conditions, error handling, or validation?
- **Test coverage**: are the tests sufficient? Are scenarios missing?
- **Security**: potential vulnerabilities (injection, missing auth checks, secret leakage)?
- **Simplification**: unnecessary complexity that could be reduced?
- **Conventions**: are the AGENTS.md rules honored (language, comments, watermarks)?

## Phase 3: Report

Structure the reflection as:

- **Positive**: what was solved well.
- **Improvements**: concrete suggestions with `file:line` references.
- **Risks**: potential problems that were overlooked.

Be honest and direct. If everything looks good, say so briefly. Do not invent
problems where none exist.

Classify each finding: a **must-fix** is a Risk that would ship a defect — a real
bug, a security hole, or a broken convention the gate would reject. Everything else
is advisory and is buffered into the final report, not fixed here.
A CRITICAL finding from a re-review is a must-fix only when its FINDING REPRODUCTION line reads REPRODUCED,
whenever the chain logged one for it; NOT-REPRODUCED and NOT-TESTABLE findings go to `## Open`.

The review chain may have deferred findings instead of re-reviewing them, but only while
`hooks.reviewConvergence` is enabled: resolve it against the `TOP` from Phase 1, because this
bash carries no `COPILOT_PROJECT_DIR` and would otherwise skip the project config the review
hook reads, with
`ZENSU_ROOT="${COPILOT_PLUGIN_ROOT}" COPILOT_PROJECT_DIR="$TOP" bash -c 'source "$ZENSU_ROOT/hooks/lib/zensu-config.sh"; zensu_hook_enabled reviewConvergence && echo on || echo off'`,
and on `off` skip this paragraph and add no ledger rows to `## Open`. On `on`, run
`node "${COPILOT_PLUGIN_ROOT}/hooks/lib/review-ledger-v1.js" --report --log <run-log> --root "$TOP"`
over the run log of the `/zensu-tdd` chain this stage closes: the log that chain has been
writing to in this session, never a log resolved by recency. When that path is not known in
this session, skip the ledger. On `status=ok` or `status=partial`, every entry in state
`routed-unfixed` or `parked`, and every `deferred` entry rated IMPORTANT or CRITICAL, is a candidate;
an entry carried from an earlier generation keeps its `G<g>:` prefix in every use.
Before a candidate becomes a must-fix, `view` its cited region with native `view_range: [max(1, line − 10), max(1, line − 10) + 24]` and keep it only when that code still shows what its summary describes; an
entry the region no longer supports, or one whose anchor is `-`, goes to `## Open` with that
reason. A `parked` or `routed-unfixed` candidate the region still supports is a must-fix,
whatever the must-fix bar above says: fix it in the one fix round in [fix-round.md](fix-round.md), and keep it in
`## Open` only for a named blocker — the one fix round already spent, or a fix that needs a
product decision. Fix every other must-fix the same way, or keep it in `## Open` with the
reason it stays open. After a fix lands, append the same `FINDING LEDGER` line, with its id
exactly as listed and the state `fixed`, through
`COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh" append --log <run-log> --message-stdin`
fed by a heredoc whose delimiter is quoted, never through `--message`, so no finding text is
shell-expanded and the report no longer lists it as open. When the log's secret scan refuses
such a line, rewrite its summary without the value; never resend it with the
`zensu-secret-allow` marker or `ZENSU_SECRET_SCAN=off`. `status=partial` also adds the
`## Open` row `FINDINGS LEDGER PARTIAL — <reason>`; `status=degraded` adds no candidates and
the row `FINDINGS LEDGER UNAVAILABLE — <reason>`.

**Acceptance re-verification** (standalone handoffs only; an Autopilot-bound chain is not
gated here, and its terminus line says whether its VALIDATE stage runs). Before you settle the
must-fix list, run
`COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh" --acceptance-status --log <run-log>`
over the run log named in the paragraph above. Exit 0 means every active `AC-###`
criterion has a `pass` on the current tree. Otherwise follow the remedy its summary line
names, never the exit code alone. A `run:` segment means invoke `/zensu-verify-feature` with
`--chain --log <run-log>` (read `{plugin_root}/skills/zensu-verify-feature/SKILL.md` with native view and execute it in this main thread with the stated input), which drives only the
criteria that are `missing`, `stale` or `partial`. A `fix:` segment means a criterion fails
on this tree: it is a must-fix candidate for the one fix round in [fix-round.md](fix-round.md), exactly like a `parked`
ledger entry, and so is a criterion that verification returns as `fail` or `partial`. An
`add:` or `restore:` segment, or a summary with no remedy (`unresolved`, `unavailable`), is
not yours to verify away: carry it into the report and leave it to the user. A fix round that
edits anything makes every record stale, so refresh this evidence once after that fix within this same invocation.
Never drive a criterion again while it already has a `fail` on the current tree and nothing
was edited since. When the run-log path is not known in this session, skip this read: the
terminus refuses with the remedy.

