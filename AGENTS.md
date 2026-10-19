# Zensu Copilot CLI

- Use English for repository code, comments, documentation, fixtures and commits.
- `upstream/zensu-claude-code/` is an immutable, tracked source snapshot. Do not edit it.
- Maintain the native policy, skills and agents in `src/plugin/` and native execution modules in `src/`. The build copies owned files byte-for-byte into `dist/zensu`; never add source-host imports, protocol conversion, runtime rewriting or template transformation.
- Preserve the full Zensu workflow surface. Record host-specific differences explicitly in `docs/parity.md`.
- Do not represent fixture tests as live Copilot validation. Keep native captures separate from fixtures.
- Do not access or modify Claude configuration, sessions, installed plugins, credentials or source checkout.
- Hooks must normalize tool arguments as well as names; unknown mutating schemas must not silently bypass gates.
- Never infer a main-agent identity from an unclassified subagent. Bind workflow state to Copilot session identity.
- Run the smallest relevant tests after edits, then the package and integration checks before delivery.
