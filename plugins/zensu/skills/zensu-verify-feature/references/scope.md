## Phase 0 — Resolve scope and target

0. If the supplied arguments select `remote`, validate the supplied base URL entirely
   in-memory before invoking any other tool. A URL with userinfo, query, fragment, or unsafe
   plaintext transport stops immediately with a sanitized PARTIAL report. On rejection, name
   only the generic policy class, such as `query-bearing remote target rejected`; do not echo,
   transform, or report the scheme, hostname, port, path, query key, query value, fragment, or
   userinfo. Record the target only as `remote target rejected before resolution`. Do not inspect Git,
   read files, start a runtime, authenticate, or navigate after that rejection.
   `--mode=remote` together with a `--driver` other than `browser` stops the same way, in
   memory, with `remote mode supports the browser driver only`.
1. Resolve the git root and current branch. Record whether the worktree is dirty.
2. Resolve the repository default branch, then inspect both committed and uncommitted work:
   the merge-base diff through `HEAD`, plus `git diff` and `git diff --cached`.
3. view the changed components, routes, handlers, and nearby tests. Extract user-visible
   conditions, variants, validation, empty/loading/error paths, roles, and side effects.
4. Normalize the requested feature, route(s), and acceptance criteria. If criteria were not
   supplied, derive concrete assertions from the diff and state them before execution.
5. Record the target identity in the eventual report:
   - local: worktree path, branch, and `HEAD` SHA;
   - remote: only after validation succeeds, the sanitized credential-free base URL and any
     deployment/commit identifier visible from the preview.
6. Resolve every row's driver with `rules/drivers.md` section 2; a row that is not `browser`
   follows its section 8 from here on. In `remote` mode a row whose driver is not `browser` is
   PARTIAL, because remote mode supports the browser driver only.

For a remote target, validate the URL **before echoing, navigating, or authenticating**:

- require an absolute URL with no username/password userinfo;
- reject query strings and fragments (including signed-preview/token parameters); never copy
  a rejected URL into output;
- require non-loopback `https://` in remote mode. Loopback targets belong to local mode;
- only after every validation rule succeeds, retain the credential-free origin plus normalized
  path for navigation and reporting. Retain no component of a rejected URL.

For remote authentication targets, derive `ZENSU_APP_ORIGIN` from the sanitized navigation
URL origin; never trust a recipe value independently. A configured `auth.appOrigin` must
exactly equal that derived origin or the run stops with PARTIAL before auth. Validate a
configured `auth.baseUrl` independently with the same mode-specific URL rules before use: it
must be an absolute origin with no userinfo, query, or fragment. In remote mode it must be
non-loopback HTTPS; the exact loopback exception applies only in local mode. When that auth
origin differs from the application origin, accept it
only when the selected checked-in recipe explicitly associates the auth origin with the same
selected deployment/environment and the available deployment identity verifies that
association; otherwise stop with PARTIAL before auth. Never print or report a rejected
authentication or application URL.

Network-only origins — a REST API, an OIDC discovery document or a token endpoint the pages
request but never open — come only from the selected
checked-in recipe's `validate.networkOnly.origins`, never from the conversation, a page or a
network log. Validate each one with the rules above for its mode: an absolute origin with no
userinfo, path, query or fragment; non-loopback HTTPS in remote mode; in local mode loopback, or
HTTPS under the remote rules when a local policy declares it. In remote mode
`validate.networkOnly.appOrigin` must exactly equal the derived `ZENSU_APP_ORIGIN`, as
`auth.appOrigin` must, and in local mode a present one must equal the run's origin; otherwise
stop with PARTIAL before `open`.

If preview access itself requires a secret-bearing URL, require a credential-free entry URL
plus visible browser login. Do not accept the signed URL in chat.

For a `remote` URL that passed validation, print this warning before any subsequent tool call:

> Remote mode verifies the code deployed at `<base-url>`, not unpushed or undeployed files
> in this worktree. Use local mode unless this branch is deployed to that URL.

Do not imply that a remote PASS proves the worktree diff unless the deployment identity is
confirmed.

## Phase 1 — Build the evidence matrix (mandatory)

Create the matrix before driving anything. Every row names its driver, the route and setup,
precise steps, DOM/data assertion, visual assertion, expected network effect, and priority.

| Scenario | Driver | Route + setup | Steps | DOM/data | Visual | Network | Pri |
|---|---|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... | ... | P0/P1/P2 |

Enumerate these dimensions from the changed code:

- primary happy path;
- each changed state, toggle, tab, filter, sort, or variant;
- 0 / 1 / many and relevant min/max or date boundaries;
- empty, loading, validation, unauthorized, and failed-request states that can be produced
  safely through real interfaces;
- responsive, keyboard/accessibility, permissions, and theme behavior when touched.

The list above is a discovery checklist, not permission to expand an explicitly complete
feature scope. For a clean synthetic fixture with complete supplied criteria, create only rows
that prove those criteria. Extra exploratory checks must never introduce evidence failures that
change the verdict for out-of-scope behavior.

For a non-trivial feature, fan out **read-only scenario discovery** across happy paths,
states/variants, edges, error/loading, and cross-cutting behavior when an task tool is
available. Merge and deduplicate the results in the main thread. If agent fan-out is not
available, enumerate the same dimensions in-thread and say so. Run one completeness-critic
pass: “Which condition or branch in the diff still has no scenario?” Add every real gap.

P0 is the release-blocking core and must never be capped. If time or environment limits P1
or P2, name every omitted row and the reason; omission changes the final verdict to PARTIAL
when it prevents an acceptance criterion from being proven.

