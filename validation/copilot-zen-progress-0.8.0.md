# Zen progress validation for Copilot 0.8.0

## Evidence boundaries

The Zen implementation and workflow timeout fixes were reviewed and tested before
being ported to the 0.7.0 release line. Release integration preserves the newer
AI-work capture and automatic-context modules. The pull request and tagged release
run `npm run verify` on their own source revisions; their results are separate
from the earlier local evidence below.

## Earlier native presentation evidence

On 2026-11-03, Copilot CLI 1.0.100 produced real model responses in three fresh,
isolated sessions with exactly one frozen external plugin. The observed model was
gpt-6-luna. Ten CLI invocations completed successfully; 23 semantic checks passed.
The frozen build receipt SHA-256 was
`deb19e737decca7ae7a6fca0fa0ab2e9c29880dd5cbc0dc097b72be388a8a06d`.
All 274 frozen files remained unchanged. This identifies the earlier development
package, not the subsequently integrated 0.8.0 release archive.

The transition prompt asked for a short intermediate message between two probe
commands without supplying the expected progress line. The visible message
included `Zensu: ▶implement ·review ·self-review` before the next tool call. The
final response carried `Zensu: ✓implement ▶review ·self-review`.

Checks covered initial presentation, changed and unchanged progress, intermediate
output, final output, off/on and repeated off/on, session isolation, first-prompt
off, one final-answer correction without repeated work, chain closure, frozen
package integrity and unchanged normal installation settings.

Earlier attempts are retained locally: hook delivery alone initially failed to
produce an intermediate line; the first reminder revision exposed an unwanted
metadata prefix. The final value-only instruction fixed that observed case. A
negative control still rejects the earlier missing intermediate line. Two stale
progress checks were refined to require workflow marks after `Zensu:` instead of
misclassifying unrelated startup/tip prose. The intermediate assertion was not
weakened.

## Fixture and package evidence

Before release integration, 507 Node tests and 36 Python tests passed with no
failures, skips or cancellations. The changed progress module had 100% line,
98.95% branch and 100% function coverage. These are scoped results for that
reviewed development snapshot, not a coverage claim for the whole repository.

Native fixtures exercise real session bindings, helpers and dispatcher events.
The workflow reliability regression verifies one project validation per bound
helper invocation and refusal when a later fresh validation fails. Fixture-only
compaction, child-principal and failure-path assertions are not live model proof.

## Limitations and retained artifacts

Workflow states in the native presentation probe were scripted disposable inputs;
no actual implementation or review was performed by those probe conversations.
Intermediate rendering depends on model compliance. A successful probe is not a
guarantee for every model or future conversation. The final stop correction is
bounded to one request per genuine user turn and cannot override workflow policy.

Raw local native transcripts, hook captures, failed attempts and protocol
screenshots remain local to avoid publishing session metadata and machine paths.
The provided screenshot was a clearly labeled transcript excerpt in TextEdit,
not an original Copilot terminal screenshot. No active user session, normal plugin
installation, immutable upstream snapshot or Claude installation was changed.
