# Copilot hook timeout repair and dispatcher coverage

## Reviewed changes

The startup and prompt event budgets, bounded context-discovery deadline and
authenticated empty-state resume optimization address three observed hook
timeouts. Earlier context survives an enrichment deadline with an explicit
unfinished-work diagnostic. Admission and completion authority remain unchanged.

Six native timeout regressions and one context-budget structure assertion cover
the repair. Seventeen additional dispatcher cases exercise actual CLI failure
envelopes and exact prompt/capture persistence in isolated temporary storage.

Both implementation review chains completed with **plugin code review passed**:
five perspectives and a consume reviewer, round 1, zero findings in each chain.
Terminal self-reviews required no fix round. This is automated review, not human
acceptance. All reviewed repair/test bytes were preserved when preparing 0.8.3.

## Real Copilot evidence

On 2026-11-04, Copilot CLI 1.0.105 passed **23/23 unchanged presentation checks**
across ten invocations and three fresh sessions. An additional audit examined
78 native hook completions and found zero runtime errors or timeout diagnostics.
Two separate turns used the existing bounded presentation correction.

The frozen candidate carried version 0.8.0 with the unpublished timeout repair.
Its build-receipt SHA-256 was
`310189321daeb38c4e959a48ae46dfc403027df3912ac111f4076c17544d0d39`.
Native evidence SHA-256:
`a4ada422232b4c4876d89e5ecd974eec82e5cd3e5bcb3a77c7955c49cd637770`.
The earlier failed 22/23 run and its three timeout diagnostics remain retained
locally. Raw transcripts, session identifiers and local configuration are not
included in this public changeset.

This was real model/native-hook execution against scripted disposable workflow
states. It was not a full implementation/review workflow, forced compaction or
child-agent live exercise. It is not claimed as a fresh live run of the final
0.8.3 package, which also retains later 0.8.1/0.8.2 changes from main.

## Full suite and coverage

The 2026-11-10 coverage follow-up passed **568 Node + 36 Python = 604 tests**, with
zero failures, cancellations or skips. Build and package checks verified 1,015
immutable upstream files, 284 package hashes and 136 syntax checks. The explicit
dispatcher line threshold of 90% passed:

| Runtime file | Lines | Branches | Functions |
|---|---:|---:|---:|
| `src/dispatcher.js` | 94.86% | 90.00% | 81.82% |

The full Node run used the normal test globs and concurrency plus
`--experimental-test-coverage --test-coverage-include=src/dispatcher.js
--test-coverage-lines=90`; all remaining verification stages ran sequentially.
No production lines were changed or excluded to raise coverage. The earlier
repair's context-discovery coverage was 100% lines, 94.83% branches and 100%
functions; shell behavior is checked by executable fixtures.

These counts describe the reviewed development snapshot before integration with
0.8.2. The PR and release workflows run the entire final-source suite again on
their exact commits. A completed release/marketplace workflow verifies and
publishes the released bytes; it does not itself establish native rendering.
