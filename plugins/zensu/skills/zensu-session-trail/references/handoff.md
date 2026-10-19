# Native handoff brief

Run `handoff <id-or-prefix>` through this skill's bound native entry point. It prints a continuation brief and suggested destination without writing the brief. Keep its leading data caution intact. Verify the worktree and every actionable claim before continuing.

If the user requested a saved brief, use native `create`/`edit` at their approved destination. The content can include confidential session or repository material; do not automatically add it to tracked project files or a shared folder. A brief printed in a session may itself enter that session's transcript. When confidentiality requires no persisted copy, report that limit instead of claiming the conversation is transient storage.

Provide the exact returned `copilot --resume '<id>'` command when native resumption is wanted. Do not launch a second process automatically or invent a window/account link. To continue the work in this session, follow [takeover.md](takeover.md); a brief alone grants no authority to change another session or its files.
