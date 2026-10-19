# Phase 6 step 10: close implementation and run the review chain

view this at Phase 6 step 10, after steps 1 to 9 in `references/audit.md`, and again at the start of every review round the post-review directive routes back to you.

10. **Close implementation and trigger the review chain.** This replaces the old subagent auto-review hook — the chain is now driven from this main thread. Execute these steps STRICTLY ONE AT A TIME (single tool call per step, wait for each result; every Agent spawn sets `mode: "sync"`), never as a parallel batch beyond the review fan-out of step 3 and the judge pair of step 4b, and never bundled with the Phase 6 audit writes above:

This file is the routing index. Before executing each stage, use native `view` to read its complete reference below. Every reference is bounded for the native reader; do not skip a stage because this index does not repeat its instructions. Re-read the relevant stage after compaction and follow the same sequence on every routed review round.

| Order | Required reference | Steps and obligations |
|---|---|---|
| 1 | [review-packet.md](review-packet.md) | 10.1–2c: completion preconditions, canonical changed paths, persona discovery, immutable packet |
| 2 | [review-panel.md](review-panel.md) | 10.3–4b: panel fan-out, merge, independent judges, required primary recovery |
| 3 | [review-verification.md](review-verification.md) | 10.4c: structured finding input, anchor/evidence verification, reproduction, visible neutralization |
| 4 | [review-completion.md](review-completion.md) | 10.5 and routing: one-shot consume ticket, fix rounds, convergence, self-review and chain terminus |

The final reference invokes `{plugin_root}/skills/zensu-self-review/SKILL.md` in this main thread when self-review is enabled. It owns the terminal handoff; reading this index is not completion evidence.
