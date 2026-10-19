# First repeated native run: workflow failure despite app acceptance

Session `73eda529-69c3-41bf-acbc-a257d1eca1cc` reached native closure flags
and exited 0 on 2026-10-19 at 19:41:35 UTC. This used frozen build
`3a5392d07ab1bdb14238ee787ca91505b6d6f71b2e61e74d4f70ffa3daf6815c`, which has
since been superseded. It is not proof of the newer frozen build.

The native evidence records all five aspect reviewers, substantive primary and
independent second judges, one ticket-consumed reviewer round, terminal
self-review with one latched fix round, and a bound chain-closure call. These
markers do not prove valid workflow completion. Canonical injected packet
bytes matched across the reviewers. The latest edit-landing receipt says clean (13 claims landed, zero pending),
but the earlier audit produced pending predicates and the later audit omitted
that dirty-before context. This is not acceptable recovery evidence. The receipt
downgrade and reported duplicate terminal self-review are retained as workflow
failures rather than overwritten by final state flags.

The final acceptance status is 4/4 on the amended tree. An independent offline
installation of its tarball passed all 14 original invoice assertions, including
200 seeded arithmetic samples and maximum-safe-integer boundaries. Source and
installed library/CLI digests match. The two optional one-MiB comparisons differ
from the prior implementation; they do not change the four original criteria.
The frozen plugin, monitored global configuration and marketplace files remained
unchanged.

After process exit, 24 exact main-session referenced native record/log files were
preserved with source paths and hashes. The latest full suite and all four AC
records agree with the independently hashed current 11-file project tree. This
confirms application evidence while leaving the workflow failures below intact.

The follow-up as a whole is not marked green: native oversized reads occurred,
and the original “Chain close and final report” progress row remained unchecked
after closure even though the managed block was complete. Five initial reviewer
spawns were denied before corrected packet-reference prompts succeeded. The tests
aspect produced substantive evidence but omitted an explicit `Fix:` label.
Pre-hook repeated context prefixes are retained as unassessed observations:
they do not establish whether the model copied them or the host echoed rewritten
arguments. Unlanded-claim recovery and failing-assertion diagnostics were not
live-exercised by this task.

See [machine analysis](first-native-analysis.json), [observations](first-run-observations.json),
[independent consumer](first-independent-consumer.json), and the preserved
[first source checkpoint](first-package-checkpoint.json). The next corrected run must have its own session, build hash and result.
