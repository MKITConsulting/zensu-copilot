# Copilot CLI port

Reference: Claude plugin 0.27.0 at `65d6aba7e3f6c0d98af2a02c9b4854c1f0c78980`.
The user authorized the complete CLI port and chose direct implementation without the Zensu implementation workflow.

## Requirements

| ID | Requirement | Acceptance evidence |
| --- | --- | --- |
| R1 | Installable Agent Plugins 1.0 package exposing all 32 skills and six agents | Build validation and Copilot plugin/skill/agent discovery |
| R2 | Own the state, review, TDD, evidence, acceptance and recovery engine without source-host runtime contracts | Deterministic build, state integration and native owned regression tests |
| R3 | Direct native CLI policies with correct events, arguments, output and permissions | Protocol and child-process integration tests, native CLI captures |
| R4 | Copilot-specific session identity, private state and model helper binding | Isolation, restart, concurrent session and tamper tests |
| R5 | Planning, custom reviewer results, fix loops and bounded continuation | Approval/result/continuation contracts and live smoke tests |
| R6 | Copilot session trail and takeover/lineage operations | Session fixtures and real local session discovery |
| R7 | Copilot work-order launcher and process supervision | Command/stream/cancellation/lease tests |
| R8 | Native docs, diagnostics, package release checks and explicit parity accounting | Package audit and independent review |

## Implementation sequence

1. Import an immutable source snapshot and define build and parity contracts.
2. Implement native event, tool, result and transcript normalization.
3. Adapt the shared runtime identity and model-side helper environment.
4. Render the complete skill and agent surface with Copilot-native instructions.
5. Implement session trail and headless work-order integration.
6. Build and test the packaged runtime, inspect real Copilot events, fix differences.
7. Run independent reviews, resolve findings, document remaining host limits precisely.

## Preconditions

- Node, Bash, Git and the source checkout are available.
- The user is installing Copilot CLI in parallel; authentication may require their interaction.
- Product tracking uses the existing `zensu` CLI; live tests must not mutate real product data.
- Live model probes use an isolated temporary repository and explicit bounded prompts.
- No merge, publication or deployment is requested.

## Native rewrite 0.2.0

The user explicitly required removing all Claude compatibility, retaining every
workflow, and continuing direct implementation without arming Zensu. The owned
source tree replaces build-time rewriting; policies consume native envelopes and
return native outputs; helper identity uses only native/host-neutral selectors;
transcript consumers read actual native events; desktop-specific transport code is
removed in favor of the existing native workflows. Build independence and full
workflow regressions are acceptance gates for this rewrite.
