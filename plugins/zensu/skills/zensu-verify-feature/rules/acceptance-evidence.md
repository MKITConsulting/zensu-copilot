# Acceptance checks: useful diagnostics and shared evidence

These rules apply to exit-code checks under `--chain`. They preserve the credential-blind
boundary, current-tree evidence and one recorded verdict per active criterion. They do not
change browser consent, UI evidence planes or the report-only boundary of this skill.

## Safe synthetic diagnostics

The evidence runner exposes the check's stdout/stderr tail to the model. Report redaction and
the runner's tail length are not sanitizers. Suppress raw application output, network output,
request/response bodies, headers, arbitrary exception messages and stack traces **before**
they reach that runner. For example, capture a child process's stdout/stderr into the local
assertion harness, assert its exact contract there, and do not forward those buffers. A curl
check that needs no response body can use `curl -fsS -o /dev/null <validated-loopback-url>
>/dev/null 2>&1` and retain its exit status.

For a proven unauthenticated, synthetic, secret-free local fixture, keep useful assertion
diagnostics instead of hiding the whole harness output. First inspect the check's code and
inputs to establish that classification; being on localhost is insufficient. Use a wrapper
that emits **only** these bounded fields, chosen before execution:

- a literal criterion ID such as `AC-001`;
- a fixed check name such as `packaged-bin-exit`, never derived from input or application output;
- `pass`, `fail` or `unverified` and a finite category such as `assertion`, `exit-code`,
  `timeout`, `launch` or `setup`;
- the numeric child exit status, when one was actually observed.

Use at most 20 diagnostic lines, each at most 160 characters. If more checks fail, print a
numeric omitted-check count; do not replace bounded summaries with a log dump. For example:

```text
AC-001 check=rounding result=pass
AC-002 check=invalid-quantity result=pass
AC-003 check=packaged-bin-exit result=fail category=exit-code exit=2
```

The wrapper must catch unexpected exceptions without printing their message or stack, emit
only a fixed category, and exit nonzero. Capture a test framework's raw failure output too:
assertion libraries often print input values. Do not use a regex to redact arbitrary logs and
declare the result safe. No credential, token, cookie, signed URL, environment value, personal
data, raw subject stdout/stderr or unclassified value may appear in a diagnostic. If that
cannot be guaranteed, retain output suppression and record a bounded fixed failure category.

Assertions still inspect the real interface, including stdout/stderr, errors and side effects
when required; output suppression never excuses omitting those assertions. The wrapper exits
0 only when every claimed assertion ran and passed. A setup or launch failure is not evidence
that the product criterion fails: record `partial` with the fixed category.

## One observed run, several individually recorded ACs

1. Before execution, map each intended `AC-###` to named assertions of the shared suite in the
   matrix. A smoke check or an unrelated full test suite is insufficient. Each criterion must
   have all of its required evidence planes; an API check cannot prove a browser UI criterion.
2. Prepare/build/package once for the current tree, placing generated files outside the
   project or in a gitignored path. Run the real assertion suite once through
   `zensu-log.sh --evidence-run --scope acceptance --cmd '<check>' --log <run log>`.
   Confirm a completed record, an unchanged start/end tree and the actual exit code. Never
   substitute a prior full-suite/lint record, a different session or a previous build.
3. After a successful shared run, immediately record **each covered AC separately**, in
   sequence, with `--acceptance-record --ac AC-### --verdict pass --driver <actual-driver>
   --evidence-run <same er1 id> --log <run log>`. Use the standard stdin evidence form in
   `references/chain.md`. Each observation names its own assertions and results in English.
   No code edits, tree-changing writes or unrelated work may intervene. Do not wait until
   the end of the entire verification session, and do not rerun the identical suite once
   per criterion merely to obtain different record IDs.
4. The recorder checks the session, acceptance scope, completion, unchanged tree, current
   tree and exit/verdict agreement on every record. It does not establish the assertion-to-AC
   mapping for you. If the tree or criterion changes, refresh the affected evidence and
   records; never force a stale record through or claim an AC that the suite did not assert.
5. When a shared run fails, do **not** record any criterion as `pass` from its nonzero record.
   Record `fail` only for an AC whose own assertion demonstrated a product failure; record
   unproven/setup-blocked criteria as `partial`. A separate targeted check may prove another
   AC that the shared failure left unproven. Do not repeatedly rerun a criterion already
   recorded failing on this tree: it requires a code change first.
6. Finish with `--acceptance-status`. Every active criterion must independently pass on the
   current tree before the chain closes. A shared `er1` does not reduce that requirement.
