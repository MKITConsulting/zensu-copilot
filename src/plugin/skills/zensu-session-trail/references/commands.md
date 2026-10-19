# Native Copilot session-trail commands

Read [../SKILL.md](../SKILL.md) for the binding, scope and confirmation contract.
Run commands through `node "$COPILOT_PLUGIN_ROOT/skills/zensu-session-trail/scripts/trail.mjs"` in the bound session.

| Command | Observed result or exact write |
| --- | --- |
| `instances` | Registered process candidates; uncertain PIDs remain unknown |
| `list` | Native sessions in this repository and its linked Git worktrees |
| `show <id-or-prefix>` | Session digest, recent user prompts, Git state and resume command |
| `handoff <id-or-prefix>` | Continuation brief on stdout; writes no brief |
| `limited` | Recorded rate-limit errors and later observed main-agent completion, not current quota |
| `takeover <id-or-prefix>` | Brief and provisional handover edge into this session |
| `lineage` | Plugin-local handover chains |
| `adopt <id-or-prefix>` | Explicit continuation edge into this session |
| `release <id-or-prefix>` | Handover-completion preview; `--apply` records it in plugin data |
| `label <id-or-prefix> <text>` | Plugin-local label; `--self <text>` and `--remove <id>` are supported |

Every command accepts `--json` and `--config-dir <absolute-root>`. The default native root is `COPILOT_HOME`, otherwise `~/.copilot`. Session scans default to the current repository and 21 days; `--repo`, `--all`, `--days` (zero means all history) and `--no-git` adjust supported scans. `--all` widens scope to other projects and must match the user's request. `list --live` requires verified process-start identity.

`show` and `takeover` accept `--prompts <n>`, `--anchor <absolute-path>` and `--receipt <32-hex-token>`; `handoff` accepts the receipt token too. A receipt token is data, not permission, and this reader creates no Session Hub receipt. `takeover --no-record` prints a read-only brief. Active or uncertain owners require confirmed `--force`; it does not kill them. `--reason <text>` annotates takeover/adoption.

`lineage --where <exact-id>` follows a chain. `--diagnose` reports store availability. `--backfill` previews edges inferred from explicit native detached-continuation metadata; `--apply` persists them as inferred. `--forget <exact-id>` previews removal of matching plugin edges; `--apply` deletes those ledger records only. These modes are mutually exclusive. `ZENSU_SESSION_LINEAGE=off` refuses edge creation.

Unknown commands and unsupported flag combinations are errors. Never invent a desktop/window/task-chip command or translate a source-host command by its name alone.
