# Phase 6 steps 1 to 3: suite, build and coverage

1. Run the full suite and the linter through the plugin's evidence runner. **This is the implementation pass's mandatory full-suite run** — Phase 5 checkpoints are scoped, so this is where the whole suite is measured for the TEST VERDICT (step 3b runs it again under coverage instrumentation — a different execution, which perturbs timing-sensitive and concurrency tests, so its result reports COVERAGE only and never carries the verdict). It is never optional, never scoped down, and it must measure the FINISHED tree — run it after the last implementation step. **Suite failed**: do NOT mark Phase 6 complete; route it exactly like step 2's build failure — amend the plan with a new `[W]` integration step (Phase 2), create its task (Phase 3), fix it under the still-active gate, then re-run this step.
   - **The commands.** `COPILOT_PLUGIN_DATA="{plugin_data}" bash "{plugin_root}/hooks/lib/zensu-log.sh" --evidence-run --scope full --cmd '{full_test_cmd}' --log {log_file}`, then the same with `--scope lint --cmd '{lint_cmd}'`. When the project configures `evidence.fullSuiteCommand`, drop `--cmd` from the full run: the runner uses the configured command and refuses a different one. The runner executes the command itself from a private script file, prints the path of its full output first, then the last 80 lines and one summary line (`zensu evidence-run: scope=… exit=… duration=… tree=… record=… cmd=…`), exits with the suite's own status, and appends a machine-written `EVIDENCE RUN — …` line to the run log. You write no claim line for these runs. Never pipe the runner into `tail`, `grep` or `head`: it already prints the tail, and `--show all` prints everything. A suite too long for one tool call may use the native bash asynchronous mode; await its actual completion before accepting evidence: its record lands when it finishes, and until then the terminus refuses the chain as `running`.
   - **What the terminus reads.** A `full` record is bound to a fingerprint of the working tree. `--chain-done` reads the newest one, never a claim in the run log, and refuses a missing, red, interrupted or still-running record, and one measured on a tree that has changed since (§Full-Suite Gate in `docs/gates.md`). A later round that changes ANY file (test files included — they move the verdict too) re-runs only its OWN scoped suites; the full suite is re-run ONCE more in the CONVERGENCE branch of step 10, with `--if-stale`, so the shipped verdict is measured without paying a full run per round. When the project's own rules forbid a local full run (a CI-only suite), do not run it: say so in the final report, and expect the terminus to refuse unless the project sets `evidence.fullSuiteGate` to `advisory`.
   - **Non-bash test runners.** A suite reachable only through a non-bash tool (rare; e.g. a custom MCP test runner) cannot produce a record: log `TEST VIA {tool} — {verdict}`, surface it prominently in the final report, and expect the terminus to refuse under `required`.
2. **Build Verification.** Tests can be green while the artifact is broken (compile errors only the build catches, env vars frozen at build-time, broken imports the test harness shims out). Verify the project actually builds.
   - Determine the build command by reading the project's metadata: `README.md`, `AGENTS.md`, `package.json` (`scripts.build`), `pom.xml`, `Cargo.toml`, `Makefile`, `go.mod`, `pyproject.toml`, etc. Pick the canonical command the docs name as "build".
   - Decide applicability. If the TDD spec is genuinely non-buildable (docs-only migration, pure data fixture, etc.) AND the project metadata confirms no build step is wired, record `Build: – n/a` with the reason and proceed to step 3.
   - If the project IS buildable, run the build. Capture exit code and the last ~30 lines of output.
   - **Build passed** (exit 0, no critical warnings): record `Build: ✓ passed`. Proceed to step 3.
   - **Build failed**: DO NOT mark Phase 6 complete. Treat the failure as a new requirement and return to Phase 2 to amend the plan with a new `[W]` integration step that fixes the build, then create a task for it (Phase 3 mechanics) and re-run Phase 4-6 after the fix. The Phase 6 "done" claim is only valid when the build is green.
   - If the build can't run for ambient reasons (dependencies not restorable from the lockfile, network down, unknown toolchain), record `Build: – skipped (reason)` and continue — do not block the audit on environment problems the developer must resolve. Surface the skip prominently in the final report so the developer notices.
3. Coverage report (changed files only):
   - If `{coverage_cmd}` is null → log `COVERAGE SKIPPED — no tool` and skip to step 4.
   - Else:
     a) Collect list of files modified during session from `IMPL`/`WIRED` log entries (Phase 4 Cycle B logs `files: {list}`). Parse them exactly as step 5b a) does — read only the `files:` list, never the commentary after ` | ` — or the description leaks into the coverage include filter and skews its scope.
     b) Run coverage on full test suite, restricting report scope to changed files via the tool's include filter:
        - vitest: `--coverage --coverage.include={file1} --coverage.include={file2}`
        - jest: `--coverage --collectCoverageFrom={file}`
        - c8/nyc: `--include={file}`
        - pytest-cov: `--cov={module}`
        - go: `go test -coverprofile=cover.out ./... && go tool cover -func=cover.out` (filter manually)
     c) Parse per-file metrics: lines %, branches %, functions %.
     d) Compare each file against `{threshold}`.
     e) Build Coverage section for the final report (markdown table):

        ```
        ## Coverage (changed files)
        | File | Lines | Branches | Funcs | vs {threshold} |
        |------|-------|----------|-------|----------------|
        | ...  | ...   | ...      | ...   | PASS / FAIL    |

        Summary: {N}/{M} files PASS @ {threshold}
        Threshold source: {threshold_source}
        ```

   - If ≥1 file FAIL: log `COVERAGE BELOW THRESHOLD on {N} files: {file_list}`. Standalone mode asks the user (in their language) whether to run an additional TDD cycle for uncovered branches. Delegated mode persists `BLOCK(coverage-threshold-decision-required)`, reports the files, and stops without asking. Do NOT auto-loop (avoids scope explosion).
