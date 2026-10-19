# Browser policy and consent

Before any browser call, resolve how each origin is approved. A **policy** is a
`ZENSU_VERIFY_NAVIGATION_POLICY_V1` set in the environment that launched GitHub Copilot CLI, declared
by `validate.navigationBroker`; its targets need no prompt. Every other origin needs
**consent**, the ordinary case for a user who has not configured anything. Run
`node "${COPILOT_PLUGIN_ROOT}/scripts/verify-browser-config.js" --check-policy <local|remote> "<validated-origin>" declared-safe`
as a standalone preflight once for every origin the run navigates. It prints `consent` or `policy`
and exits `0`, or exits `1` with a named reason. `policy` names a target with the `declared-safe`
mode of the config contract. A
target covers every route on its origin: no route list is declared or checked, so pages whose
path carries identifiers that change on every run are covered too. Contract v1 intentionally
supports no redaction-driver mode: coverage on an origin that is not approved stops with PARTIAL.
For each network-only origin, run it with the operand `network-only` instead, never both:
`node "${COPILOT_PLUGIN_ROOT}/scripts/verify-browser-config.js" --check-policy <local|remote> "<network-only-origin>" network-only`.
It prints `policy` and exits `0` only when the parent policy lists that origin in
`networkOnlyOrigins`; without a policy it refuses, and the browser session below says what a
consent-mode run passes instead.

The browser is `playwright-cli`, and the browser consent gate — the hook pair
`pre-browser-navigation-consent.sh` / `post-browser-navigation-consent.sh` on the bash matcher —
judges a `playwright-cli` call on a `zensu-verify-*` session before it runs. It is a textual gate: it
judges the calls whose command text names the CLI and that session, which is one more reason every
call spells both literally. It denies every
command outside the set in `rules/browser-verification.md`, every flag outside that command's
own list, every call from a subagent, every call whose session or arguments are not
literal, and every command that is not exactly one plain `playwright-cli` call. `open` must carry the run config that `scripts/verify-browser-config.js` wrote, and the
gate reads that config itself: an isolated browser, the run's origins as
`network.allowedOrigins`, service workers blocked, artifacts inside the run directory. Local
mode navigates loopback origins only: a loopback IP or the exact name `localhost`, which the
browser resolves to loopback itself; `app.localhost`, `localhost.` and every other hostname are
refused. `localhost` and `127.0.0.1` are different origins — use the one the application
expects, everywhere. Remote mode accepts only non-loopback HTTPS,
rejects RFC1918, CGNAT, link-local/metadata, loopback, documentation, multicast/reserved,
IPv4-mapped IPv6, ULA, and non-global IPv6 addresses, rejects mixed public and non-public DNS
answers, and pins each hostname to an approved public address in Chromium to prevent DNS
rebinding. An invalid policy stops before browser use with PARTIAL. A policy's network-only
origins serve the pages' own requests only: `open`, `goto` and `tab-new` aimed at one are
denied, and that denial is final. Never try to configure the variable from a child bash call —
the hooks read it from the environment GitHub Copilot CLI started with, and the gate denies an
`export` or an environment assignment on a command that carries a `zensu-verify` call.

**Consent.** For an origin the preflight answers `consent`, the first call that reaches it opens
the host's permission prompt; read `rules/browser-verification.md` section 1 before that call.
Consent is per ORIGIN, but a remote origin is asked again at every `open`.
When native human consent is unavailable, rejected or automated, do not infer approval.
An unattended run needs an explicit matching parent navigation policy; otherwise report
PARTIAL and preserve the missing-consent reason. The consent memory `.zensu/state/verify-consent-<session-key>.json` is read for the
report and never written, edited or deleted: a record placed there skips the human's prompt for
that origin.

**Redirects are not filtered by the browser.** `network.allowedOrigins` blocks a direct
navigation and every HTTP(S) subresource request outside the run config, but the browser
follows a server redirect to another origin. After every call that can navigate — `open`,
`goto`, `go-back`, `go-forward`, `reload`, `tab-new`, `tab-select`, `tab-close`, and any click or
key press that follows a link or submits a form — read the `Page URL` line `playwright-cli`
prints. A page can also navigate itself onto a network-only origin: the browser knows one class
of allowed origin. If the line names an origin outside the run config, or a
network-only origin, stop driving that page: take no snapshot or screenshot and read no console or network
output from it, run `close`, and report the scenario PARTIAL with the redirect as the
observation.

