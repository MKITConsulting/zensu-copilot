## Chain mode (`--chain`)

`/zensu-tdd` Phase 6 step 6d and `/zensu-self-review` invoke this skill with
`--chain --log <run log>`, so that every acceptance criterion of the running chain is
verified live before the chain can close. Everything above still binds. Chain mode changes
only these points:

1. **Scope is the plan, complete and bounded.** Run
   `COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh" --acceptance-status --log <run log>`.
   It lists every active `AC-###` criterion of the chain's plan with its state on the current
   tree, and its summary line names the remedy for what does not pass. Verify every criterion
   that is `missing`, `stale` or `partial`, and every criterion after an `invalid` summary. Skip
   one that already passes on this tree, and never re-drive one that fails on this tree: it needs
   a code change first. `FR-###` rows and deprecated criteria are out of scope. The list is the
   complete feature boundary: build one or more P0 rows per criterion and no other rows.
2. **Local only.** Refuse `--mode=remote`, because a deployed URL runs other code than this
   tree and every record binds to this tree. `--attach` is allowed, but when Phase 2 cannot
   prove that the attached process serves this worktree, each verdict it yields is at most
   `partial`.
3. **Use the cheapest driver that can observe the criterion,** named as in
   `rules/drivers.md`: `browser` through this skill's `playwright-cli` flow; `mobile` and
   `desktop` through their own rule files; and `api`, `cli`, `async`, `iac`, `custom` or
   `library` as one shell check that exits 0 exactly when the criterion holds. Pass the same
   id to `--driver` when you record the criterion.
   The credential-blind rules above bind every driver: never the
   autopilot `storageState` login, and never a secret in a command or in the evidence. An
   exit-code check reaches only an unauthenticated, synthetic local process or loopback target.
   Suppress raw application/network output before the evidence runner receives it: the runner
   prints its captured output tail to you. Controlled synthetic checks may instead emit the
   bounded allowlisted assertion diagnostics in `rules/acceptance-evidence.md`; read that rule
   before preparing the check. A criterion that needs a token file, ambient credentials or a
   non-loopback host is `partial`. This exception never permits real credentials, raw logs,
   response bodies or arbitrary exception text to reach the runner.
4. **The plugin observes every exit-code check.** Run the check through
   `COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh" --evidence-run --scope acceptance --cmd '<check>' --log <run log>`
   and cite the `record=er1_…` id of its summary line. The check must leave the working tree
   unchanged, tracked and untracked non-ignored files alike, so it writes any output outside the
   project or to a gitignored path: a run that changed the tree cannot back a verdict. A Maestro
   flow runs the same way.
5. **Record each criterion right after you observe it,** never batched at the end. One observed
   acceptance run may prove several criteria: map each AC to actual assertions in the matrix,
   run the shared suite once, then immediately record each covered AC separately with that same
   `er1_…` reference and criterion-specific observations. Follow the freshness, coverage and
   mixed-failure rules in `rules/acceptance-evidence.md`; a shared run is not a blanket pass:

   ```bash
   COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh" --acceptance-record --ac AC-001 --verdict pass --driver browser --log <run log> <<'EVIDENCE'
   What was exercised and what was observed, in one or two sentences.
   EVIDENCE
   ```

   Add `--evidence-run <er1 id>` for an observed check; its exit code must agree with the
   verdict. The evidence names the observation in English, whatever language this conversation
   is in, because it lands in the run log. It never carries a credential, a raw console line,
   personal data, or a page value the Phase 5 rules would redact. It never names the browser
   CLI or the `zensu-verify-…` session, because the browser consent gate refuses such a call;
   name the route or page and what it showed. `pass` needs the proof the Phase 5 PASS rule
   demands for that criterion: for an observed driver the cited exit-0 run is that proof, and the
   DOM/data-and-visual rule binds the UI drivers. Anything not proven is `partial` with the
   reason, and `partial` blocks the chain exactly like `fail`.
6. **Never end the turn to wait.** When a manual login or a consent prompt is needed, ask with
   `the available user-question channel` whether the user has finished it, then continue in the same turn. A
   criterion the user cannot unblock now is `partial`.
7. **Boot on the same loopback origin** as an earlier pass of this chain. Consent is remembered
   per origin, so the same port asks nothing twice.
8. **Report** in the Phase 5 format and name the criterion id first in every Scenario cell
   (`AC-001 — …`). Run `--acceptance-status` once more after the last record and put its
   lines under the table. The verdict line follows the Phase 5 verdict rules.
9. **Work in the chain's anchor.** Resolve the Phase 0 git root with
   `ANCHOR="$(COPILOT_PLUGIN_DATA="${COPILOT_PLUGIN_DATA}" bash "${COPILOT_PLUGIN_ROOT}/hooks/lib/zensu-log.sh" --project-root)" && [ -n "$ANCHOR" ] && GIT_ROOT="$(git -C "$ANCHOR" rev-parse --show-toplevel)"`,
   never from the working directory, and stop when `GIT_ROOT` is empty. Run every command this run
   starts — `git`, the runtime recipe, fixtures and teardown, but never a `playwright-cli` call,
   which must stay one plain call — as `cd "<that root>" && …`, and read the recipe files
   from that root; that `cd` is the one prefix a recorded `down` may carry (Phase 2 step 3).
   After `/zensu-adopt-session --reanchor` the bash
   tool still starts in the session's previous worktree, while every record binds to the
   anchor's tree. `--evidence-run` needs no prefix: it already runs in the anchor.

