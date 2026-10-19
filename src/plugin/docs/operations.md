# Operations

## Install and version resolution

Build with `npm run build` in the source repository, then install the absolute
`dist/zensu` directory with `copilot plugin install /absolute/path/dist/zensu`.
Copilot CLI 1.0.98 copies local installs into its plugin cache. Rebuild and reinstall
after source changes, and start a fresh session before validating a changed runtime.
A local path install is currently supported but Copilot warns it will be deprecated
in favor of a marketplace entry. This repository does not publish a marketplace.

The root `plugin.json` declares the version. `build.json` hashes every shipped file
and records its owned source path. The build never reads the historical source
snapshot or rewrites host contracts. `npm run check` checks package and source
integrity. `/zensu-doctor` diagnoses the actual installed package and session.

## Updating

Reinstall a newly built package, then start a fresh Copilot session. A session is
bound to an installation, version and runtime digest; changing those files during
an active chain is not a supported hot reload. The adoption/recovery skills report
the recorded and executing identities before any explicitly confirmed repair.
Do not edit the installed cache, bypass a failed binding or replace state flags by
hand. Preserve pending work and run `/zensu-doctor` first.

## Platform Support

The native runtime requires Node.js 22+, Bash and Git. It has been exercised on
macOS with Copilot CLI 1.0.98. Zensu and forge CLI credentials are required only for
the respective backend/forge workflows. Browser and other validation tools are
separate capabilities. The plugin grants none of those tools itself.

The policy parser accepts the native Bash tool. PowerShell and unknown mutating
LSP/workflow tools are denied. Read-only LSP calls use an explicit operation list.
The work-order launcher's process-group supervision is POSIX-specific; native
Windows process supervision has not been validated. Do not apply another coding
host's environment variables or permission-mode switches to Copilot.

## Troubleshooting

- **Plugin missing:** run `copilot plugin list`, reinstall the built package, then
  start a new session. Native skill names are `/zensu-*`.
- **CLI or authentication missing:** use the named CLI's supported login procedure.
  Never print tokens or replace authenticated backend operations with a mock.
- **Reviewer refused:** inspect the actual Copilot task/permission result and the
  namespaced agent definition. A refusal is not a review; the user controls host
  permissions. Do not change permission settings to authorize your own task.
- **Hook error or state mismatch:** retain the exact diagnostic, run `/zensu-doctor`
  and use the appropriate session adoption/chain recovery skill. A missing or
  malformed workflow baseline does not mean an inactive workflow.
- **Missing required question or approval:** keep the decision pending. A headless
  run or successful tool transport cannot grant human approval.
- **Slow hook:** fix the failing/slow policy or dependency. The bounded dispatcher
  denies an operation if a required policy cannot complete.
