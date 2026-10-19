# Phase 6 steps 1 to 9: audit and final report

Read this index when the last Phase 4 step is done. Run the sections below in order; read each bounded reference only when its step is reached. A skipped mode-specific audit remains explicitly skipped under `references/modes.md`; splitting the instructions never waives a gate.

| Reference | Required stage | Read when |
|---|---|---|
| [audit-evidence.md](audit-evidence.md) | Steps 1–3: full suite and lint, build, changed-file coverage | Beginning Phase 6; again when those checks must be refreshed after edits |
| [audit-integrity.md](audit-integrity.md) | Steps 4–6c: implementation check, strict mtime audit, edit landing, precondition drift, cross-layer pairing, requirements coverage | Evidence steps 1–3 finished; the same edit-landing procedure applies after a fix |
| [audit-acceptance.md](audit-acceptance.md) | Steps 6d–9: live acceptance, plan status, completion log and implementation report | Integrity audits finished; refresh affected acceptance after any later edit |

Acceptance still invokes `{plugin_root}/skills/zensu-verify-feature/SKILL.md` from step 6d. Only after steps 1–9 finish continue to [review-chain.md](review-chain.md), Phase 6 step 10.

Use native `view` on the exact reference path, not a wildcard read of the directory. If a read returns `File too large` or a truncation notice, use bounded `view_range` reads until the needed section is complete; successful transport alone does not establish that its instructions were read.
