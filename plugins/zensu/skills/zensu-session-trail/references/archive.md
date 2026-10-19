# Release, archiving and worktrees

`release` means completion of a plugin handover. Without `--apply` it is a preview; with `--apply` it writes the completion edge in Copilot plugin data. It does not archive a native Copilot session, terminate a process, change a branch, delete a worktree or add/remove archive-protection markers.

The native session reader has no exclusive worktree lock. Two live sessions can use the same checkout. Inspect process-start identity and Git state before handing work over, and preserve unrelated or uncommitted changes. A stale registry entry is not proof that a process is dead; unknown liveness remains unknown.

Worktree cleanup or process termination is a separate operation requiring the user's applicable authorization and concrete inspection. Do not derive permission from a completed lineage edge or fabricate a desktop archive command. See [takeover.md](takeover.md) for the supported handover sequence.
