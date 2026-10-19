# Native session-trail evidence limits

- A registered PID is live only with matching process-start identity. Missing or mismatched identity means unknown; an ended registry record is evidence of that recorded end, not a global process search.
- `events.jsonl` is a persisted event stream. Unknown event types and read failures must be disclosed. Never present a bounded or partial read as a complete history.
- Titles fall back to supported scalar `workspace.yaml` metadata because title/idle events may be transient. Complex YAML is unsupported, never guessed.
- Main-user prompt history excludes generated skill/autopilot prompts and child-agent messages. Pending and withdrawn message queues cannot be reconstructed from the available event contract.
- `limited` reports observed quota/rate-limit errors and whether a later main-agent turn completed. It does not query remaining quota or prove a current account is usable.
- Accounts, window ownership, desktop task chips, presets and archive-protection semantics are unavailable. Plugin labels do not rename native titles or accounts.
- Only explicit `detachedFromSpawningParentSessionId` metadata provides cross-session linkage. An event's `parentId` links events, not sessions; task IDs are not resume IDs.
- A takeover edge is provisional intent. A release edge records verified handover completion in this plugin; neither controls Copilot or Git.

Use [../SKILL.md](../SKILL.md) and [commands.md](commands.md) for supported actions. Report missing capabilities plainly instead of guessing a compatible command.
