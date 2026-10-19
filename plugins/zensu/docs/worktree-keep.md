# Worktree ownership in Copilot CLI

Copilot CLI sessions use explicit Git worktrees and the plugin's native session
observations. This plugin does not maintain a desktop application's worktree pool,
window/account bindings or archive-protection markers.

`/zensu-session-trail` reads native events and workspace metadata, provides an
inspection/handoff brief, and prints a native resume command. `release --apply`
records completion of a local handover; it does not archive a host session or
remove a checkout. A recorded active session is not by itself proof of a live OS
process. Process liveness requires a verified PID and process-start identity.

Session reanchoring must preserve Git repository identity, registered worktree
membership, closed workflow state, independent ownership and conservative treatment
of other sessions whose activity cannot be ruled out. Inspect its read-only report
before confirming a move. Pending work or incomplete ownership evidence refuses
reanchoring instead of widening the write gate to another checkout.
