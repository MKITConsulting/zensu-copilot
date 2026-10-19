# Browser session, authentication and preflight

### Browser session (both modes)

After readiness, once the base URL is final, write the run config:

```bash
node "${COPILOT_PLUGIN_ROOT}/scripts/verify-browser-config.js" --run-dir "$RUN_DIR" --mode <local|remote> --origin "<app-origin>" [--network-only-origin "<network-only-origin>" ...]
```

Pass one `--origin` per origin the matrix navigates — the application origin and, only when it
differs, the validated authentication origin (`auth.baseUrl`) — and one `--network-only-origin`
per validated network-only origin, and nothing else; the two kinds count together toward the
bound of 8 origins. Never pass a network-only origin as `--origin`: the helper refuses it in
policy mode. In consent mode the helper refuses `--network-only-origin`: pass a network-only
origin of the run's mode — loopback in local mode, public HTTPS in remote mode — with `--origin`
instead, where the consent prompt covers it like any other origin, never navigate to it, and
report the rows that need another one PARTIAL, because it needs the launch-time policy. The helper prints `session=zensu-verify-<id>`, `config=<absolute path>`,
`mode=consent|policy`, one `origin=` line per navigable origin and one `network-only-origin=`
line per network-only origin, or exits `1` with a named reason and writes nothing. It refuses unless
the native manifest and `hooks/registry.json` demonstrably register both consent hooks on a matcher that covers bash, the
installed `playwright-cli` manifest names the measured version, and no empty or relative PATH
entry comes before or holds `playwright-cli`; then report PARTIAL with its
reason, and never open a browser without the run config it writes. Copy the printed session
name and config path LITERALLY into every later call. Never rebuild them, never hold them in a
shell variable, and never set `PLAYWRIGHT_CLI_SESSION`: the gate denies a session or argument it
cannot read as a literal. Then open the browser, headed when the matrix needs visible manual
login:

```bash
playwright-cli -s=<session> open --config=<config> [--headed] <app-origin><route>
```

Run each `playwright-cli` call as its own plain bash command on the main thread — exactly one
call per bash command, with nothing before or after it: no `&&`, `;` or pipe, no subshell or
command substitution, no wrapper such as `timeout` or `nohup`, no package launcher such as
`npx`, never through `xargs`, `bash -c`, a heredoc or a here-string, and never from a subagent.
The gate denies every other shape. Name the same session on every call:
`playwright-cli -s=<session> <command> ...`, and quote an argument that carries `?`, `*`, `[`
or `{`, or that starts with `~` or `=`, because the gate reads an unquoted one as a shell
pattern it cannot judge. Single-quote an argument that carries `$`: double quotes do not help,
because the gate reads a `$` outside single quotes as an expansion it cannot judge unless
whitespace, the end of the command or a closing double quote follows it, so a `fill` or `type`
value such as `"$price"` is denied and `'$price'` is not. A denial that objects only to how a call is spelled is answered once,
as `rules/browser-verification.md` section 0 describes; every other denial is final.

### Authentication (both modes)

The browser consent gate denies every cookie, local/session-storage and storage-state command
on a `zensu-verify` session, and `open` carries only the run config, which holds no storage
state. This is deliberate: those commands combine state restoration with credential getters
and exporters, so admitting them would violate the credential-blind boundary. Do not invoke
`auth.loginScript`, accept `STORAGE_STATE`, or try to restore browser state by another tool or
another session. A future gate may re-enable opaque state only when it admits a path-contained
setter and hard-denies every getter/exporter.

The evidence boundary is the ORIGIN, never the route. Before authenticating or navigating to
any protected page—including an initial `open` or `goto`, which prints the page title and
writes a snapshot of the page—its origin must be approved: by a parent-environment policy
target that names that origin with `evidenceMode: declared-safe`, or by the user's answer to the
permission prompt the gate raises for that origin. An
approved origin covers every page on it, at any path, including routes whose identifiers change
on every run; no route list is declared, matched or checked. A page on an origin that is not
approved is never opened, and a refused prompt makes that origin's scenarios PARTIAL.
Final-report redaction is too late. The same boundary applies to screenshots. A recipe's
`validate.evidenceSafety` block (`../../zensu-autopilot/rules/config.md`) is an optional declaration of
the application's data classification; it no longer gates navigation, and a `routes` list left
in it is ignored.

Use this order:

1. **Visible manual login:** navigate a headed browser to the login page, ask the user to
   enter credentials in that browser, and wait for confirmation. Never ask them to paste a
   credential into chat and never type it on their behalf.
2. **No safe path:** skip authenticated scenarios and report PARTIAL. Token extraction or
   `localStorage.setItem(...)` injection is forbidden, including for throwaway remote users.

## playwright-cli preflight

Verification drives the browser through `playwright-cli`, the `@playwright/cli` package, which
must be on `PATH`: check with `command -v playwright-cli`. When it is missing, stop with PARTIAL
and name the pinned install route for the user to run — `npm install -g @playwright/cli@0.1.21`,
the version the browser consent gate was measured against; `brew install playwright-cli` is
unpinned and may install a version the run-config helper refuses. Never install it on their
behalf.
`/zensu-doctor` reports whether it is installed and which version. The browser consent gate
parses its arguments as measured against version 0.1.21 and denies an argument shape it does
not recognize rather than admitting it — including a `zensu-verify` session name it does not
resolve as the call's session.

The run config uses the system Chrome channel. When `open` reports that the browser is not
installed, obtain explicit approval for the networked download, then run
`playwright-cli install-browser` WITHOUT a session flag — the gate does not admit it on a
`zensu-verify` session — and retry `open`. Never switch to Firefox or WebKit: the run config's
resolver pins and proxy switch are Chromium switches, and the gate refuses another `--browser`
value. Never drive `playwright-cli` on a session name you chose yourself, and never `attach` to
a running browser: only a `zensu-verify` session opened with the run config sits behind the
consent gate, and a browser outside it has neither the origin restriction nor the
credential-blind command set. Do not silently replace the browser driver with ad-hoc `curl`
checks; that cannot prove the UI.
