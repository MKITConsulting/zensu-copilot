## Phase 2 — Prepare the runtime

For either mode, create a collision-safe per-run directory beneath the physical git workspace
root, `$GIT_ROOT/.zensu/verify-feature-runs/<random>`, and register cleanup immediately. Reject
a symlinked `.zensu` or `verify-feature-runs` boundary. Remove only the unique leaf on cleanup.
This common `$RUN_DIR` must exist before runtime or authentication preparation.

### Local mode

Local means the application process actually uses files from the current worktree.
Set `ROOT="${COPILOT_PLUGIN_ROOT}"` once before loading a bundled rule, and run every
plugin script a bundled rule names from this concrete absolute `ROOT`, because
supporting files loaded through `view` do not receive Copilot's native placeholder
substitution. Whenever a bundled rule file says `<absolute-plugin-root>`, replace it with
this concrete absolute `ROOT`.

0. When `--attach=<origin>` was given, skip runtime preparation entirely and follow
   `rules/attach.md`. When `--setup` was given, run `rules/setup.md` and stop after the recipe is written.
1. Inspect the explicit `--config` path, else `.zensu/runtime.yaml`, else `.zensu/autopilot.yaml`,
   as a **candidate**, using `../../zensu-autopilot/rules/config.md` (the two file names share one
   schema; `runtime.yaml` is the verify-owned spelling that setup writes, and it is tried first).
   Record which file was selected in the report. An autopilot recipe is not automatically safe
   for live verification. Accept it only when all of these facts are explicit and internally
   consistent:
   - every service has startup and readiness commands;
   - every started resource has an explicit scoped `down` command, or remains a foreground
     child whose exact PID the run owns;
   - host ports and resource names are per-run/collision-safe inputs rather than fixed shared
     values;
   - application and authentication base URLs, fixture setup, and cleanup refer to the same
     run-specific runtime;
   - the browser base URL is either a run-specific literal or comes from a checked-in
     `validate.baseUrlCommand` executed only after readiness. Validate it again before
     navigating. Where the session cannot show the prompt, a policy is the whole allowlist: its output
     must exactly match a policy target, and a command that selects a previously unknown port
     needs a discovery run followed by a policy-configured restart. Elsewhere a run-specific
     loopback port is the EXPECTED shape rather than a defect — the first navigation to it asks
     the user through the permission prompt;
   Reject fixed-port Compose stacks, shared resource names, daemonized services without
   ownership, or recipes whose teardown scope is ambiguous. Record why the candidate was
   rejected; do not execute any part of it.
2. Resolve the runtime from the first **compatible** option:
   - the accepted candidate recipe;
   - otherwise, in an interactive session, offer the guided setup with ONE `the available user-question channel`
     ("No runtime recipe found. Set one up now?"); on yes run `rules/setup.md`, then resume at
     step 1 with the recipe it wrote. On no, or when no human can answer, stop with PARTIAL and
     list the missing startup, readiness, base URL, auth, fixture, isolation, and teardown
     facts. Never invent commands.
   In consent mode the accepted candidate takes its run-specific port from
   `node "${COPILOT_PLUGIN_ROOT}/scripts/verify-free-port.js" --from 5173`, exported to the
   recipe's commands as `ZENSU_VERIFY_PORT`; the browser base URL is then that port on the
   loopback origin the application expects — `http://127.0.0.1:$ZENSU_VERIFY_PORT`, or
   `http://localhost:$ZENSU_VERIFY_PORT` when the recipe's `validate.baseUrlCommand` prints it or
   the app's CORS allow-list, cookies or auth callback name `localhost` — and the first
   navigation to it asks the user.
3. Before starting a service, register its scoped cleanup. A daemonized or shared service
   without scoped teardown is a blocker.
   Record each configured `down` command verbatim. Execute that command later as its own
   standalone bash invocation, byte-for-byte. Do not combine it with semicolons, `&&`, pipes,
   subshells, logging, or any other cleanup; run additional run-owned cleanup separately. Under
   `--chain`, the `cd "<that root>" &&` prefix of Chain mode point 9 is the one exception.
4. Run readiness probes until they pass or their configured timeout expires. A sleep is not
   readiness evidence.
5. Seed only data required by the matrix, through repository-owned fixtures, typed tools, or
   the UI. Never use a hand-written raw API payload when the repository has a typed path.

### Remote mode

Use only the supplied/configured base URL. Do not boot or tear down remote infrastructure.
Keep mutations minimal and use disposable records with recognizable run-specific names. A
remote origin outside a policy is approved at the permission prompt at every `open` (Phase 0).
The redirect check from Phase 0 applies to every navigation.

