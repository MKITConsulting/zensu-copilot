# Zensu for GitHub Copilot CLI

A native Copilot CLI plugin with all 32 Zensu skills, six review/PLM agents and
the complete workflow, evidence, acceptance and recovery engine. Version 0.2.0
uses native Copilot events, tools, approvals and session history directly. There
is no Claude compatibility layer, alias environment, transcript projection or
runtime dependency on another coding host.

The independently maintained sources are in `src/plugin/` and `src/`. The build
copies them byte-for-byte to `dist/zensu`, without transformations or imports from
the historical snapshot. The original 0.27.0 source at
`65d6aba7e3f6c0d98af2a02c9b4854c1f0c78980` remains immutable under `upstream/`
for provenance and parity checks; it is not needed to build or run the package.

## Prerequisites

- Node.js 22 or newer, Bash and Git on `PATH`.
- GitHub Copilot CLI, authenticated with access to the chosen model. Native
  integration has been probed with CLI **1.0.98**; this is the tested version,
  not a claimed compatibility range. This package targets the CLI, not the IDE
  extension or GitHub's hosted coding agent.
- The `zensu` CLI and its login for tracked features, Pulse and work orders.
  Local implementation/review and configuration can work without a Zensu account.
- Authenticated `gh` for GitHub PR workflows, or `glab` for GitLab MR workflows.
  Browser validation additionally needs the measured `@playwright/cli` version
  reported by `/zensu-doctor`; other validation drivers need their own tools.

## Install the release

This repository is private. Authenticate `gh` with access to
`MKITConsulting/zensu-copilot`, then download and verify the release:

```bash
mkdir zensu-copilot-0.2.0
cd zensu-copilot-0.2.0
gh release download v0.2.0 --repo MKITConsulting/zensu-copilot \
  --pattern zensu-copilot-0.2.0.tar.gz --pattern build.json --pattern SHA256SUMS
shasum -a 256 -c SHA256SUMS
tar -xzf zensu-copilot-0.2.0.tar.gz
copilot plugin install "$(pwd)/zensu"
```

## Build from source

```bash
gh repo clone MKITConsulting/zensu-copilot
cd zensu-copilot
npm run verify
copilot plugin install "$(pwd)/dist/zensu"
```

The install argument must be an absolute path. Restart Copilot after installing
or updating the plugin.
For development without an installed Zensu plugin, load the rebuilt directory
in a fresh session:

```bash
copilot --plugin-dir "$(pwd)/dist/zensu"
```

Do not combine `--plugin-dir` with an installed Zensu version: Copilot loads both
hook registrations. Reinstall the built package and start a fresh session when
Zensu is already installed.

To resume an existing session after an in-place plugin update, run
`/zensu-adopt-session` for the diagnosis. If it reports a runtime digest change,
review the update and explicitly accept it with `/zensu-adopt-session --confirm`.
This verifies the replacement package, archives the old binding and preserves the
workflow; it neither clears a pending review nor silently accepts an update.

Start with `/zensu-help`, `/zensu-doctor`, then `/zensu-setup --project`.
Commands use `/zensu-…`, for example `/zensu-tdd`, `/zensu-autopilot`,
`/zensu-pr-team-review` and `/zensu-session-trail list`.

CLI 1.0.98 caches local installs; after rebuilding, run the same install command
again to refresh the cache. It currently warns that direct installs will be
removed in a future release. Published distribution should use a plugin
marketplace; this checkout's local installation remains supported by the tested
version.

Configuration is read from `~/.zensu/config.json` and the project's
`.zensu/config.json`; `ZENSU_CONFIG` selects a full override. Project setup avoids
changing the shared global configuration. The Zensu defaults remain: vanilla
implementation, review-chain enforcement and Zen mode enabled; strict RED/GREEN
TDD is available through `/zensu-tdd-mode`.

Workflows use the tools actually exposed in the session. Progress uses
`update_todo`, another available progress tool, or a real `.zensu/progress/`
checklist. Edits use available `apply_patch` or native create/edit tools.
Interactive conversation can carry required questions when `ask_user` is
absent; missing decisions in headless runs stay pending.

## Validation

Run `npm run verify` for native protocol, policy, session, evidence, review,
acceptance, launcher and source-independence tests. The suite executes the owned
native engine; fixture-driven checks are kept separate from live Copilot proof.
The [validation record](docs/copilot-runtime.md#observed-validation-record) records
which native build was tested and what was actually observed.

External backend/forge operations, human approval and browser/other driver runs
require separate live acceptance with the applicable tools and disposable data.
The native 0.2.0 test run passed 420 tests and completed a local Copilot workflow
through acceptance, native review and terminal self-review. See the record for
the exact tested build and remaining live proof boundaries.

See [the complete parity map](docs/parity.md) for every skill, agent and host
limitation, and [runtime and live validation](docs/copilot-runtime.md) for the
event contract, state locations, work-order launcher and acceptance procedure.

## License

[FSL-1.1-Apache-2.0](LICENSE), inherited from the pinned Zensu source. Upstream
provenance is recorded in [upstream.json](https://github.com/MKITConsulting/zensu-copilot/blob/main/upstream.json).
The generated `build.json` records the owned files and hashes included in the package.
